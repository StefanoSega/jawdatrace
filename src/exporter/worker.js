/**
 * Data export: the async-event consumer.
 *
 * A Jira admin starts an export of one project from the admin page (see
 * src/resolvers/dataExport.js). This consumer reads all of the project's app
 * data and attaches it to a Jira issue chosen by the admin, as
 * `jawdatrace-export-NNN.json` files (at most 5 MB each). The files use the
 * import format (docs/IMPORT_FORMAT.md), so they can be imported again into
 * this or another site, and the customer can read them without the app.
 *
 * What is exported:
 *  - tests       steps of every Test (issue property `jawdatrace.steps`)
 *  - setMembers  Test Set membership (Jira "Test Set" links)
 *  - planTests   Plan membership (SQL)
 *  - executions  plan, environment and members of every Execution (SQL)
 *  - runs        every run in those Executions, plus ad-hoc runs of the Tests (SQL)
 * Evidence references are not exported; the evidence files themselves are
 * Jira attachments on the Tests.
 *
 * It runs in ONE invocation (up to 15 minutes): one JQL page per 100 Tests,
 * Sets or Plans, and one SQL statement per 100 Executions, Plans or Tests.
 * That covers projects with tens of thousands of runs; the job fails with a
 * code (shown on the admin page) if a project is too large.
 *
 * AUTHORIZATION: only a Jira admin can start an export (checked in the
 * resolver), so the consumer reads AS THE APP, limited to the job's project.
 */
import api, { route } from '@forge/api';
import { Queue } from '@forge/events';
import { runMigrations } from '../db/migrations';
import {
  fromSqlDateTime,
  saveExportJob,
  selectAdHocRuns,
  selectExecutionMembers,
  selectExportJob,
  selectPlanMembers,
  selectProjectExecutions,
  selectRunsOfExecutions,
} from '../db/queries';
import { JiraError, searchJql } from '../resolvers/jira';
import { ISSUE_TYPES, LINK_TYPES, STEPS_PROPERTY_KEY, UNKNOWN_ACCOUNT } from '../shared/constants';
import { IMPORT_FORMAT, IMPORT_FORMAT_VERSION, isProjectKey } from '../importer/format';

export const EXPORT_QUEUE_KEY = 'data-export';
export const EXPORT_STATUS = Object.freeze({ RUNNING: 'running', DONE: 'done', FAILED: 'failed' });
export const FILE_TARGET_BYTES = 5 * 1024 * 1024;
const BATCH = 100;
const JQL_MAX = 1_000_000;

export async function enqueueExport(projectKey, runId) {
  await new Queue({ key: EXPORT_QUEUE_KEY }).push({ body: { projectKey, runId } });
}

const chunks = (items) => {
  const out = [];
  for (let index = 0; index < items.length; index += BATCH) out.push(items.slice(index, index + BATCH));
  return out;
};

/** The project's issues of one app issue type, as the app (project key is validated). */
function projectIssues(projectKey, issueType, fields, properties = []) {
  return searchJql(`project = "${projectKey}" AND issuetype = "${issueType}"`, fields, JQL_MAX, {
    as: 'app',
    properties,
  });
}

/** One run row -> an import-format run. */
function toRun(row) {
  // Runs that came from an import keep their original id, so importing the
  // export again (anywhere) is idempotent; other runs use their own id.
  const requestId = String(row.client_request_id ?? '');
  const id = requestId.startsWith('imp:') ? requestId.slice(4) : String(row.id);
  return {
    id,
    test: String(row.test_issue_id),
    execution: row.execution_issue_id ? String(row.execution_issue_id) : null,
    status: row.status,
    ...(row.executed_by && row.executed_by !== UNKNOWN_ACCOUNT ? { executedBy: row.executed_by } : {}),
    executedAt: fromSqlDateTime(row.executed_at),
    ...(row.comment ? { comment: row.comment } : {}),
  };
}

/** Read all of a project's app data into import-format sections. */
export async function buildExport({ projectKey, projectId }) {
  const tests = await projectIssues(projectKey, ISSUE_TYPES.TEST, ['issuetype'], [STEPS_PROPERTY_KEY]);
  const testIds = tests.map((issue) => String(issue.id));
  const testsSection = tests
    .filter((issue) => issue.properties?.[STEPS_PROPERTY_KEY]?.steps?.length)
    .map((issue) => ({ test: String(issue.id), steps: issue.properties[STEPS_PROPERTY_KEY].steps }));

  // Seen from a Set, the Tests it contains are the links' outwardIssue.
  const sets = await projectIssues(projectKey, ISSUE_TYPES.TEST_SET, ['issuelinks']);
  const setMembers = sets
    .map((issue) => ({
      set: String(issue.id),
      tests: (issue.fields?.issuelinks ?? [])
        .filter((link) => link.type?.name === LINK_TYPES.TEST_SET.name && link.outwardIssue)
        .map((link) => String(link.outwardIssue.id)),
    }))
    .filter((entry) => entry.tests.length);

  const plans = await projectIssues(projectKey, ISSUE_TYPES.TEST_PLAN, []);
  const planTests = new Map();
  for (const batch of chunks(plans.map((issue) => String(issue.id)))) {
    for (const row of await selectPlanMembers(batch)) {
      const planId = String(row.plan_issue_id);
      if (!planTests.has(planId)) planTests.set(planId, []);
      planTests.get(planId).push(String(row.test_issue_id));
    }
  }

  const executionRows = await selectProjectExecutions(projectId);
  const executions = new Map(
    executionRows.map((row) => [
      String(row.execution_issue_id),
      {
        execution: String(row.execution_issue_id),
        plan: row.plan_issue_id ? String(row.plan_issue_id) : null,
        environment: row.environment ?? null,
        tests: [],
      },
    ])
  );
  const runs = [];
  for (const batch of chunks([...executions.keys()])) {
    for (const row of await selectExecutionMembers(batch)) {
      executions.get(String(row.execution_issue_id))?.tests.push(String(row.test_issue_id));
    }
    for (const row of await selectRunsOfExecutions(batch)) runs.push(toRun(row));
  }
  for (const batch of chunks(testIds)) {
    for (const row of await selectAdHocRuns(batch)) runs.push(toRun(row));
  }

  return {
    tests: testsSection,
    setMembers,
    planTests: [...planTests].map(([plan, members]) => ({ plan, tests: members })),
    executions: [...executions.values()],
    runs,
  };
}

const SECTIONS = ['tests', 'setMembers', 'planTests', 'executions', 'runs'];

/** Split the sections into files of about `maxBytes`, keeping section order. */
export function splitIntoFiles(sections, projectKey, maxBytes = FILE_TARGET_BYTES) {
  const header = () => ({ format: IMPORT_FORMAT, version: IMPORT_FORMAT_VERSION, projectKey });
  const files = [];
  let current = header();
  let size = JSON.stringify(current).length;
  let entries = 0;
  for (const section of SECTIONS) {
    for (const entry of sections[section]) {
      const entrySize = JSON.stringify(entry).length + 1;
      if (entries > 0 && size + entrySize > maxBytes) {
        files.push(current);
        current = header();
        size = JSON.stringify(current).length;
        entries = 0;
      }
      if (!current[section]) {
        current[section] = [];
        size += section.length + 5;
      }
      current[section].push(entry);
      size += entrySize;
      entries += 1;
    }
  }
  files.push(current);
  return files;
}

/** Attach one file to an issue (as the app). */
async function attach(issueId, name, content) {
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'application/json' }), name);
  const response = await api.asApp().requestJira(route`/rest/api/3/issue/${issueId}/attachments`, {
    method: 'POST',
    headers: { 'X-Atlassian-Token': 'no-check', Accept: 'application/json' },
    body: form,
  });
  if (!response.ok) throw new JiraError(response.status, `Attachment upload failed with status ${response.status}`);
}

export const exportFileName = (stamp, index) => `jawdatrace-export-${stamp}-${String(index + 1).padStart(3, '0')}.json`;

/** Queue consumer entry point (manifest: function `exportWorker`). */
export async function handler(event) {
  const { projectKey, runId } = event?.body ?? {};
  if (!isProjectKey(projectKey) || typeof runId !== 'string') return;

  await runMigrations();
  const job = await selectExportJob(projectKey);
  if (!job || job.runId !== runId || job.status !== EXPORT_STATUS.RUNNING) return;

  try {
    const sections = await buildExport(job);
    const files = splitIntoFiles(sections, projectKey);
    // One stamp per export, so the files of different exports never mix.
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
    for (const [index, file] of files.entries()) {
      await attach(job.targetIssueId, exportFileName(stamp, index), JSON.stringify(file));
    }
    await saveExportJob({
      ...job,
      status: EXPORT_STATUS.DONE,
      files: files.length,
      counts: Object.fromEntries(SECTIONS.map((section) => [section, sections[section].length])),
    });
  } catch (error) {
    const code = String(error?.code ?? error?.name ?? 'Error');
    console.error(`[jawdatrace] data export failed: ${code}${error?.status ? ` ${error.status}` : ''}`);
    await saveExportJob({ ...job, status: EXPORT_STATUS.FAILED, error: code });
  }
}
