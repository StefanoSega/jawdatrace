/**
 * Status resolver: latest Test status for a list of Tests, in a given scope.
 *
 * One resolver serves the Test Set, Story coverage, and project report views.
 * Cost per call: 1 Jira request per 100 Tests (visibility filter) + 1 SQL
 * statement (+1 Jira request when scoped to a Plan/Execution).
 */
import { ISSUE_TYPES, LIMITS, SCOPE } from '../shared/constants';
import { ValidationError } from '../shared/evidence';
import { combineEnvironmentStatuses, resolveDisplayStatus } from '../shared/status';
import { fromSqlDateTime, selectLatestRuns } from '../db/queries';
import { assertIssueId, assertIssueIdList, filterVisibleIssueIds, getVisibleIssue } from './permissions';

/**
 * Collapse the rows returned by selectLatestRuns into one display status per
 * Test: first per environment (see resolveDisplayStatus for how a newer
 * EXECUTING re-run is treated), then across environments (worst result wins).
 * Exported for unit tests.
 *
 * @param {object[]} rows
 * @param {{ finalPrecedence?: boolean }} [options] - forwarded to resolveDisplayStatus
 * @returns {Record<string, { status: string, executedAt: string, executedBy: string }>}
 */
export function buildStatusMap(rows, options = {}) {
  // testId -> env -> { any, final }
  const byTest = new Map();
  for (const row of rows) {
    const envs = byTest.get(row.test_issue_id) ?? new Map();
    const env = row.env ?? '';
    const entry = envs.get(env) ?? {};
    const run = {
      status: row.status,
      executedAt: fromSqlDateTime(row.executed_at),
      executedBy: row.executed_by,
    };
    if (Number(row.rn_any) === 1) entry.any = run;
    if (Number(row.rn_final) === 1 && row.status !== 'EXECUTING') entry.final = run;
    envs.set(env, entry);
    byTest.set(row.test_issue_id, envs);
  }
  const result = {};
  for (const [testId, envs] of byTest) {
    const perEnvironment = [...envs.values()].map((entry) => resolveDisplayStatus(entry.final, entry.any, options));
    const combined = combineEnvironmentStatuses(perEnvironment);
    if (combined) result[testId] = combined;
  }
  return result;
}

/**
 * Validate a scope object coming from the UI. Exported for unit tests.
 *
 * Every scope may carry:
 *  - environment: only count runs from Executions in that environment
 *    (ad-hoc runs have no environment, so they drop out when it is set)
 *  - finalPrecedence: see resolveDisplayStatus (defaults to true)
 */
export function parseScope(scope) {
  const kind = scope?.kind ?? SCOPE.LATEST;
  const environment = scope?.environment == null || scope.environment === '' ? null : String(scope.environment);
  if (environment && environment.length > LIMITS.ENVIRONMENT_MAX) throw new ValidationError('Invalid environment.');
  const finalPrecedence = scope?.finalPrecedence !== false;
  if (kind === SCOPE.LATEST) return { kind, environment, finalPrecedence };
  if (kind === SCOPE.PLAN || kind === SCOPE.EXECUTION) {
    return { kind, id: assertIssueId(scope.id, `${kind} id`), environment, finalPrecedence };
  }
  throw new ValidationError('Invalid status scope.');
}

/**
 * Statuses for Tests the user can see, already permission-checked.
 * Shared by other resolvers (plans, executions) that have their own checks.
 */
export async function statusesForVisibleTests(visibleTestIds, scope) {
  return buildStatusMap(await selectLatestRuns(visibleTestIds, scope), {
    finalPrecedence: scope.finalPrecedence !== false,
  });
}

/** Public resolver: statuses for up to LIMITS.STATUS_IDS_MAX Tests. */
export async function getStatuses(payload) {
  const testIssueIds = assertIssueIdList(payload?.testIssueIds ?? [], LIMITS.STATUS_IDS_MAX);
  const scope = parseScope(payload?.scope);

  if (scope.kind === SCOPE.PLAN) await getVisibleIssue(scope.id, ISSUE_TYPES.TEST_PLAN);
  if (scope.kind === SCOPE.EXECUTION) await getVisibleIssue(scope.id, ISSUE_TYPES.TEST_EXECUTION);

  const visible = await filterVisibleIssueIds(testIssueIds);
  return { statuses: await statusesForVisibleTests(visible, scope) };
}
