import { beforeEach, describe, expect, it } from 'vitest';
import { jiraCalls, resetFetch, resetJira, setFetchHandler, setJiraHandler } from './mocks/forge-api';
import { pushedEvents, resetEvents } from './mocks/forge-events';
import { kvsData, kvsSecrets, resetKvs } from './mocks/forge-kvs';
import { resetSql, setSqlHandler, sqlCalls } from './mocks/forge-sql';
import { mapComment, mapEnvironment, mapExecutedAt, mapSteps, mapXrayStatus } from '../src/import/mapping';
import { STAGES, emptyCounts } from '../src/import/state';
import { handler, importExecutionsPage, importRunsPage, importTestsPage } from '../src/import/worker';
import { saveXrayCredentials, startXrayImport } from '../src/resolvers/xrayImport';

beforeEach(() => {
  resetJira();
  resetSql();
  resetFetch();
  resetEvents();
  resetKvs();
});

const baseState = (overrides = {}) => ({
  projectKey: 'BA',
  projectId: '10000',
  runId: 'run-1',
  startedBy: 'admin-1',
  stage: STAGES.TESTS,
  start: 0,
  status: 'running',
  counts: emptyCounts(),
  totals: {},
  ...overrides,
});

// A fake Xray client: returns the canned GraphQL `data` for each call in order.
function fakeXray(...pages) {
  const calls = [];
  const xray = async (query, variables) => {
    calls.push({ query, variables });
    return pages.shift();
  };
  return { xray, calls };
}

describe('mapping', () => {
  it('maps Xray statuses, TODO as membership only, unknown as skipped', () => {
    expect(mapXrayStatus('PASSED')).toBe('PASS');
    expect(mapXrayStatus('FAILED')).toBe('FAIL');
    expect(mapXrayStatus('ABORTED')).toBe('BLOCKED');
    expect(mapXrayStatus('BLOCKED')).toBe('BLOCKED');
    expect(mapXrayStatus('EXECUTING')).toBe('EXECUTING');
    expect(mapXrayStatus('TODO')).toBeNull();
    expect(mapXrayStatus('RETEST')).toBeUndefined();
  });

  it('maps steps (result -> expected) and returns null when there are none', () => {
    expect(mapSteps([{ id: 's1', action: 'Open app', data: '', result: 'Home shows' }])).toEqual({
      v: 1,
      revision: 1,
      steps: [{ id: 's1', action: 'Open app', data: '', expected: 'Home shows' }],
    });
    expect(mapSteps([])).toBeNull();
    expect(mapSteps([{ id: 'x', action: ' ', data: '', result: '' }])).toBeNull();
  });

  it('joins several environments in a stable order', () => {
    expect(mapEnvironment(['iOS'])).toBe('iOS');
    expect(mapEnvironment(['UAT', 'Android', 'UAT'])).toBe('Android, UAT');
    expect(mapEnvironment([])).toBeNull();
  });

  it('marks comments as imported and prefers finishedOn', () => {
    expect(mapComment('broken on login')).toBe('[Imported from Xray] broken on login');
    expect(mapComment(null)).toBe('[Imported from Xray]');
    expect(mapExecutedAt({ startedOn: '2026-10-01T10:00:00Z', finishedOn: '2026-10-01T11:00:00Z' }).toISOString()).toBe(
      '2026-10-01T11:00:00.000Z'
    );
    expect(mapExecutedAt({})).toBeNull();
  });
});

describe('importTestsPage', () => {
  const page = {
    getTests: {
      total: 2,
      results: [
        {
          issueId: '1',
          steps: [{ id: 's1', action: 'Do', data: '', result: 'Done' }],
          testSets: { total: 2, results: [{ issueId: '50' }, { issueId: '51' }] },
          testPlans: { total: 1, results: [{ issueId: '70' }] },
        },
        // Already has jawdatrace steps: never overwritten.
        { issueId: '2', steps: [{ id: 's2', action: 'X', result: 'Y' }], testSets: { total: 0, results: [] }, testPlans: { total: 0, results: [] } },
      ],
    },
  };

  beforeEach(() => {
    setJiraHandler((as, path) => {
      if (path === '/rest/api/3/issue/bulkfetch') {
        return {
          status: 200,
          body: {
            issues: [
              // Test 1 is already in Set 50 (seen from the Test, the Set is the inwardIssue).
              { id: '1', fields: { issuelinks: [{ type: { name: 'Test Set' }, inwardIssue: { id: '50' } }] } },
              { id: '2', fields: { issuelinks: [] }, properties: { 'jawdatrace.steps': { v: 1, steps: [] } } },
            ],
          },
        };
      }
      return { status: 201, body: {} };
    });
  });

  it('writes missing steps in bulk, creates only missing Set links, and records plan membership', async () => {
    const { xray } = fakeXray(page);
    const next = await importTestsPage(xray, baseState());

    expect(jiraCalls.every((call) => call.as === 'app')).toBe(true);
    const bulk = jiraCalls.find((call) => call.path === '/rest/api/3/issue/properties/multi');
    expect(bulk.body.issues).toEqual([
      { issueID: 1, properties: { 'jawdatrace.steps': { v: 1, revision: 1, steps: [{ id: 's1', action: 'Do', data: '', expected: 'Done' }] } } },
    ]);
    const links = jiraCalls.filter((call) => call.path === '/rest/api/3/issueLink');
    expect(links).toHaveLength(1);
    expect(links[0].body).toEqual({ type: { name: 'Test Set' }, inwardIssue: { id: '51' }, outwardIssue: { id: '1' } });

    const planInsert = sqlCalls.find((call) => call.query.startsWith('INSERT IGNORE INTO plan_test'));
    expect(planInsert.params.slice(0, 2)).toEqual(['70', '1']);

    expect(next.counts).toMatchObject({ tests: 2, stepsWritten: 1, setLinks: 1, planTests: 1 });
    // Last page (start 0 + 50 >= total 2): move on to executions.
    expect(next.stage).toBe(STAGES.EXECUTIONS);
    expect(next.start).toBe(0);
  });
});

describe('importExecutionsPage + importRunsPage', () => {
  it('stores executions with environment and first plan, then their runs', async () => {
    const { xray, calls } = fakeXray({
      getTestExecutions: {
        total: 1,
        results: [{ issueId: '200', testEnvironments: ['iOS'], testPlans: { total: 1, results: [{ issueId: '70' }] } }],
      },
    });
    let state = await importExecutionsPage(xray, baseState({ stage: STAGES.EXECUTIONS }));
    const upsert = sqlCalls.find((call) => call.query.startsWith('INSERT INTO test_execution'));
    expect(upsert.params.slice(0, 5)).toEqual(['200', '10000', '70', 'iOS', 'admin-1']);
    expect(state).toMatchObject({ stage: STAGES.RUNS, execIds: ['200'], runStart: 0, start: 1, execTotal: 1 });
    expect(calls[0].variables).toEqual({ jql: 'project = "BA"', start: 0 });

    resetSql();
    setSqlHandler((query) => (query.startsWith('INSERT IGNORE INTO test_run') ? { affectedRows: 2 } : []));
    const runs = fakeXray({
      getTestRuns: {
        total: 4,
        results: [
          { id: 'r1', status: { name: 'PASSED' }, test: { issueId: '1' }, testExecution: { issueId: '200' }, executedById: 'u1', finishedOn: '2026-10-01T10:00:00Z' },
          { id: 'r2', status: { name: 'FAILED' }, test: { issueId: '2' }, testExecution: { issueId: '200' }, comment: 'crash' },
          { id: 'r3', status: { name: 'TODO' }, test: { issueId: '3' }, testExecution: { issueId: '200' } },
          { id: 'r4', status: { name: 'RETEST' }, test: { issueId: '4' }, testExecution: { issueId: '200' } },
        ],
      },
    });
    state = await importRunsPage(runs.xray, state);

    const members = sqlCalls.find((call) => call.query.startsWith('INSERT IGNORE INTO execution_test'));
    expect(members.params.filter((_, i) => i % 4 === 1)).toEqual(['1', '2', '3', '4']);
    const insert = sqlCalls.find((call) => call.query.startsWith('INSERT IGNORE INTO test_run'));
    // 11 columns per run; only PASS and FAIL become runs.
    expect(insert.params).toHaveLength(22);
    expect(insert.params[3]).toBe('PASS');
    expect(insert.params[7]).toBe('u1');
    expect(insert.params[9]).toBe('xray:r1');
    expect(insert.params[14]).toBe('FAIL');
    expect(insert.params[15]).toBe('[Imported from Xray] crash');
    expect(insert.params[18]).toBe('admin-1'); // no executedById -> the admin who started it
    expect(state.counts).toMatchObject({ runs: 2, todo: 1, skippedStatus: 1 });
    // All runs read and no more executions: done.
    expect(state.stage).toBe(STAGES.DONE);
  });

  it('pages through runs before moving to the next executions', async () => {
    const { xray } = fakeXray({ getTestRuns: { total: 250, results: [{ id: 'r', status: { name: 'TODO' }, test: { issueId: '1' }, testExecution: { issueId: '200' } }] } });
    const state = await importRunsPage(
      xray,
      baseState({ stage: STAGES.RUNS, execIds: ['200'], runStart: 100, start: 50, execTotal: 120 })
    );
    expect(state).toMatchObject({ stage: STAGES.RUNS, runStart: 200 });
    const last = await importRunsPage(fakeXray({ getTestRuns: { total: 250, results: [] } }).xray, state);
    expect(last).toMatchObject({ stage: STAGES.EXECUTIONS, start: 50, execIds: [] });
  });
});

describe('handler', () => {
  beforeEach(() => {
    kvsSecrets.set('xray-import-credentials', { clientId: 'id', clientSecret: 'secret', region: 'us' });
  });

  it('ignores events from an older run', async () => {
    kvsData.set('xray-import:BA', baseState({ runId: 'run-2' }));
    await handler({ body: { projectKey: 'BA', runId: 'run-1' } });
    expect(sqlCalls).toHaveLength(0);
    expect(pushedEvents).toHaveLength(0);
  });

  it('waits and re-queues itself when Xray rate-limits', async () => {
    kvsData.set('xray-import:BA', baseState());
    setFetchHandler((url) =>
      url.endsWith('/authenticate') ? { status: 200, body: 'token' } : { status: 429, body: { error: 'slow down' } }
    );
    await handler({ body: { projectKey: 'BA', runId: 'run-1' } });
    expect(kvsData.get('xray-import:BA')).toMatchObject({ status: 'waiting', stage: STAGES.TESTS, start: 0 });
    expect(pushedEvents).toEqual([
      { queue: 'xray-import', body: { projectKey: 'BA', runId: 'run-1' }, delayInSeconds: 120 },
    ]);
  });

  it('fails without retrying when the API key is rejected', async () => {
    kvsData.set('xray-import:BA', baseState());
    setFetchHandler(() => ({ status: 401 }));
    await handler({ body: { projectKey: 'BA', runId: 'run-1' } });
    expect(kvsData.get('xray-import:BA')).toMatchObject({ status: 'failed', error: 'XRAY_UNAUTHORIZED' });
    expect(pushedEvents).toHaveLength(0);
  });
});

describe('admin resolvers', () => {
  const notAdmin = () => ({ status: 200, body: { permissions: { ADMINISTER: { havePermission: false } } } });

  it('refuse non-admins before touching Xray or storage', async () => {
    setJiraHandler(notAdmin);
    await expect(saveXrayCredentials({ clientId: 'a', clientSecret: 'b' })).rejects.toThrow(/administrators/);
    await expect(startXrayImport({ projectKey: 'BA' }, 'u1')).rejects.toThrow(/administrators/);
    expect(kvsSecrets.size).toBe(0);
    expect(pushedEvents).toHaveLength(0);
  });

  it('only stores an API key that Xray accepts', async () => {
    setJiraHandler(() => ({ status: 200, body: { permissions: { ADMINISTER: { havePermission: true } } } }));
    setFetchHandler(() => ({ status: 401 }));
    await expect(saveXrayCredentials({ clientId: 'a', clientSecret: 'b', region: 'us' })).rejects.toThrow(/rejected/);
    expect(kvsSecrets.size).toBe(0);

    setFetchHandler(() => ({ status: 200, body: 'token' }));
    await saveXrayCredentials({ clientId: 'a', clientSecret: 'b', region: 'us' });
    expect(kvsSecrets.get('xray-import-credentials')).toEqual({ clientId: 'a', clientSecret: 'b', region: 'us' });
  });

  it('starts an import: saves the state and queues one event', async () => {
    kvsSecrets.set('xray-import-credentials', { clientId: 'a', clientSecret: 'b', region: 'us' });
    setJiraHandler((as, path) =>
      path.startsWith('/rest/api/3/mypermissions')
        ? { status: 200, body: { permissions: { ADMINISTER: { havePermission: true } } } }
        : { status: 200, body: { id: 10000, key: 'BA' } }
    );
    const { state } = await startXrayImport({ projectKey: 'ba', restart: true }, 'admin-1');
    expect(state).toMatchObject({ projectKey: 'BA', stage: 'tests', status: 'running' });
    const saved = kvsData.get('xray-import:BA');
    expect(saved).toMatchObject({ projectId: '10000', startedBy: 'admin-1', start: 0 });
    expect(pushedEvents).toEqual([{ queue: 'xray-import', body: { projectKey: 'BA', runId: saved.runId } }]);
    // Secrets never leave the backend.
    expect(JSON.stringify(state)).not.toContain('secret');
  });
});
