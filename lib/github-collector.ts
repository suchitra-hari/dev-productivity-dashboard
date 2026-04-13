/**
 * Fetches merged PRs from GitHub for a set of team members in a given time window.
 *
 * Uses the `gh` CLI (must be authenticated) to list PRs, then fetches
 * commit messages for each PR so agentic-detector can scan them.
 */

import {execSync} from 'child_process';

import {type PRRecord, type TeamRoster, type WeekWindow} from './types';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns all merged PRs authored by team members within the given week window.
 * Rate-limiting: fetches commits for up to MAX_COMMITS_PER_PR commits per PR.
 */
export async function collectPRsForTeam(
  roster: TeamRoster,
  week: WeekWindow,
  opts: {owner?: string; repo?: string} = {}
): Promise<PRRecord[]> {
  const owner = opts.owner ?? 'webflow';
  const repo = opts.repo ?? 'webflow';

  const githubLogins = roster.members.map((m) => m.githubLogin).filter(Boolean);

  if (githubLogins.length === 0) {
    console.warn(
      `[github-collector] No GitHub logins resolved for team "${roster.teamName}" — skipping PR collection`
    );
    return [];
  }

  console.log(
    `[github-collector] Fetching PRs for ${roster.teamName} ` +
      `(${githubLogins.length} members) in ${week.label}...`
  );

  const allPRs: PRRecord[] = [];

  // GitHub search API has a limit on OR clauses; batch into groups of 20
  const BATCH_SIZE = 20;
  for (let i = 0; i < githubLogins.length; i += BATCH_SIZE) {
    const batch = githubLogins.slice(i, i + BATCH_SIZE);
    const prs = await fetchPRBatch(batch, week, owner, repo);
    allPRs.push(...prs);
  }

  // De-duplicate by PR number (a member might appear in multiple batches)
  const seen = new Set<number>();
  const dedupedPRs = allPRs.filter((pr) => {
    if (seen.has(pr.number)) return false;
    seen.add(pr.number);
    return true;
  });

  console.log(
    `[github-collector] Found ${dedupedPRs.length} merged PRs for ${roster.teamName} in ${week.label}`
  );
  return dedupedPRs;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface GHPRItem {
  number: number;
  title: string;
  author: {login: string};
  mergedAt: string;
  url: string;
  body: string;
}

async function fetchPRBatch(
  logins: string[],
  week: WeekWindow,
  owner: string,
  repo: string
): Promise<PRRecord[]> {
  // Build a search query:  repo:owner/repo is:pr is:merged merged:START..END author:A author:B ...
  // GitHub search API supports multiple author: clauses with OR semantics
  const authorClauses = logins.map((l) => `author:${l}`).join(' ');
  const query = `repo:${owner}/${repo} is:pr is:merged merged:${week.start}..${week.end} ${authorClauses}`;

  let raw: string;
  try {
    raw = execSync(
      `gh pr list --repo ${owner}/${repo} --state merged ` +
        `--search ${JSON.stringify(query)} ` +
        `--limit 200 ` +
        `--json number,title,author,mergedAt,url,body`,
      {encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe']}
    );
  } catch (err) {
    console.warn(`[github-collector] gh pr list failed: ${err}`);
    return [];
  }

  let items: GHPRItem[];
  try {
    items = JSON.parse(raw) as GHPRItem[];
  } catch {
    console.warn(
      `[github-collector] Failed to parse gh output: ${raw.slice(0, 200)}`
    );
    return [];
  }

  // Filter to only requested authors (gh search can be fuzzy)
  const loginSet = new Set(logins.map((l) => l.toLowerCase()));
  const filtered = items.filter((pr) =>
    loginSet.has(pr.author.login.toLowerCase())
  );

  // Fetch commit messages for each PR (needed for agentic Co-Authored-By detection)
  const results: PRRecord[] = [];
  for (const pr of filtered) {
    const commitMessages = fetchCommitMessages(pr.number, owner, repo);
    results.push({
      number: pr.number,
      title: pr.title,
      author: pr.author.login,
      mergedAt: pr.mergedAt,
      url: pr.url,
      bodySnippet: (pr.body ?? '').slice(0, 2000),
      commitMessages,
      hasAgenticCommit: false, // will be filled by agentic-detector
      hasAgenticBody: false,
      isAgentic: false,
    });
  }

  return results;
}

const MAX_COMMITS_PER_PR = 50;

function fetchCommitMessages(
  prNumber: number,
  owner: string,
  repo: string
): string[] {
  try {
    const raw = execSync(
      `gh pr view ${prNumber} --repo ${owner}/${repo} ` +
        `--json commits --jq '.commits[0:${MAX_COMMITS_PER_PR}][].messageHeadline + "\\n" + .commits[0:${MAX_COMMITS_PER_PR}][].messageBody'`,
      {encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe']}
    );
    return raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Week window builder
// ---------------------------------------------------------------------------

/**
 * Splits the last `numWeeks` × 7-day windows ending today into a list of
 * WeekWindow objects in chronological order (oldest first).
 */
export function buildWeekWindows(
  numWeeks: number,
  endDate?: Date
): WeekWindow[] {
  const end = endDate ?? new Date();
  const windows: WeekWindow[] = [];

  for (let w = numWeeks - 1; w >= 0; w--) {
    const windowEnd = new Date(end);
    windowEnd.setDate(end.getDate() - w * 7);

    const windowStart = new Date(windowEnd);
    windowStart.setDate(windowEnd.getDate() - 6);

    const startStr = toISODate(windowStart);
    const endStr = toISODate(windowEnd);
    const idx = numWeeks - w;

    windows.push({
      start: startStr,
      end: endStr,
      label: `W${idx} (${formatShort(windowStart)}–${formatShort(windowEnd)})`,
    });
  }

  return windows;
}

function toISODate(d: Date): string {
  return d.toISOString().split('T')[0];
}

function formatShort(d: Date): string {
  return d.toLocaleDateString('en-US', {month: 'short', day: 'numeric'});
}
