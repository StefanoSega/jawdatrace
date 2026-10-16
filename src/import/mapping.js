/**
 * Pure helpers that turn Xray Cloud data into jawdatrace data.
 * No Forge or network calls here, so they are easy to unit-test.
 */
import { LIMITS, RUN_STATUS, STEPS_SCHEMA_VERSION } from '../shared/constants';

/** Marker put in front of imported run comments (and used as executed_by fallback). */
export const IMPORT_MARKER = 'Imported from Xray';

/**
 * Xray status name -> jawdatrace run status.
 *  - returns null for TODO (the Test is a member of the Execution but has no run)
 *  - returns undefined for statuses we don't know (custom statuses); the
 *    importer skips those runs and counts them, rather than guessing
 *
 * @param {string | undefined} name - e.g. "PASSED", "FAILED", "EXECUTING"
 */
export function mapXrayStatus(name) {
  switch (String(name ?? '').toUpperCase()) {
    case 'PASSED':
    case 'PASS':
      return RUN_STATUS.PASS;
    case 'FAILED':
    case 'FAIL':
      return RUN_STATUS.FAIL;
    case 'BLOCKED':
    case 'ABORTED':
      return RUN_STATUS.BLOCKED;
    case 'EXECUTING':
      return RUN_STATUS.EXECUTING;
    case 'TODO':
    case 'TO DO':
      return null;
    default:
      return undefined;
  }
}

/**
 * Xray manual steps -> the `jawdatrace.steps` issue property value.
 * Xray calls the expected result "result". Empty steps are dropped.
 *
 * @param {Array<{ id?: string, action?: string, data?: string, result?: string }>} xraySteps
 * @returns {{ v: number, revision: number, steps: object[] } | null} null when there are no steps
 */
export function mapSteps(xraySteps) {
  const steps = (xraySteps ?? [])
    .map((step, index) => ({
      id: String(step?.id ?? `xray-${index + 1}`),
      action: String(step?.action ?? '').trim(),
      data: String(step?.data ?? '').trim(),
      expected: String(step?.result ?? '').trim(),
    }))
    .filter((step) => step.action || step.data || step.expected);
  if (steps.length === 0) return null;
  // revision 1: the first saved version; later edits in the UI bump it.
  return { v: STEPS_SCHEMA_VERSION, revision: 1, steps };
}

/**
 * Xray allows several Test Environments per Execution ("iOS", "UAT"); we keep
 * one free-text environment, so join them in a stable order.
 */
export function mapEnvironment(testEnvironments) {
  const names = [...new Set((testEnvironments ?? []).map((name) => String(name).trim()).filter(Boolean))].sort();
  if (names.length === 0) return null;
  return names.join(', ').slice(0, LIMITS.ENVIRONMENT_MAX);
}

/** Run comment with an "Imported from Xray" prefix, within the comment limit. */
export function mapComment(comment) {
  const text = String(comment ?? '').trim();
  const full = text ? `[${IMPORT_MARKER}] ${text}` : `[${IMPORT_MARKER}]`;
  return full.slice(0, LIMITS.COMMENT_MAX);
}

/**
 * When the run happened: finishedOn for final runs, startedOn otherwise.
 * Returns a Date, or null when Xray has neither (the importer then uses "now").
 */
export function mapExecutedAt(run) {
  for (const value of [run?.finishedOn, run?.startedOn]) {
    if (!value) continue;
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

/** Jira project keys are upper-case letters, digits and underscores. */
export function isProjectKey(value) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,49}$/.test(value);
}
