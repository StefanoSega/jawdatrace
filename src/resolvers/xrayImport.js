/**
 * Admin resolvers for the one-off Xray import (Jira administrators only).
 *
 *  - saveXrayCredentials: check an Xray API key against Xray, then store it as
 *    a Forge secret. The secret is never returned to the browser or logged.
 *  - startXrayImport:     start (or restart / resume) the import of one
 *    project; the work itself happens in the queue consumer
 *    (src/import/worker.js), so this returns immediately.
 *  - getXrayImportState:  progress counters for the admin page (no polling;
 *    the admin presses "Refresh").
 *
 * Cost: one Forge invocation per button press, plus one Xray authentication
 * call when saving the key.
 */
import { randomUUID } from 'node:crypto';
import { ValidationError } from '../shared/evidence';
import { isProjectKey } from '../import/mapping';
import { IMPORT_STATUS, STAGES, emptyCounts, getCredentials, getState, saveState, setCredentials } from '../import/state';
import { enqueue } from '../import/worker';
import { XRAY_REGIONS, authenticate } from '../import/xray';
import { jira, route } from './jira';
import { ForbiddenError, assertJiraAdmin } from './permissions';

function parseProjectKey(value) {
  const projectKey = String(value ?? '').trim().toUpperCase();
  if (!isProjectKey(projectKey)) throw new ValidationError('Enter a valid project key, e.g. BA.');
  return projectKey;
}

/** The import state minus anything internal the UI doesn't need. */
function publicState(state) {
  if (!state) return null;
  const { projectKey, stage, status, error, counts, totals, startedAt, updatedAt } = state;
  return { projectKey, stage, status, error, counts, totals: totals ?? {}, startedAt, updatedAt };
}

export async function getXrayImportState(payload) {
  await assertJiraAdmin();
  const credentials = await getCredentials();
  const projectKey = payload?.projectKey ? parseProjectKey(payload.projectKey) : null;
  return {
    hasCredentials: Boolean(credentials),
    region: credentials?.region ?? null,
    state: projectKey ? publicState(await getState(projectKey)) : null,
  };
}

export async function saveXrayCredentials(payload) {
  await assertJiraAdmin();
  const clientId = String(payload?.clientId ?? '').trim();
  const clientSecret = String(payload?.clientSecret ?? '').trim();
  const region = String(payload?.region ?? 'global');
  if (!clientId || clientId.length > 200 || !clientSecret || clientSecret.length > 500) {
    throw new ValidationError('Enter the Xray Client ID and Client Secret.');
  }
  if (!Object.hasOwn(XRAY_REGIONS, region)) throw new ValidationError('Unknown Xray region.');

  try {
    await authenticate(region, clientId, clientSecret);
  } catch (error) {
    throw new ValidationError(
      error?.status === 401 || error?.status === 400
        ? 'Xray rejected this API key. Check the Client ID and Secret.'
        : 'Could not reach Xray. Try again later.'
    );
  }
  await setCredentials({ clientId, clientSecret, region });
  return { hasCredentials: true, region };
}

/**
 * payload: { projectKey, restart?: boolean }
 *  - restart=false (Resume): continue from the saved position
 *  - restart=true  (Start):  start over from the first page; safe because
 *    every write is idempotent, and events of the previous run are ignored
 */
export async function startXrayImport(payload, accountId) {
  await assertJiraAdmin();
  const projectKey = parseProjectKey(payload?.projectKey);
  if (!(await getCredentials())) throw new ValidationError('Save an Xray API key first.');

  // The project must exist and be visible to the admin.
  let project;
  try {
    project = await jira('user', route`/rest/api/3/project/${projectKey}`);
  } catch {
    throw new ForbiddenError('Project not found or not accessible.');
  }

  const previous = await getState(projectKey);
  const resume = !payload?.restart && previous && previous.status !== IMPORT_STATUS.DONE;
  const state = resume
    ? { ...previous, runId: randomUUID(), status: IMPORT_STATUS.RUNNING, error: null }
    : {
        projectKey,
        projectId: String(project.id),
        runId: randomUUID(),
        startedBy: accountId,
        startedAt: new Date().toISOString(),
        stage: STAGES.TESTS,
        start: 0,
        status: IMPORT_STATUS.RUNNING,
        error: null,
        counts: emptyCounts(),
        totals: {},
      };
  await saveState(state);
  await enqueue(projectKey, state.runId);
  return { state: publicState(state) };
}
