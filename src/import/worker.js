/**
 * Xray -> jawdatrace importer: the async-event consumer.
 *
 * WHY A QUEUE: a real project has thousands of Tests and tens of thousands of
 * runs, far more than one resolver call (25 s) can handle. A Jira admin starts
 * the import from the admin page (see src/resolvers/xrayImport.js). That
 * pushes ONE event to the `xray-import` queue; this consumer works through
 * pages for up to ~9 minutes, saves its position in KVS after every page, and
 * pushes the next event to continue. Nothing runs on a schedule; it stops when
 * the import is done or fails. This is a deliberate, one-off exception to the
 * "no background jobs" rule (docs/ENGINEERING_PRINCIPLES.md).
 *
 * STAGES (src/import/state.js):
 *  1. tests       Xray getTests, 50 per page
 *                 - steps          -> issue property `jawdatrace.steps` (bulk, as the app)
 *                 - Set membership -> Jira "Test Set" links (one POST each; Jira has no bulk endpoint)
 *                 - Plan membership-> plan_test rows (one SQL statement per page)
 *  2. executions  Xray getTestExecutions, 50 per page -> test_execution rows
 *  3. runs        Xray getTestRuns for those 50 Executions, 100 per page
 *                 -> execution_test + test_run rows (one SQL statement each per page)
 *                 then back to 2 for the next 50 Executions.
 *
 * IDEMPOTENT: Tests that already have steps are skipped, existing links are
 * not recreated, SQL inserts are INSERT IGNORE, and each run is keyed by
 * client_request_id = "xray:<Xray test run id>". Re-running is safe.
 *
 * AUTHORIZATION: only a Jira admin can start or resume an import (checked in
 * the resolver). Here we act AS THE APP, because there is no user in a queue
 * consumer and the admin may not see every issue.
 */
import { randomUUID } from 'node:crypto';
import { Queue } from '@forge/events';
import { runMigrations } from '../db/migrations';
import { insertExecutionTestRows, insertPlanTestPairs, insertRuns, upsertExecution } from '../db/queries';
import { jira, route } from '../resolvers/jira';
import { LINK_TYPES, STEPS_PROPERTY_KEY } from '../shared/constants';
import { EVIDENCE_VERSION } from '../shared/evidence';
import {
  isProjectKey,
  mapComment,
  mapEnvironment,
  mapExecutedAt,
  mapSteps,
  mapXrayStatus,
} from './mapping';
import { IMPORT_STATUS, STAGES, getCredentials, getState, saveState } from './state';
import {
  EXECUTIONS_QUERY,
  RUNS_PAGE,
  RUNS_QUERY,
  TESTS_PAGE,
  TESTS_QUERY,
  authenticate,
  graphql,
} from './xray';

export const QUEUE_KEY = 'xray-import';

// Stop taking new pages after this long; the function timeout is 900 s.
const TIME_BUDGET_MS = 9 * 60 * 1000;
// Xray Standard allows 300 requests per 5 minutes: stay at ~1 per second.
const XRAY_MIN_INTERVAL_MS = 1100;
// When Xray or Jira says "slow down", continue after this delay.
const RATE_LIMIT_DELAY_S = 120;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Continue the import in a new invocation. */
export async function enqueue(projectKey, runId, delayInSeconds = 0) {
  const queue = new Queue({ key: QUEUE_KEY });
  await queue.push({ body: { projectKey, runId }, ...(delayInSeconds ? { delayInSeconds } : {}) });
}

/** Xray query helper that keeps us under Xray's rate limit. */
function xrayClient(region, token) {
  let lastCall = 0;
  return async (query, variables) => {
    const wait = lastCall + XRAY_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    return graphql(region, token, query, variables);
  };
}

const projectJql = (projectKey) => `project = "${projectKey}"`;

// ---------------------------------------------------------------------------
// Stage 1: Tests (steps, Set links, Plan membership)
// ---------------------------------------------------------------------------

export async function importTestsPage(xray, state) {
  const data = await xray(TESTS_QUERY, { jql: projectJql(state.projectKey), start: state.start });
  const page = data?.getTests ?? { total: 0, results: [] };
  const tests = page.results ?? [];
  const counts = { ...state.counts };

  // One Jira request: existing links and the steps property for the whole page.
  // Tests deleted in Jira are simply missing from the answer and are skipped.
  const ids = tests.map((test) => String(test.issueId));
  const found = ids.length
    ? await jira('app', route`/rest/api/3/issue/bulkfetch`, {
        method: 'POST',
        body: { issueIdsOrKeys: ids, fields: ['issuelinks'], properties: [STEPS_PROPERTY_KEY] },
      })
    : { issues: [] };
  const issuesById = new Map((found?.issues ?? []).map((issue) => [String(issue.id), issue]));

  const propertyWrites = [];
  const planPairs = [];
  for (const test of tests) {
    const testId = String(test.issueId);
    const issue = issuesById.get(testId);
    if (!issue) continue;

    // Steps: never overwrite steps that already exist in jawdatrace.
    const steps = issue.properties?.[STEPS_PROPERTY_KEY] ? null : mapSteps(test.steps);
    if (steps) propertyWrites.push({ issueID: Number(testId), properties: { [STEPS_PROPERTY_KEY]: steps } });

    // Set membership: "Set contains Test". Seen from the Test, the Set is the
    // link's inwardIssue (same direction as createLink in the UI).
    const existingSets = new Set(
      (issue.fields?.issuelinks ?? [])
        .filter((link) => link.type?.name === LINK_TYPES.TEST_SET.name && link.inwardIssue)
        .map((link) => String(link.inwardIssue.id))
    );
    for (const set of test.testSets?.results ?? []) {
      const setId = String(set.issueId);
      if (existingSets.has(setId)) continue;
      try {
        await jira('app', route`/rest/api/3/issueLink`, {
          method: 'POST',
          body: { type: { name: LINK_TYPES.TEST_SET.name }, inwardIssue: { id: setId }, outwardIssue: { id: testId } },
        });
        counts.setLinks += 1;
      } catch (error) {
        if (error?.status === 429) throw error;
        counts.failedLinks += 1;
      }
    }

    for (const plan of test.testPlans?.results ?? []) {
      planPairs.push({ planIssueId: String(plan.issueId), testIssueId: testId });
    }

    const setsTotal = test.testSets?.total ?? 0;
    const plansTotal = test.testPlans?.total ?? 0;
    if (setsTotal > (test.testSets?.results ?? []).length || plansTotal > (test.testPlans?.results ?? []).length) {
      counts.truncated += 1;
    }
  }

  if (propertyWrites.length) {
    // Bulk set (up to 100 issues per call). Jira runs it as a background task.
    await jira('app', route`/rest/api/3/issue/properties/multi`, { method: 'POST', body: { issues: propertyWrites } });
    counts.stepsWritten += propertyWrites.length;
  }
  await insertPlanTestPairs(planPairs);
  counts.planTests += planPairs.length;
  counts.tests += tests.length;

  const nextStart = state.start + TESTS_PAGE;
  const finished = tests.length === 0 || nextStart >= (page.total ?? 0);
  return {
    ...state,
    counts,
    totals: { ...state.totals, tests: page.total ?? 0 },
    stage: finished ? STAGES.EXECUTIONS : STAGES.TESTS,
    start: finished ? 0 : nextStart,
  };
}

// ---------------------------------------------------------------------------
// Stage 2: Executions (environment, plan)
// ---------------------------------------------------------------------------

export async function importExecutionsPage(xray, state) {
  const data = await xray(EXECUTIONS_QUERY, { jql: projectJql(state.projectKey), start: state.start });
  const page = data?.getTestExecutions ?? { total: 0, results: [] };
  const executions = page.results ?? [];
  const counts = { ...state.counts };

  for (const execution of executions) {
    // jawdatrace links an Execution to at most one Plan; Xray allows several.
    const plans = execution.testPlans?.results ?? [];
    if ((execution.testPlans?.total ?? 0) > 1) counts.truncated += 1;
    await upsertExecution({
      executionIssueId: String(execution.issueId),
      projectId: state.projectId,
      planIssueId: plans[0] ? String(plans[0].issueId) : null,
      environment: mapEnvironment(execution.testEnvironments),
      createdBy: state.startedBy,
    });
  }
  counts.executions += executions.length;

  const execIds = executions.map((execution) => String(execution.issueId));
  const nextStart = state.start + execIds.length;
  const total = page.total ?? 0;
  if (execIds.length === 0) return { ...state, counts, stage: STAGES.DONE };
  return {
    ...state,
    counts,
    totals: { ...state.totals, executions: total },
    stage: STAGES.RUNS,
    execIds,
    runStart: 0,
    // Where stage 2 continues after the runs of these Executions.
    start: nextStart,
    execTotal: total,
  };
}

// ---------------------------------------------------------------------------
// Stage 3: Runs of the current batch of Executions
// ---------------------------------------------------------------------------

export async function importRunsPage(xray, state) {
  const data = await xray(RUNS_QUERY, { execIds: state.execIds, start: state.runStart });
  const page = data?.getTestRuns ?? { total: 0, results: [] };
  const xrayRuns = page.results ?? [];
  const counts = { ...state.counts };

  const members = [];
  const runs = [];
  xrayRuns.forEach((run, index) => {
    const testIssueId = run.test?.issueId ? String(run.test.issueId) : null;
    const executionIssueId = run.testExecution?.issueId ? String(run.testExecution.issueId) : null;
    if (!testIssueId || !executionIssueId) return;
    members.push({ executionIssueId, testIssueId, sortOrder: state.runStart + index + 1 });

    const status = mapXrayStatus(run.status?.name);
    if (status === null) {
      counts.todo += 1;
      return;
    }
    if (status === undefined) {
      counts.skippedStatus += 1;
      return;
    }
    runs.push({
      id: randomUUID(),
      testIssueId,
      executionIssueId,
      status,
      comment: mapComment(run.comment),
      // Xray evidence files stay in Xray; nothing to reference in Jira.
      evidence: { v: EVIDENCE_VERSION, items: [] },
      executedBy: run.executedById ? String(run.executedById) : state.startedBy,
      executedAt: mapExecutedAt(run) ?? new Date(),
      clientRequestId: `xray:${run.id}`,
    });
  });

  await insertExecutionTestRows(members);
  counts.runs += await insertRuns(runs);

  const nextRunStart = state.runStart + RUNS_PAGE;
  if (xrayRuns.length > 0 && nextRunStart < (page.total ?? 0)) {
    return { ...state, counts, runStart: nextRunStart };
  }
  // Runs of this batch done: next batch of Executions, or finished.
  const moreExecutions = state.start < (state.execTotal ?? 0);
  return {
    ...state,
    counts,
    stage: moreExecutions ? STAGES.EXECUTIONS : STAGES.DONE,
    execIds: [],
    runStart: 0,
  };
}

const STEP_BY_STAGE = {
  [STAGES.TESTS]: importTestsPage,
  [STAGES.EXECUTIONS]: importExecutionsPage,
  [STAGES.RUNS]: importRunsPage,
};

/**
 * Queue consumer entry point (manifest: function `importWorker`).
 * event.body = { projectKey, runId }. Events from an older run (the admin
 * restarted the import) are ignored.
 */
export async function handler(event) {
  const { projectKey, runId } = event?.body ?? {};
  if (!isProjectKey(projectKey) || typeof runId !== 'string') return;

  let state = await getState(projectKey);
  if (!state || state.runId !== runId) return;
  if (state.status === IMPORT_STATUS.DONE || state.status === IMPORT_STATUS.FAILED) return;

  const deadline = Date.now() + TIME_BUDGET_MS;
  try {
    await runMigrations();
    const credentials = await getCredentials();
    if (!credentials) {
      await saveState({ ...state, status: IMPORT_STATUS.FAILED, error: 'NO_CREDENTIALS' });
      return;
    }
    const token = await authenticate(credentials.region, credentials.clientId, credentials.clientSecret);
    const xray = xrayClient(credentials.region, token);

    state = { ...state, status: IMPORT_STATUS.RUNNING, error: null };
    while (state.stage !== STAGES.DONE && Date.now() < deadline) {
      state = await STEP_BY_STAGE[state.stage](xray, state);
      await saveState(state);
    }
    if (state.stage === STAGES.DONE) {
      await saveState({ ...state, status: IMPORT_STATUS.DONE });
    } else {
      await enqueue(projectKey, runId);
    }
  } catch (error) {
    const status = error?.status;
    if (status === 429 || status === 502 || status === 503 || status === 504) {
      // Progress up to the last finished page is saved; try again later.
      await saveState({ ...state, status: IMPORT_STATUS.WAITING, error: error?.code ?? `HTTP_${status}` });
      await enqueue(projectKey, runId, RATE_LIMIT_DELAY_S);
      return;
    }
    const code = error?.code ?? error?.name ?? 'Error';
    console.error(`[jawdatrace] xray import failed: ${code}${status ? ` ${status}` : ''}`);
    await saveState({ ...state, status: IMPORT_STATUS.FAILED, error: String(code) });
  }
}
