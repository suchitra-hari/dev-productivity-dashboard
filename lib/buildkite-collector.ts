/**
 * Collects CI build pass/fail statistics from Buildkite.
 *
 * Pipeline → team mapping is heuristic-based: pipeline slugs and names are
 * matched against known team keywords. Pipelines with no match are bucketed
 * under "Unknown" and excluded from team-level metrics.
 *
 * Uses the Buildkite MCP tool `list_builds` via the provided caller interface.
 */

import {type CIStats, type TeamName, type WeekWindow} from './types';

// ---------------------------------------------------------------------------
// Pipeline → team keyword mapping
// Extend this map as pipelines are renamed or new ones are added.
// ---------------------------------------------------------------------------

const PIPELINE_TEAM_MAP: Record<string, TeamName> = {
  // Design System
  spring: 'Design System',
  'design-system': 'Design System',
  storybook: 'Design System',
  component: 'Design System',

  // Build Loop
  'build-loop': 'Build Loop',
  'build-check': 'Build Loop',
  webpack: 'Build Loop',
  'ci-build': 'Build Loop',
  'nx-build': 'Build Loop',
  typescript: 'Build Loop',

  // Agent Loop
  'agent-loop': 'Agent Loop',
  'risk-assessment': 'Agent Loop',
  'ai-describe': 'Agent Loop',
  'pr-description': 'Agent Loop',
  aia: 'Agent Loop',

  // Delivery Loop
  'delivery-loop': 'Delivery Loop',
  deploy: 'Delivery Loop',
  release: 'Delivery Loop',
  canary: 'Delivery Loop',
  rollout: 'Delivery Loop',

  // Shared Services
  'shared-services': 'Shared Services',
  infrastructure: 'Shared Services',
  platform: 'Shared Services',
  monitoring: 'Shared Services',
  observability: 'Shared Services',
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BuildkiteCaller {
  listBuilds(args: {
    org_slug: string;
    pipeline_slug?: string;
    state?: string;
    page?: number;
    per_page?: number;
  }): Promise<unknown>;
}

/**
 * Fetches build stats per team for the given week window.
 * Returns a map of TeamName → CIStats.
 */
export async function collectCIStats(
  caller: BuildkiteCaller,
  week: WeekWindow,
  orgSlug: string = 'webflow'
): Promise<Map<TeamName, CIStats>> {
  console.log(`[buildkite-collector] Collecting CI stats for ${week.label}...`);

  // Fetch builds across all pipelines (paginated)
  const allBuilds = await fetchAllBuilds(caller, orgSlug, week);

  console.log(
    `[buildkite-collector] Total builds fetched: ${allBuilds.length}`
  );

  // Group by team
  const teamStats = new Map<TeamName, {total: number; failed: number}>();

  for (const build of allBuilds) {
    const team = classifyBuild(build);
    if (!team) continue;

    const current = teamStats.get(team) ?? {total: 0, failed: 0};
    current.total++;
    if (isFailed(build)) current.failed++;
    teamStats.set(team, current);
  }

  // Convert to CIStats
  const result = new Map<TeamName, CIStats>();
  for (const [team, stats] of teamStats) {
    result.set(team, {
      totalBuilds: stats.total,
      failedBuilds: stats.failed,
      failureRate: stats.total > 0 ? stats.failed / stats.total : 0,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface BuildRecord {
  state: string;
  pipeline?: {slug?: string; name?: string};
  pipeline_slug?: string;
  pipeline_name?: string;
  created_at?: string;
  finished_at?: string;
}

async function fetchAllBuilds(
  caller: BuildkiteCaller,
  orgSlug: string,
  week: WeekWindow
): Promise<BuildRecord[]> {
  const allBuilds: BuildRecord[] = [];
  const PER_PAGE = 100;
  let page = 1;
  const MAX_PAGES = 20; // safety cap

  while (page <= MAX_PAGES) {
    let raw: unknown;
    try {
      raw = await caller.listBuilds({
        org_slug: orgSlug,
        per_page: PER_PAGE,
        page,
      });
    } catch (err) {
      console.warn(
        `[buildkite-collector] listBuilds failed on page ${page}: ${err}`
      );
      break;
    }

    const builds = extractBuilds(raw);
    if (builds.length === 0) break;

    // Filter to the week window using created_at
    const weekBuilds = builds.filter((b) =>
      isInWindow(b.created_at ?? b.finished_at ?? '', week)
    );

    allBuilds.push(...weekBuilds);

    // If we got fewer results than requested, no more pages
    if (builds.length < PER_PAGE) break;

    // If the oldest build on this page is before our window start, stop
    const oldest = builds[builds.length - 1];
    if (oldest.created_at && oldest.created_at < week.start) break;

    page++;
  }

  return allBuilds;
}

function extractBuilds(raw: unknown): BuildRecord[] {
  if (Array.isArray(raw)) return raw as BuildRecord[];
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const inner = obj['builds'] ?? obj['data'] ?? obj['result'];
    if (Array.isArray(inner)) return inner as BuildRecord[];
    // DX MCP wraps in { result: "..." }
    if (typeof inner === 'string') {
      try {
        const parsed = JSON.parse(inner);
        if (Array.isArray(parsed)) return parsed as BuildRecord[];
      } catch {
        // ignore
      }
    }
  }
  return [];
}

function isInWindow(dateStr: string, week: WeekWindow): boolean {
  if (!dateStr) return false;
  const date = dateStr.split('T')[0];
  return date >= week.start && date <= week.end;
}

function isFailed(build: BuildRecord): boolean {
  const state = (build.state ?? '').toLowerCase();
  return state === 'failed' || state === 'canceled' || state === 'timed_out';
}

function classifyBuild(build: BuildRecord): TeamName | null {
  const slug = (
    build.pipeline?.slug ??
    build.pipeline_slug ??
    ''
  ).toLowerCase();

  const name = (
    build.pipeline?.name ??
    build.pipeline_name ??
    ''
  ).toLowerCase();

  const combined = `${slug} ${name}`;

  for (const [keyword, team] of Object.entries(PIPELINE_TEAM_MAP)) {
    if (combined.includes(keyword)) {
      return team;
    }
  }

  return null;
}
