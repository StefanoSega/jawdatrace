/**
 * Data import: the async-event consumer.
 *
 * WHY A QUEUE: an import from another tool can hold thousands of Tests and
 * tens of thousands of runs, far more than one resolver call (25 s) can
 * handle. A Jira admin starts the import from the admin page (see
 * src/resolvers/dataImport.js). That pushes ONE event to the `data-import`
 * queue; this consumer works through pages for up to ~9 minutes, saves its
 * position in SQL after every page, and pushes the next event to continue.
 * Nothing runs on a schedule; it stops when the import is done or fails. This
 * is a deliberate exception to the "no background jobs" rule
 * (docs/ENGINEERING_PRINCIPLES.md).
 *
 * INPUT: `jawdatrace-import*.json` attachments on one Jira issue, in name
 * order (format: docs/IMPORT_FORMAT.md, validation: ./format.js). Each file is
 * imported section by section, 100 entries per page:
 *  1. tests       steps          -> issue property `jawdatrace.steps` (bulk)
 *  2. setLinks    Set membership -> Jira "Test Set" links (one POST each; Jira has no bulk endpoint)
 *  3. planTests   Plan membership-> plan_test rows (one SQL statement per page)
 *  4. executions  plan, environment, members -> test_execution / execution_test rows
 *  5. runs        -> test_run rows (one SQL statement per page)
 *
 * IDEMPOTENT: Tests that already have steps keep them, existing links are not
 * recreated, SQL inserts are INSERT IGNORE, and each run is keyed by
 * client_request_id = "imp:<run id from the file>". Re-running is safe.
 *
 * AUTHORIZATION: only a Jira admin can start or resume an import (checked in
 * the resolver). Here we act AS THE APP, because there is no user in a queue
 * consumer. So every page is checked against Jira first: an entry is skipped
 * unless all its issues exist, belong to the import's project and have the
 * expected issue type. A file can never touch another project.
 */
import { randomUUID } from 'node:crypto';
import api, { route } from '@forge/api';
import { Queue } from '@forge/events';
import { runMigrations } from '../db/migrations';
import {
  insertExecutionTestRows,
  insertPlanTestPairs,
  insertRuns,
  saveImportJob,
  selectImportJob,
  upsertExecution,
} from '../db/queries';
import { JiraError, bulkFetchIssues, jira } from '../resolvers/jira';
import { ISSUE_TYPES, LINK_TYPES, STEPS_PROPERTY_KEY } from '../shared/constants';
import { EVIDENCE_VERSION, ValidationError } from '../shared/evidence';
import { FILE_MAX_BYTES, isProjectKey, parseImportFile } from './format';

export const QUEUE_KEY = 'data-import';
export const PAGE_SIZE = 100;

/** Sections of a file, in the order they are imported. */
export const SECTIONS = Object.freeze(['tests', 'setLinks', 'planTests', 'executions', 'runs']);

export const IMPORT_STATUS = Object.freeze({
  RUNNING: 'running',
  WAITING: 'waiting', // rate-limited, will continue by itself
  DONE: 'done',
  FAILED: 'failed',
});

export function emptyCounts() {
  return {
    stepsWritten: 0, // Tests that got a jawdatrace.steps property
    stepsKept: 0, // Tests that already had steps (left as they are)
    setLinks: 0, // "Test Set" links created
    failedLinks: 0, // links Jira refused
    planTests: 0, // plan memberships written
    executions: 0, // Test Executions written
    runs: 0, // runs inserted (re-imports insert 0)
    skipped: 0, // entries whose issues are missing, in another project or of the wrong type
  };
}

// Stop taking new pages after this long; the function timeout is 900 s.
const TIME_BUDGET_MS = 9 * 60 * 1000;
// When Jira says "slow down", continue after this delay.
const RATE_LIMIT_DELAY_S = 120;
const RETRYABLE = new Set([429, 502, 503, 504]);

/** Continue the import in a new invocation. */
export async function enqueue(projectKey, runId, delayInSeconds = 0) {
  const queue = new Queue({ key: QUEUE_KEY });
  await queue.push({ body: { projectKey, runId }, ...(delayInSeconds ? { delayInSeconds } : {}) });
}

// ---------------------------------------------------------------------------
// Reading a file
// ---------------------------------------------------------------------------

// The parsed file of the current attachment, kept while the runtime is warm so
// each page doesn't download and parse the file again.
let cachedFile = null;

/** Download and parse one attachment (as the app). */
export async function loadFile(file, projectKey) {
  if (cachedFile?.id === file.id && cachedFile.projectKey === projectKey) return cachedFile.data;
  // redirect=false: Jira streams the content instead of redirecting to the media service.
  const response = await api
    .asApp()
    .requestJira(route`/rest/api/3/attachment/content/${file.id}?redirect=false`, { headers: { Accept: '*/*' } });
  if (!response.ok) throw new JiraError(response.status, `Attachment download failed with status ${response.status}`);
  const raw = await response.text();
  if (raw.length > FILE_MAX_BYTES) throw new ValidationError('The file is too large; split it.');
  const data = parseImportFile(raw, projectKey);
  cachedFile = { id: file.id, projectKey, data };
  return data;
}

export function _resetFileCacheForTests() {
  cachedFile = null;
}

// ---------------------------------------------------------------------------
// One page of one section
// ---------------------------------------------------------------------------

/**
 * Look up the issues of a page as the app, keeping only those in the import's
 * project. Returns a function `is(id, type)` for the type checks.
 */
async function checkIssues(ids, job, { fields = [], properties = [] } = {}) {
  const unique = [...new Set(ids.filter(Boolean))];
  const issues = unique.length
    ? await bulkFetchIssues('app', unique, ['project', 'issuetype', ...fields], properties)
    : [];
  const byId = new Map(
    issues
      .filter((issue) => String(issue.fields?.project?.id) === String(job.projectId))
      .map((issue) => [String(issue.id), issue])
  );
  const is = (id, type) => byId.get(id)?.fields?.issuetype?.name === type;
  return { byId, is };
}

async function importTests(page, job, counts) {
  const { byId, is } = await checkIssues(
    page.map((entry) => entry.testId),
    job,
    { properties: [STEPS_PROPERTY_KEY] }
  );
  const writes = [];
  for (const entry of page) {
    if (!is(entry.testId, ISSUE_TYPES.TEST)) {
      counts.skipped += 1;
      continue;
    }
    if (!entry.steps) continue;
    // Never overwrite steps that already exist in jawdatrace.
    if (byId.get(entry.testId).properties?.[STEPS_PROPERTY_KEY]) {
      counts.stepsKept += 1;
      continue;
    }
    writes.push({ issueID: Number(entry.testId), properties: { [STEPS_PROPERTY_KEY]: entry.steps } });
  }
  if (writes.length) {
    // Bulk set (up to 100 issues per call). Jira runs it as a background task.
    await jira('app', route`/rest/api/3/issue/properties/multi`, { method: 'POST', body: { issues: writes } });
    counts.stepsWritten += writes.length;
  }
}

async function importSetLinks(page, job, counts) {
  const { byId, is } = await checkIssues(
    page.flatMap((entry) => [entry.setId, entry.testId]),
    job,
    { fields: ['issuelinks'] }
  );
  for (const { setId, testId } of page) {
    if (!is(setId, ISSUE_TYPES.TEST_SET) || !is(testId, ISSUE_TYPES.TEST)) {
      counts.skipped += 1;
      continue;
    }
    // "Set contains Test". Seen from the Test, the Set is the link's
    // inwardIssue (same direction as createLink in the UI).
    const exists = (byId.get(testId).fields?.issuelinks ?? []).some(
      (link) => link.type?.name === LINK_TYPES.TEST_SET.name && String(link.inwardIssue?.id) === setId
    );
    if (exists) continue;
    try {
      await jira('app', route`/rest/api/3/issueLink`, {
        method: 'POST',
        body: { type: { name: LINK_TYPES.TEST_SET.name }, inwardIssue: { id: setId }, outwardIssue: { id: testId } },
      });
      counts.setLinks += 1;
    } catch (error) {
      if (RETRYABLE.has(error?.status)) throw error;
      counts.failedLinks += 1;
    }
  }
}

async function importPlanTests(page, job, counts) {
  const { is } = await checkIssues(
    page.flatMap((entry) => [entry.planId, entry.testId]),
    job
  );
  const pairs = [];
  for (const { planId, testId } of page) {
    if (is(planId, ISSUE_TYPES.TEST_PLAN) && is(testId, ISSUE_TYPES.TEST)) {
      pairs.push({ planIssueId: planId, testIssueId: testId });
    } else {
      counts.skipped += 1;
    }
  }
  await insertPlanTestPairs(pairs);
  counts.planTests += pairs.length;
}

async function importExecutions(page, job, counts) {
  const { is } = await checkIssues(
    page.flatMap((entry) => [entry.executionId, entry.planId, ...entry.testIds]),
    job
  );
  const members = [];
  for (const entry of page) {
    const planOk = entry.planId === null || is(entry.planId, ISSUE_TYPES.TEST_PLAN);
    if (!is(entry.executionId, ISSUE_TYPES.TEST_EXECUTION) || !planOk) {
      counts.skipped += 1;
      continue;
    }
    await upsertExecution({
      executionIssueId: entry.executionId,
      projectId: job.projectId,
      planIssueId: entry.planId,
      environment: entry.environment,
      createdBy: job.startedBy,
    });
    counts.executions += 1;
    entry.testIds.forEach((testId, index) => {
      if (is(testId, ISSUE_TYPES.TEST)) {
        members.push({ executionIssueId: entry.executionId, testIssueId: testId, sortOrder: index + 1 });
      } else {
        counts.skipped += 1;
      }
    });
  }
  await insertExecutionTestRows(members);
}

async function importRuns(page, job, counts) {
  const { is } = await checkIssues(
    page.flatMap((run) => [run.testId, run.executionId]),
    job
  );
  const members = [];
  const runs = [];
  page.forEach((run, index) => {
    const executionOk = run.executionId === null || is(run.executionId, ISSUE_TYPES.TEST_EXECUTION);
    if (!is(run.testId, ISSUE_TYPES.TEST) || !executionOk) {
      counts.skipped += 1;
      return;
    }
    if (run.executionId) {
      // A run implies membership; existing members keep their position.
      members.push({ executionIssueId: run.executionId, testIssueId: run.testId, sortOrder: job.offset + index + 1 });
    }
    runs.push({
      id: randomUUID(),
      testIssueId: run.testId,
      executionIssueId: run.executionId,
      status: run.status,
      comment: run.comment,
      // Files from the other tool are not copied; nothing to reference in Jira.
      evidence: { v: EVIDENCE_VERSION, items: [] },
      executedBy: run.executedBy ?? job.startedBy,
      executedAt: new Date(run.executedAt),
      clientRequestId: `imp:${run.id}`,
    });
  });
  await insertExecutionTestRows(members);
  counts.runs += await insertRuns(runs);
}

const IMPORT_SECTION = {
  tests: importTests,
  setLinks: importSetLinks,
  planTests: importPlanTests,
  executions: importExecutions,
  runs: importRuns,
};

/** Import the page at the job's cursor and return the job with the cursor moved on. */
export async function importPage(data, job) {
  const items = data[job.section] ?? [];
  const page = items.slice(job.offset, job.offset + PAGE_SIZE);
  const counts = { ...job.counts };
  if (page.length) await IMPORT_SECTION[job.section](page, job, counts);

  const offset = job.offset + PAGE_SIZE;
  if (offset < items.length) return { ...job, counts, offset };
  const nextSection = SECTIONS.indexOf(job.section) + 1;
  if (nextSection < SECTIONS.length) return { ...job, counts, section: SECTIONS[nextSection], offset: 0 };
  return { ...job, counts, fileIndex: job.fileIndex + 1, section: SECTIONS[0], offset: 0 };
}

/**
 * Queue consumer entry point (manifest: function `importWorker`).
 * event.body = { projectKey, runId }. Events from an older run (the admin
 * restarted the import) are ignored.
 */
export async function handler(event) {
  const { projectKey, runId } = event?.body ?? {};
  if (!isProjectKey(projectKey) || typeof runId !== 'string') return;

  await runMigrations();
  let job = await selectImportJob(projectKey);
  if (!job || job.runId !== runId) return;
  if (job.status === IMPORT_STATUS.DONE || job.status === IMPORT_STATUS.FAILED) return;

  const deadline = Date.now() + TIME_BUDGET_MS;
  try {
    job = { ...job, status: IMPORT_STATUS.RUNNING, error: null };
    while (job.fileIndex < job.files.length && Date.now() < deadline) {
      const data = await loadFile(job.files[job.fileIndex], projectKey);
      job = await importPage(data, job);
      await saveImportJob(job);
    }
    if (job.fileIndex >= job.files.length) {
      await saveImportJob({ ...job, status: IMPORT_STATUS.DONE });
    } else {
      await enqueue(projectKey, runId);
    }
  } catch (error) {
    if (RETRYABLE.has(error?.status)) {
      // Progress up to the last finished page is saved; try again later.
      await saveImportJob({ ...job, status: IMPORT_STATUS.WAITING, error: `HTTP_${error.status}` });
      await enqueue(projectKey, runId, RATE_LIMIT_DELAY_S);
      return;
    }
    // Our own validation messages are safe to show; anything else is a code.
    const file = job.files[job.fileIndex]?.name ?? '';
    const message =
      error instanceof ValidationError ? `${file}: ${error.message}` : String(error?.code ?? error?.name ?? 'Error');
    if (!(error instanceof ValidationError)) {
      console.error(`[jawdatrace] data import failed: ${message}${error?.status ? ` ${error.status}` : ''}`);
    }
    await saveImportJob({ ...job, status: IMPORT_STATUS.FAILED, error: message });
  }
}
