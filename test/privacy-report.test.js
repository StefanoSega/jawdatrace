import { beforeEach, describe, expect, it, vi } from 'vitest';
import { privacyCalls, resetPrivacy, setPrivacyHandler } from './mocks/forge-api';
import { resetSql, setSqlHandler, sqlCalls } from './mocks/forge-sql';
import { handler } from '../src/privacy/report';

beforeEach(() => {
  resetSql();
  resetPrivacy();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const accountRow = (id) => ({ account_id: id, stored_since: '2026-10-01 10:00:00.000' });

function sqlWith({ accounts = [], jobs = [] }) {
  setSqlHandler((query, params) => {
    if (query.includes('FROM test_run') && query.includes('GROUP BY account_id')) {
      const afterId = params[0];
      return accounts.filter((id) => id > afterId).slice(0, 900).map(accountRow);
    }
    if (query.includes('SELECT state, updated_at FROM import_job')) {
      return jobs.map((job) => ({ state: JSON.stringify(job), updated_at: '2026-10-02 10:00:00.000' }));
    }
    return { affectedRows: 0 };
  });
}

describe('personal data report', () => {
  it('reports stored accounts 90 at a time with the oldest stored time', async () => {
    const accounts = Array.from({ length: 100 }, (_, i) => `acc-${String(i).padStart(3, '0')}`);
    sqlWith({ accounts });
    await handler();
    expect(privacyCalls.map((call) => call.length)).toEqual([90, 10]);
    expect(privacyCalls[0][0]).toEqual({ accountId: 'acc-000', updatedAt: '2026-10-01T10:00:00.000Z' });
    // "unknown" is never reported.
    const select = sqlCalls.find((call) => call.query.includes('GROUP BY account_id'));
    expect(select.params).toEqual(['', 'unknown']);
  });

  it('anonymises closed accounts in runs, executions and import jobs', async () => {
    sqlWith({ accounts: ['acc-1', 'acc-2'], jobs: [{ projectKey: 'ABC', startedBy: 'acc-2', files: [] }] });
    setPrivacyHandler(() => [
      { accountId: 'acc-2', status: 'closed' },
      { accountId: 'acc-1', status: 'updated' },
    ]);
    await handler();

    const runUpdate = sqlCalls.find((call) => call.query.startsWith('UPDATE test_run'));
    expect(runUpdate.params).toEqual(['unknown', 'acc-2']);
    const executionUpdate = sqlCalls.find((call) => call.query.startsWith('UPDATE test_execution'));
    expect(executionUpdate.params).toEqual(['unknown', 'acc-2']);
    const jobSave = sqlCalls.find((call) => call.query.includes('INTO import_job'));
    expect(JSON.parse(jobSave.params[1]).startedBy).toBe('unknown');
    // The admin was already reported with the runs: one report call only.
    expect(privacyCalls).toHaveLength(1);
  });

  it('reports import admins who have no runs', async () => {
    sqlWith({ accounts: [], jobs: [{ projectKey: 'ABC', startedBy: 'admin-9', startedAt: '2026-09-01T00:00:00.000Z' }] });
    await handler();
    expect(privacyCalls).toEqual([[{ accountId: 'admin-9', updatedAt: '2026-09-01T00:00:00.000Z' }]]);
  });

  it('stops quietly when Atlassian rate-limits, without logging account ids', async () => {
    sqlWith({ accounts: ['acc-1'] });
    setPrivacyHandler(() => Promise.reject({ status: 429 }));
    await handler();
    expect(console.error.mock.calls[0][0]).toContain('429');
    expect(console.error.mock.calls[0][0]).not.toContain('acc-1');
  });
});
