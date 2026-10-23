/**
 * The jawdatrace import file format (version 1), see docs/IMPORT_FORMAT.md.
 *
 * An admin attaches one or more `jawdatrace-import*.json` files to a Jira
 * issue and starts the import from the admin page. This module turns the
 * text of one file into clean, validated lists the worker can write. It is
 * pure (no Forge or network calls), so it is easy to unit-test.
 *
 * Everything is checked here, because the worker writes AS THE APP: issue
 * ids must be numeric strings, statuses must be known, texts are trimmed to
 * the app's limits. Invalid input throws a ValidationError that names the
 * offending entry (e.g. "runs[12].status: unknown status").
 */
import { LIMITS, RECORDABLE_STATUSES, STEPS_SCHEMA_VERSION } from '../shared/constants';
import { ValidationError } from '../shared/evidence';

export const IMPORT_FORMAT = 'jawdatrace-import';
export const IMPORT_FORMAT_VERSION = 1;

/** Attachments with this name are picked up, in name order. */
export const FILE_NAME_PATTERN = /^jawdatrace-import.*\.json$/i;
export const FILE_MAX_BYTES = 10 * 1024 * 1024;
export const FILES_MAX = 50;

// Per file, after flattening: keeps memory and one file's work bounded.
const ITEMS_MAX = 100_000;
const STEPS_MAX = 100;
const STEP_TEXT_MAX = 5000;
const RUN_ID_PATTERN = /^[A-Za-z0-9._:-]{1,48}$/;
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;

/** Jira project keys are upper-case letters, digits and underscores. */
export function isProjectKey(value) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,49}$/.test(value);
}

function fail(path, message) {
  throw new ValidationError(`${path}: ${message}`);
}

function issueId(value, path) {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof id !== 'string' || !/^\d{1,18}$/.test(id)) fail(path, 'expected a numeric issue id');
  return id;
}

function list(value, path) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(path, 'expected a list');
  return value;
}

function text(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

function steps(value, path) {
  const items = list(value, path);
  if (items.length > STEPS_MAX) fail(path, `at most ${STEPS_MAX} steps`);
  const cleaned = items
    .map((step, index) => ({
      id: text(step?.id, 64) || `s${index + 1}`,
      action: text(step?.action, STEP_TEXT_MAX),
      data: text(step?.data, STEP_TEXT_MAX),
      expected: text(step?.expected, STEP_TEXT_MAX),
    }))
    .filter((step) => step.action || step.data || step.expected);
  if (cleaned.length === 0) return null;
  // revision 1: the first saved version; later edits in the UI bump it.
  return { v: STEPS_SCHEMA_VERSION, revision: 1, steps: cleaned };
}

function executedAt(value, path) {
  const date = new Date(value);
  if (value === undefined || value === null || Number.isNaN(date.getTime())) fail(path, 'expected an ISO date');
  return date.toISOString();
}

/**
 * Parse and validate one import file.
 *
 * @param {string} raw - the file's text
 * @param {string} projectKey - the project the admin is importing into
 * @returns {{ tests, setLinks, planTests, executions, runs }} flat, clean lists
 */
export function parseImportFile(raw, projectKey) {
  let file;
  try {
    file = JSON.parse(raw);
  } catch {
    throw new ValidationError('The file is not valid JSON.');
  }
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw new ValidationError('The file is not an object.');
  if (file.format !== IMPORT_FORMAT) fail('format', `expected "${IMPORT_FORMAT}"`);
  if (file.version !== IMPORT_FORMAT_VERSION) fail('version', `expected ${IMPORT_FORMAT_VERSION}`);
  if (file.projectKey !== projectKey) fail('projectKey', `expected "${projectKey}"`);

  const tests = list(file.tests, 'tests').map((entry, index) => ({
    testId: issueId(entry?.test, `tests[${index}].test`),
    steps: steps(entry?.steps, `tests[${index}].steps`),
  }));

  // Membership lists are flattened into pairs, so the worker can page them.
  const setLinks = list(file.setMembers, 'setMembers').flatMap((entry, index) => {
    const setId = issueId(entry?.set, `setMembers[${index}].set`);
    return list(entry?.tests, `setMembers[${index}].tests`).map((test, position) => ({
      setId,
      testId: issueId(test, `setMembers[${index}].tests[${position}]`),
    }));
  });

  const planTests = list(file.planTests, 'planTests').flatMap((entry, index) => {
    const planId = issueId(entry?.plan, `planTests[${index}].plan`);
    return list(entry?.tests, `planTests[${index}].tests`).map((test, position) => ({
      planId,
      testId: issueId(test, `planTests[${index}].tests[${position}]`),
    }));
  });

  const executions = list(file.executions, 'executions').map((entry, index) => {
    const path = `executions[${index}]`;
    return {
      executionId: issueId(entry?.execution, `${path}.execution`),
      planId: entry?.plan === undefined || entry?.plan === null ? null : issueId(entry.plan, `${path}.plan`),
      environment: text(entry?.environment, LIMITS.ENVIRONMENT_MAX) || null,
      testIds: list(entry?.tests, `${path}.tests`).map((test, position) => issueId(test, `${path}.tests[${position}]`)),
    };
  });

  const runs = list(file.runs, 'runs').map((entry, index) => {
    const path = `runs[${index}]`;
    const id = String(entry?.id ?? '');
    if (!RUN_ID_PATTERN.test(id)) fail(`${path}.id`, 'expected 1-48 letters, digits or . _ : -');
    if (!RECORDABLE_STATUSES.includes(entry?.status)) fail(`${path}.status`, 'unknown status');
    const executedBy = entry?.executedBy === undefined || entry?.executedBy === null ? null : String(entry.executedBy);
    if (executedBy !== null && !ACCOUNT_ID_PATTERN.test(executedBy)) fail(`${path}.executedBy`, 'invalid account id');
    return {
      id,
      testId: issueId(entry?.test, `${path}.test`),
      executionId:
        entry?.execution === undefined || entry?.execution === null ? null : issueId(entry.execution, `${path}.execution`),
      status: entry.status,
      executedBy,
      executedAt: executedAt(entry?.executedAt, `${path}.executedAt`),
      comment: text(entry?.comment, LIMITS.COMMENT_MAX) || null,
    };
  });

  const total = tests.length + setLinks.length + planTests.length + executions.length + runs.length;
  if (total > ITEMS_MAX) throw new ValidationError(`Too many entries in one file (at most ${ITEMS_MAX}); split it.`);
  return { tests, setLinks, planTests, executions, runs };
}
