import { beforeEach, describe, expect, it } from 'vitest';
import { jiraCalls, resetJira, setJiraHandler } from './mocks/forge-api';
import { pushedEvents, resetEvents } from './mocks/forge-events';
import { resetSql, setSqlHandler, sqlCalls } from './mocks/forge-sql';
import { parseImportFile } from '../src/importer/format';
import { _resetFileCacheForTests, emptyCounts, handler, importPage } from '../src/importer/worker';
import { startImport } from '../src/resolvers/dataImport';

beforeEach(() => {
  resetJira();
  resetSql();
  resetEvents();
  _resetFileCacheForTests();
});

const file = (overrides = {}) => ({ format: 'jawdatrace-import', version: 1, projectKey: 'ABC', ...overrides });

const baseJob = (overrides = {}) => ({
  projectKey: 'ABC',
  projectId: '10000',
  sourceIssueKey: 'ABC-99',
  files: [{ id: '500', name: 'jawdatrace-import-001.json' }],
  runId: 'run-1',
  startedBy: 'admin-1',
  fileIndex: 0,
  section: 'tests',
  offset: 0,
  status: 'running',
  error: null,
  counts: emptyCounts(),
  ...overrides,
});

// Issues known to the fake Jira: id -> [type, projectId].
const ISSUES = {
  1: ['Test', '10000'],
  2: ['Test', '10000'],
  3: ['Test', '20000'], // another project
  50: ['Test Set', '10000'],
  60: ['Test Plan', '10000'],
  70: ['Test Execution', '10000'],
};

function bulkfetch(body, extra = () => ({})) {
  return {
    issues: body.issueIdsOrKeys
      .filter((id) => ISSUES[id])
      .map((id) => ({
        id,
        fields: { issuetype: { name: ISSUES[id][0] }, project: { id: ISSUES[id][1] }, ...extra(id).fields },
        properties: extra(id).properties ?? {},
      })),
  };
}

describe('parseImportFile', () => {
  it('flattens memberships and cleans values', () => {
    const data = parseImportFile(
      JSON.stringify(
        file({
          tests: [{ test: '1', steps: [{ action: ' Open ', expected: 'Home' }, { action: '' }] }],
          setMembers: [{ set: '50', tests: ['1', 2] }],
          planTests: [{ plan: '60', tests: ['1'] }],
          executions: [{ execution: '70', plan: '60', environment: ' iOS ', tests: ['1'] }],
          runs: [{ id: 'r-1', test: '1', execution: '70', status: 'PASS', executedAt: '2026-10-01T10:00:00Z' }],
        })
      ),
      'ABC'
    );
    expect(data.tests[0].steps).toEqual({ v: 1, revision: 1, steps: [{ id: 's1', action: 'Open', data: '', expected: 'Home' }] });
    expect(data.setLinks).toEqual([
      { setId: '50', testId: '1' },
      { setId: '50', testId: '2' },
    ]);
    expect(data.executions[0]).toEqual({ executionId: '70', planId: '60', environment: 'iOS', testIds: ['1'] });
    expect(data.runs[0]).toMatchObject({ id: 'r-1', executionId: '70', executedBy: null, comment: null });
  });

  it('rejects bad files with a message naming the entry', () => {
    expect(() => parseImportFile('nope', 'ABC')).toThrow('not valid JSON');
    expect(() => parseImportFile(JSON.stringify(file({ projectKey: 'XYZ' })), 'ABC')).toThrow('projectKey');
    expect(() => parseImportFile(JSON.stringify(file({ version: 2 })), 'ABC')).toThrow('version');
    expect(() => parseImportFile(JSON.stringify(file({ tests: [{ test: '1 OR 1=1' }] })), 'ABC')).toThrow(
      'tests[0].test'
    );
    const run = { id: 'r', test: '1', status: 'PASSED', executedAt: '2026-10-01T10:00:00Z' };
    expect(() => parseImportFile(JSON.stringify(file({ runs: [run] })), 'ABC')).toThrow('runs[0].status');
    expect(() => parseImportFile(JSON.stringify(file({ runs: [{ ...run, status: 'PASS', id: 'x'.repeat(49) }] })), 'ABC')).toThrow(
      'runs[0].id'
    );
  });
});

describe('importPage', () => {
  it('writes steps only for Tests of the project that have none', async () => {
    setJiraHandler((as, path, init) => {
      if (path.includes('bulkfetch')) {
        return { body: bulkfetch(init.body, (id) => ({ properties: id === '2' ? { 'jawdatrace.steps': {} } : {} })) };
      }
      return { status: 204 };
    });
    const steps = { v: 1, revision: 1, steps: [{ id: 's1', action: 'a', data: '', expected: '' }] };
    const data = { tests: ['1', '2', '3', '999'].map((testId) => ({ testId, steps })) };
    const job = await importPage(data, baseJob());

    expect(jiraCalls.every((call) => call.as === 'app')).toBe(true);
    const write = jiraCalls.find((call) => call.path.includes('properties/multi'));
    expect(write.body.issues).toEqual([{ issueID: 1, properties: { 'jawdatrace.steps': steps } }]);
    expect(job.counts).toMatchObject({ stepsWritten: 1, stepsKept: 1, skipped: 2 });
    expect(job).toMatchObject({ section: 'setLinks', offset: 0 });
  });

  it('creates missing Set links and skips existing ones', async () => {
    setJiraHandler((as, path, init) => {
      if (path.includes('bulkfetch')) {
        const links = (id) =>
          id === '2' ? [{ type: { name: 'Test Set' }, inwardIssue: { id: '50' } }] : [];
        return { body: bulkfetch(init.body, (id) => ({ fields: { issuelinks: links(id) } })) };
      }
      return { status: 201 };
    });
    const data = { setLinks: [{ setId: '50', testId: '1' }, { setId: '50', testId: '2' }, { setId: '1', testId: '2' }] };
    const job = await importPage(data, baseJob({ section: 'setLinks' }));

    const posts = jiraCalls.filter((call) => call.path.includes('issueLink'));
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ type: { name: 'Test Set' }, inwardIssue: { id: '50' }, outwardIssue: { id: '1' } });
    expect(job.counts).toMatchObject({ setLinks: 1, skipped: 1 });
  });

  it('writes executions with members and runs with an imp: request id', async () => {
    setJiraHandler((as, path, init) => ({ body: bulkfetch(init.body) }));
    setSqlHandler((query) => (query.includes('INSERT IGNORE INTO test_run') ? { affectedRows: 1 } : []));

    let job = await importPage(
      { executions: [{ executionId: '70', planId: '60', environment: 'iOS', testIds: ['1', '3'] }] },
      baseJob({ section: 'executions' })
    );
    expect(sqlCalls[0].params).toEqual(expect.arrayContaining(['70', '10000', '60', 'iOS', 'admin-1']));
    expect(sqlCalls[1].params.slice(0, 3)).toEqual(['70', '1', 1]);
    expect(job.counts).toMatchObject({ executions: 1, skipped: 1 });

    resetSql();
    setSqlHandler((query) => (query.includes('INSERT IGNORE INTO test_run') ? { affectedRows: 1 } : []));
    const run = { id: 'r-1', testId: '1', executionId: '70', status: 'FAIL', executedBy: null, executedAt: '2026-10-01T10:00:00.000Z', comment: 'x' };
    job = await importPage({ runs: [run, { ...run, testId: '3' }] }, { ...job, section: 'runs', offset: 0 });
    const insert = sqlCalls.find((call) => call.query.includes('INTO test_run'));
    expect(insert.params).toEqual(expect.arrayContaining(['1', '70', 'FAIL', 'x', 'admin-1', 'imp:r-1']));
    expect(job.counts).toMatchObject({ runs: 1, skipped: 2 });
    // Last section of the only file: move on to the next file.
    expect(job).toMatchObject({ fileIndex: 1, section: 'tests', offset: 0 });
  });

  it('reuses UUID run ids from an export as the row id', async () => {
    setJiraHandler((as, path, init) => ({ body: bulkfetch(init.body) }));
    setSqlHandler(() => ({ affectedRows: 0 }));
    const uuid = '41F9E6AE-8950-4C1B-9D5A-0123456789AB';
    const run = { testId: '1', executionId: null, status: 'PASS', executedBy: null, executedAt: '2026-10-01T10:00:00.000Z', comment: null };
    await importPage({ runs: [{ ...run, id: uuid }, { ...run, id: 'x1:P:abc' }] }, baseJob({ section: 'runs' }));
    const insert = sqlCalls.find((call) => call.query.includes('INTO test_run'));
    expect(insert.params[0]).toBe(uuid.toLowerCase());
    expect(insert.params[11]).not.toBe('x1:P:abc'); // other ids get a fresh row id
    expect(insert.params[11]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('pages through a section 100 entries at a time', async () => {
    setJiraHandler((as, path, init) => ({ body: bulkfetch(init.body) }));
    const data = { planTests: Array.from({ length: 150 }, () => ({ planId: '60', testId: '1' })) };
    const first = await importPage(data, baseJob({ section: 'planTests' }));
    expect(first).toMatchObject({ section: 'planTests', offset: 100 });
    const second = await importPage(data, first);
    expect(second).toMatchObject({ section: 'executions', offset: 0 });
    expect(second.counts.planTests).toBe(150);
  });
});

describe('handler', () => {
  const content = JSON.stringify(file({ planTests: [{ plan: '60', tests: ['1'] }] }));

  function sqlWithJob(job) {
    const saved = [];
    setSqlHandler((query, params) => {
      if (query.includes('FROM import_job')) return [{ state: JSON.stringify(job), updated_at: '2026-10-01 10:00:00.000' }];
      if (query.includes('INTO import_job')) saved.push(JSON.parse(params[1]));
      return [];
    });
    return saved;
  }

  it('imports the files and marks the job done', async () => {
    const saved = sqlWithJob(baseJob());
    setJiraHandler((as, path, init) =>
      path.includes('attachment/content/500?redirect=false') ? { body: JSON.parse(content) } : { body: bulkfetch(init.body) }
    );
    await handler({ body: { projectKey: 'ABC', runId: 'run-1' } });
    expect(saved.at(-1)).toMatchObject({ status: 'done', fileIndex: 1 });
    expect(saved.at(-1).counts.planTests).toBe(1);
    expect(pushedEvents).toHaveLength(0);
  });

  it('ignores events from an older run', async () => {
    const saved = sqlWithJob(baseJob({ runId: 'run-2' }));
    await handler({ body: { projectKey: 'ABC', runId: 'run-1' } });
    expect(saved).toHaveLength(0);
    expect(jiraCalls).toHaveLength(0);
  });

  it('waits and continues later when Jira rate-limits', async () => {
    const saved = sqlWithJob(baseJob());
    setJiraHandler(() => ({ status: 429 }));
    await handler({ body: { projectKey: 'ABC', runId: 'run-1' } });
    expect(saved.at(-1)).toMatchObject({ status: 'waiting', error: 'HTTP_429' });
    expect(pushedEvents[0]).toMatchObject({ queue: 'data-import', body: { projectKey: 'ABC', runId: 'run-1' }, delayInSeconds: 120 });
  });

  it('fails with a readable message when a file is invalid', async () => {
    const saved = sqlWithJob(baseJob());
    setJiraHandler(() => ({ body: file({ projectKey: 'XYZ' }) }));
    await handler({ body: { projectKey: 'ABC', runId: 'run-1' } });
    expect(saved.at(-1)).toMatchObject({ status: 'failed', error: 'jawdatrace-import-001.json: projectKey: expected "ABC"' });
  });
});

describe('startImport', () => {
  function jiraAs({ admin = true, projectKey = 'ABC', attachments = [] } = {}) {
    setJiraHandler((as, path) => {
      if (path.includes('mypermissions')) return { body: { permissions: { ADMINISTER: { havePermission: admin } } } };
      if (path.includes('/issue/ABC-99')) {
        return { body: { fields: { project: { id: '10000', key: projectKey }, attachment: attachments } } };
      }
      return { status: 404 };
    });
  }

  it('is for Jira admins only', async () => {
    jiraAs({ admin: false });
    await expect(startImport({ projectKey: 'ABC', issueKey: 'ABC-99' }, 'u1')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('picks the import attachments in name order and enqueues the job', async () => {
    jiraAs({
      attachments: [
        { id: '2', filename: 'jawdatrace-import-002.json', size: 10 },
        { id: '9', filename: 'screenshot.png', size: 10 },
        { id: '1', filename: 'jawdatrace-import-001.json', size: 10 },
      ],
    });
    const saved = [];
    setSqlHandler((query, params) => {
      if (query.includes('INTO import_job')) saved.push(JSON.parse(params[1]));
      return [];
    });
    const result = await startImport({ projectKey: 'abc', issueKey: 'ABC-99', restart: true }, 'admin-1');
    expect(result.state.files).toEqual(['jawdatrace-import-001.json', 'jawdatrace-import-002.json']);
    expect(saved[0]).toMatchObject({ projectId: '10000', startedBy: 'admin-1', section: 'tests', offset: 0 });
    expect(pushedEvents).toHaveLength(1);
  });

  it('refuses an issue from another project or without files', async () => {
    jiraAs({ projectKey: 'XYZ' });
    await expect(startImport({ projectKey: 'ABC', issueKey: 'ABC-99', restart: true }, 'u1')).rejects.toThrow(
      'not in project ABC'
    );
    jiraAs();
    await expect(startImport({ projectKey: 'ABC', issueKey: 'ABC-99', restart: true }, 'u1')).rejects.toThrow(
      'no jawdatrace-import'
    );
  });
});
