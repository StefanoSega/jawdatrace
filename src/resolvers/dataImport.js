/**
 * Admin resolvers for the data import (Jira administrators only).
 *
 *  - startImport:    start (or restart / resume) importing the
 *                    `jawdatrace-import*.json` attachments of one issue into a
 *                    project; the work itself happens in the queue consumer
 *                    (src/importer/worker.js), so this returns immediately.
 *  - getImportState: progress counters for the admin page (no polling; the
 *                    admin presses "Refresh").
 *
 * Cost: one Forge invocation per button press, plus one Jira request to list
 * the attachments when an import starts.
 */
import { randomUUID } from 'node:crypto';
import { saveImportJob, selectImportJob } from '../db/queries';
import { ValidationError } from '../shared/evidence';
import { FILES_MAX, FILE_MAX_BYTES, FILE_NAME_PATTERN, isProjectKey } from '../importer/format';
import { IMPORT_STATUS, SECTIONS, emptyCounts, enqueue } from '../importer/worker';
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
    throw new ValidationError('Enter the key of the issue that holds the import files, e.g. ABC-123.');
  }
  return issueKey;
}

/** The job minus anything internal the UI doesn't need. */
function publicState(job) {
  if (!job) return null;
  const { projectKey, sourceIssueKey, files, fileIndex, section, status, error, counts, startedAt, updatedAt } = job;
  return {
    projectKey,
    sourceIssueKey,
    files: files.map((file) => file.name),
    fileIndex,
    section,
    status,
    error,
    counts,
    startedAt,
    updatedAt,
  };
}

export async function getImportState(payload) {
  await assertJiraAdmin();
  if (!payload?.projectKey) return { state: null };
  return { state: publicState(await selectImportJob(parseProjectKey(payload.projectKey))) };
}

/**
 * The import files attached to an issue (as the admin), in name order.
 * The issue must belong to the project being imported into.
 */
async function listImportFiles(issueKey, projectKey) {
  let issue;
  try {
    issue = await jira('user', route`/rest/api/3/issue/${issueKey}?fields=project,attachment`);
  } catch {
    throw new ForbiddenError('Issue not found or not accessible.');
  }
  if (issue?.fields?.project?.key !== projectKey) {
    throw new ValidationError(`${issueKey} is not in project ${projectKey}.`);
  }
  const files = (issue.fields.attachment ?? [])
    .filter((attachment) => FILE_NAME_PATTERN.test(String(attachment.filename)))
    .sort((a, b) => String(a.filename).localeCompare(String(b.filename)));
  if (files.length === 0) throw new ValidationError(`${issueKey} has no jawdatrace-import*.json attachments.`);
  if (files.length > FILES_MAX) throw new ValidationError(`At most ${FILES_MAX} import files per issue.`);
  const tooLarge = files.find((file) => Number(file.size) > FILE_MAX_BYTES);
  if (tooLarge) throw new ValidationError(`${tooLarge.filename} is larger than 10 MB; split it.`);
  return {
    projectId: String(issue.fields.project.id),
    files: files.map((file) => ({ id: String(file.id), name: String(file.filename) })),
  };
}

/**
 * payload: { projectKey, issueKey, restart?: boolean }
 *  - restart=false (Resume): continue an unfinished import from its saved position
 *  - restart=true  (Start):  list the attachments again and start from the
 *    first file; safe because every write is idempotent, and events of the
 *    previous run are ignored
 */
export async function startImport(payload, accountId) {
  await assertJiraAdmin();
  const projectKey = parseProjectKey(payload?.projectKey);
  const previous = await selectImportJob(projectKey);
  const resume = !payload?.restart && previous && previous.status !== IMPORT_STATUS.DONE;

  let job;
  if (resume) {
    job = { ...previous, runId: randomUUID(), status: IMPORT_STATUS.RUNNING, error: null };
  } else {
    const sourceIssueKey = parseIssueKey(payload?.issueKey);
    const { projectId, files } = await listImportFiles(sourceIssueKey, projectKey);
    job = {
      projectKey,
      projectId,
      sourceIssueKey,
      files,
      runId: randomUUID(),
      startedBy: accountId,
      startedAt: new Date().toISOString(),
      fileIndex: 0,
      section: SECTIONS[0],
      offset: 0,
      status: IMPORT_STATUS.RUNNING,
      error: null,
      counts: emptyCounts(),
    };
  }
  await saveImportJob(job);
  await enqueue(projectKey, job.runId);
  return { state: publicState({ ...job, updatedAt: new Date().toISOString() }) };
}
