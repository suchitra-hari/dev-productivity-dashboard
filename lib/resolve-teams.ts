/**
 * Resolves Developer Productivity pillar team rosters from DX.
 *
 * Strategy:
 *   1. listTeams → find each team by name substring
 *   2. getTeamDetails → member emails
 *   3. queryData → join emails to GitHub logins from DX data warehouse
 *
 * If the data warehouse join fails (e.g. table schema differs), falls back
 * to emails-only with an empty githubLogin, which callers must handle.
 */

import {execSync} from 'child_process';

import {
  type TeamMember,
  type TeamName,
  type TeamRoster,
  TEAM_NAMES,
} from './types';

// ---------------------------------------------------------------------------
// MCP call helpers — we shell out to the cursor MCP bridge via JSON-RPC
// because these scripts run outside the IDE context. The DX MCP server is
// accessed through a thin wrapper that forwards calls and returns JSON.
// ---------------------------------------------------------------------------

function callDXMcp(toolName: string, args: Record<string, unknown>): unknown {
  const payload = JSON.stringify({tool: toolName, arguments: args});
  // dx-mcp-call is a thin shim defined in this package that routes to the
  // user-dx-mcp MCP server. If not present we fall back to direct npx call.
  try {
    const result = execSync(
      `npx ts-node -e "
        const {Client} = require('@modelcontextprotocol/sdk/client/index.js');
        const {StdioClientTransport} = require('@modelcontextprotocol/sdk/client/stdio.js');
        // Inline call omitted – use the dx-mcp wrapper below
      "`,
      {encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe']}
    );
    return JSON.parse(result);
  } catch {
    throw new Error(`DX MCP call failed for tool ${toolName}: ${payload}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetches all team rosters for the Developer Productivity pillar from DX.
 *
 * IMPORTANT: This function is designed to be called from the report entry
 * point via the MCP client that is already set up in report.ts. We export
 * both the pure data types and a factory that accepts the MCP caller so tests
 * can inject a mock.
 */
export async function resolveTeams(dxCaller: DXCaller): Promise<TeamRoster[]> {
  console.log('[resolve-teams] Fetching team list from DX...');
  const allTeams = await dxCaller.listTeams();

  const rosters: TeamRoster[] = [];

  for (const teamName of TEAM_NAMES) {
    const match = findTeam(allTeams, teamName);
    if (!match) {
      console.warn(
        `[resolve-teams] Team not found in DX: "${teamName}" — skipping`
      );
      continue;
    }

    console.log(
      `[resolve-teams] Fetching members for "${teamName}" (id=${match.id})...`
    );
    const details = await dxCaller.getTeamDetails({team_id: match.id});
    const emails = extractEmails(details);

    let members: TeamMember[];
    if (emails.length === 0) {
      console.warn(`[resolve-teams] No members found for team "${teamName}"`);
      members = [];
    } else {
      members = await resolveGitHubLogins(dxCaller, emails, details);
    }

    rosters.push({
      teamName,
      dxTeamId: match.id,
      members,
    });
  }

  return rosters;
}

// ---------------------------------------------------------------------------
// DX Caller interface — injected so tests can stub
// ---------------------------------------------------------------------------

export interface DXCaller {
  listTeams(): Promise<unknown>;
  getTeamDetails(args: {
    team_id?: string;
    team_emails?: string;
  }): Promise<unknown>;
  queryData(sql: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface DXTeamSummary {
  id: string;
  name: string;
}

function findTeam(
  allTeams: unknown,
  targetName: TeamName
): DXTeamSummary | undefined {
  if (!Array.isArray(allTeams)) {
    // DX may wrap in { teams: [...] }
    const obj = allTeams as Record<string, unknown>;
    const arr = obj['teams'] ?? obj['data'] ?? obj['results'];
    if (Array.isArray(arr)) return findTeam(arr, targetName);
    return undefined;
  }

  const lower = targetName.toLowerCase();
  return allTeams.find((t: unknown) => {
    const team = t as Record<string, unknown>;
    const name = String(team['name'] ?? '').toLowerCase();
    return name.includes(lower) || lower.includes(name);
  }) as DXTeamSummary | undefined;
}

function extractEmails(details: unknown): string[] {
  const obj = details as Record<string, unknown>;

  // Try common shapes returned by DX
  const candidates = [
    obj['members'],
    obj['team_members'],
    (obj['data'] as Record<string, unknown> | undefined)?.['members'],
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      const emails = candidate.flatMap((m: unknown) => {
        const member = m as Record<string, unknown>;
        const email =
          member['email'] ??
          member['user_email'] ??
          (member['user'] as Record<string, unknown> | undefined)?.['email'];
        return email ? [String(email)] : [];
      });
      if (emails.length > 0) return emails;
    }
  }

  return [];
}

function extractDisplayName(member: Record<string, unknown>): string {
  return String(
    member['name'] ??
      member['display_name'] ??
      member['full_name'] ??
      (member['user'] as Record<string, unknown> | undefined)?.['name'] ??
      member['email'] ??
      'Unknown'
  );
}

async function resolveGitHubLogins(
  dxCaller: DXCaller,
  emails: string[],
  rawDetails: unknown
): Promise<TeamMember[]> {
  // First attempt: query DX data warehouse for email → github_login mapping
  const emailList = emails.map((e) => `'${e}'`).join(', ');

  const tablesToTry = [
    `SELECT email, github_login, name FROM contributors WHERE email IN (${emailList})`,
    `SELECT email, github_handle AS github_login, display_name AS name FROM users WHERE email IN (${emailList})`,
    `SELECT email, github_username AS github_login, full_name AS name FROM team_members WHERE email IN (${emailList})`,
  ];

  for (const sql of tablesToTry) {
    try {
      const raw = await dxCaller.queryData(sql);
      const rows = parseQueryResult(raw);
      if (rows.length > 0) {
        console.log(
          `[resolve-teams] Resolved ${rows.length} GitHub logins via queryData`
        );
        // Fill in any emails not returned by the query
        const found = new Map(rows.map((r) => [r.email as string, r]));
        return emails.map((email) => {
          const row = found.get(email);
          return {
            email,
            githubLogin: row ? String(row['github_login'] ?? '') : '',
            displayName: row ? String(row['name'] ?? email) : email,
          };
        });
      }
    } catch {
      // Try next SQL variant
    }
  }

  // Fallback: extract display names from raw details, leave githubLogin empty
  console.warn(
    '[resolve-teams] queryData did not return GitHub logins — ' +
      'GitHub collection will be limited. Inspect DX schema via --schema flag.'
  );

  const rawObj = rawDetails as Record<string, unknown>;
  const membersArr =
    (rawObj['members'] as unknown[]) ??
    (rawObj['team_members'] as unknown[]) ??
    [];

  return emails.map((email, idx) => {
    const raw = membersArr[idx] as Record<string, unknown> | undefined;
    return {
      email,
      githubLogin: raw
        ? String(
            (raw['github_login'] as string | undefined) ??
              (raw['github_handle'] as string | undefined) ??
              ''
          )
        : '',
      displayName: raw ? extractDisplayName(raw) : email,
    };
  });
}

function parseQueryResult(raw: string): Record<string, unknown>[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      const inner = obj['result'] ?? obj['rows'] ?? obj['data'];
      if (typeof inner === 'string')
        return JSON.parse(inner) as Record<string, unknown>[];
      if (Array.isArray(inner)) return inner as Record<string, unknown>[];
    }
  } catch {
    // Not JSON — DX may return CSV or plain text; treat as empty
  }
  return [];
}
