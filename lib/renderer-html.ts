/**
 * HTML dashboard renderer.
 *
 * Reads dashboard/index.html as a template and replaces the marked data block
 * (<!-- DATA_START --> … <!-- DATA_END -->) and metadata strings with fresh
 * values derived from a live ProductivityReport.
 *
 * Usage:
 *   import {renderHTML} from './lib/renderer-html';
 *   const html = renderHTML(report);
 *   writeFileSync('dashboard/index.html', html);
 *
 * Or via CLI:
 *   ./report.ts --html --output dashboard/index.html
 */

import {readFileSync} from 'fs';
import {join} from 'path';

import {type ProductivityReport, type TeamName, TEAM_NAMES} from './types';

const TEMPLATE_PATH = join(__dirname, '../dashboard/index.html');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function renderHTML(
  report: ProductivityReport,
  templatePath = TEMPLATE_PATH
): string {
  let html = readFileSync(templatePath, 'utf-8');

  // Replace window metadata string
  const windowStr = buildWindowString(report);
  html = html.replace(
    /<!-- META_WINDOW_START -->[\s\S]*?<!-- META_WINDOW_END -->/,
    `<!-- META_WINDOW_START -->${windowStr}<!-- META_WINDOW_END -->`
  );

  // Replace generated-at string
  const generatedStr = buildGeneratedString(report.generatedAt);
  html = html.replace(
    /<!-- META_GENERATED_START -->[\s\S]*?<!-- META_GENERATED_END -->/,
    `<!-- META_GENERATED_START -->${generatedStr}<!-- META_GENERATED_END -->`
  );

  // Replace the data block
  const dataBlock = buildDataBlock(report);
  html = html.replace(
    /<!-- DATA_START -->[\s\S]*?<!-- DATA_END -->/,
    `<!-- DATA_START -->\n${dataBlock}\n      <!-- DATA_END -->`
  );

  return html;
}

// ---------------------------------------------------------------------------
// Data block builder
// ---------------------------------------------------------------------------

function buildDataBlock(report: ProductivityReport): string {
  const weekLabels = report.weeks.map(shortWeekLabel);

  const prsMerged = buildTeamWeekMap(report, (snap) => snap.prsMerged);
  const prsPerPerson = buildTeamWeekMap(report, (snap) =>
    parseFloat(snap.prsPerPerson.toFixed(1))
  );
  const agentReqs = buildTeamWeekMap(report, (snap) => {
    const meta = snap.agenticStats as Record<string, unknown>;
    return typeof meta['_agentRequests'] === 'number' ? meta['_agentRequests'] : 0;
  });

  const adoptionData = buildAdoptionData(report);
  const innovationPct = buildTeamWeekMap(report, (snap) =>
    parseFloat((snap.innovationRatio * 100).toFixed(1))
  );
  const reReviewRate = buildTeamWeekMap(report, (snap) =>
    parseFloat((snap.reReviewStats.reReviewRate * 100).toFixed(1))
  );
  const speedTable = buildSpeedTable(report);

  return [
    `      const TEAMS = ${JSON.stringify(TEAM_NAMES, null, 8).replace(/\n/g, '\n      ')};`,
    `      const COLORS = ['#4f8ef7', '#34d399', '#a78bfa', '#22d3ee', '#fbbf24'];`,
    `      const WEEKS = ${JSON.stringify(weekLabels)};`,
    ``,
    `      // ── Data ─────────────────────────────────────────────────────────────────────`,
    ``,
    `      const prsMerged = ${serializeTeamMap(prsMerged)};`,
    ``,
    `      const prsPerPerson = ${serializeTeamMap(prsPerPerson)};`,
    ``,
    `      const agentReqs = ${serializeTeamMap(agentReqs)};`,
    ``,
    `      const adoptionData = ${JSON.stringify(adoptionData, null, 8).replace(/\n/g, '\n      ')};`,
    ``,
    `      const innovationPct = ${serializeTeamMap(innovationPct)};`,
    ``,
    `      const reReviewRate = ${serializeTeamMap(reReviewRate)};`,
    ``,
    `      const speedTable = ${JSON.stringify(speedTable, null, 8).replace(/\n/g, '\n      ')};`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Per-team week map
// ---------------------------------------------------------------------------

type WeeklySnapshot = ProductivityReport['teams'][number]['weeks'][number];

function buildTeamWeekMap(
  report: ProductivityReport,
  extract: (snap: WeeklySnapshot) => number
): Record<TeamName, number[]> {
  const result = {} as Record<TeamName, number[]>;
  for (const teamReport of report.teams) {
    result[teamReport.teamName] = report.weeks.map((week) => {
      const snap = teamReport.weeks.find((w) => w.week.start === week.start);
      return snap ? extract(snap) : 0;
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Adoption data
// ---------------------------------------------------------------------------

function buildAdoptionData(report: ProductivityReport): AdoptionEntry[] {
  return report.teams.map((teamReport) => {
    const lastSnap = teamReport.weeks[teamReport.weeks.length - 1];
    const meta = (lastSnap?.agenticStats ?? {}) as Record<string, unknown>;
    const teamSize =
      lastSnap?.memberCount ??
      Math.max(...teamReport.weeks.map((w) => w.memberCount), 0);

    const cursorUsers =
      typeof meta['_cursorActiveUsers'] === 'number'
        ? meta['_cursorActiveUsers']
        : 0;

    const agentReqsByWeek = report.weeks.map((week) => {
      const snap = teamReport.weeks.find((w) => w.week.start === week.start);
      const m = (snap?.agenticStats ?? {}) as Record<string, unknown>;
      return typeof m['_agentRequests'] === 'number' ? m['_agentRequests'] : 0;
    });

    const totalAgentReqs = agentReqsByWeek.reduce((s, n) => s + n, 0);
    const overallPct = Math.round(teamReport.overallAgenticRate * 100);

    return {
      team: teamReport.teamName,
      size: teamSize,
      users: cursorUsers,
      pct: overallPct,
      total: totalAgentReqs,
      w: agentReqsByWeek,
      status: agenticBadge(teamReport.overallAgenticRate),
    };
  });
}

interface AdoptionEntry {
  team: string;
  size: number;
  users: number;
  pct: number;
  total: number;
  w: number[];
  status: string;
}

// ---------------------------------------------------------------------------
// Speed table
// ---------------------------------------------------------------------------

function buildSpeedTable(report: ProductivityReport): SpeedEntry[] {
  return report.teams.map((teamReport) => {
    const data = report.weeks.map((week) => {
      const snap = teamReport.weeks.find((w) => w.week.start === week.start);
      return [snap?.prsMerged ?? 0, parseFloat((snap?.prsPerPerson ?? 0).toFixed(1))] as [
        number,
        number,
      ];
    });

    const firstPpp = data[0]?.[1] ?? 0;
    const lastPpp = data[data.length - 1]?.[1] ?? 0;

    let trendStr: string;
    if (lastPpp > firstPpp * 1.1) trendStr = '↑ Rising';
    else if (lastPpp < firstPpp * 0.9) trendStr = '↓ Falling';
    else trendStr = '→ Stable';

    return {
      team: teamReport.teamName,
      data,
      total: teamReport.totalPRs,
      trend: trendStr,
    };
  });
}

interface SpeedEntry {
  team: string;
  data: [number, number][];
  total: number;
  trend: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function agenticBadge(rate: number): string {
  if (rate >= 0.5) return '🟢 Full-Agentic';
  if (rate >= 0.25) return '🟡 Adopting';
  if (rate > 0) return '🔵 Early';
  return '⚪ Not Detected';
}

/** Converts a WeekWindow label like "W1 (Mar 14–Mar 20)" → "W1 Mar 14" */
function shortWeekLabel(week: {label: string}): string {
  const match = week.label.match(/W(\d+)\s*\(([A-Z][a-z]+ \d+)/);
  return match ? `W${match[1]} ${match[2]}` : week.label;
}

function buildWindowString(report: ProductivityReport): string {
  const start = formatDate(report.windowStart);
  const end = formatDate(report.windowEnd);
  const days = report.weeks.length * 7;
  return `${start} – ${end} · ${days} days · ${report.weeks.length} weekly windows`;
}

function buildGeneratedString(generatedAt: string): string {
  const d = new Date(generatedAt);
  return `Generated ${d.toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric'})}`;
}

function formatDate(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00');
  return d.toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric'});
}

function serializeTeamMap(map: Record<string, number[]>): string {
  const entries = Object.entries(map)
    .map(([team, vals]) => `        '${team}': ${JSON.stringify(vals)}`)
    .join(',\n');
  return `{\n${entries},\n      }`;
}
