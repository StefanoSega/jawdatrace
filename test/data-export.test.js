import { beforeEach, describe, expect, it } from 'vitest';
import { jiraCalls, resetJira, setJiraHandler } from './mocks/forge-api';
import { pushedEvents, resetEvents } from './mocks/forge-events';
import { resetSql, setSqlHandler, sqlCalls } from './mocks/forge-sql';
import { parseImportFile } from '../src/importer/format';
import { buildExport, handler, splitIntoFiles } from '../src/exporter/worker';
import { startExport } from '../src/resolvers/dataExport';

beforeEach(() => {
  resetJira();
  resetSql();
  resetEvents();
});

const steps = { v: 1, revision: 2, steps: [{ id: 's1', action: 'Open', data: '', expected: 'Home' }] };

// Fake Jira search results per issue type, and SQL rows per table.
function fakeSite() {
  setJiraHandler((as, path, init) => {
    if (!path.includes('/search/jql')) return { status: 201, body: [] };
    const jql = init.body.jql;
    if (jql.includes('"Test Set"')) {
      return {
        body: {
          issues: [
            {
              id: '50',
              fields: {
                issuelinks: [
                  { type: { name: 'Test Set' }, outwardIssue: { id: '1' } },
                  { type: { name: 'Test' }, outwardIssue: { id: '9' } },
                ],
              },
            },
          ],
        },
      };
    }
    if (jql.includes('"Test Plan"')) return { body: { issues: [{ id: '60' }] } };
    return { body: { issues: [{ id: '1', properties: { 'jawdatrace.steps': steps } }, { id: '2', properties: {} }] } };
  });
  setSqlHandler((query) => {
    if (query.includes('FROM plan_test')) return [{ plan_issue_id: '60', test_issue_id: '1' }];
    if (query.includes('FROM test_execution')) return [{ execution_issue_id: '70', plan_issue_id: '60', environment: 'iOS' }];
    if (query.includes('FROM execution_test')) {
      return [
        { execution_issue_id: '70', test_issue_id: '2' },
        { execution_issue_id: '70', test_issue_id: '1' },
      ];
    }
    const run = {
      test_issue_id: '1',
      status: 'PASS',
      comment: null,
      executed_at: '2026-10-01 10:00:00.000',
    };
    if (query.includes('execution_issue_id IN')) {
      return [
        { ...run, id: 'uuid-1', execution_issue_id: '70', executed_by: 'acc-1', client_request_id: 'req-1' },
        { ...run, id: 'uuid-2', execution_issue_id: '70', executed_by: 'unknown', client_request_id: 'imp:x1:P:abc' },
      ];
    }
    if (query.includes('execution_issue_id IS NULL')) {
      return [{ ...run, id: 'uuid-3', execution_issue_id: null, executed_by: 'acc-2', client_request_id: 'r', comment: 'c' }];
    }
    if (query.includes('FROM export_job')) {
      return [
        {
          state: JSON.stringify({
            projectKey: 'ABC',
            projectId: '10000',
            targetIssueId: '99',
            runId: 'run-1',
            status: 'running',
          }),
          updated_at: '2026-10-01 10:00:00.000',
        },
      ];
    }
    return [];
  });
}

describe('buildExport', () => {
  it('collects every section in the import format', async () => {
    fakeSite();
    const sections = await buildExport({ projectKey: 'ABC', projectId: '10000' });

    expect(jiraCalls.every((call) => call.as === 'app')).toBe(true);
    expect(sections.tests).toEqual([{ test: '1', steps: steps.steps }]);
    expect(sections.setMembers).toEqual([{ set: '50', tests: ['1'] }]);
    expect(sections.planTests).toEqual([{ plan: '60', tests: ['1'] }]);
    expect(sections.executions).toEqual([{ execution: '70', plan: '60', environment: 'iOS', tests: ['2', '1'] }]);
    expect(sections.runs).toEqual([
      { id: 'uuid-1', test: '1', execution: '70', status: 'PASS', executedBy: 'acc-1', executedAt: '2026-10-01T10:00:00.000Z' },
      // Imported runs keep their original id; former users are left out.
      { id: 'x1:P:abc', test: '1', execution: '70', status: 'PASS', executedAt: '2026-10-01T10:00:00.000Z' },
      { id: 'uuid-3', test: '1', execution: null, status: 'PASS', executedBy: 'acc-2', executedAt: '2026-10-01T10:00:00.000Z', comment: 'c' },
    ]);
    // The SQL reads are scoped to the project.
    expect(sqlCalls.find((call) => call.query.includes('FROM test_execution')).params).toEqual(['10000']);
  });

  it('produces files the import accepts', async () => {
    fakeSite();
    const files = splitIntoFiles(await buildExport({ projectKey: 'ABC', projectId: '10000' }), 'ABC', 300);
    expect(files.length).toBeGreaterThan(1);
    const parsed = files.map((file) => parseImportFile(JSON.stringify(file), 'ABC'));
    expect(parsed.flatMap((data) => data.runs)).toHaveLength(3);
  });
});

describe('handler', () => {
  it('attaches the files to the target issue and marks the job done', async () => {
    fakeSite();
    await handler({ body: { projectKey: 'ABC', runId: 'run-1' } });
    const upload = jiraCalls.find((call) => call.path.includes('/issue/99/attachments'));
    expect(upload).toBeDefined();
    const saved = sqlCalls.filter((call) => call.query.includes('INTO export_job')).map((call) => JSON.parse(call.params[1]));
    expect(saved.at(-1)).toMatchObject({ status: 'done', files: 1, counts: { tests: 1, runs: 3 } });
  });

  it('ignores events from an older run', async () => {
    fakeSite();
    await handler({ body: { projectKey: 'ABC', runId: 'run-0' } });
    expect(jiraCalls).toHaveLength(0);
  });
});

describe('startExport', () => {
  it('checks admin and project, then enqueues', async () => {
    setJiraHandler((as, path) => {
      if (path.includes('mypermissions')) return { body: { permissions: { ADMINISTER: { havePermission: true } } } };
      if (path.includes('/issue/ABC-5')) return { body: { id: '99', fields: { project: { id: '10000', key: 'ABC' } } } };
      return { status: 404 };
    });
    const result = await startExport({ projectKey: 'abc', issueKey: 'abc-5' });
    expect(result.state).toMatchObject({ projectKey: 'ABC', targetIssueKey: 'ABC-5', status: 'running' });
    expect(pushedEvents[0]).toMatchObject({ queue: 'data-export', body: { projectKey: 'ABC' } });
    await expect(startExport({ projectKey: 'XYZ', issueKey: 'ABC-5' })).rejects.toThrow('not in project XYZ');
  });
});
