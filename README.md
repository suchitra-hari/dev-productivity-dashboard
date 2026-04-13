# Developer Productivity Report

A reusable TypeScript script that generates a weekly-chunked productivity report for the **Developer Productivity pillar**, organized around [DX's Core4](https://app.getdx.com/dashboard/groups/NTU0NA) metrics plus agentic adoption signals.

## Teams in Scope

| Pillar Team     | DX Team              | DX ID |
| --------------- | -------------------- | ----- |
| Design System   | Spring Design System | 58    |
| Build Loop      | Build Loop           | 50    |
| Agent Loop      | Developer Platform   | 21    |
| Delivery Loop   | Delivery Loop        | 23    |
| Shared Services | Shared Services      | 3     |

## Core4 Dimensions

| Dimension         | Definition                                      | Source                                        |
| ----------------- | ----------------------------------------------- | --------------------------------------------- |
| **Speed**         | PRs merged per week, PRs/person/week            | DX warehouse `github_pulls`                   |
| **Effectiveness** | DXI score (developer experience composite)      | DX survey snapshots `dx_snapshot_team_scores` |
| **Quality**       | Defect Ratio = Bug issues closed ÷ total issues | DX warehouse `jira_issues`                    |
| **Impact**        | Innovation Ratio = Feature/Story issues ÷ total | DX warehouse `jira_issues`                    |

## Additional Signals

| Signal              | Definition                                           | Source                      |
| ------------------- | ---------------------------------------------------- | --------------------------- |
| **Adoption**        | % of team members using Cursor Agent                 | `cursor_daily_user_metrics` |
| **Agent Requests**  | Total Cursor Agent requests per team/week            | `cursor_daily_user_metrics` |
| **Re-review Rate**  | % of PRs with CHANGES_REQUESTED + follow-up review   | `github_reviews`            |
| **CI Failure Rate** | Failed Buildkite builds ÷ total (per team pipelines) | Buildkite API               |

## Usage

```bash
# Generate report for last 28 days (4 weeks), print to stdout
./report.ts

# Write to file
./report.ts --output report.md

# Custom date range
./report.ts --start 2026-03-14 --weeks 4

# JSON output for downstream processing
./report.ts --json --output data.json

# Skip Buildkite CI stats (faster, for local use)
./report.ts --skip-ci --output report.md
```

## Running via Cursor Agent

The fastest way to run this report is via the Cursor agent, which has direct access to the DX MCP tools:

1. Open Cursor
2. Ask the agent: _"Run the dev productivity report for the last 30 days"_
3. The agent will call `queryData` on the DX MCP, collect all signals, and render the report

## Environment Variables

| Variable              | Description                                                            |
| --------------------- | ---------------------------------------------------------------------- |
| `DX_DATABASE_URL`     | PostgreSQL connection string to DX data warehouse (for standalone use) |
| `BUILDKITE_API_TOKEN` | Buildkite API token for CI failure rates                               |

## File Structure

```
ops/dev-productivity-report/
  report.ts              ← Entry point (run this)
  lib/
    types.ts             ← Shared type definitions
    resolve-teams.ts     ← DX team → member mapping
    github-collector.ts  ← PR collection via gh CLI
    agentic-detector.ts  ← Agentic PR detection (Yan's method)
    review-analyzer.ts   ← Re-review rate computation
    buildkite-collector.ts ← CI stats from Buildkite
    jira-collector.ts    ← Defect/innovation ratios
    dx-metrics.ts        ← DX warehouse queries (Core4 + Cursor usage)
    aggregator.ts        ← Joins all signals per team per week
    renderer.ts          ← Markdown report generator
```

## Methodology Notes

- **DXI scores** come from DX survey snapshots collected every ~6 weeks. The most recent snapshot (Jan 11–21, 2026) is used for the Effectiveness dimension.
- **Agentic adoption** is measured via Cursor's `cursor_daily_user_metrics` table (agent_requests > 0 per user per day). This captures Cursor Agent usage but not raw Claude Code usage (tracked separately in `claude_code_daily_user_metrics`).
- **Defect/Innovation ratios** count Jira issues by type (`Bug`/`Defect` vs `Story`/`Feature`/`Epic`) closed in the window, filtered to team members by email.
- **CI failure rates** use heuristic pipeline-to-team classification based on pipeline slug/name keywords. Pipelines with no keyword match are excluded.

## Related

- [Yan's Agentic Dashboard](https://yan-xie-webflow.github.io/agentic-dashboard/) — Reference implementation for agentic detection
- [DX Core4 Dashboard](https://app.getdx.com/dashboard/groups/NTU0NA) — Live Core4 scores in DX
