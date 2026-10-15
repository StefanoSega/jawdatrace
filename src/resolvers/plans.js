/**
 * Test Plan resolvers.
 *
 * Plan membership is app data (SQL) rather than Jira links so that a Test
 * doesn't collect a Jira link for every release plan it was ever part of.
 *
 * Cost per call:
 *  - getPlan:            1 Jira (plan) + 1 per 100 members (visibility) + 2 SQL
 *  - addPlanTests:       2 Jira (plan + edit permission) + 1 per 100 Tests + 1 SQL
 *  - removePlanTests:    2 Jira + 1 SQL
 *  - listPlanExecutions: 1 Jira (plan) + 1 per 100 executions + 2 SQL
 *  - getTestPlans:       1 Jira (test) + 1 bulk fetch + 1 SQL
 */
import { ISSUE_TYPES, LIMITS, SCOPE } from '../shared/constants';
import { ValidationError } from '../shared/evidence';
import { countStatuses, overallStatus } from '../shared/status';
import {
  deletePlanTests,
  fromSqlDateTime,
  insertPlanTests,
  selectPlanExecutionStatuses,
  selectPlanExecutionsWithCounts,
  selectPlansForTest,
  selectPlanTests,
} from '../db/queries';
import {
  assertIssueId,
  assertIssueIdList,
  describeVisibleIssues,
  fetchVisibleTests,
  filterVisibleIssueIds,
  getEditableIssue,
  getVisibleIssue,
} from './permissions';
import { statusesForVisibleTests } from './status';

function parseEnvironment(value) {
  if (value == null || value === '') return null;
  const environment = String(value).trim();
  if (environment.length > LIMITS.ENVIRONMENT_MAX) throw new ValidationError('Invalid environment.');
  return environment || null;
}

/** Plan members with their plan-scoped status and execution counts. */
export async function getPlan(payload) {
  const planIssueId = assertIssueId(payload?.planIssueId, 'plan id');
  const environment = parseEnvironment(payload?.environment);
  await getVisibleIssue(planIssueId, ISSUE_TYPES.TEST_PLAN);

  const members = await selectPlanTests(planIssueId);
  const memberIds = members.map((row) => row.test_issue_id);
  // One bulk request both filters by visibility and returns the table details.
  const details = await fetchVisibleTests(memberIds);
  const visibleIds = memberIds.filter((id) => details.has(id));
  const statuses = await statusesForVisibleTests(visibleIds, {
    kind: SCOPE.PLAN,
    id: planIssueId,
    environment,
  });

  const tests = members
    .filter((row) => details.has(row.test_issue_id))
    .map((row) => ({
      ...details.get(row.test_issue_id),
      executionCount: Number(row.execution_count) || 0,
      run: statuses[row.test_issue_id] ?? null,
    }));
  const counts = countStatuses(visibleIds, statuses);

  return {
    tests,
    hiddenCount: memberIds.length - visibleIds.length,
    counts,
    overall: overallStatus(counts),
  };
}

/** Add Tests (e.g. typed keys, JQL results, or all members of a Test Set). */
export async function addPlanTests(payload) {
  const planIssueId = assertIssueId(payload?.planIssueId, 'plan id');
  const requested = assertIssueIdList(payload?.testIssueIds ?? [], LIMITS.ADD_TESTS_MAX);
  await getEditableIssue(planIssueId, ISSUE_TYPES.TEST_PLAN);

  // Only Tests the user can see, and only issues of type Test.
  const testIds = await filterVisibleIssueIds(requested, ISSUE_TYPES.TEST);
  await insertPlanTests(planIssueId, testIds);
  return { added: testIds.length, skipped: requested.length - testIds.length };
}

export async function removePlanTests(payload) {
  const planIssueId = assertIssueId(payload?.planIssueId, 'plan id');
  const testIds = assertIssueIdList(payload?.testIssueIds ?? [], LIMITS.ADD_TESTS_MAX);
  await getEditableIssue(planIssueId, ISSUE_TYPES.TEST_PLAN);
  await deletePlanTests(planIssueId, testIds);
  return { removed: testIds.length };
}

/**
 * The plan's Test Executions with a progress summary each, computed from two
 * SQL statements in total (not one query per execution).
 */
export async function listPlanExecutions(payload) {
  const planIssueId = assertIssueId(payload?.planIssueId, 'plan id');
  await getVisibleIssue(planIssueId, ISSUE_TYPES.TEST_PLAN);

  const executions = await selectPlanExecutionsWithCounts(planIssueId);
  const described = new Map(
    (await describeVisibleIssues(executions.map((row) => row.execution_issue_id))).map((issue) => [issue.id, issue])
  );

  // Latest status per (execution, test) -> per-execution counts.
  const statusRows = await selectPlanExecutionStatuses(planIssueId);
  const byExecution = new Map();
  for (const row of statusRows) {
    const counts = byExecution.get(row.execution_issue_id) ?? {};
    counts[row.status] = (counts[row.status] ?? 0) + 1;
    byExecution.set(row.execution_issue_id, counts);
  }

  return {
    executions: executions
      .filter((row) => described.has(row.execution_issue_id))
      .map((row) => {
        const issue = described.get(row.execution_issue_id);
        const statusCounts = byExecution.get(row.execution_issue_id) ?? {};
        const total = Number(row.total) || 0;
        const ran = Object.values(statusCounts).reduce((sum, value) => sum + value, 0);
        const counts = {
          total,
          PASS: statusCounts.PASS ?? 0,
          FAIL: statusCounts.FAIL ?? 0,
          BLOCKED: statusCounts.BLOCKED ?? 0,
          EXECUTING: statusCounts.EXECUTING ?? 0,
          TODO: Math.max(0, total - ran),
        };
        return {
          id: issue.id,
          key: issue.key,
          summary: issue.summary,
          jiraStatus: issue.status,
          environment: row.environment,
          createdAt: fromSqlDateTime(row.created_at),
          counts,
          overall: overallStatus(counts),
        };
      }),
  };
}

/** Plans that contain a given Test (Test panel "Sets & Plans" tab). */
export async function getTestPlans(payload) {
  const testIssueId = assertIssueId(payload?.testIssueId, 'test id');
  await getVisibleIssue(testIssueId, ISSUE_TYPES.TEST);
  const planIds = await selectPlansForTest(testIssueId);
  return { plans: await describeVisibleIssues(planIds) };
}
