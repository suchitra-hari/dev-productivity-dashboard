/**
 * Jira data collector for Core4 Quality and Impact metrics:
 *   Quality → Defect Ratio  = bugs_closed / total_issues_closed
 *   Impact  → Innovation Ratio = features / total_issues_closed
 *
 * Also builds initiative alignment: maps Jira epics to DX initiatives by
 * comparing epic names/keys against initiative names from DX.
 *
 * Jira issue types used:
 *   Bugs:     Bug, Defect
 *   Features: Story, Feature, New Feature, Epic (as parent)
 *   Other:    Task, Sub-task, Improvement, Technical Debt
 *
 * The Jira project key and cloud ID are required (set via env vars or config).
 */

import {
  type Initiative,
  type JiraStats,
  type TeamName,
  type WeekWindow,
} from './types';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface AtlassianCaller {
  searchJiraIssuesUsingJql(args: {
    cloudId: string;
    jql: string;
    maxResults?: number;
    fields?: string[];
    nextPageToken?: string;
  }): Promise<unknown>;
}

export interface JiraConfig {
  cloudId: string;
  projectKey: string;
  /** Map of Jira user account IDs per team name */
  teamAccountIds: Record<TeamName, string[]>;
}

/**
 * Computes Jira-based metrics for a team in a week window.
 */
export async function collectJiraStats(
  caller: AtlassianCaller,
  config: JiraConfig,
  teamName: TeamName,
  week: WeekWindow
): Promise<JiraStats> {
  const accountIds = config.teamAccountIds[teamName] ?? [];

  if (accountIds.length === 0) {
    console.warn(
      `[jira-collector] No Jira account IDs for team "${teamName}" — ` +
        'Jira metrics will be zeroed. Provide team account IDs via JiraConfig.'
    );
    return emptyStats();
  }

  console.log(
    `[jira-collector] Querying Jira for "${teamName}" in ${week.label}...`
  );

  const jql = buildJQL(config.projectKey, accountIds, week);
  const issues = await fetchAllIssues(caller, config.cloudId, jql);

  return computeStats(issues);
}

/**
 * Resolves Jira account IDs for a list of email addresses.
 * Uses Jira's user lookup. Returns a map of email → accountId.
 */
export async function resolveJiraAccountIds(
  caller: AtlassianCaller & {
    lookupJiraAccountId: (args: {
      cloudId: string;
      searchString: string;
    }) => Promise<unknown>;
  },
  cloudId: string,
  emails: string[]
): Promise<Map<string, string>> {
  const result = new Map<string, string>();

  for (const email of emails) {
    try {
      const raw = await caller.lookupJiraAccountId({
        cloudId,
        searchString: email,
      });
      const accountId = extractAccountId(raw, email);
      if (accountId) result.set(email, accountId);
    } catch (err) {
      console.warn(
        `[jira-collector] Failed to look up Jira account for ${email}: ${err}`
      );
    }
  }

  return result;
}

/**
 * Computes initiative alignment: for each DX initiative, counts how many
 * closed Jira issues in the window reference it (via epic name matching).
 */
export async function computeInitiativeAlignment(
  caller: AtlassianCaller,
  config: JiraConfig,
  teamName: TeamName,
  week: WeekWindow,
  initiatives: Initiative[]
): Promise<Map<string, number>> {
  const alignment = new Map<string, number>();
  const accountIds = config.teamAccountIds[teamName] ?? [];
  if (accountIds.length === 0 || initiatives.length === 0) return alignment;

  for (const initiative of initiatives) {
    // Search for issues linked to epics matching the initiative name
    const nameWords = initiative.name
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 3);

    if (nameWords.length === 0) continue;

    const epicClause = nameWords
      .map((w) => `"Epic Link" ~ "${w}"`)
      .join(' OR ');

    const jql =
      `project = ${config.projectKey} AND ` +
      `resolutiondate >= "${week.start}" AND resolutiondate <= "${week.end}" AND ` +
      `statusCategory = Done AND ` +
      `assignee in (${accountIds.map((id) => `"${id}"`).join(', ')}) AND ` +
      `(${epicClause})`;

    try {
      const issues = await fetchAllIssues(caller, config.cloudId, jql);
      alignment.set(initiative.id, issues.length);
    } catch {
      alignment.set(initiative.id, 0);
    }
  }

  return alignment;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface JiraIssue {
  fields: {
    issuetype?: {name?: string};
    status?: {statusCategory?: {name?: string}};
    resolutiondate?: string | null;
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildJQL(
  projectKey: string,
  accountIds: string[],
  week: WeekWindow
): string {
  const assigneeClause = accountIds.map((id) => `"${id}"`).join(', ');

  return (
    `project = ${projectKey} AND ` +
    `resolutiondate >= "${week.start}" AND resolutiondate <= "${week.end}" AND ` +
    `statusCategory = Done AND ` +
    `assignee in (${assigneeClause})`
  );
}

async function fetchAllIssues(
  caller: AtlassianCaller,
  cloudId: string,
  jql: string
): Promise<JiraIssue[]> {
  const all: JiraIssue[] = [];
  let nextPageToken: string | undefined;
  const MAX_PAGES = 10;
  let page = 0;

  while (page < MAX_PAGES) {
    let raw: unknown;
    try {
      raw = await caller.searchJiraIssuesUsingJql({
        cloudId,
        jql,
        maxResults: 100,
        fields: ['issuetype', 'status', 'resolutiondate'],
        nextPageToken,
      });
    } catch (err) {
      console.warn(`[jira-collector] JQL query failed: ${err}\nJQL: ${jql}`);
      break;
    }

    const {issues, nextToken} = extractIssues(raw);
    all.push(...issues);

    if (!nextToken || issues.length === 0) break;
    nextPageToken = nextToken;
    page++;
  }

  return all;
}

function extractIssues(raw: unknown): {
  issues: JiraIssue[];
  nextToken?: string;
} {
  if (!raw || typeof raw !== 'object') return {issues: []};

  const obj = raw as Record<string, unknown>;

  // Unwrap DX-style { result: "..." }
  if (typeof obj['result'] === 'string') {
    try {
      return extractIssues(JSON.parse(obj['result']));
    } catch {
      return {issues: []};
    }
  }

  const issues = (obj['issues'] ?? obj['data'] ?? []) as JiraIssue[];
  const nextToken = obj['nextPageToken'] as string | undefined;

  return {
    issues: Array.isArray(issues) ? issues : [],
    nextToken,
  };
}

function computeStats(issues: JiraIssue[]): JiraStats {
  const total = issues.length;
  let bugs = 0;
  let features = 0;

  for (const issue of issues) {
    const typeName = (issue.fields?.issuetype?.name ?? '').toLowerCase();
    if (isBug(typeName)) bugs++;
    else if (isFeature(typeName)) features++;
  }

  return {
    totalIssuesClosed: total,
    bugsClosed: bugs,
    featuresClosed: features,
    defectRatio: total > 0 ? bugs / total : 0,
    innovationRatio: total > 0 ? features / total : 0,
  };
}

function isBug(typeName: string): boolean {
  return typeName === 'bug' || typeName === 'defect';
}

function isFeature(typeName: string): boolean {
  return (
    typeName === 'story' ||
    typeName === 'feature' ||
    typeName === 'new feature' ||
    typeName === 'epic'
  );
}

function emptyStats(): JiraStats {
  return {
    totalIssuesClosed: 0,
    bugsClosed: 0,
    featuresClosed: 0,
    defectRatio: 0,
    innovationRatio: 0,
  };
}

function extractAccountId(raw: unknown, email: string): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  // Handle DX result wrapper
  let data: unknown = obj;
  if (typeof obj['result'] === 'string') {
    try {
      data = JSON.parse(obj['result']);
    } catch {
      return null;
    }
  }

  if (Array.isArray(data)) {
    const user = (data as Record<string, unknown>[]).find(
      (u) =>
        String(u['emailAddress'] ?? '').toLowerCase() === email.toLowerCase()
    );
    return user ? String(user['accountId'] ?? '') || null : null;
  }

  const dataObj = data as Record<string, unknown>;
  return String(dataObj['accountId'] ?? '') || null;
}
