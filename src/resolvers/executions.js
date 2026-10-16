/**
 * Test Execution resolvers.
 *
 * A Test Execution is a real Jira issue (so it has a summary, assignee,
 * workflow, comments…). The app stores only what Jira can't: which Plan it
 * belongs to, its environment (e.g. "iOS"), and its ordered list of Tests.
 *
 * Cost per call:
 *  - createExecution: ~5 Jira requests (plan, permission, create meta, create
 *                     issue, visibility) + 3–4 SQL statements
 *  - getExecution:    1 Jira (execution) + 1 per 100 Tests + 1 bulk fetch (plan) + 3 SQL
 *  - updateExecution: 2–3 Jira + 2 SQL
 *  - add/removeExecutionTests: 2 Jira (+1 per 100 Tests) + 2 SQL
 *  - listEnvironments: 1 Jira (project) + 1 SQL
 */
import { ISSUE_TYPES, LIMITS, RUN_STATUS, SCOPE } from '../shared/constants';
import { ValidationError } from '../shared/evidence';
import { countStatuses, overallStatus } from '../shared/status';
import {
  deleteExecutionTests,
  ensureExecution,
  insertExecutionTests,
  selectEnvironments,
  selectExecution,
  selectExecutionTests,
  selectPlanTests,
  upsertExecution,
} from '../db/queries';
import { jira, route } from './jira';
import {
  ForbiddenError,
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
  if (value == null) return null;
  const environment = String(value).trim();
  if (environment.length > LIMITS.ENVIRONMENT_MAX) throw new ValidationError('Invalid environment.');
  return environment || null;
}

function parseSummary(value) {
  const summary = String(value ?? '').trim();
  if (!summary || summary.length > 255) throw new ValidationError('A summary of 1–255 characters is required.');
  return summary;
}

/** Find the "Test Execution" issue type id for a project, as the user. */
async function findExecutionIssueTypeId(projectId) {
  const meta = await jira('user', route`/rest/api/3/issue/createmeta/${projectId}/issuetypes?maxResults=100`);
  const type = (meta?.issueTypes ?? meta?.values ?? []).find((t) => t.name === ISSUE_TYPES.TEST_EXECUTION);
  if (!type) {
    throw new ValidationError(
      `The "${ISSUE_TYPES.TEST_EXECUTION}" issue type is not available in this project. Ask a Jira admin to add it.`
    );
  }
  return type.id;
}

/**
 * Create a Test Execution issue from a Test Plan and seed it with the plan's
 * Tests. Not atomic: if seeding fails after the issue was created, the issue
 * still exists and its panel offers to add Tests (we report a warning).
 *
 * payload: { planIssueId, summary, environment, include: 'all' | 'notPassed' }
 */
export async function createExecution(payload, accountId) {
  const planIssueId = assertIssueId(payload?.planIssueId, 'plan id');
  const summary = parseSummary(payload?.summary);
  const environment = parseEnvironment(payload?.environment);
  const include = payload?.include === 'notPassed' ? 'notPassed' : 'all';

  // The user must be able to edit the plan to add executions to it.
  const plan = await getEditableIssue(planIssueId, ISSUE_TYPES.TEST_PLAN);
  const projectId = String(plan.fields.project.id);

  // Create the Jira issue as the user (Jira checks "Create issues" permission).
  const issueTypeId = await findExecutionIssueTypeId(projectId);
  const created = await jira('user', route`/rest/api/3/issue`, {
    method: 'POST',
    body: { fields: { project: { id: projectId }, issuetype: { id: issueTypeId }, summary } },
  });
  const executionIssueId = String(created.id);

  try {
    await upsertExecution({ executionIssueId, projectId, planIssueId, environment, createdBy: accountId });

    // Seed with the plan's visible Tests, optionally skipping those already passed.
    const memberIds = (await selectPlanTests(planIssueId)).map((row) => row.test_issue_id);
    let testIds = await filterVisibleIssueIds(memberIds);
    if (include === 'notPassed' && testIds.length) {
      const statuses = await statusesForVisibleTests(testIds, { kind: SCOPE.PLAN, id: planIssueId, environment });
      testIds = testIds.filter((id) => statuses[id]?.status !== RUN_STATUS.PASS);
    }
    await insertExecutionTests(executionIssueId, testIds);
    return { key: created.key, id: executionIssueId, testCount: testIds.length };
  } catch (error) {
    // Issue exists but setup partially failed: tell the user instead of hiding it.
    return {
      key: created.key,
      id: executionIssueId,
      testCount: 0,
      warning: 'The Test Execution was created, but its Tests could not be added. Open it to add Tests.',
    };
  }
}

/** Everything the Test Execution panel needs, in one call. */
export async function getExecution(payload) {
  const executionIssueId = assertIssueId(payload?.executionIssueId, 'execution id');
  const issue = await getVisibleIssue(executionIssueId, ISSUE_TYPES.TEST_EXECUTION);

  const execution = await selectExecution(executionIssueId);
  const members = await selectExecutionTests(executionIssueId);
  const memberIds = members.map((row) => row.test_issue_id);
  // One bulk request both filters by visibility and returns the table details.
  const details = await fetchVisibleTests(memberIds);
  const visibleIds = memberIds.filter((id) => details.has(id));
  // Inside one Execution the newest run is the Test's current state (like
  // Xray's single test run per execution), so a re-run shows as EXECUTING.
  const statuses = await statusesForVisibleTests(visibleIds, {
    kind: SCOPE.EXECUTION,
    id: executionIssueId,
    finalPrecedence: false,
  });

  const [plan] = execution?.plan_issue_id ? await describeVisibleIssues([execution.plan_issue_id]) : [];
  const counts = countStatuses(visibleIds, statuses);

  return {
    initialized: Boolean(execution),
    projectId: String(issue.fields.project.id),
    environment: execution?.environment ?? null,
    plan: plan ?? (execution?.plan_issue_id ? { restricted: true } : null),
    tests: visibleIds.map((id) => ({ ...details.get(id), run: statuses[id] ?? null })),
    hiddenCount: memberIds.length - visibleIds.length,
    counts,
    overall: overallStatus(counts),
  };
}

/** Change the plan and/or environment of an execution. */
export async function updateExecution(payload, accountId) {
  const executionIssueId = assertIssueId(payload?.executionIssueId, 'execution id');
  const issue = await getEditableIssue(executionIssueId, ISSUE_TYPES.TEST_EXECUTION);
  const environment = parseEnvironment(payload?.environment);
  const planIssueId = payload?.planIssueId == null ? null : assertIssueId(payload.planIssueId, 'plan id');
  if (planIssueId) await getVisibleIssue(planIssueId, ISSUE_TYPES.TEST_PLAN);

  await upsertExecution({
    executionIssueId,
    projectId: String(issue.fields.project.id),
    planIssueId,
    environment,
    createdBy: accountId,
  });
  return { ok: true };
}

export async function addExecutionTests(payload, accountId) {
  const executionIssueId = assertIssueId(payload?.executionIssueId, 'execution id');
  const requested = assertIssueIdList(payload?.testIssueIds ?? [], LIMITS.ADD_TESTS_MAX);
  const issue = await getEditableIssue(executionIssueId, ISSUE_TYPES.TEST_EXECUTION);

  // Executions created via Jira's native Create dialog have no row yet.
  await ensureExecution({ executionIssueId, projectId: String(issue.fields.project.id), createdBy: accountId });
  const testIds = await filterVisibleIssueIds(requested, ISSUE_TYPES.TEST);
  await insertExecutionTests(executionIssueId, testIds);
  return { added: testIds.length, skipped: requested.length - testIds.length };
}

export async function removeExecutionTests(payload) {
  const executionIssueId = assertIssueId(payload?.executionIssueId, 'execution id');
  const testIds = assertIssueIdList(payload?.testIssueIds ?? [], LIMITS.ADD_TESTS_MAX);
  await getEditableIssue(executionIssueId, ISSUE_TYPES.TEST_EXECUTION);
  // Runs are history and are kept; only membership is removed.
  await deleteExecutionTests(executionIssueId, testIds);
  return { removed: testIds.length };
}

/** Environment suggestions for a project (values used by earlier executions). */
export async function listEnvironments(payload) {
  const projectId = assertIssueId(payload?.projectId, 'project id');
  try {
    await jira('user', route`/rest/api/3/project/${projectId}`);
  } catch {
    throw new ForbiddenError('Project not found or not accessible.');
  }
  return { environments: await selectEnvironments(projectId) };
}
