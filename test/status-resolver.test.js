import { beforeEach, describe, expect, it } from 'vitest';
import { resetJira, setJiraHandler } from './mocks/forge-api';
import { resetSql, setSqlHandler, sqlCalls } from './mocks/forge-sql';
import { buildStatusMap, getStatuses, parseScope } from '../src/resolvers/status';

beforeEach(() => {
  resetJira();
  resetSql();
});

describe('buildStatusMap', () => {
  it('combines latest-any and latest-final rows per Test', () => {
    const rows = [
      // Test 1: passed, then a newer EXECUTING re-run -> EXECUTING
      { test_issue_id: '1', status: 'EXECUTING', executed_at: '2026-10-02 10:00:00.000', rn_any: 1, rn_final: 1 },
      { test_issue_id: '1', status: 'PASS', executed_at: '2026-10-01 10:00:00.000', rn_any: 2, rn_final: 1 },
      // Test 2: only a final result that is also the newest row
      { test_issue_id: '2', status: 'FAIL', executed_at: '2026-10-01 10:00:00.000', rn_any: 1, rn_final: 1 },
    ];
    const map = buildStatusMap(rows);
    // Default (Xray's default): the final PASS has precedence over the re-run.
    expect(map['1'].status).toBe('PASS');
    expect(map['2'].status).toBe('FAIL');
    expect(map['2'].executedAt).toBe('2026-10-01T10:00:00.000Z');
    // Without final precedence the newer EXECUTING re-run wins.
    expect(buildStatusMap(rows, { finalPrecedence: false })['1'].status).toBe('EXECUTING');
  });
});

describe('buildStatusMap across environments (regression: dev-site Plan JDT-7)', () => {
  // iOS: JDT-2 failed, JDT-3 started; later, Android passed everything.
  const rows = [
    { test_issue_id: '2', env: 'iOS', status: 'FAIL', executed_at: '2026-10-15 11:26:33.000', rn_any: 1, rn_final: 1 },
    { test_issue_id: '2', env: 'Android', status: 'PASS', executed_at: '2026-10-15 11:28:10.000', rn_any: 1, rn_final: 1 },
    { test_issue_id: '3', env: 'iOS', status: 'EXECUTING', executed_at: '2026-10-15 11:27:00.000', rn_any: 1, rn_final: 1 },
    { test_issue_id: '3', env: 'Android', status: 'PASS', executed_at: '2026-10-15 11:28:40.000', rn_any: 1, rn_final: 1 },
    { test_issue_id: '1', env: 'iOS', status: 'PASS', executed_at: '2026-10-15 11:25:41.000', rn_any: 1, rn_final: 1 },
    { test_issue_id: '1', env: 'Android', status: 'PASS', executed_at: '2026-10-15 11:27:50.000', rn_any: 1, rn_final: 1 },
  ];

  it('does not let a later Android pass hide an iOS failure', () => {
    expect(buildStatusMap(rows)['2'].status).toBe('FAIL');
  });
  it('keeps an in-progress environment visible as EXECUTING', () => {
    expect(buildStatusMap(rows)['3'].status).toBe('EXECUTING');
  });
  it('passes only when every environment passed, reporting the latest run', () => {
    const map = buildStatusMap(rows);
    expect(map['1'].status).toBe('PASS');
    expect(map['1'].executedAt).toBe('2026-10-15T11:27:50.000Z');
  });
});

describe('parseScope', () => {
  it('defaults to latest and validates plan/execution ids', () => {
    expect(parseScope(undefined)).toEqual({ kind: 'latest', environment: null, finalPrecedence: true });
    expect(parseScope({ kind: 'plan', id: '5', environment: 'iOS' })).toEqual({
      kind: 'plan',
      id: '5',
      environment: 'iOS',
      finalPrecedence: true,
    });
    expect(() => parseScope({ kind: 'plan', id: 'abc' })).toThrow();
    expect(() => parseScope({ kind: 'everything' })).toThrow();
  });

  it('accepts an environment and the final-precedence flag on the latest scope', () => {
    expect(parseScope({ kind: 'latest', environment: 'Android', finalPrecedence: false })).toEqual({
      kind: 'latest',
      environment: 'Android',
      finalPrecedence: false,
    });
    expect(parseScope({ kind: 'latest', environment: '' }).environment).toBeNull();
    expect(() => parseScope({ kind: 'latest', environment: 'x'.repeat(101) })).toThrow(/environment/);
  });
});

describe('getStatuses', () => {
  it('only queries SQL for Tests the user can see', async () => {
    setJiraHandler((as, path, init) => ({
      status: 200,
      body: { issues: init.body.issueIdsOrKeys.filter((id) => id !== '2').map((id) => ({ id, fields: {} })) },
    }));
    setSqlHandler(() => []);
    await getStatuses({ testIssueIds: ['1', '2', '3'] });
    const select = sqlCalls.find((call) => call.query.includes('FROM test_run'));
    expect(select.params).toEqual(['1', '3']);
  });

  it('checks the Test Plan is visible when scoped to a plan', async () => {
    setJiraHandler((as, path) =>
      path.startsWith('/rest/api/3/issue/77') ? { status: 404 } : { status: 200, body: { issues: [] } }
    );
    await expect(getStatuses({ testIssueIds: ['1'], scope: { kind: 'plan', id: '77' } })).rejects.toThrow(
      /not accessible/
    );
    expect(sqlCalls).toHaveLength(0);
  });

  it('honours finalPrecedence=false from the UI scope', async () => {
    setJiraHandler((as, path, init) => ({
      status: 200,
      body: { issues: init.body.issueIdsOrKeys.map((id) => ({ id, fields: {} })) },
    }));
    setSqlHandler(() => [
      { test_issue_id: '1', env: 'iOS', status: 'EXECUTING', executed_at: '2026-10-02 10:00:00.000', rn_any: 1, rn_final: 1 },
      { test_issue_id: '1', env: 'iOS', status: 'PASS', executed_at: '2026-10-01 10:00:00.000', rn_any: 2, rn_final: 1 },
    ]);
    const on = await getStatuses({ testIssueIds: ['1'], scope: { kind: 'latest' } });
    expect(on.statuses['1'].status).toBe('PASS');
    const off = await getStatuses({ testIssueIds: ['1'], scope: { kind: 'latest', finalPrecedence: false } });
    expect(off.statuses['1'].status).toBe('EXECUTING');
  });

  it('caps the number of ids per call', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => String(i + 1));
    await expect(getStatuses({ testIssueIds: ids })).rejects.toThrow(/At most 500/);
  });
});
