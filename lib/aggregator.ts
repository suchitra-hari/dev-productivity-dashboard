/**
 * Aggregates all collected signals into a unified ProductivityReport.
 *
 * Joins:
 *   - PR throughput (from DX warehouse github_pulls)
 *   - Cursor agentic usage (cursor_daily_user_metrics)
 *   - Jira defect/innovation ratios (jira_issues)
 *   - Re-review rates (github_reviews)
 *   - Core4 DX snapshot scores
 *   - CI failure rates (Buildkite)
 */

import {
  type CursorUsageRow,
  type JiraStatsRow,
  type PRThroughputRow,
  type ReReviewRow,
} from './dx-metrics';
import {
  type AgenticStats,
  type CIStats,
  type DXIScore,
  type Initiative,
  type ProductivityReport,
  type ReReviewStats,
  type TeamName,
  type TeamReport,
  type TeamRoster,
  type WeekWindow,
  type WeeklyTeamSnapshot,
  TEAM_NAMES,
} from './types';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface AggregatorInput {
  weeks: WeekWindow[];
  rosters: TeamRoster[];
  prThroughput: PRThroughputRow[];
  cursorUsage: CursorUsageRow[];
  jiraStats: JiraStatsRow[];
  reReviewRates: ReReviewRow[];
  core4Scores: Map<TeamName, Record<string, DXIScore>>;
  ciStats: Map<TeamName, Map<string, CIStats>>;
  initiatives: Initiative[];
}

export function aggregate(input: AggregatorInput): ProductivityReport {
  const {
    weeks,
    rosters,
    prThroughput,
    cursorUsage,
    jiraStats,
    reReviewRates,
    core4Scores,
    ciStats,
    initiatives,
  } = input;

  const windowStart = weeks[0]?.start ?? '';
  const windowEnd = weeks[weeks.length - 1]?.end ?? '';

  const teams: TeamReport[] = [];

  for (const teamName of TEAM_NAMES) {
    const roster = rosters.find((r) => r.teamName === teamName) ?? {
      teamName,
      dxTeamId: '',
      members: [],
    };

    const weekSnapshots = buildWeekSnapshots(teamName, weeks, {
      prThroughput,
      cursorUsage,
      jiraStats,
      reReviewRates,
      core4Scores,
      ciStats,
    });

    const totalPRs = weekSnapshots.reduce((s, w) => s + w.prsMerged, 0);
    const totalAgenticPRs = weekSnapshots.reduce(
      (s, w) => s + w.agenticStats.agentic,
      0
    );
    const totalPRsForRate = weekSnapshots.reduce(
      (s, w) => s + w.agenticStats.total,
      0
    );
    const avgDefectRatio =
      weekSnapshots.reduce((s, w) => s + w.defectRatio, 0) /
      Math.max(weekSnapshots.length, 1);
    const avgInnovationRatio =
      weekSnapshots.reduce((s, w) => s + w.innovationRatio, 0) /
      Math.max(weekSnapshots.length, 1);
    const avgCIFailureRate =
      weekSnapshots.reduce((s, w) => s + w.ciStats.failureRate, 0) /
      Math.max(weekSnapshots.length, 1);

    teams.push({
      teamName,
      roster,
      weeks: weekSnapshots,
      avgDefectRatio,
      avgInnovationRatio,
      totalPRs,
      overallAgenticRate:
        totalPRsForRate > 0 ? totalAgenticPRs / totalPRsForRate : 0,
      avgCIFailureRate,
      initiatives,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    windowStart,
    windowEnd,
    weeks,
    teams,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface SignalData {
  prThroughput: PRThroughputRow[];
  cursorUsage: CursorUsageRow[];
  jiraStats: JiraStatsRow[];
  reReviewRates: ReReviewRow[];
  core4Scores: Map<TeamName, Record<string, DXIScore>>;
  ciStats: Map<TeamName, Map<string, CIStats>>;
}

function buildWeekSnapshots(
  teamName: TeamName,
  weeks: WeekWindow[],
  signals: SignalData
): WeeklyTeamSnapshot[] {
  return weeks.map((week) => {
    const pr = findPRRow(signals.prThroughput, teamName, week.start);
    const cursor = findCursorRow(signals.cursorUsage, teamName, week.start);
    const jira = findJiraRow(signals.jiraStats, teamName, week.start);
    const review = findReReviewRow(signals.reReviewRates, teamName, week.start);
    const core4 = signals.core4Scores.get(teamName) ?? {};
    const teamCI = signals.ciStats.get(teamName);
    const ciRow = teamCI?.get(week.start);

    const memberCount = cursor?.teamSize ?? 0;
    const prsMerged = pr?.prsMerged ?? 0;
    const activeAuthors = pr?.activeAuthors ?? 0;
    const prsPerPerson = pr?.prsPerPerson ?? 0;

    // Agentic stats from Cursor usage
    const cursorActiveUsers = cursor?.cursorActiveUsers ?? 0;
    const agentRequests = cursor?.agentRequests ?? 0;
    const adoptionPct = cursor?.adoptionPct ?? 0;

    const agenticStats: AgenticStats = {
      total: prsMerged,
      // Proxy: if any team member used agent mode in this week, count prs proportionally
      agentic: Math.round((adoptionPct / 100) * prsMerged),
      agenticRate: adoptionPct / 100,
      isFullAgentic: adoptionPct > 50,
    };

    const reReviewStats: ReReviewStats = {
      totalPRs: review?.totalPRs ?? prsMerged,
      reReviewedPRs: review?.reReviewedPRs ?? 0,
      reReviewRate:
        (review?.totalPRs ?? 0) > 0
          ? (review?.reReviewedPRs ?? 0) / (review?.totalPRs ?? 1)
          : 0,
    };

    const ciStatsForWeek: CIStats = ciRow ?? {
      totalBuilds: 0,
      failedBuilds: 0,
      failureRate: 0,
    };

    // Core4 — DXI comes from survey snapshot; Speed from PR throughput
    const dxiScore = core4['Effectiveness']?.score ?? null;
    const defectRatio = (jira?.defectRatioPct ?? 0) / 100;
    const innovationRatio = (jira?.innovationRatioPct ?? 0) / 100;

    return {
      teamName,
      week,
      memberCount,
      prsMerged,
      prsPerPerson,
      dxiScore,
      defectRatio,
      innovationRatio,
      agenticStats: {
        ...agenticStats,
        // Add cursor context as extra metadata for renderer
        _cursorActiveUsers: cursorActiveUsers,
        _agentRequests: agentRequests,
        _adoptionPct: adoptionPct,
      } as AgenticStats & Record<string, unknown>,
      reReviewStats,
      ciStats: ciStatsForWeek,
      prNumbers: [],
    };
  });
}

function weekStartMatches(rowWeekStart: string, windowStart: string): boolean {
  // DX returns week starts with +00:00 timezone; strip it
  const normalized = rowWeekStart.replace(/\+.*$/, '').split('T')[0];
  return normalized === windowStart || rowWeekStart.startsWith(windowStart);
}

function findPRRow(
  rows: PRThroughputRow[],
  teamName: TeamName,
  weekStart: string
): PRThroughputRow | undefined {
  return rows.find(
    (r) => r.teamName === teamName && weekStartMatches(r.weekStart, weekStart)
  );
}

function findCursorRow(
  rows: CursorUsageRow[],
  teamName: TeamName,
  weekStart: string
): CursorUsageRow | undefined {
  return rows.find(
    (r) => r.teamName === teamName && weekStartMatches(r.weekStart, weekStart)
  );
}

function findJiraRow(
  rows: JiraStatsRow[],
  teamName: TeamName,
  weekStart: string
): JiraStatsRow | undefined {
  return rows.find(
    (r) => r.teamName === teamName && weekStartMatches(r.weekStart, weekStart)
  );
}

function findReReviewRow(
  rows: ReReviewRow[],
  teamName: TeamName,
  weekStart: string
): ReReviewRow | undefined {
  return rows.find(
    (r) => r.teamName === teamName && weekStartMatches(r.weekStart, weekStart)
  );
}
