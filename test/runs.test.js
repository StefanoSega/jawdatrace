import { beforeEach, describe, expect, it } from 'vitest';
import { jiraCalls, resetJira, setJiraHandler } from './mocks/forge-api';
import { resetSql, setSqlHandler, sqlCalls } from './mocks/forge-sql';
import { decodeCursor, encodeCursor, recordRun, validateRunInput } from '../src/resolvers/runs';
import { ForbiddenError } from '../src/resolvers/permissions';
import { ValidationError } from '../src/shared/evidence';

const REQUEST_ID = 'req-12345678';

/** Jira mock: a Test (id 100) with one attachment, an Execution (id 200), configurable edit permission. */
function mockJira({ canEdit = true } = {}) {
  setJiraHandler((as, path) => {
    if (path.startsWith('/rest/api/3/mypermissions')) {
      return { status: 200, body: { permissions: { EDIT_ISSUES: { havePermission: canEdit } } } };
    }
    if (path.startsWith('/rest/api/3/issue/100')) {
      return {
        status: 200,
        body: {
          id: '100',
          fields: {
            issuetype: { name: 'Test' },
            project: { id: '1' },
            attachment: [{ id: '555', filename: 'shot.png', mimeType: 'image/png', size: 10 }],
          },
        },
      };
    }
    if (path.startsWith('/rest/api/3/issue/200')) {
      return { status: 200, body: { id: '200', fields: { issuetype: { name: 'Test Execution' }, project: { id: '1' } } } };
    }
    return { status: 404 };
  });
}

beforeEach(() => {
  resetJira();
  resetSql();
});

describe('validateRunInput', () => {
  it('accepts a valid submission', () => {
    const input = validateRunInput({ status: 'PASS', comment: ' ok ', clientRequestId: REQUEST_ID });
    expect(input.status).toBe('PASS');
    expect(input.comment).toBe('ok');
  });

  it('rejects bad statuses, oversized comments and bad request ids', () => {
    expect(() => validateRunInput({ status: 'TODO', clientRequestId: REQUEST_ID })).toThrow(ValidationError);
    expect(() =>
      validateRunInput({ status: 'PASS', comment: 'x'.repeat(5001), clientRequestId: REQUEST_ID })
    ).toThrow(/5000/);
    expect(() => validateRunInput({ status: 'PASS', clientRequestId: 'short' })).toThrow(ValidationError);
  });
});

describe('recordRun', () => {
  it('ad-hoc run: requires edit permission on the Test', async () => {
    mockJira({ canEdit: false });
    await expect(
      recordRun({ testIssueId: '100', status: 'PASS', clientRequestId: REQUEST_ID }, 'acc-1')
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(sqlCalls).toHaveLength(0);
  });

  it('ad-hoc run: stores attachment metadata taken from Jira, not from the client', async () => {
    mockJira();
    setSqlHandler(() => ({ affectedRows: 1 }));
    const result = await recordRun(
      {
        testIssueId: '100',
        status: 'FAIL',
        clientRequestId: REQUEST_ID,
        evidence: { items: [{ type: 'jira-attachment', attachmentId: '555', filename: 'evil.exe' }] },
      },
      'acc-1'
    );
    expect(result.duplicate).toBe(false);
    const insert = sqlCalls.find((call) => call.query.startsWith('INSERT IGNORE INTO test_run'));
    const evidence = JSON.parse(insert.params[5]);
    expect(evidence.items[0].filename).toBe('shot.png');
    expect(insert.params[1]).toBe('100'); // test id
    expect(insert.params[2]).toBeNull(); // no execution
    expect(insert.params[7]).toBe('acc-1'); // executed by the caller, not the client
  });

  it("rejects evidence attachments that are not on the Test", async () => {
    mockJira();
    await expect(
      recordRun(
        {
          testIssueId: '100',
          status: 'FAIL',
          clientRequestId: REQUEST_ID,
          evidence: { items: [{ type: 'jira-attachment', attachmentId: '999' }] },
        },
        'acc-1'
      )
    ).rejects.toThrow(/does not belong/);
  });

  it('run in an Execution: the Test must be a member of the Execution', async () => {
    mockJira();
    setSqlHandler((query) => (query.includes('FROM execution_test') ? [] : { affectedRows: 1 }));
    await expect(
      recordRun(
        { testIssueId: '100', executionIssueId: '200', status: 'PASS', clientRequestId: REQUEST_ID },
        'acc-1'
      )
    ).rejects.toThrow(/not part of the Test Execution/);
  });

  it('run in an Execution: checks edit permission on the Execution and stores the execution id', async () => {
    mockJira();
    setSqlHandler((query) => (query.includes('FROM execution_test') ? [{ found: 1 }] : { affectedRows: 1 }));
    await recordRun(
      { testIssueId: '100', executionIssueId: '200', status: 'EXECUTING', clientRequestId: REQUEST_ID },
      'acc-1'
    );
    const permissionCall = jiraCalls.find((call) => call.path.startsWith('/rest/api/3/mypermissions'));
    expect(permissionCall.path).toContain('issueId=200');
    const insert = sqlCalls.find((call) => call.query.startsWith('INSERT IGNORE INTO test_run'));
    expect(insert.params[2]).toBe('200');
  });

  it('reports a duplicate submission (same request id) without failing', async () => {
    mockJira();
    setSqlHandler(() => ({ affectedRows: 0 }));
    const result = await recordRun({ testIssueId: '100', status: 'PASS', clientRequestId: REQUEST_ID }, 'acc-1');
    expect(result.duplicate).toBe(true);
  });
});

describe('pagination cursor', () => {
  it('round-trips and converts to SQL datetime format', () => {
    const cursor = encodeCursor({ executed_at: '2026-10-15 09:30:00.123', id: '3f2b9c1e-0000-4000-8000-000000000000' });
    expect(decodeCursor(cursor)).toEqual({
      executedAt: '2026-10-15 09:30:00.123',
      id: '3f2b9c1e-0000-4000-8000-000000000000',
    });
  });

  it('rejects tampered cursors', () => {
    expect(() => decodeCursor('not-a-cursor')).toThrow(ValidationError);
    const bad = Buffer.from(JSON.stringify({ t: '2026-10-15', i: "x' OR 1=1" })).toString('base64url');
    expect(() => decodeCursor(bad)).toThrow(ValidationError);
  });
});
