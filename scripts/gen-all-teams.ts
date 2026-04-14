/**
 * gen-all-teams.ts
 *
 * Generates dashboard/all-teams.html from DX warehouse data.
 *
 * Because the DX warehouse is accessed via the Cursor MCP tool (not a direct
 * CLI database connection), this script is structured as a data-in / HTML-out
 * pipeline:
 *
 *   1. Run the SQL below in the DX MCP tool to refresh `TEAM_DATA`.
 *   2. Run this script:  npx tsx scripts/gen-all-teams.ts
 *   3. The generated dashboard/all-teams.html is committed to the repo.
 *
 * ── Refresh SQL ──────────────────────────────────────────────────────────────
 *
 *   SELECT
 *     t.name AS team,
 *     COALESCE(t.flattened_parent, '(Ungrouped)') AS pillar,
 *     COUNT(DISTINCT du.id)  AS team_size,
 *     COUNT(DISTINCT CASE WHEN cdm.email IS NOT NULL THEN du.id END) AS cursor_active,
 *     COUNT(DISTINCT CASE WHEN ccm.email IS NOT NULL THEN du.id END) AS claude_active,
 *     COUNT(DISTINCT CASE WHEN cdm.email IS NOT NULL OR ccm.email IS NOT NULL
 *           THEN du.id END) AS combined_active
 *   FROM dx_teams t
 *   JOIN dx_users du ON du.team_id = t.id AND du.deleted_at IS NULL
 *   LEFT JOIN cursor_daily_user_metrics cdm
 *     ON LOWER(cdm.email) = LOWER(du.email)
 *     AND cdm.date >= '<START_DATE>'
 *     AND cdm.date <  '<END_DATE>'
 *     AND cdm.is_active = true
 *   LEFT JOIN claude_code_daily_user_metrics ccm
 *     ON LOWER(ccm.email) = LOWER(du.email)
 *     AND ccm.date >= '<START_DATE>'
 *     AND ccm.date <= '<END_DATE_INCLUSIVE>'
 *     AND ccm.is_active = true
 *   WHERE t.parent = false AND t.deleted_at IS NULL
 *   GROUP BY t.name, t.flattened_parent
 *   ORDER BY t.flattened_parent NULLS LAST, t.name;
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Types ────────────────────────────────────────────────────────────────────

interface TeamRow {
  pillar: string;
  team: string;
  size: number;
  cursorActive: number;
  claudeActive: number;
  combinedActive: number;
  totalPRs: number;
  agenticPRs: number;
}

type AgenticTier = 'full_agentic' | 'adopting' | 'exploring' | 'insufficient_data';

// ── Tier logic (mirrors lib/agentic-detector.ts) ─────────────────────────────

function computeTier(combinedActive: number, teamSize: number): AgenticTier {
  if (teamSize < 2) return 'insufficient_data';
  const rate = combinedActive / teamSize;
  if (rate >= 0.6) return 'full_agentic';
  if (rate >= 0.3) return 'adopting';
  return 'exploring';
}

function tierBadge(tier: AgenticTier): string {
  switch (tier) {
    case 'full_agentic':
      return '<span class="badge badge-green">🟢 Full-Agentic</span>';
    case 'adopting':
      return '<span class="badge badge-yellow">🟡 Adopting</span>';
    case 'exploring':
      return '<span class="badge badge-blue">🔵 Exploring</span>';
    default:
      return '<span class="badge" style="background:rgba(122,139,163,0.15);color:var(--muted)">— Insufficient Data</span>';
  }
}

// ── Live data (from DX MCP query, 13 Apr 2026, window: Mar 14 – Apr 13) ──────
// PR signal: a PR is "agentic" if the author had Cursor or Claude activity
// on the same day the PR was merged (DX warehouse signal).

const REPORT_DATE = '13 Apr 2026';
const WINDOW = 'Mar 14 – Apr 13 2026';

const TEAM_DATA: TeamRow[] = [
  // Analytics Engineering
  { pillar: 'Analytics Engineering', team: 'EPD Analytics Engineering',       size: 4,  cursorActive: 2, claudeActive: 4,  combinedActive: 4,  totalPRs: 66,  agenticPRs: 64  },
  { pillar: 'Analytics Engineering', team: 'GTM / G&A Analytics Engineering', size: 3,  cursorActive: 2, claudeActive: 3,  combinedActive: 3,  totalPRs: 35,  agenticPRs: 34  },
  // Collaborate Pillar
  { pillar: 'Collaborate Pillar',    team: 'Assets',                           size: 6,  cursorActive: 3, claudeActive: 6,  combinedActive: 6,  totalPRs: 19,  agenticPRs: 17  },
  { pillar: 'Collaborate Pillar',    team: 'Collaboration',                    size: 9,  cursorActive: 8, claudeActive: 8,  combinedActive: 9,  totalPRs: 48,  agenticPRs: 47  },
  { pillar: 'Collaborate Pillar',    team: 'IdSC',                             size: 7,  cursorActive: 4, claudeActive: 6,  combinedActive: 7,  totalPRs: 81,  agenticPRs: 79  },
  { pillar: 'Collaborate Pillar',    team: 'User Expansion',                   size: 3,  cursorActive: 1, claudeActive: 2,  combinedActive: 2,  totalPRs: 12,  agenticPRs: 12  },
  { pillar: 'Collaborate Pillar',    team: 'Workflows',                        size: 7,  cursorActive: 6, claudeActive: 4,  combinedActive: 6,  totalPRs: 52,  agenticPRs: 50  },
  // Compose Pillar
  { pillar: 'Compose Pillar',        team: 'CMS Authoring',                    size: 6,  cursorActive: 6, claudeActive: 6,  combinedActive: 6,  totalPRs: 88,  agenticPRs: 84  },
  { pillar: 'Compose Pillar',        team: 'CMS Extensibility',                size: 8,  cursorActive: 2, claudeActive: 8,  combinedActive: 8,  totalPRs: 49,  agenticPRs: 28  },
  { pillar: 'Compose Pillar',        team: 'Localization',                     size: 5,  cursorActive: 1, claudeActive: 4,  combinedActive: 4,  totalPRs: 30,  agenticPRs: 13  },
  { pillar: 'Compose Pillar',        team: 'Site Discovery',                   size: 3,  cursorActive: 3, claudeActive: 3,  combinedActive: 3,  totalPRs: 21,  agenticPRs: 19  },
  // Convert Pillar
  { pillar: 'Convert Pillar',        team: 'Analyze',                          size: 7,  cursorActive: 6, claudeActive: 5,  combinedActive: 7,  totalPRs: 46,  agenticPRs: 43  },
  { pillar: 'Convert Pillar',        team: 'Convert Infra',                    size: 5,  cursorActive: 4, claudeActive: 4,  combinedActive: 5,  totalPRs: 29,  agenticPRs: 29  },
  { pillar: 'Convert Pillar',        team: 'Optimize',                         size: 9,  cursorActive: 7, claudeActive: 8,  combinedActive: 9,  totalPRs: 80,  agenticPRs: 61  },
  // Data Engineering
  { pillar: 'Data Engineering',      team: 'Data Science',                     size: 4,  cursorActive: 4, claudeActive: 4,  combinedActive: 4,  totalPRs: 13,  agenticPRs: 12  },
  { pillar: 'Data Engineering',      team: 'Ecosystem Data Science',           size: 5,  cursorActive: 4, claudeActive: 4,  combinedActive: 4,  totalPRs: 1,   agenticPRs: 1   },
  // Design Pillar
  { pillar: 'Design Pillar',         team: 'Design Experience',                size: 10, cursorActive: 5, claudeActive: 5,  combinedActive: 7,  totalPRs: 73,  agenticPRs: 58  },
  { pillar: 'Design Pillar',         team: 'Design Infra',                     size: 5,  cursorActive: 4, claudeActive: 3,  combinedActive: 4,  totalPRs: 28,  agenticPRs: 21  },
  { pillar: 'Design Pillar',         team: 'Structure',                        size: 14, cursorActive: 12,claudeActive: 12, combinedActive: 13, totalPRs: 110, agenticPRs: 107 },
  { pillar: 'Design Pillar',         team: 'Styles',                           size: 8,  cursorActive: 6, claudeActive: 7,  combinedActive: 8,  totalPRs: 61,  agenticPRs: 60  },
  // Develop Pillar
  { pillar: 'Develop Pillar',        team: 'Code Gen',                         size: 9,  cursorActive: 6, claudeActive: 6,  combinedActive: 8,  totalPRs: 45,  agenticPRs: 36  },
  { pillar: 'Develop Pillar',        team: 'Code Sync',                        size: 4,  cursorActive: 1, claudeActive: 3,  combinedActive: 4,  totalPRs: 26,  agenticPRs: 25  },
  { pillar: 'Develop Pillar',        team: 'Webflow Cloud',                    size: 8,  cursorActive: 5, claudeActive: 7,  combinedActive: 8,  totalPRs: 84,  agenticPRs: 67  },
  // Growth Pillar
  { pillar: 'Growth Pillar',         team: 'AI Design & Assist',               size: 12, cursorActive: 7, claudeActive: 7,  combinedActive: 11, totalPRs: 49,  agenticPRs: 39  },
  { pillar: 'Growth Pillar',         team: 'Developer Platform',               size: 14, cursorActive: 9, claudeActive: 12, combinedActive: 12, totalPRs: 161, agenticPRs: 146 },
  { pillar: 'Growth Pillar',         team: 'Lifecycle',                        size: 3,  cursorActive: 2, claudeActive: 3,  combinedActive: 3,  totalPRs: 40,  agenticPRs: 36  },
  { pillar: 'Growth Pillar',         team: 'SP Success',                       size: 7,  cursorActive: 3, claudeActive: 7,  combinedActive: 7,  totalPRs: 60,  agenticPRs: 29  },
  { pillar: 'Growth Pillar',         team: 'Subscription & Payments',          size: 12, cursorActive: 8, claudeActive: 12, combinedActive: 12, totalPRs: 83,  agenticPRs: 64  },
  // Infrastructure
  { pillar: 'Infrastructure',        team: 'Data Platform',                    size: 12, cursorActive: 9, claudeActive: 12, combinedActive: 12, totalPRs: 184, agenticPRs: 172 },
  { pillar: 'Infrastructure',        team: 'Hosting Infrastructure',           size: 6,  cursorActive: 3, claudeActive: 6,  combinedActive: 6,  totalPRs: 148, agenticPRs: 138 },
  { pillar: 'Infrastructure',        team: 'Site Reliability',                 size: 5,  cursorActive: 2, claudeActive: 4,  combinedActive: 4,  totalPRs: 40,  agenticPRs: 34  },
  // Productivity Pillar
  { pillar: 'Productivity Pillar',   team: 'Build Loop',                       size: 8,  cursorActive: 2, claudeActive: 8,  combinedActive: 8,  totalPRs: 79,  agenticPRs: 76  },
  { pillar: 'Productivity Pillar',   team: 'Delivery Loop',                    size: 8,  cursorActive: 4, claudeActive: 8,  combinedActive: 8,  totalPRs: 179, agenticPRs: 162 },
  { pillar: 'Productivity Pillar',   team: 'Shared Services',                  size: 5,  cursorActive: 4, claudeActive: 5,  combinedActive: 5,  totalPRs: 18,  agenticPRs: 10  },
  { pillar: 'Productivity Pillar',   team: 'Spring Design System',             size: 4,  cursorActive: 4, claudeActive: 4,  combinedActive: 4,  totalPRs: 85,  agenticPRs: 65  },
  // Security
  { pillar: 'Security',              team: 'Application Security',             size: 6,  cursorActive: 2, claudeActive: 6,  combinedActive: 6,  totalPRs: 38,  agenticPRs: 26  },
  { pillar: 'Security',              team: 'Information Security',             size: 3,  cursorActive: 3, claudeActive: 3,  combinedActive: 3,  totalPRs: 3,   agenticPRs: 3   },
  { pillar: 'Security',              team: 'Risk & Compliance',                size: 3,  cursorActive: 0, claudeActive: 3,  combinedActive: 3,  totalPRs: 0,   agenticPRs: 0   },
  { pillar: 'Security',              team: 'Security Engineering',             size: 3,  cursorActive: 3, claudeActive: 3,  combinedActive: 3,  totalPRs: 6,   agenticPRs: 5   },
  { pillar: 'Security',              team: 'Trust & Safety',                   size: 4,  cursorActive: 1, claudeActive: 4,  combinedActive: 4,  totalPRs: 0,   agenticPRs: 0   },
  // Ungrouped
  { pillar: '(Ungrouped)',           team: 'AI Foundations',                   size: 2,  cursorActive: 2, claudeActive: 2,  combinedActive: 2,  totalPRs: 28,  agenticPRs: 24  },
  { pillar: '(Ungrouped)',           team: 'Leadership',                       size: 15, cursorActive: 8, claudeActive: 15, combinedActive: 15, totalPRs: 112, agenticPRs: 111 },
];

// ── Build HTML ───────────────────────────────────────────────────────────────

function pct(active: number, size: number): number {
  return size === 0 ? 0 : Math.round((active / size) * 100);
}

function prAgenticBadge(agenticPRs: number, totalPRs: number): string {
  if (totalPRs === 0) return '<span style="color:var(--muted);font-size:11px">—</span>';
  const p = pct(agenticPRs, totalPRs);
  const cls = p >= 60 ? 'badge-green' : p >= 30 ? 'badge-yellow' : 'badge-blue';
  return `<span class="badge ${cls}">${p}%</span>`;
}

function buildPillarRows(rows: TeamRow[]): string {
  // Group by pillar
  const byPillar = new Map<string, TeamRow[]>();
  for (const row of rows) {
    const bucket = byPillar.get(row.pillar) ?? [];
    bucket.push(row);
    byPillar.set(row.pillar, bucket);
  }

  const pillars = [...byPillar.keys()].sort((a, b) => {
    if (a === '(Ungrouped)') return 1;
    if (b === '(Ungrouped)') return -1;
    return a.localeCompare(b);
  });

  return pillars
    .map((pillar) => {
      const teams = byPillar.get(pillar)!;
      const totalSize = teams.reduce((s, t) => s + t.size, 0);
      const totalCombined = teams.reduce((s, t) => s + t.combinedActive, 0);
      const totalCursor = teams.reduce((s, t) => s + t.cursorActive, 0);
      const totalClaude = teams.reduce((s, t) => s + t.claudeActive, 0);
      const totalPRs = teams.reduce((s, t) => s + t.totalPRs, 0);
      const totalAgenticPRs = teams.reduce((s, t) => s + t.agenticPRs, 0);
      const pillarPct = pct(totalCombined, totalSize);

      const pillarRow = `
      <tr class="pillar-row">
        <td colspan="2" class="pillar-name">${pillar}</td>
        <td class="num">${totalSize}</td>
        <td class="num muted">${totalCursor}</td>
        <td class="num muted">${totalClaude}</td>
        <td class="num">${totalCombined}</td>
        <td>
          <div class="bar-wrap">
            <div class="bar-fill" style="width:${pillarPct}%"></div>
            <span class="bar-label">${pillarPct}%</span>
          </div>
        </td>
        <td>${tierBadge(computeTier(totalCombined, totalSize))}</td>
        <td class="num">${totalPRs}</td>
        <td class="num muted">${totalAgenticPRs}</td>
        <td>${prAgenticBadge(totalAgenticPRs, totalPRs)}</td>
      </tr>`;

      const teamRows = teams
        .map((t) => {
          const adoptionPct = pct(t.combinedActive, t.size);
          const tier = computeTier(t.combinedActive, t.size);
          const toolPref =
            t.claudeActive > t.cursorActive
              ? '<span class="tool-pill claude">Claude</span>'
              : t.cursorActive > t.claudeActive
                ? '<span class="tool-pill cursor">Cursor</span>'
                : '<span class="tool-pill both">Both</span>';
          return `
      <tr class="team-row">
        <td class="team-indent">${t.team}</td>
        <td>${toolPref}</td>
        <td class="num">${t.size}</td>
        <td class="num">${t.cursorActive}</td>
        <td class="num">${t.claudeActive}</td>
        <td class="num">${t.combinedActive}</td>
        <td>
          <div class="bar-wrap">
            <div class="bar-fill ${tier === 'full_agentic' ? 'green' : tier === 'adopting' ? 'yellow' : 'blue'}"
                 style="width:${adoptionPct}%"></div>
            <span class="bar-label">${adoptionPct}%</span>
          </div>
        </td>
        <td>${tierBadge(tier)}</td>
        <td class="num">${t.totalPRs > 0 ? t.totalPRs : '<span style="color:var(--muted)">—</span>'}</td>
        <td class="num">${t.agenticPRs > 0 ? t.agenticPRs : '<span style="color:var(--muted)">—</span>'}</td>
        <td>${prAgenticBadge(t.agenticPRs, t.totalPRs)}</td>
      </tr>`;
        })
        .join('');

      return pillarRow + teamRows;
    })
    .join('');
}

function buildSummaryCards(rows: TeamRow[]): string {
  const totalTeams = rows.length;
  const fullAgentic = rows.filter((r) => computeTier(r.combinedActive, r.size) === 'full_agentic').length;
  const adopting = rows.filter((r) => computeTier(r.combinedActive, r.size) === 'adopting').length;
  const exploring = rows.filter((r) => computeTier(r.combinedActive, r.size) === 'exploring').length;
  const totalSize = rows.reduce((s, r) => s + r.size, 0);
  const totalCombined = rows.reduce((s, r) => s + r.combinedActive, 0);
  const overallPct = pct(totalCombined, totalSize);
  const claudeDominant = rows.filter((r) => r.claudeActive > r.cursorActive).length;
  const totalPRs = rows.reduce((s, r) => s + r.totalPRs, 0);
  const totalAgenticPRs = rows.reduce((s, r) => s + r.agenticPRs, 0);
  const prAgenticPct = pct(totalAgenticPRs, totalPRs);

  return `
    <div class="stat-grid">
      <div class="stat-card">
        <div class="label">Total Teams</div>
        <div class="value">${totalTeams}</div>
        <div class="sub">${totalSize} engineers tracked</div>
      </div>
      <div class="stat-card">
        <div class="label">Full-Agentic</div>
        <div class="value" style="color:var(--green)">${fullAgentic}</div>
        <div class="sub">of ${totalTeams} teams ≥ 60% adoption</div>
        <span class="badge badge-green">🟢 ${Math.round((fullAgentic / totalTeams) * 100)}% of teams</span>
      </div>
      <div class="stat-card">
        <div class="label">Overall Adoption</div>
        <div class="value">${overallPct}%</div>
        <div class="sub">${totalCombined} of ${totalSize} engineers on AI tools</div>
      </div>
      <div class="stat-card">
        <div class="label">Total PRs Merged (30d)</div>
        <div class="value">${totalPRs.toLocaleString()}</div>
        <div class="sub">across all tracked teams</div>
      </div>
      <div class="stat-card">
        <div class="label">Agentic PRs (30d)</div>
        <div class="value" style="color:var(--green)">${totalAgenticPRs.toLocaleString()}</div>
        <div class="sub">${prAgenticPct}% of all PRs merged while author was on AI tools</div>
        <span class="badge badge-green">🟢 ${prAgenticPct}% agentic</span>
      </div>
      <div class="stat-card">
        <div class="label">Claude-Dominant Teams</div>
        <div class="value">${claudeDominant}</div>
        <div class="sub">Claude active &gt; Cursor active</div>
        <span class="badge badge-blue">of ${totalTeams} teams</span>
      </div>
    </div>`;
}

function generateHTML(): string {
  const summaryCards = buildSummaryCards(TEAM_DATA);
  const tableRows = buildPillarRows(TEAM_DATA);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Agentic Adoption — All Teams · Webflow</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link
      href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap"
      rel="stylesheet"
    />
    <style>
      :root {
        --bg: #0b0f14;
        --surface: #141920;
        --surface2: #1c2430;
        --border: #252e3d;
        --text: #e2e8f0;
        --muted: #7a8ba3;
        --accent: #4f8ef7;
        --green: #34d399;
        --yellow: #fbbf24;
        --red: #f87171;
        --purple: #a78bfa;
        --cyan: #22d3ee;
        --mono: 'IBM Plex Mono', monospace;
        --sans: 'IBM Plex Sans', sans-serif;
      }
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        background: var(--bg);
        color: var(--text);
        font-family: var(--sans);
        font-size: 14px;
        line-height: 1.6;
        min-height: 100vh;
      }
      header {
        border-bottom: 1px solid var(--border);
        padding: 28px 40px 24px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      header h1 {
        font-size: 22px;
        font-weight: 700;
        letter-spacing: -0.3px;
        color: #fff;
      }
      header .meta {
        font-family: var(--mono);
        font-size: 11px;
        color: var(--muted);
        display: flex;
        gap: 20px;
        flex-wrap: wrap;
        align-items: center;
      }
      header .meta .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--green); display:inline-block; }
      header .nav-back {
        font-family: var(--mono);
        font-size: 11px;
        color: var(--accent);
        text-decoration: none;
      }
      header .nav-back:hover { text-decoration: underline; }
      main {
        padding: 32px 40px;
        max-width: 1400px;
        margin: 0 auto;
      }
      section { margin-bottom: 40px; }
      h2 {
        font-size: 13px;
        font-weight: 600;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--muted);
        margin-bottom: 16px;
        padding-bottom: 8px;
        border-bottom: 1px solid var(--border);
      }
      .stat-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: 12px;
        margin-bottom: 32px;
      }
      .stat-card {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .stat-card .label {
        font-family: var(--mono);
        font-size: 10px;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }
      .stat-card .value {
        font-size: 28px;
        font-weight: 700;
        color: #fff;
        line-height: 1.1;
      }
      .stat-card .sub { font-size: 12px; color: var(--muted); margin-top: 2px; }
      .stat-card .badge {
        display: inline-block;
        font-size: 10px;
        font-family: var(--mono);
        padding: 2px 6px;
        border-radius: 4px;
        margin-top: 4px;
        font-weight: 600;
      }
      .badge-green { background: rgba(52,211,153,0.15); color: var(--green); }
      .badge-yellow { background: rgba(251,191,36,0.15); color: var(--yellow); }
      .badge-blue { background: rgba(79,142,247,0.15); color: var(--accent); }
      .badge-red { background: rgba(248,113,113,0.15); color: var(--red); }
      .table-wrap {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 8px;
        overflow: auto;
      }
      table { width: 100%; border-collapse: collapse; font-size: 13px; }
      th {
        background: var(--surface2);
        color: var(--muted);
        font-family: var(--mono);
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        padding: 10px 14px;
        text-align: left;
        border-bottom: 1px solid var(--border);
        white-space: nowrap;
      }
      th.num, td.num { text-align: right; }
      td {
        padding: 9px 14px;
        border-bottom: 1px solid var(--border);
        vertical-align: middle;
      }
      td.muted { color: var(--muted); }
      tr:last-child td { border-bottom: none; }
      /* Pillar header row */
      tr.pillar-row td {
        background: rgba(255,255,255,0.035);
        border-top: 2px solid var(--border);
        font-weight: 600;
        color: #fff;
      }
      tr.pillar-row:first-child td { border-top: none; }
      .pillar-name {
        font-family: var(--mono);
        font-size: 11px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--muted) !important;
        font-weight: 600 !important;
      }
      /* Team rows */
      tr.team-row:hover td { background: rgba(255,255,255,0.02); }
      .team-indent { padding-left: 28px !important; }
      /* Tool preference pills */
      .tool-pill {
        font-size: 10px;
        font-family: var(--mono);
        padding: 2px 7px;
        border-radius: 10px;
        font-weight: 600;
        white-space: nowrap;
      }
      .tool-pill.claude { background: rgba(167,139,250,0.18); color: var(--purple); }
      .tool-pill.cursor { background: rgba(79,142,247,0.18); color: var(--accent); }
      .tool-pill.both { background: rgba(52,211,153,0.15); color: var(--green); }
      /* Adoption bar */
      .bar-wrap {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 120px;
      }
      .bar-fill {
        height: 6px;
        border-radius: 3px;
        background: var(--green);
        flex-shrink: 0;
        min-width: 2px;
        max-width: 80px;
      }
      .bar-fill.yellow { background: var(--yellow); }
      .bar-fill.blue { background: var(--accent); }
      .bar-label {
        font-family: var(--mono);
        font-size: 11px;
        color: var(--muted);
        white-space: nowrap;
      }
      /* Inline badge in table */
      td .badge {
        font-size: 10px;
        font-family: var(--mono);
        padding: 2px 8px;
        border-radius: 4px;
        font-weight: 600;
        white-space: nowrap;
      }
      .methodology {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 20px 24px;
        font-size: 12px;
        color: var(--muted);
        line-height: 1.8;
      }
      .methodology strong { color: var(--text); }
      .methodology code {
        font-family: var(--mono);
        font-size: 11px;
        background: rgba(255,255,255,0.06);
        padding: 1px 5px;
        border-radius: 3px;
      }
    </style>
  </head>
  <body>
    <header>
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <h1>Agentic Adoption &mdash; All Engineering Teams</h1>
        <a class="nav-back" href="index.html">← Back to Productivity Pillar Report</a>
      </div>
      <div class="meta">
        <span><span class="dot"></span>&nbsp;Generated ${REPORT_DATE}</span>
        <span>Window: ${WINDOW} (30 days)</span>
        <span>Signal: Cursor + Claude Code active users (DX warehouse)</span>
        <span>43 teams &middot; 12 pillars</span>
      </div>
    </header>

    <main>
      <section>
        <h2>Summary</h2>
        ${summaryCards}
      </section>

      <section>
        <h2>Team Breakdown by Pillar</h2>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th style="width:220px">Team</th>
                <th>Primary Tool</th>
                <th class="num">Size</th>
                <th class="num">Cursor Active</th>
                <th class="num">Claude Active</th>
                <th class="num">Combined</th>
                <th style="min-width:160px">Adoption</th>
                <th>Tier</th>
                <th class="num">Total PRs</th>
                <th class="num">Agentic PRs</th>
                <th>Agentic PR %</th>
              </tr>
            </thead>
            <tbody>
              ${tableRows}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <div class="methodology">
          <strong>Methodology</strong><br />
          <strong>Adoption %</strong> = engineers active on <code>Cursor</code> <em>or</em> <code>Claude Code</code> in the 30-day window ÷ DX-tracked team size.
          "Active" = <code>is_active = true</code> on at least one day in the window
          (<code>cursor_daily_user_metrics</code> / <code>claude_code_daily_user_metrics</code>).<br /><br />
          <strong>Agentic PR %</strong> = PRs where the author had an active Cursor or Claude session
          on the same calendar day the PR was merged. This is a conservative proxy —
          it undercounts PRs where AI was used earlier in the branch lifetime but not on merge day.<br /><br />
          Tier thresholds: &lt;30% = Exploring, 30–59% = Adopting, ≥60% = Full-Agentic.
          "Primary Tool" shows which tool had more unique active users (Claude / Cursor / Both if equal).<br /><br />
          <strong>Note on Leadership &amp; AI Foundations</strong>: shown for completeness — non-pillar
          groupings with mixed membership. High adoption reflects Claude licensing breadth.
        </div>
      </section>
    </main>
  </body>
</html>`;
}

// ── Write output ─────────────────────────────────────────────────────────────

const outPath = path.join(process.cwd(), 'dashboard', 'all-teams.html');
const html = generateHTML();
fs.writeFileSync(outPath, html, 'utf-8');
console.log(`✓ Written ${outPath}`);
