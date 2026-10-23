/**
 * Admin resolvers for the data export (Jira administrators only).
 *
 *  - startExport:    export one project's app data as jawdatrace-export-*.json
 *                    attachments on an issue of that project; the work
 *                    happens in the queue consumer (src/exporter/worker.js).
 *  - getExportState: status for the admin page (the admin presses "Refresh").
 *
 * Cost: one Forge invocation per button press, plus one Jira request to check
 * the target issue when an export starts.
 */
import { randomUUID } from 'node:crypto';
import { saveExportJob, selectExportJob } from '../db/queries';
import { ValidationError } from '../shared/evidence';
import { isProjectKey } from '../importer/format';
import { EXPORT_STATUS, enqueueExport } from '../exporter/worker';
import { jira, route } from './jira';
import { ForbiddenError, assertJiraAdmin } from './permissions';

function parseProjectKey(value) {
  const projectKey = String(value ?? '').trim().toUpperCase();
  if (!isProjectKey(projectKey)) throw new ValidationError('Enter a valid project key, e.g. ABC.');
  return projectKey;
}

function parseIssueKey(value) {
  const issueKey = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{0,49}-\d{1,18}$/.test(issueKey)) {
    throw new ValidationError('Enter the key of the issue to attach the export to, e.g. ABC-123.');
  }
  return issueKey;
}

function publicState(job) {
  if (!job) return null;
  const { projectKey, targetIssueKey, status, error, files, counts, startedAt, updatedAt } = job;
  return { projectKey, targetIssueKey, status, error, files: files ?? 0, counts: counts ?? {}, startedAt, updatedAt };
}

export async function getExportState(payload) {
  await assertJiraAdmin();
  if (!payload?.projectKey) return { state: null };
  return { state: publicState(await selectExportJob(parseProjectKey(payload.projectKey))) };
}

/** payload: { projectKey, issueKey } */
export async function startExport(payload) {
  await assertJiraAdmin();
  const projectKey = parseProjectKey(payload?.projectKey);
  const targetIssueKey = parseIssueKey(payload?.issueKey);

  let issue;
  try {
    issue = await jira('user', route`/rest/api/3/issue/${targetIssueKey}?fields=project`);
  } catch {
    throw new ForbiddenError('Issue not found or not accessible.');
  }
  if (issue?.fields?.project?.key !== projectKey) {
    throw new ValidationError(`${targetIssueKey} is not in project ${projectKey}.`);
  }

  const previous = await selectExportJob(projectKey);
  if (previous?.status === EXPORT_STATUS.RUNNING && Date.now() - Date.parse(previous.updatedAt) < 20 * 60 * 1000) {
    throw new ValidationError('An export of this project is already running.');
  }
  const job = {
    projectKey,
    projectId: String(issue.fields.project.id),
    targetIssueKey,
    targetIssueId: String(issue.id),
    runId: randomUUID(),
    startedAt: new Date().toISOString(),
    status: EXPORT_STATUS.RUNNING,
    error: null,
  };
  await saveExportJob(job);
  await enqueueExport(projectKey, job.runId);
  return { state: publicState({ ...job, updatedAt: new Date().toISOString() }) };
}
