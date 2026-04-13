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

import {type DXIScore, type Initiative, type TeamName} from './types';

// Pillar team ID map — verified from DX `dx_teams` table
export const DX_TEAM_IDS: Record<string, number> = {
  'Build Loop': 50,
  'Delivery Loop': 23,
  'Agent Loop': 21, // "Developer Platform" in DX
  'Shared Services': 3,
  'Design System': 58, // "Spring Design System" in DX
};

// Reverse map for rendering
export const DX_TEAM_DISPLAY_NAMES: Record<number, string> = {
  50: 'Build Loop',
  23: 'Delivery Loop',
  21: 'Agent Loop',
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
