import { beforeEach, describe, expect, it } from 'vitest';
import { resetSql, setSqlHandler, sqlCalls } from './mocks/forge-sql';
import {
  fromSqlDateTime,
  insertExecutionTests,
  placeholders,
  selectLatestRuns,
  toSqlDateTime,
} from '../src/db/queries';

beforeEach(() => resetSql());

describe('helpers', () => {
  it('builds placeholder lists', () => {
    expect(placeholders(3)).toBe('?, ?, ?');
  });
  it('converts dates both ways in UTC', () => {
    const sqlValue = toSqlDateTime(new Date('2026-10-15T09:30:00.123Z'));
    expect(sqlValue).toBe('2026-10-15 09:30:00.123');
    expect(fromSqlDateTime(sqlValue)).toBe('2026-10-15T09:30:00.123Z');
  });
});

describe('selectLatestRuns', () => {
  it('does not hit SQL for an empty list', async () => {
    expect(await selectLatestRuns([], { kind: 'latest' })).toEqual([]);
    expect(sqlCalls).toHaveLength(0);
  });

  it('binds every value (ids, plan, environment) as parameters', async () => {
    await selectLatestRuns(['1', '2'], { kind: 'plan', id: '9', environment: "iOS' OR 1=1" });
    const [call] = sqlCalls;
    expect(call.params).toEqual(['1', '2', '9', "iOS' OR 1=1"]);
    expect(call.query).not.toContain('iOS');
    expect(call.query).toContain('e.plan_issue_id = ?');
    expect(call.query).toContain('e.environment = ?');
  });

  it('filters by execution in execution scope', async () => {
    await selectLatestRuns(['1'], { kind: 'execution', id: '5' });
    expect(sqlCalls[0].query).toContain('r.execution_issue_id = ?');
    expect(sqlCalls[0].params).toEqual(['1', '5']);
  });

  it('filters the latest scope by environment, as a bound parameter', async () => {
    await selectLatestRuns(['1'], { kind: 'latest', environment: 'iOS' });
    expect(sqlCalls[0].query).toContain('e.environment = ?');
    expect(sqlCalls[0].query).not.toContain('plan_issue_id = ?');
    expect(sqlCalls[0].params).toEqual(['1', 'iOS']);
  });

  it('ignores the environment in execution scope', async () => {
    await selectLatestRuns(['1'], { kind: 'execution', id: '5', environment: 'iOS' });
    expect(sqlCalls[0].query).not.toContain('e.environment = ?');
    expect(sqlCalls[0].params).toEqual(['1', '5']);
  });

  it('does not filter by environment when none is given', async () => {
    await selectLatestRuns(['1'], { kind: 'latest', environment: null });
    expect(sqlCalls[0].query).not.toContain('e.environment = ?');
  });

  it('ranks runs per Test and environment', async () => {
    await selectLatestRuns(['1'], { kind: 'latest' });
    expect(sqlCalls[0].query).toContain("PARTITION BY r.test_issue_id, COALESCE(e.environment, '')");
    expect(sqlCalls[0].query).toContain('LEFT JOIN test_execution e');
  });
});

describe('insertExecutionTests', () => {
  it('appends after the current max order in one multi-row insert', async () => {
    setSqlHandler((query) => (query.includes('MAX(sort_order)') ? [{ max_order: 4 }] : { affectedRows: 2 }));
    await insertExecutionTests('200', ['1', '2']);
    const insert = sqlCalls.find((call) => call.query.startsWith('INSERT IGNORE INTO execution_test'));
    expect(insert.params.filter((_, i) => i % 4 === 2)).toEqual([5, 6]);
    expect(sqlCalls).toHaveLength(2);
  });
});
