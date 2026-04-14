/**
 * DX data warehouse queries for Core4 metrics and agentic adoption signals.
 *
 * Queries the DX PostgreSQL warehouse via the `queryData` MCP tool.
 * All SQL is written to match the actual schema discovered during development:
 *
 *   dx_snapshot_team_scores — Core4 scores (item_type = 'core4')
 *   cursor_daily_user_metrics — Cursor/agentic usage per user per day
 *   github_pulls + github_pull_commits — PR throughput
 *   github_reviews — Re-review rates
 *   jira_issues + jira_issue_types — Defect/Innovation ratios
 *
 * Team IDs for the Developer Productivity pillar (confirmed from DX warehouse):
 *   50  = Build Loop
 *   23  = Delivery Loop
 *   21  = Developer Platform  (mapped to "Agent Loop" in this pillar)
 *   3   = Shared Services
 *   58  = Spring Design System
 */

import {
  type AIProviderUsageRow,
  type DXIScore,
  type EpicAgenticRow,
  type Initiative,
  type TeamName,
} from './types';

// Pillar team ID map — verified from DX `dx_teams` table
export const DX_TEAM_IDS: Record<string, number> = {
  'Build Loop': 50,
  'Delivery Loop': 23,
  // 'Agent Loop' omitted — new team not yet in DX warehouse
  'Shared Services': 3,
  'Design System': 58, // "Spring Design System" in DX
};

// Reverse map for rendering
export const DX_TEAM_DISPLAY_NAMES: Record<number, string> = {
  50: 'Build Loop',
  23: 'Delivery Loop',
  3: 'Shared Services',
  58: 'Design System',
};

// ---------------------------------------------------------------------------
// Caller interface
// ---------------------------------------------------------------------------

export interface DXWarehouseCaller {
  queryData(sql: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetches the most recent Core4 snapshot scores for all pillar teams.
 * Returns null values for teams with no recent snapshot.
 */
export async function fetchCore4Scores(
  caller: DXWarehouseCaller
): Promise<Map<TeamName, Record<string, DXIScore>>> {
  const teamIds = Object.values(DX_TEAM_IDS).join(', ');

  const sql = `
    SELECT
      t.name AS dx_team_name,
      t.id AS team_id,
      si.name AS metric,
      sts.score,
      sts.vs_org,
      sts.vs_prev,
      s.start_date,
      s.end_date,
      sts.unit
    FROM dx_snapshot_team_scores sts
    JOIN dx_snapshots s ON sts.snapshot_id = s.id
    JOIN dx_teams t ON sts.team_id = t.id
    JOIN dx_snapshot_items si ON sts.item_id = si.id
    WHERE sts.team_id IN (${teamIds})
      AND si.item_type = 'core4'
    ORDER BY s.start_date DESC, t.name, si.name
  `;

  const raw = await caller.queryData(sql);
  const rows = parseCSV(raw);

  const result = new Map<TeamName, Record<string, DXIScore>>();

  // Keep only the most recent snapshot per team (first occurrence in DESC order)
  const seenTeams = new Set<number>();

  for (const row of rows) {
    const teamId = parseInt(String(row['team_id'] ?? '0'));
    const pillarName = DX_TEAM_DISPLAY_NAMES[teamId] as TeamName | undefined;
    if (!pillarName) continue;
    if (seenTeams.has(teamId)) continue;
    seenTeams.add(teamId);

    if (!result.has(pillarName)) result.set(pillarName, {});
    const metrics = result.get(pillarName)!;

    const metricName = String(row['metric'] ?? '');
    metrics[metricName] = {
      score: parseFloat(String(row['score'] ?? '0')) || null,
      label: metricName,
    };
  }

  return result;
}

/**
 * Returns weekly PR throughput per team in the given date range.
 */
export async function fetchWeeklyPRThroughput(
  caller: DXWarehouseCaller,
  startDate: string,
  endDate: string
): Promise<PRThroughputRow[]> {
  const teamIds = Object.values(DX_TEAM_IDS).join(', ');

  const sql = `
    SELECT
      t.name AS dx_team_name,
      t.id AS team_id,
      DATE_TRUNC('week', gp.merged)::date AS week_start,
      COUNT(DISTINCT gp.id) AS prs_merged,
      COUNT(DISTINCT gp.user_id) AS active_authors,
      ROUND(COUNT(DISTINCT gp.id)::numeric / NULLIF(COUNT(DISTINCT gp.user_id), 0), 2) AS prs_per_person
    FROM github_pulls gp
    JOIN github_users gu ON gp.user_id = gu.id
    JOIN dx_users du ON du.github_username = gu.login
    JOIN dx_teams t ON du.team_id = t.id
    WHERE du.team_id IN (${teamIds})
      AND du.deleted_at IS NULL
      AND gp.merged >= '${startDate}'
      AND gp.merged < '${endDate}'
    GROUP BY t.name, t.id, DATE_TRUNC('week', gp.merged)
    ORDER BY t.name, week_start
  `;

  const raw = await caller.queryData(sql);
  const rows = parseCSV(raw);

  return rows.map((row) => ({
    teamId: parseInt(String(row['team_id'] ?? '0')),
    teamName:
      (DX_TEAM_DISPLAY_NAMES[
        parseInt(String(row['team_id'] ?? '0'))
      ] as TeamName) ?? '',
    weekStart: String(row['week_start'] ?? ''),
    prsMerged: parseInt(String(row['prs_merged'] ?? '0')),
    activeAuthors: parseInt(String(row['active_authors'] ?? '0')),
    prsPerPerson: parseFloat(String(row['prs_per_person'] ?? '0')),
  }));
}

/**
 * Returns weekly Cursor agent usage (proxy for agentic adoption) per team.
 */
export async function fetchWeeklyCursorUsage(
  caller: DXWarehouseCaller,
  startDate: string,
  endDate: string
): Promise<CursorUsageRow[]> {
  const teamIds = Object.values(DX_TEAM_IDS).join(', ');

  const sql = `
    SELECT
      t.name AS dx_team_name,
      t.id AS team_id,
      DATE_TRUNC('week', cdm.date)::date AS week_start,
      COUNT(DISTINCT cdm.email) AS cursor_active_users,
      COUNT(DISTINCT du.id) AS team_size,
      ROUND(COUNT(DISTINCT cdm.email)::numeric / NULLIF(COUNT(DISTINCT du.id), 0) * 100, 1) AS adoption_pct,
      SUM(cdm.agent_requests) AS agent_requests,
      SUM(cdm.total_applies) AS total_applies,
      SUM(cdm.total_accepts) AS total_accepts
    FROM cursor_daily_user_metrics cdm
    JOIN dx_users du ON du.email = cdm.email
    JOIN dx_teams t ON du.team_id = t.id
    WHERE du.team_id IN (${teamIds})
      AND du.deleted_at IS NULL
      AND cdm.date >= '${startDate}'
      AND cdm.date < '${endDate}'
      AND cdm.is_active = true
    GROUP BY t.name, t.id, DATE_TRUNC('week', cdm.date)
    ORDER BY t.name, week_start
  `;

  const raw = await caller.queryData(sql);
  const rows = parseCSV(raw);

  return rows.map((row) => ({
    teamId: parseInt(String(row['team_id'] ?? '0')),
    teamName:
      (DX_TEAM_DISPLAY_NAMES[
        parseInt(String(row['team_id'] ?? '0'))
      ] as TeamName) ?? '',
    weekStart: String(row['week_start'] ?? ''),
    cursorActiveUsers: parseInt(String(row['cursor_active_users'] ?? '0')),
    teamSize: parseInt(String(row['team_size'] ?? '0')),
    adoptionPct: parseFloat(String(row['adoption_pct'] ?? '0')),
    agentRequests: parseInt(String(row['agent_requests'] ?? '0')),
    totalApplies: parseInt(String(row['total_applies'] ?? '0')),
    totalAccepts: parseInt(String(row['total_accepts'] ?? '0')),
  }));
}

/**
 * Returns 30-day Claude Code usage totals per team from
 * claude_code_daily_user_metrics + claude_code_daily_user_metrics_breakdowns.
 * Falls back to [] if tables are unavailable.
 */
export async function fetchClaudeCodeUsage(
  caller: DXWarehouseCaller,
  startDate: string,
  endDate: string
): Promise<ClaudeCodeRow[]> {
  const teamIds = Object.values(DX_TEAM_IDS).join(', ');

  const sql = `
    SELECT
      t.id AS team_id,
      t.name AS dx_team_name,
      COUNT(DISTINCT ccm.email)               AS active_users,
      SUM(b.num_sessions)                     AS total_sessions,
      SUM(b.commits_by_claude_code)           AS commits_by_claude,
      SUM(b.pull_requests_by_claude_code)     AS prs_by_claude,
      SUM(b.lines_of_code_added)              AS lines_added
    FROM claude_code_daily_user_metrics ccm
    JOIN claude_code_daily_user_metrics_breakdowns b ON b.daily_user_metric_id = ccm.id
    JOIN dx_users du ON LOWER(du.email) = LOWER(ccm.email)
    JOIN dx_teams t  ON du.team_id = t.id
    WHERE du.team_id IN (${teamIds})
      AND du.deleted_at IS NULL
      AND ccm.date >= '${startDate}'
      AND ccm.date <= '${endDate}'
      AND ccm.is_active = true
    GROUP BY t.id, t.name
    ORDER BY t.name
  `;

  let raw: string;
  try {
    raw = await caller.queryData(sql);
  } catch (err) {
    console.warn(`[dx-metrics] fetchClaudeCodeUsage failed — falling back to empty. (${err})`);
    return [];
  }

  const rows = parseCSV(raw);
  return rows.map((row) => ({
    teamId: parseInt(String(row['team_id'] ?? '0')),
    teamName:
      (DX_TEAM_DISPLAY_NAMES[
        parseInt(String(row['team_id'] ?? '0'))
      ] as TeamName) ?? '',
    activeUsers: parseInt(String(row['active_users'] ?? '0')),
    totalSessions: parseInt(String(row['total_sessions'] ?? '0')),
    commitsByClaude: parseInt(String(row['commits_by_claude'] ?? '0')),
    prsByClaude: parseInt(String(row['prs_by_claude'] ?? '0')),
    linesAdded: parseInt(String(row['lines_added'] ?? '0')),
  }));
}

/**
 * Returns weekly AI tool adoption per team from the DX `custom` namespace,
 * covering all providers (Cursor, Augment Code, OpenAI Codex, etc.).
 *
 * Falls back to an empty array if the table doesn't exist yet so the rest
 * of the report continues to run. Table name is discovered at runtime via
 * information_schema if `custom.ai_tool_usage` is not found.
 */
export async function fetchWeeklyAIProviderUsage(
  caller: DXWarehouseCaller,
  startDate: string,
  endDate: string
): Promise<AIProviderUsageRow[]> {
  const teamIds = Object.values(DX_TEAM_IDS).join(', ');

  // Discover the correct table name in the custom schema on first call
  const discoverySQL = `
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'custom'
      AND table_name ILIKE '%ai%tool%'
    LIMIT 5
  `;

  let tableName = 'custom.ai_tool_usage';
  try {
    const discoveryRaw = await caller.queryData(discoverySQL);
    const discoveryRows = parseCSV(discoveryRaw);
    if (discoveryRows.length > 0) {
      tableName = `custom.${String(discoveryRows[0]['table_name'] ?? 'ai_tool_usage')}`;
    }
  } catch {
    // Table discovery failed — proceed with default name, will catch below
  }

  const sql = `
    SELECT
      t.id AS team_id,
      t.name AS dx_team_name,
      DATE_TRUNC('week', atu.date)::date AS week_start,
      atu.tool_name AS provider,
      COUNT(DISTINCT atu.email) AS active_users,
      COUNT(DISTINCT du.id) AS team_size,
      ROUND(COUNT(DISTINCT atu.email)::numeric / NULLIF(COUNT(DISTINCT du.id), 0) * 100, 1) AS adoption_pct,
      COUNT(*) AS total_sessions
    FROM ${tableName} atu
    JOIN dx_users du ON du.email = atu.email
    JOIN dx_teams t ON du.team_id = t.id
    WHERE du.team_id IN (${teamIds})
      AND du.deleted_at IS NULL
      AND atu.date >= '${startDate}'
      AND atu.date < '${endDate}'
    GROUP BY t.id, t.name, DATE_TRUNC('week', atu.date), atu.tool_name
    ORDER BY t.name, week_start, provider
  `;

  let raw: string;
  try {
    raw = await caller.queryData(sql);
  } catch (err) {
    console.warn(
      `[dx-metrics] fetchWeeklyAIProviderUsage: table "${tableName}" not available — ` +
        `falling back to Cursor-only data. (${err})`
    );
    return [];
  }

  const rows = parseCSV(raw);
  const knownProviders = new Set(['cursor', 'augment', 'codex']);

  return rows.map((row) => {
    const rawProvider = String(row['provider'] ?? '').toLowerCase();
    const provider = knownProviders.has(rawProvider)
      ? (rawProvider as AIProviderUsageRow['provider'])
      : 'other';

    return {
      teamId: parseInt(String(row['team_id'] ?? '0')),
      teamName:
        (DX_TEAM_DISPLAY_NAMES[
          parseInt(String(row['team_id'] ?? '0'))
        ] as TeamName) ?? '',
      weekStart: String(row['week_start'] ?? ''),
      provider,
      activeUsers: parseInt(String(row['active_users'] ?? '0')),
      teamSize: parseInt(String(row['team_size'] ?? '0')),
      adoptionPct: parseFloat(String(row['adoption_pct'] ?? '0')),
      totalSessions: parseInt(String(row['total_sessions'] ?? '0')),
    };
  });
}

/**
 * Returns weekly Jira defect and innovation stats per team.
 */
export async function fetchWeeklyJiraStats(
  caller: DXWarehouseCaller,
  startDate: string,
  endDate: string
): Promise<JiraStatsRow[]> {
  const teamIds = Object.values(DX_TEAM_IDS).join(', ');

  const sql = `
    SELECT
      t.name AS dx_team_name,
      t.id AS team_id,
      DATE_TRUNC('week', ji.completed_at)::date AS week_start,
      COUNT(*) AS total_issues,
      SUM(CASE WHEN jit.name ILIKE '%bug%' OR jit.name ILIKE '%defect%' THEN 1 ELSE 0 END) AS bugs,
      SUM(CASE WHEN jit.name ILIKE '%story%' OR jit.name ILIKE '%feature%' OR jit.name ILIKE '%epic%' THEN 1 ELSE 0 END) AS features,
      ROUND(SUM(CASE WHEN jit.name ILIKE '%bug%' OR jit.name ILIKE '%defect%' THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0) * 100, 1) AS defect_ratio_pct,
      ROUND(SUM(CASE WHEN jit.name ILIKE '%story%' OR jit.name ILIKE '%feature%' OR jit.name ILIKE '%epic%' THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0) * 100, 1) AS innovation_ratio_pct
    FROM jira_issues ji
    JOIN jira_issue_types jit ON ji.issue_type_id = jit.id
    JOIN jira_users ju ON ji.user_id = ju.id
    JOIN dx_users du ON LOWER(du.email) = LOWER(ju.email)
    JOIN dx_teams t ON du.team_id = t.id
    WHERE du.team_id IN (${teamIds})
      AND du.deleted_at IS NULL
      AND ji.completed_at >= '${startDate}'
      AND ji.completed_at < '${endDate}'
      AND ji.deleted_at IS NULL
    GROUP BY t.name, t.id, DATE_TRUNC('week', ji.completed_at)
    ORDER BY t.name, week_start
  `;

  const raw = await caller.queryData(sql);
  const rows = parseCSV(raw);

  return rows.map((row) => ({
    teamId: parseInt(String(row['team_id'] ?? '0')),
    teamName:
      (DX_TEAM_DISPLAY_NAMES[
        parseInt(String(row['team_id'] ?? '0'))
      ] as TeamName) ?? '',
    weekStart: String(row['week_start'] ?? ''),
    totalIssues: parseInt(String(row['total_issues'] ?? '0')),
    bugs: parseInt(String(row['bugs'] ?? '0')),
    features: parseInt(String(row['features'] ?? '0')),
    defectRatioPct: parseFloat(String(row['defect_ratio_pct'] ?? '0')),
    innovationRatioPct: parseFloat(String(row['innovation_ratio_pct'] ?? '0')),
  }));
}

/**
 * Returns weekly re-review rates per team.
 */
export async function fetchWeeklyReReviewRates(
  caller: DXWarehouseCaller,
  startDate: string,
  endDate: string
): Promise<ReReviewRow[]> {
  const teamIds = Object.values(DX_TEAM_IDS).join(', ');

  const sql = `
    SELECT
      t.name AS dx_team_name,
      t.id AS team_id,
      DATE_TRUNC('week', gp.merged)::date AS week_start,
      COUNT(DISTINCT gp.id) AS total_prs,
      COUNT(DISTINCT CASE WHEN gr_req.pull_id IS NOT NULL THEN gp.id END) AS prs_with_changes_requested,
      COUNT(DISTINCT CASE
        WHEN gr_req.pull_id IS NOT NULL
          AND gr_follow.pull_id IS NOT NULL
        THEN gp.id
      END) AS re_reviewed_prs
    FROM github_pulls gp
    JOIN github_users gu ON gp.user_id = gu.id
    JOIN dx_users du ON du.github_username = gu.login
    JOIN dx_teams t ON du.team_id = t.id
    LEFT JOIN github_reviews gr_req
      ON gr_req.pull_id = gp.id AND gr_req.state = 'CHANGES_REQUESTED'
    LEFT JOIN github_reviews gr_follow
      ON gr_follow.pull_id = gp.id
      AND gr_follow.state IN ('APPROVED', 'COMMENTED')
      AND gr_follow.submitted > gr_req.submitted
    WHERE du.team_id IN (${teamIds})
      AND du.deleted_at IS NULL
      AND gp.merged >= '${startDate}'
      AND gp.merged < '${endDate}'
    GROUP BY t.name, t.id, DATE_TRUNC('week', gp.merged)
    ORDER BY t.name, week_start
  `;

  const raw = await caller.queryData(sql);
  const rows = parseCSV(raw);

  return rows.map((row) => ({
    teamId: parseInt(String(row['team_id'] ?? '0')),
    teamName:
      (DX_TEAM_DISPLAY_NAMES[
        parseInt(String(row['team_id'] ?? '0'))
      ] as TeamName) ?? '',
    weekStart: String(row['week_start'] ?? ''),
    totalPRs: parseInt(String(row['total_prs'] ?? '0')),
    prsWithChangesRequested: parseInt(
      String(row['prs_with_changes_requested'] ?? '0')
    ),
    reReviewedPRs: parseInt(String(row['re_reviewed_prs'] ?? '0')),
  }));
}

/**
 * Returns active epic agentic breakdown for the last 30 days.
 *
 * A PR is flagged "agentic" when its author had either:
 *   a) Cursor commits in the same repo on any day the PR was open, OR
 *   b) An active Claude Code session (is_active = true) on any day the PR was open.
 *
 * This is a directional proxy — it means "AI-active engineer during PR lifetime,"
 * not proof that AI generated the code.
 *
 * Scope: epics with status In Progress or To Do that have ≥ 1 merged PR in window.
 */
export async function fetchEpicAgenticBreakdown(
  caller: DXWarehouseCaller,
  startDate: string,
  endDate: string
): Promise<EpicAgenticRow[]> {
  const teamIds = Object.values(DX_TEAM_IDS).join(', ');

  const sql = `
    WITH cursor_signal AS (
      SELECT DISTINCT
        LOWER(user_email) AS email,
        SPLIT_PART(repo_name, '/', 2) AS repo_short,
        DATE(commit_timestamp) AS active_date
      FROM cursor_commits
      WHERE commit_timestamp >= '${startDate}'
        AND commit_timestamp <= '${endDate}'
    ),
    claude_signal AS (
      SELECT DISTINCT
        LOWER(clm.email) AS email,
        clm.date AS active_date
      FROM claude_code_daily_user_metrics clm
      WHERE clm.date >= '${startDate}'
        AND clm.date <= '${endDate}'
        AND clm.is_active = true
    ),
    epic_prs AS (
      SELECT
        gp.id AS pr_id,
        gp.created,
        gp.merged,
        r.name AS repo_name,
        ji_child.parent_key AS epic_key,
        ji_epic.summary AS epic_summary,
        js.name AS epic_status,
        LOWER(du.email) AS author_email,
        t.name AS team
      FROM github_pulls gp
      JOIN github_repositories r ON r.id = gp.repository_id
      JOIN github_users gu ON gp.user_id = gu.id
      JOIN dx_users du ON du.github_username = gu.login AND du.deleted_at IS NULL
      JOIN dx_teams t ON du.team_id = t.id
      LEFT JOIN jira_issues ji_child ON ji_child.key = gp.issue_tracker_key
      LEFT JOIN jira_issues ji_epic ON ji_epic.key = ji_child.parent_key
      LEFT JOIN jira_statuses js ON js.id = ji_epic.status_id
      WHERE du.team_id IN (${teamIds})
        AND gp.merged >= '${startDate}'
        AND gp.merged <= '${endDate}'
        AND ji_child.parent_key IS NOT NULL
        AND js.name IN ('In Progress', 'To Do')
    )
    SELECT
      team,
      epic_key,
      epic_summary,
      epic_status,
      COUNT(DISTINCT pr_id) AS total_prs,
      COUNT(DISTINCT CASE WHEN cs.email IS NOT NULL OR cl.email IS NOT NULL THEN pr_id END) AS agentic_prs,
      ROUND(
        100.0 * COUNT(DISTINCT CASE WHEN cs.email IS NOT NULL OR cl.email IS NOT NULL THEN pr_id END)
        / NULLIF(COUNT(DISTINCT pr_id), 0)
      ) AS agentic_pct
    FROM epic_prs ep
    LEFT JOIN cursor_signal cs
      ON cs.email = ep.author_email
      AND cs.repo_short = ep.repo_name
      AND cs.active_date BETWEEN DATE(ep.created) AND DATE(ep.merged)
    LEFT JOIN claude_signal cl
      ON cl.email = ep.author_email
      AND cl.active_date BETWEEN DATE(ep.created) AND DATE(ep.merged)
    GROUP BY team, epic_key, epic_summary, epic_status
    HAVING COUNT(DISTINCT pr_id) >= 1
    ORDER BY team, total_prs DESC
  `;

  let raw: string;
  try {
    raw = await caller.queryData(sql);
  } catch (err) {
    console.warn(`[dx-metrics] fetchEpicAgenticBreakdown failed — falling back to empty. (${err})`);
    return [];
  }

  const rows = parseCSV(raw);
  return rows.map((row) => ({
    team: String(row['team'] ?? ''),
    epicKey: String(row['epic_key'] ?? ''),
    epicSummary: String(row['epic_summary'] ?? ''),
    epicStatus: String(row['epic_status'] ?? ''),
    totalPRs: parseInt(String(row['total_prs'] ?? '0')),
    agenticPRs: parseInt(String(row['agentic_prs'] ?? '0')),
    agenticPct: parseInt(String(row['agentic_pct'] ?? '0')),
  }));
}

/**
 * Fetches initiatives from DX (returns empty array if none are published).
 */
export async function fetchInitiatives(
  _caller: DXWarehouseCaller
): Promise<Initiative[]> {
  // DX initiatives table is not yet populated in the warehouse;
  // use listInitiatives via the MCP caller instead (see report.ts).
  return [];
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface PRThroughputRow {
  teamId: number;
  teamName: TeamName;
  weekStart: string;
  prsMerged: number;
  activeAuthors: number;
  prsPerPerson: number;
}

export interface CursorUsageRow {
  teamId: number;
  teamName: TeamName;
  weekStart: string;
  cursorActiveUsers: number;
  teamSize: number;
  adoptionPct: number;
  agentRequests: number;
  totalApplies: number;
  totalAccepts: number;
}

export interface JiraStatsRow {
  teamId: number;
  teamName: TeamName;
  weekStart: string;
  totalIssues: number;
  bugs: number;
  features: number;
  defectRatioPct: number;
  innovationRatioPct: number;
}

export interface ReReviewRow {
  teamId: number;
  teamName: TeamName;
  weekStart: string;
  totalPRs: number;
  prsWithChangesRequested: number;
  reReviewedPRs: number;
}

export interface ClaudeCodeRow {
  teamId: number;
  teamName: TeamName;
  activeUsers: number;
  totalSessions: number;
  commitsByClaude: number;
  prsByClaude: number;
  linesAdded: number;
}

// ---------------------------------------------------------------------------
// CSV parser — DX queryData returns CSV with header row
// ---------------------------------------------------------------------------

function parseCSV(raw: string): Record<string, string>[] {
  const lines = raw.trim().split('\n').filter(Boolean);
  if (lines.length < 2) return [];

  const headers = lines[0].split(', ').map((h) => h.trim());
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = splitCSVLine(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = (values[idx] ?? '').trim();
    });
    rows.push(row);
  }

  return rows;
}

function splitCSVLine(line: string): string[] {
  // Simple CSV splitter that handles quoted fields
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}
