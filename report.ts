#!/usr/bin/env -S node -r @packages/untyped/swchook

/**
 * Developer Productivity Report
 *
 * Generates a weekly-chunked productivity report for the Developer Productivity
 * pillar (Design System, Build Loop, Agent Loop, Delivery Loop, Shared Services).
 *
 * Organized around DX's Core4:
 *   Speed        — PR throughput (PRs merged, PRs/person/week)
 *   Effectiveness — DXI score from DX survey snapshots
 *   Quality      — Defect Ratio (bugs / total Jira issues closed)
 *   Impact       — Innovation Ratio (features / total Jira issues closed)
 *
 * Plus extra signals:
 *   Adoption  — Cursor Agent adoption % (proxy for agentic coding)
 *   Quality+  — Re-review rates, CI failure rates
 *
 * Data sources:
 *   DX MCP (user-dx-mcp) — queryData for warehouse SQL
 *   Buildkite MCP (project-0-webflow-buildkite) — list_builds for CI stats
 *   gh CLI — PR commits for agentic detection (supplement to Cursor data)
 *
 * Usage:
 *   ./report.ts                         # last 28 days, 4 weeks, stdout
 *   ./report.ts --output report.md      # write to file
 *   ./report.ts --weeks 4               # number of weekly windows
 *   ./report.ts --start 2026-03-14      # custom start date
 *   ./report.ts --json                  # output raw JSON instead of markdown
 *
 * Environment:
 *   DX_MCP_SERVER    — DX MCP server name (default: user-dx-mcp)
 *   BUILDKITE_ORG    — Buildkite org slug (default: webflow)
 *
 * This script is designed to be run via the Cursor agent which has MCP
 * access, or standalone with a DX database connection.
 */

import {writeFileSync} from 'fs';

import yargs = require('yargs');

import {aggregate, type AggregatorInput} from './lib/aggregator';
import {collectCIStats, type BuildkiteCaller} from './lib/buildkite-collector';
import {
  DX_TEAM_DISPLAY_NAMES,
  fetchCore4Scores,
  fetchWeeklyAIProviderUsage,
  fetchWeeklyCursorUsage,
  fetchWeeklyJiraStats,
  fetchWeeklyPRThroughput,
  fetchWeeklyReReviewRates,
  type DXWarehouseCaller,
} from './lib/dx-metrics';
import {buildWeekWindows} from './lib/github-collector';
import {renderReport} from './lib/renderer';
import {
  type CIStats,
  type TeamName,
  type TeamRoster,
  TEAM_NAMES,
} from './lib/types';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const argv = yargs
  .option('weeks', {
    alias: 'w',
    type: 'number',
    default: 4,
    description: 'Number of weekly windows to report on',
  })
  .option('start', {
    alias: 's',
    type: 'string',
    description: 'Start date (YYYY-MM-DD). Defaults to 28 days ago.',
  })
  .option('output', {
    alias: 'o',
    type: 'string',
    description: 'Write report to this file instead of stdout',
  })
  .option('json', {
    alias: 'j',
    type: 'boolean',
    default: false,
    description: 'Output raw JSON data instead of markdown',
  })
  .option('skip-ci', {
    type: 'boolean',
    default: false,
    description: 'Skip Buildkite CI stats collection (faster)',
  })
  .option('buildkite-org', {
    type: 'string',
    default: 'webflow',
    description: 'Buildkite organization slug',
  })
  .help()
  .alias('help', 'h').argv as {
  weeks: number;
  start?: string;
  output?: string;
  json: boolean;
  'skip-ci': boolean;
  'buildkite-org': string;
};

// ---------------------------------------------------------------------------
// MCP caller implementations
// ---------------------------------------------------------------------------

/**
 * DX warehouse caller that uses the user-dx-mcp MCP server via Cursor's
 * MCP bridge. When run standalone (outside Cursor), this requires the MCP
 * SDK to be set up with a connection to the DX server.
 *
 * For direct PostgreSQL access, replace `queryViaMCP` with a pg.Pool query.
 */
function createDXCaller(): DXWarehouseCaller {
  // In Cursor agent context, the MCP tools are called via the agent runtime.
  // Outside that context, we check for a DX_DATABASE_URL environment variable
  // and fall back to throwing an informative error.
  return {
    async queryData(sql: string): Promise<string> {
      // Try environment-provided PostgreSQL connection first
      const dbUrl = process.env['DX_DATABASE_URL'];
      if (dbUrl) {
        return queryPostgres(dbUrl, sql);
      }

      // Otherwise print guidance (in agent mode, this is called by the agent directly)
      throw new Error(
        'DX_DATABASE_URL not set. When running standalone, provide a ' +
          'PostgreSQL connection string to the DX data warehouse. ' +
          'In Cursor agent mode, the agent calls MCP tools directly.'
      );
    },
  };
}

async function queryPostgres(
  connectionString: string,
  sql: string
): Promise<string> {
  // Dynamic import to avoid requiring pg when not needed
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {Client} = require('pg') as typeof import('pg');
  const client = new Client({connectionString});
  await client.connect();
  try {
    const result = await client.query(sql);
    if (result.rows.length === 0) return '';
    const headers = Object.keys(result.rows[0]).join(', ');
    const rows = result.rows.map((r) => Object.values(r).join(', ')).join('\n');
    return `${headers}\n${rows}`;
  } finally {
    await client.end();
  }
}

function createBuildkiteCaller(orgSlug: string): BuildkiteCaller {
  return {
    async listBuilds(args) {
      // Buildkite API via environment token
      const token = process.env['BUILDKITE_API_TOKEN'];
      if (!token) {
        console.warn(
          '[buildkite] BUILDKITE_API_TOKEN not set — CI stats will be empty'
        );
        return [];
      }
      const qs = new URLSearchParams({
        page: String(args.page ?? 1),
        per_page: String(args.per_page ?? 100),
        ...(args.state ? {state: args.state} : {}),
      });
      const pipelinePart = args.pipeline_slug
        ? `/pipelines/${args.pipeline_slug}`
        : '';
      const url = `https://api.buildkite.com/v2/organizations/${orgSlug}${pipelinePart}/builds?${qs}`;
      const res = await fetch(url, {
        headers: {Authorization: `Bearer ${token}`},
      });
      if (!res.ok) {
        console.warn(
          `[buildkite] API error ${res.status}: ${await res.text()}`
        );
        return [];
      }
      return res.json() as Promise<unknown>;
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const numWeeks = argv.weeks;

  // Build week windows
  const endDate = new Date();
  let startDate: Date;

  if (argv.start) {
    startDate = new Date(argv.start);
  } else {
    startDate = new Date(endDate);
    startDate.setDate(endDate.getDate() - numWeeks * 7);
  }

  const weeks = buildWeekWindows(numWeeks, endDate);
  const windowStart = weeks[0].start;
  const windowEnd = weeks[weeks.length - 1].end;

  console.log(
    `[report] Generating ${numWeeks}-week report: ${windowStart} → ${windowEnd}`
  );
  console.log(`[report] Teams: ${TEAM_NAMES.join(', ')}`);

  const dxCaller = createDXCaller();

  // ---------------------------------------------------------------------------
  // Collect all signals in parallel
  // ---------------------------------------------------------------------------

  console.log('[report] Fetching Core4 DXI scores...');
  const [
    core4Scores,
    prThroughput,
    cursorUsage,
    jiraStats,
    reReviewRates,
    aiProviderUsage,
  ] = await Promise.all([
    fetchCore4Scores(dxCaller),
    fetchWeeklyPRThroughput(dxCaller, windowStart, windowEnd),
    fetchWeeklyCursorUsage(dxCaller, windowStart, windowEnd),
    fetchWeeklyJiraStats(dxCaller, windowStart, windowEnd),
    fetchWeeklyReReviewRates(dxCaller, windowStart, windowEnd),
    fetchWeeklyAIProviderUsage(dxCaller, windowStart, windowEnd).catch(
      () => []
    ),
  ]);

  console.log(
    `[report] PR rows: ${prThroughput.length}, Cursor rows: ${cursorUsage.length}, ` +
      `AI provider rows: ${aiProviderUsage.length}, Jira rows: ${jiraStats.length}`
  );

  // Remap DX team names to pillar names in collected rows
  remapTeamNames(prThroughput);
  remapTeamNames(cursorUsage);
  remapTeamNames(jiraStats);
  remapTeamNames(reReviewRates);

  // ---------------------------------------------------------------------------
  // Buildkite CI stats
  // ---------------------------------------------------------------------------

  const ciStats = new Map<TeamName, Map<string, CIStats>>();

  if (!argv['skip-ci']) {
    console.log('[report] Fetching Buildkite CI stats...');
    const buildkiteCaller = createBuildkiteCaller(argv['buildkite-org']);
    for (const week of weeks) {
      try {
        const weekCI = await collectCIStats(
          buildkiteCaller,
          week,
          argv['buildkite-org']
        );
        for (const [team, stats] of weekCI) {
          if (!ciStats.has(team)) ciStats.set(team, new Map());
          ciStats.get(team)!.set(week.start, stats);
        }
      } catch (err) {
        console.warn(`[report] CI stats failed for ${week.label}: ${err}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Build synthetic rosters from DX team metadata
  // ---------------------------------------------------------------------------

  const rosters: TeamRoster[] = TEAM_NAMES.map((teamName) => ({
    teamName,
    dxTeamId: String(
      Object.entries(DX_TEAM_DISPLAY_NAMES).find(
        ([, v]) => v === teamName
      )?.[0] ?? ''
    ),
    members: [],
  }));

  // ---------------------------------------------------------------------------
  // Aggregate and render
  // ---------------------------------------------------------------------------

  const input: AggregatorInput = {
    weeks,
    rosters,
    prThroughput,
    cursorUsage,
    aiProviderUsage,
    jiraStats,
    reReviewRates,
    core4Scores,
    ciStats,
    initiatives: [],
  };

  const report = aggregate(input);

  let output: string;
  if (argv.json) {
    output = JSON.stringify(report, null, 2);
  } else {
    output = renderReport(report);
  }

  if (argv.output) {
    writeFileSync(argv.output, output, 'utf-8');
    console.log(`[report] Written to ${argv.output}`);
  } else {
    console.log('\n' + output);
  }
}

// ---------------------------------------------------------------------------
// Team name remapper
// ---------------------------------------------------------------------------

function remapTeamNames(rows: Array<{teamName: string}>): void {
  for (const row of rows) {
    // DX warehouse uses "Spring Design System" → remap to "Design System"
    // "Developer Platform" → "Agent Loop"
    if (row.teamName === 'Spring Design System') row.teamName = 'Design System';
    if (row.teamName === 'Developer Platform') row.teamName = 'Agent Loop';
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error('[report] Fatal error:', err);
  process.exit(1);
});
