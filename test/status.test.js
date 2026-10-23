import { describe, expect, it } from 'vitest';
import { OVERALL } from '../src/shared/constants';
import {
  combineEnvironmentStatuses,
  countStatuses,
  overallStatus,
  resolveDisplayStatus,
} from '../src/shared/status';

describe('combineEnvironmentStatuses', () => {
  const at = (status, time) => ({ status, executedAt: `2026-10-15T${time}:00.000Z` });
  it('lets the worst status win: FAIL > BLOCKED > EXECUTING > PASS', () => {
    expect(combineEnvironmentStatuses([at('PASS', '12:00'), at('FAIL', '10:00')]).status).toBe('FAIL');
    expect(combineEnvironmentStatuses([at('PASS', '12:00'), at('BLOCKED', '10:00')]).status).toBe('BLOCKED');
    expect(combineEnvironmentStatuses([at('PASS', '12:00'), at('EXECUTING', '10:00')]).status).toBe('EXECUTING');
  });
  it('picks the most recent run among equals and ignores missing entries', () => {
    expect(combineEnvironmentStatuses([at('PASS', '10:00'), null, at('PASS', '12:00')]).executedAt).toBe(
      '2026-10-15T12:00:00.000Z'
    );
    expect(combineEnvironmentStatuses([])).toBeNull();
  });
});

describe('countStatuses', () => {
  it('counts missing statuses as TODO and de-duplicates ids', () => {
    const counts = countStatuses(['1', '2', '3', '3'], {
      1: { status: 'PASS' },
      2: { status: 'FAIL' },
    });
    expect(counts).toEqual({ total: 3, PASS: 1, FAIL: 1, BLOCKED: 0, EXECUTING: 0, TODO: 1 });
  });

  it('handles an empty list', () => {
    expect(countStatuses([], {}).total).toBe(0);
  });
});

describe('overallStatus', () => {
  const base = { total: 0, PASS: 0, FAIL: 0, BLOCKED: 0, EXECUTING: 0, TODO: 0 };

  it('is NO_TESTS when there are no tests', () => {
    expect(overallStatus(base)).toBe(OVERALL.NO_TESTS);
  });
  it('is NOK when any test failed, even if others are not run', () => {
    expect(overallStatus({ ...base, total: 3, PASS: 1, FAIL: 1, TODO: 1 })).toBe(OVERALL.NOK);
  });
  it('is INCOMPLETE when something is blocked, executing or not run', () => {
    expect(overallStatus({ ...base, total: 2, PASS: 1, BLOCKED: 1 })).toBe(OVERALL.INCOMPLETE);
    expect(overallStatus({ ...base, total: 2, PASS: 1, EXECUTING: 1 })).toBe(OVERALL.INCOMPLETE);
    expect(overallStatus({ ...base, total: 2, PASS: 1, TODO: 1 })).toBe(OVERALL.INCOMPLETE);
  });
  it('is OK when everything passed', () => {
    expect(overallStatus({ ...base, total: 2, PASS: 2 })).toBe(OVERALL.OK);
  });
});

describe('resolveDisplayStatus', () => {
  const pass = { status: 'PASS', executedAt: '2026-10-01T10:00:00.000Z' };
  const olderExecuting = { status: 'EXECUTING', executedAt: '2026-09-01T10:00:00.000Z' };
  const newerExecuting = { status: 'EXECUTING', executedAt: '2026-10-02T10:00:00.000Z' };

  it('prefers the final result over an older EXECUTING run', () => {
    expect(resolveDisplayStatus(pass, olderExecuting)).toBe(pass);
  });
  it('keeps the final result over a newer EXECUTING re-run by default', () => {
    expect(resolveDisplayStatus(pass, newerExecuting)).toBe(pass);
    expect(resolveDisplayStatus(pass, newerExecuting, { finalPrecedence: true })).toBe(pass);
  });
  it('shows a newer EXECUTING re-run when final precedence is off', () => {
    expect(resolveDisplayStatus(pass, newerExecuting, { finalPrecedence: false })).toBe(newerExecuting);
    expect(resolveDisplayStatus(pass, olderExecuting, { finalPrecedence: false })).toBe(pass);
  });
  it('shows EXECUTING when there is no final result', () => {
    expect(resolveDisplayStatus(undefined, newerExecuting)).toBe(newerExecuting);
  });
  it('returns null when there are no runs', () => {
    expect(resolveDisplayStatus(undefined, undefined)).toBeNull();
  });
});
