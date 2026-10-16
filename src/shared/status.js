/**
 * Pure status helpers used by both the UI and the resolvers.
 * No Forge or network calls here, which keeps them trivially unit-testable.
 */
import { FINAL_STATUSES, OVERALL, RUN_STATUS, TODO } from './constants';

/**
 * Count how many Tests are in each status.
 *
 * @param {string[]} testIds - every Test that belongs to the thing being summarised
 * @param {Record<string, {status: string}>} statusById - known statuses; missing ids count as TODO
 * @returns {{ total: number, PASS: number, FAIL: number, BLOCKED: number, EXECUTING: number, TODO: number }}
 */
export function countStatuses(testIds, statusById = {}) {
  const counts = { total: 0, PASS: 0, FAIL: 0, BLOCKED: 0, EXECUTING: 0, TODO: 0 };
  // De-duplicate: a Test linked twice (e.g. directly and via a Test Set) counts once.
  for (const id of new Set(testIds)) {
    const status = statusById[id]?.status ?? TODO;
    counts.total += 1;
    counts[status in counts ? status : TODO] += 1;
  }
  return counts;
}

/**
 * Overall status from counts:
 *  - NO_TESTS   when there is nothing to test
 *  - NOK        when any Test failed
 *  - INCOMPLETE when anything is blocked, executing or not yet run
 *  - OK         when every Test passed
 */
export function overallStatus(counts) {
  if (!counts || counts.total === 0) return OVERALL.NO_TESTS;
  if (counts.FAIL > 0) return OVERALL.NOK;
  if (counts.PASS === counts.total) return OVERALL.OK;
  return OVERALL.INCOMPLETE;
}

/** True for PASS / FAIL / BLOCKED. */
export function isFinalStatus(status) {
  return FINAL_STATUSES.includes(status);
}

/**
 * Pick the status to display for a Test in a "plan" or "latest" scope.
 * The SQL layer returns the latest final run and (separately) the latest run
 * of any status, which may be a non-final EXECUTING run.
 *
 * Two behaviours, matching Xray's "Final statuses have precedence over
 * non-final" checkbox:
 *  - finalPrecedence = true (default, Xray's default): once a Test has a
 *    final result (PASS / FAIL / BLOCKED), that result is shown even if a
 *    newer re-run is still EXECUTING. EXECUTING only shows when there is no
 *    final result yet.
 *  - finalPrecedence = false: a newer EXECUTING re-run replaces the final
 *    result, so the view shows that the Test is being re-tested right now.
 *
 * @param {{ status: string, executedAt: string } | undefined} latestFinal
 * @param {{ status: string, executedAt: string } | undefined} latestAny
 * @param {{ finalPrecedence?: boolean }} [options]
 */
export function resolveDisplayStatus(latestFinal, latestAny, { finalPrecedence = true } = {}) {
  if (latestFinal && finalPrecedence) return latestFinal;
  if (latestAny && latestAny.status === RUN_STATUS.EXECUTING) {
    if (!latestFinal || new Date(latestAny.executedAt) > new Date(latestFinal.executedAt)) {
      return latestAny;
    }
  }
  return latestFinal ?? null;
}

// Severity order used when combining environments: the "worst" result wins.
const SEVERITY = { FAIL: 4, BLOCKED: 3, EXECUTING: 2, PASS: 1 };

/**
 * Combine a Test's per-environment statuses into one, like Xray does across
 * Test Environments: a failure on iOS is NOT hidden by a later pass on
 * Android. FAIL > BLOCKED > EXECUTING > PASS; ties go to the most recent run.
 *
 * @param {Array<{ status: string, executedAt: string }>} perEnvironment
 * @returns {{ status: string, executedAt: string } | null}
 */
export function combineEnvironmentStatuses(perEnvironment) {
  let winner = null;
  for (const entry of perEnvironment) {
    if (!entry) continue;
    if (
      !winner ||
      (SEVERITY[entry.status] ?? 0) > (SEVERITY[winner.status] ?? 0) ||
      ((SEVERITY[entry.status] ?? 0) === (SEVERITY[winner.status] ?? 0) &&
        new Date(entry.executedAt) > new Date(winner.executedAt))
    ) {
      winner = entry;
    }
  }
  return winner;
}

/** Percentage helper for progress bars (0..1, safe for total=0). */
export function ratio(part, total) {
  return total > 0 ? part / total : 0;
}
