/**
 * Import bookkeeping in Forge KVS (key-value storage).
 *
 *  - One state record per project:   xray-import:<PROJECTKEY>
 *  - One secret for the Xray API key: xray-import-credentials
 *    (stored with setSecret, so it is encrypted and never sent to the UI)
 *
 * KVS needs the `storage:app` scope in manifest.yml.
 */
import { kvs } from '@forge/kvs';

const CREDENTIALS_KEY = 'xray-import-credentials';
const stateKey = (projectKey) => `xray-import:${projectKey}`;

/** Stages, in order. "runs" loops back to "executions" for the next page. */
export const STAGES = Object.freeze({
  TESTS: 'tests',
  EXECUTIONS: 'executions',
  RUNS: 'runs',
  DONE: 'done',
});

export const IMPORT_STATUS = Object.freeze({
  RUNNING: 'running',
  WAITING: 'waiting', // rate-limited, will continue by itself
  DONE: 'done',
  FAILED: 'failed',
});

export function emptyCounts() {
  return {
    tests: 0, // Tests read from Xray
    stepsWritten: 0, // Tests that got a jawdatrace.steps property
    setLinks: 0, // "Test Set" links created
    planTests: 0, // plan memberships written
    executions: 0, // Test Executions imported
    runs: 0, // runs inserted (re-imports insert 0)
    todo: 0, // Xray TODO runs (membership only)
    skippedStatus: 0, // runs with a custom Xray status we don't map
    truncated: 0, // Tests in more than 50 Sets/Plans (extra ones not imported)
    failedLinks: 0, // links Jira refused (e.g. Set deleted)
  };
}

export async function getCredentials() {
  return (await kvs.getSecret(CREDENTIALS_KEY)) ?? null;
}

export async function setCredentials(credentials) {
  await kvs.setSecret(CREDENTIALS_KEY, credentials);
}

export async function getState(projectKey) {
  return (await kvs.get(stateKey(projectKey))) ?? null;
}

export async function saveState(state) {
  await kvs.set(stateKey(state.projectKey), { ...state, updatedAt: new Date().toISOString() });
}
