/**
 * Renders the ProductivityReport as a structured markdown document.
 *
 * Structure:
 *   # Developer Productivity Report — [date range]
 *   ## Executive Summary       (Core4 table + agentic adoption)
 *   ## Week-by-Week Breakdown  (4 weekly sections)
 *     ### W1 / W2 / W3 / W4
 *       Per-team Core4 table
 *       Agentic adoption signal
 *       Quality signal (re-review + CI)
 *   ## 30-Day Rollup           (aggregate per-team)
 *   ## Notes & Methodology
 */

import {computeTier} from './agentic-detector';
import {
  AGENTIC_TIER_LABELS,
  type AgenticTier,
  type ProductivityReport,
  type TeamName,
  type TeamReport,
  type WeeklyTeamSnapshot,
} from './types';

// ---------------------------------------------------------------------------
// Trend arrows
// ---------------------------------------------------------------------------

function trend(value: number, prev?: number): string {
  if (prev === undefined) return '';
  if (value > prev) return ' ↑';
  if (value < prev) return ' ↓';
  return ' →';
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function pct(v: number, decimals = 1): string {
  return `${(v * 100).toFixed(decimals)}%`;
}

function num(v: number, decimals = 1): string {
  return v.toFixed(decimals);
}

function agenticBadge(tier: AgenticTier): string {
  const icons: Record<AgenticTier, string> = {
    insufficient_data: '⚫',
    not_detected: '⚪',
    exploring: '🔵',
    adopting: '🟡',
    full_agentic: '🟢',
  };
  return `${icons[tier]} ${AGENTIC_TIER_LABELS[tier]}`;
}

// ---------------------------------------------------------------------------
// Main render function
// ---------------------------------------------------------------------------

export function renderReport(report: ProductivityReport): string {
  const lines: string[] = [];
  const {weeks, teams, windowStart, windowEnd, generatedAt} = report;

  const fmtDate = (d: string) =>
    new Date(d).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });

  lines.push(`# Developer Productivity Report`);
  lines.push(`**Period:** ${fmtDate(windowStart)} – ${fmtDate(windowEnd)}  `);
  lines.push(
    `**Generated:** ${new Date(generatedAt).toLocaleString('en-US', {timeZone: 'America/Los_Angeles'})} PT  `
  );
  lines.push(
    `**Teams:** Design System · Build Loop · Agent Loop · Delivery Loop · Shared Services  `
  );
  lines.push(
    `**Source:** DX Data Warehouse · GitHub · Jira · Cursor usage metrics`
  );
  lines.push('');

  lines.push('---');
  lines.push('');

  // -------------------------------------------------------------------------
  // Executive Summary
  // -------------------------------------------------------------------------
  lines.push('## Executive Summary — 30-Day Core4');
  lines.push('');
  lines.push(
    '> Core4 DXI scores are from the most recent DX survey snapshot (Jan 2026). '
  );
  lines.push(
    '> Speed, Quality, and Impact are computed weekly from live warehouse data.'
  );
  lines.push('');
  lines.push(renderExecSummaryTable(teams));
  lines.push('');

  // -------------------------------------------------------------------------
  // Adoption Summary
  // -------------------------------------------------------------------------
  lines.push('## Agentic Adoption Signal (Cursor Agent, 30d)');
  lines.push('');
  lines.push(renderAdoptionTable(teams, weeks));
  lines.push('');

  // -------------------------------------------------------------------------
  // Week-by-Week
  // -------------------------------------------------------------------------
  lines.push('## Week-by-Week Breakdown');
  lines.push('');

  for (let wIdx = 0; wIdx < weeks.length; wIdx++) {
    const week = weeks[wIdx];
    lines.push(`### ${week.label}`);
    lines.push('');

    // Per-team snapshot table
    lines.push('**Core4 + Agentic Signals**');
    lines.push('');
    lines.push(renderWeekTable(teams, wIdx));
    lines.push('');

    // Quality signal
    lines.push('**Quality Signal (Re-review Rate · CI)**');
    lines.push('');
    lines.push(renderQualityTable(teams, wIdx));
    lines.push('');
  }

  // -------------------------------------------------------------------------
  // 30-Day Rollup
  // -------------------------------------------------------------------------
  lines.push('## 30-Day Rollup');
  lines.push('');
  lines.push(renderRollupTable(teams));
  lines.push('');

  // -------------------------------------------------------------------------
  // Productivity Signal — PRs per person trend
  // -------------------------------------------------------------------------
  lines.push('## Productivity Signal — PRs / Person / Week');
  lines.push('');
  lines.push(renderPRPerPersonTable(teams, weeks));
  lines.push('');

  // -------------------------------------------------------------------------
  // Notes
  // -------------------------------------------------------------------------
  lines.push('---');
  lines.push('');
  lines.push('## Methodology & Notes');
  lines.push('');
  lines.push('| Signal | Source | Definition |');
  lines.push('|--------|--------|------------|');
  lines.push(
    '| Speed | DX warehouse `github_pulls` | PRs merged per week, PRs/person/week |'
  );
  lines.push(
    '| Effectiveness (DXI) | DX survey snapshots | Composite developer experience score (0–100 scale) |'
  );
  lines.push(
    '| Quality (Defect Ratio) | DX warehouse `jira_issues` | Bug/Defect issues closed ÷ total issues closed |'
  );
  lines.push(
    '| Impact (Innovation Ratio) | DX warehouse `jira_issues` | Story/Feature issues closed ÷ total issues closed |'
  );
  lines.push(
    '| Agentic Adoption | DX warehouse `cursor_daily_user_metrics` | % of team members with active Cursor Agent sessions |'
  );
  lines.push(
    '| Agent Requests | DX warehouse `cursor_daily_user_metrics` | Total Cursor Agent requests per team per week |'
  );
  lines.push(
    '| Re-review Rate | DX warehouse `github_reviews` | % of merged PRs that received CHANGES_REQUESTED followed by re-review |'
  );
  lines.push(
    '| CI Failure Rate | Buildkite (pipeline classification by name) | Failed builds ÷ total builds for team-owned pipelines |'
  );
  lines.push('');
  lines.push('**Team → DX mapping:**');
  lines.push('- Design System = Spring Design System (team_id 58)');
  lines.push('- Build Loop = Build Loop (team_id 50)');
  lines.push('- Agent Loop = Developer Platform (team_id 21)');
  lines.push('- Delivery Loop = Delivery Loop (team_id 23)');
  lines.push('- Shared Services = Shared Services (team_id 3)');
  lines.push('');
  lines.push(
    '**DXI note:** Survey snapshots are collected every ~6 weeks. The Jan 11–21 snapshot is the most recent available. Next snapshot expected ~Feb 2026.'
  );
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Table builders
// ---------------------------------------------------------------------------

function renderExecSummaryTable(teams: TeamReport[]): string {
  const header =
    '| Team | Speed (PRs) | DXI Score | Defect Ratio | Innovation Ratio | Agentic % (30d) |';
  const sep =
    '|------|------------|-----------|-------------|-----------------|----------------|';
  const rows = teams.map((t) => {
    const totalPRs = t.totalPRs;
    const dxiScore = latestDXI(t);
    const defect = pct(t.avgDefectRatio);
    const innov = pct(t.avgInnovationRatio);
    const agPct = pct(t.overallAgenticRate);
    const badge = agenticBadge(computeTier(t.totalPRs, t.overallAgenticRate));
    return `| ${t.teamName} | ${totalPRs} | ${dxiScore} | ${defect} | ${innov} | ${agPct} ${badge} |`;
  });
  return [header, sep, ...rows].join('\n');
}

function renderAdoptionTable(teams: TeamReport[], weeks: WeekWindow[]): string {
  const weekHeaders = weeks.map((w) => `| ${w.label}`).join(' ');
  const header = `| Team | Team Size | Cursor 30d | Agent Requests (30d) ${weekHeaders} (agent reqs) |`;
  const sep = `|------|-----------|------------|----------------------${weeks.map(() => '|-------').join('')}|`;

  const rows = teams.map((t) => {
    const teamSize = t.roster.members.length || t.weeks[0]?.memberCount || '—';
    const cursorUsers30d = countCursorUsers30d(t);
    const totalAgentReqs = totalAgentRequests(t);
    const weekCols = weeks
      .map((_, wIdx) => {
        const snap = t.weeks[wIdx];
        const reqs =
          (snap?.agenticStats as Record<string, unknown>)?._agentRequests ?? 0;
        const adoptPct =
          (snap?.agenticStats as Record<string, unknown>)?._adoptionPct ?? 0;
        return `| ${reqs} (${adoptPct}%)`;
      })
      .join(' ');
    return `| ${t.teamName} | ${teamSize} | ${cursorUsers30d} | ${totalAgentReqs} ${weekCols} |`;
  });

  return [header, sep, ...rows].join('\n');
}

function renderWeekTable(teams: TeamReport[], weekIdx: number): string {
  const header =
    '| Team | PRs Merged | PRs/Person | DXI | Defect% | Innovation% | Cursor Active | Agent Reqs |';
  const sep =
    '|------|-----------|------------|-----|---------|------------|--------------|------------|';
  const rows = teams.map((t) => {
    const snap = t.weeks[weekIdx];
    if (!snap) return `| ${t.teamName} | — | — | — | — | — | — | — |`;

    const dxi = snap.dxiScore != null ? snap.dxiScore.toFixed(0) : '—';
    const cursorActive =
      (snap.agenticStats as Record<string, unknown>)?._cursorActiveUsers ?? '—';
    const agentReqs =
      (snap.agenticStats as Record<string, unknown>)?._agentRequests ?? '—';
    const prevSnap = weekIdx > 0 ? t.weeks[weekIdx - 1] : undefined;

    return (
      `| ${t.teamName} ` +
      `| ${snap.prsMerged}${trend(snap.prsMerged, prevSnap?.prsMerged)} ` +
      `| ${num(snap.prsPerPerson)}${trend(snap.prsPerPerson, prevSnap?.prsPerPerson)} ` +
      `| ${dxi} ` +
      `| ${pct(snap.defectRatio)}${trend(snap.defectRatio, prevSnap?.defectRatio)} ` +
      `| ${pct(snap.innovationRatio)}${trend(snap.innovationRatio, prevSnap?.innovationRatio)} ` +
      `| ${cursorActive} ` +
      `| ${agentReqs} |`
    );
  });
  return [header, sep, ...rows].join('\n');
}

function renderQualityTable(teams: TeamReport[], weekIdx: number): string {
  const header =
    '| Team | Total PRs | Changes Requested | Re-reviewed PRs | Re-review Rate | CI Builds | CI Fail Rate |';
  const sep =
    '|------|-----------|------------------|----------------|---------------|-----------|-------------|';
  const rows = teams.map((t) => {
    const snap = t.weeks[weekIdx];
    if (!snap) return `| ${t.teamName} | — | — | — | — | — | — |`;
    const rr = snap.reReviewStats;
    const ci = snap.ciStats;
    return (
      `| ${t.teamName} ` +
      `| ${rr.totalPRs} ` +
      `| — ` +
      `| ${rr.reReviewedPRs} ` +
      `| ${pct(rr.reReviewRate)} ` +
      `| ${ci.totalBuilds || '—'} ` +
      `| ${ci.totalBuilds > 0 ? pct(ci.failureRate) : '—'} |`
    );
  });
  return [header, sep, ...rows].join('\n');
}

function renderRollupTable(teams: TeamReport[]): string {
  const header =
    '| Team | Total PRs (30d) | Avg PRs/Person/Week | Avg Defect% | Avg Innovation% | Overall Agentic% | Avg CI Fail% |';
  const sep =
    '|------|----------------|--------------------|-----------|--------------|-----------------|-----------  |';
  const rows = teams.map((t) => {
    const avgPPP =
      t.weeks.length > 0
        ? t.weeks.reduce((s, w) => s + w.prsPerPerson, 0) / t.weeks.length
        : 0;
    return (
      `| ${t.teamName} ` +
      `| ${t.totalPRs} ` +
      `| ${num(avgPPP)} ` +
      `| ${pct(t.avgDefectRatio)} ` +
      `| ${pct(t.avgInnovationRatio)} ` +
      `| ${pct(t.overallAgenticRate)} ${agenticBadge(computeTier(t.totalPRs, t.overallAgenticRate))} ` +
      `| ${pct(t.avgCIFailureRate)} |`
    );
  });
  return [header, sep, ...rows].join('\n');
}

function renderPRPerPersonTable(
  teams: TeamReport[],
  weeks: WeekWindow[]
): string {
  const weekHeaders = weeks.map((w) => `| ${w.label}`).join(' ');
  const header = `| Team ${weekHeaders} | Trend |`;
  const sep = `|------${weeks.map(() => '|------').join('')}|-------|`;

  const rows = teams.map((t) => {
    const weekCols = weeks
      .map((_, wIdx) => {
        const snap = t.weeks[wIdx];
        if (!snap) return '| —';
        const prev = wIdx > 0 ? t.weeks[wIdx - 1] : undefined;
        return `| ${num(snap.prsPerPerson)}${trend(snap.prsPerPerson, prev?.prsPerPerson)}`;
      })
      .join(' ');
    const first = t.weeks[0]?.prsPerPerson ?? 0;
    const last = t.weeks[t.weeks.length - 1]?.prsPerPerson ?? 0;
    const trendLabel =
      last > first * 1.1
        ? '↑ Rising'
        : last < first * 0.9
          ? '↓ Declining'
          : '→ Stable';
    return `| ${t.teamName} ${weekCols} | ${trendLabel} |`;
  });

  return [header, sep, ...rows].join('\n');
}

// ---------------------------------------------------------------------------
// Helper computations
// ---------------------------------------------------------------------------

function latestDXI(t: TeamReport): string {
  const dxi = t.weeks.find((w) => w.dxiScore != null)?.dxiScore;
  return dxi != null ? dxi.toFixed(0) : '—';
}

function countCursorUsers30d(t: TeamReport): number {
  const emails = new Set<string>();
  for (const w of t.weeks) {
    const users = (w.agenticStats as Record<string, unknown>)
      ?._cursorActiveUsers;
    if (typeof users === 'number' && users > 0) {
      // We don't have individual emails here — use max across weeks as proxy
    }
  }
  // Use max weekly active as 30d estimate (conservative)
  return t.weeks.reduce(
    (max, w) =>
      Math.max(
        max,
        ((w.agenticStats as Record<string, unknown>)
          ?._cursorActiveUsers as number) ?? 0
      ),
    0
  );
}

function totalAgentRequests(t: TeamReport): number {
  return t.weeks.reduce(
    (sum, w) =>
      sum +
      (((w.agenticStats as Record<string, unknown>)
        ?._agentRequests as number) ?? 0),
    0
  );
}
