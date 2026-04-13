/**
 * Computes re-review rates for a set of PRs.
 *
 * Re-review = a PR that received at least one "changes_requested" review event
 * followed by a subsequent "approved" or "commented" review (indicating the author
 * addressed feedback and a reviewer looked again).
 *
 * This is a quality signal: high re-review rates may indicate unclear specs,
 * agentic PRs requiring more correction rounds, or inadequate PR prep.
 */

import {execSync} from 'child_process';

import {type PRRecord, type ReReviewStats} from './types';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Computes re-review statistics for a list of PRs.
 * Fetches review timelines from GitHub for each PR.
 */
export async function computeReReviewStats(
  prs: PRRecord[],
  opts: {owner?: string; repo?: string} = {}
): Promise<ReReviewStats> {
  const owner = opts.owner ?? 'webflow';
  const repo = opts.repo ?? 'webflow';

  if (prs.length === 0) {
    return {totalPRs: 0, reReviewedPRs: 0, reReviewRate: 0};
  }

  let reReviewedCount = 0;

  for (const pr of prs) {
    const wasReReviewed = await checkReReview(pr.number, owner, repo);
    if (wasReReviewed) reReviewedCount++;
  }

  const reReviewRate = prs.length > 0 ? reReviewedCount / prs.length : 0;

  return {
    totalPRs: prs.length,
    reReviewedPRs: reReviewedCount,
    reReviewRate,
  };
}

/**
 * Lightweight version that accepts raw review data (for testing / batching).
 */
export function computeReReviewStatsFromEvents(
  prReviewEvents: ReviewEvent[][]
): ReReviewStats {
  const total = prReviewEvents.length;
  let reReviewedCount = 0;

  for (const events of prReviewEvents) {
    if (hasReReview(events)) reReviewedCount++;
  }

  return {
    totalPRs: total,
    reReviewedPRs: reReviewedCount,
    reReviewRate: total > 0 ? reReviewedCount / total : 0,
  };
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export interface ReviewEvent {
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED';
  submittedAt: string;
  author: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function checkReReview(
  prNumber: number,
  owner: string,
  repo: string
): Promise<boolean> {
  const events = fetchReviewEvents(prNumber, owner, repo);
  return hasReReview(events);
}

function fetchReviewEvents(
  prNumber: number,
  owner: string,
  repo: string
): ReviewEvent[] {
  try {
    const raw = execSync(
      `gh pr view ${prNumber} --repo ${owner}/${repo} ` +
        `--json reviews --jq '.reviews[] | {state: .state, submittedAt: .submittedAt, author: .author.login}'`,
      {encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe']}
    );
    // gh --jq with multiple objects outputs one JSON per line (NDJSON)
    return raw
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as ReviewEvent;
        } catch {
          return null;
        }
      })
      .filter((e): e is ReviewEvent => e !== null);
  } catch {
    return [];
  }
}

/**
 * A PR is considered "re-reviewed" if the timeline contains:
 *   1. At least one CHANGES_REQUESTED event from reviewer A
 *   2. Followed by at least one APPROVED or non-trivial COMMENTED event
 *      from any reviewer (author's responses don't count)
 *
 * Chronological order is preserved by GitHub's API.
 */
function hasReReview(events: ReviewEvent[]): boolean {
  let hadChangesRequested = false;

  for (const event of events) {
    if (event.state === 'CHANGES_REQUESTED') {
      hadChangesRequested = true;
      continue;
    }
    if (
      hadChangesRequested &&
      (event.state === 'APPROVED' || event.state === 'COMMENTED')
    ) {
      return true;
    }
  }

  return false;
}
