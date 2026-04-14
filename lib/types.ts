/**
 * Shared types for the Developer Productivity Report.
 *
 * Organized around DX's Core4:
 *   Speed        → PR throughput
 *   Effectiveness → DXI score
 *   Quality      → Defect Ratio
 *   Impact       → Innovation Ratio
 *
 * Plus extra signals: agentic adoption, re-review rate, CI failure rate.
 */

export type TeamName =
  | 'Design System'
  | 'Build Loop'
  | 'Delivery Loop'
  | 'Shared Services';

export const TEAM_NAMES: TeamName[] = [
  'Design System',
  'Build Loop',
  'Delivery Loop',
  'Shared Services',
];

export interface WeekWindow {
  /** Inclusive start, ISO date string */
  start: string;
  /** Inclusive end, ISO date string */
  end: string;
  /** Human-friendly label, e.g. "W1 (Mar 14–20)" */
  label: string;
}

export interface TeamMember {
  email: string;
  githubLogin: string;
  displayName: string;
}

export interface TeamRoster {
  teamName: TeamName;
  dxTeamId: string;
  members: TeamMember[];
}

// ---------------------------------------------------------------------------
// GitHub / PR signals
// ---------------------------------------------------------------------------

export interface PRRecord {
  number: number;
  title: string;
  author: string;
  mergedAt: string;
  url: string;
  bodySnippet: string;
  commitMessages: string[];
  /** Whether any commit has Co-Authored-By agentic signature */
  hasAgenticCommit: boolean;
  /** Whether PR body contains a reliable agentic signature */
  hasAgenticBody: boolean;
  /** True if both commit + body signals fire, or either fires as strong signal */
  isAgentic: boolean;
}

export type AgenticTier =
  | 'insufficient_data' // < 4 PRs in window — sample too small to classify
  | 'not_detected' // 0% agentic
  | 'exploring' // 1–29%
  | 'adopting' // 30–59%
  | 'full_agentic'; // 60%+

export const AGENTIC_TIER_LABELS: Record<AgenticTier, string> = {
  insufficient_data: 'Insufficient Data',
  not_detected: 'Not Detected',
  exploring: 'Exploring',
  adopting: 'Adopting',
  full_agentic: 'Full-Agentic',
};

/** Minimum PRs required in the window before a tier is assigned. */
export const MIN_PRS_FOR_CLASSIFICATION = 4;

export interface AgenticStats {
  total: number;
  agentic: number;
  agenticRate: number;
  /** 4-tier classification; replaces the old binary isFullAgentic */
  tier: AgenticTier;
  /** Backward-compat shorthand — true when tier === 'full_agentic' */
  isFullAgentic: boolean;
  /** Per-provider active user counts for the week (from DX warehouse) */
  providerBreakdown?: Record<string, number>;
}

export interface ReReviewStats {
  totalPRs: number;
  /** PRs that received at least one "changes_requested" then a subsequent re-review */
  reReviewedPRs: number;
  reReviewRate: number;
}

// ---------------------------------------------------------------------------
// Buildkite CI signals
// ---------------------------------------------------------------------------

export interface CIStats {
  totalBuilds: number;
  failedBuilds: number;
  failureRate: number;
}

// ---------------------------------------------------------------------------
// Jira signals
// ---------------------------------------------------------------------------

export interface JiraStats {
  totalIssuesClosed: number;
  bugsClosed: number;
  featuresClosed: number;
  /** bugs / total */
  defectRatio: number;
  /** features / total */
  innovationRatio: number;
}

// ---------------------------------------------------------------------------
// AI provider adoption signals (multi-tool: Cursor, Augment, Codex, etc.)
// ---------------------------------------------------------------------------

export interface AIProviderUsageRow {
  teamId: number;
  teamName: TeamName;
  weekStart: string;
  provider: 'cursor' | 'augment' | 'codex' | 'other';
  activeUsers: number;
  teamSize: number;
  adoptionPct: number;
  totalSessions: number;
}

// ---------------------------------------------------------------------------
// Epic agentic breakdown
// ---------------------------------------------------------------------------

export interface EpicAgenticRow {
  team: string;
  epicKey: string;
  epicSummary: string;
  epicStatus: string;
  totalPRs: number;
  agenticPRs: number;
  agenticPct: number;
  /** Median PR cycle time (open → merge) in hours */
  medianCycleHours: number;
}

// ---------------------------------------------------------------------------
// DX signals
// ---------------------------------------------------------------------------

export interface DXIScore {
  /** null if not available from DX data warehouse */
  score: number | null;
  label: string;
}

export interface Initiative {
  id: string;
  name: string;
  progressPercent: number | null;
  priority: number;
}

// ---------------------------------------------------------------------------
// Aggregated weekly snapshot per team
// ---------------------------------------------------------------------------

export interface WeeklyTeamSnapshot {
  teamName: TeamName;
  week: WeekWindow;
  memberCount: number;

  // Core4
  /** Speed: PRs merged this week */
  prsMerged: number;
  /** Speed: PRs per active engineer */
  prsPerPerson: number;
  /** Effectiveness: DXI score (null if unavailable) */
  dxiScore: number | null;
  /** Quality: defect ratio */
  defectRatio: number;
  /** Impact: innovation ratio */
  innovationRatio: number;

  // Extra signals
  agenticStats: AgenticStats;
  reReviewStats: ReReviewStats;
  ciStats: CIStats;

  /** PR numbers for drill-down */
  prNumbers: number[];
}

// ---------------------------------------------------------------------------
// Report-level aggregates
// ---------------------------------------------------------------------------

export interface TeamReport {
  teamName: TeamName;
  roster: TeamRoster;
  weeks: WeeklyTeamSnapshot[];
  /** Simple average of weekly defectRatio */
  avgDefectRatio: number;
  /** Simple average of weekly innovationRatio */
  avgInnovationRatio: number;
  /** Total PRs over the 30-day window */
  totalPRs: number;
  /** Agentic rate over the 30-day window */
  overallAgenticRate: number;
  /** CI failure rate averaged over weeks */
  avgCIFailureRate: number;
  /** DX initiatives with progress */
  initiatives: Initiative[];
}

export interface ProductivityReport {
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  weeks: WeekWindow[];
  teams: TeamReport[];
}
