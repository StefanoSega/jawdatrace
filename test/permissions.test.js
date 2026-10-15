import { beforeEach, describe, expect, it } from 'vitest';
import { jiraCalls, resetJira, setJiraHandler } from './mocks/forge-api';
import {
  ForbiddenError,
  assertIssueId,
  assertIssueIdList,
  filterVisibleIssueIds,
  getEditableIssue,
  getVisibleIssue,
} from '../src/resolvers/permissions';
import { ValidationError } from '../src/shared/evidence';

beforeEach(() => resetJira());

describe('assertIssueId', () => {
  it('accepts numeric ids only (blocks JQL/path injection)', () => {
    expect(assertIssueId('10042')).toBe('10042');
    expect(assertIssueId(10042)).toBe('10042');
    expect(() => assertIssueId('10042 OR 1=1')).toThrow(ValidationError);
    expect(() => assertIssueId('../admin')).toThrow(ValidationError);
    expect(() => assertIssueId(undefined)).toThrow(ValidationError);
  });

  it('de-duplicates and caps id lists', () => {
    expect(assertIssueIdList(['1', '2', '1'], 10)).toEqual(['1', '2']);
    expect(() => assertIssueIdList(['1', '2', '3'], 2)).toThrow(/At most 2/);
  });
});

describe('getVisibleIssue', () => {
  it('reports 404 and 403 the same way, as forbidden', async () => {
    setJiraHandler(() => ({ status: 404 }));
    await expect(getVisibleIssue('1', 'Test')).rejects.toBeInstanceOf(ForbiddenError);
    setJiraHandler(() => ({ status: 403 }));
    await expect(getVisibleIssue('1', 'Test')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects issues of the wrong type', async () => {
    setJiraHandler(() => ({ status: 200, body: { id: '1', fields: { issuetype: { name: 'Story' } } } }));
    await expect(getVisibleIssue('1', 'Test')).rejects.toThrow(/Expected an issue of type Test/);
  });

  it('calls Jira as the user', async () => {
    setJiraHandler(() => ({ status: 200, body: { id: '1', fields: { issuetype: { name: 'Test' } } } }));
    await getVisibleIssue('1', 'Test');
    expect(jiraCalls[0].as).toBe('user');
  });
});

describe('getEditableIssue', () => {
  it('requires EDIT_ISSUES on top of visibility', async () => {
    setJiraHandler((as, path) => {
      if (path.startsWith('/rest/api/3/mypermissions')) {
        return { status: 200, body: { permissions: { EDIT_ISSUES: { havePermission: false } } } };
      }
      return { status: 200, body: { id: '1', fields: { issuetype: { name: 'Test' } } } };
    });
    await expect(getEditableIssue('1', 'Test')).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('filterVisibleIssueIds', () => {
  it('batches 100 ids per bulk request and keeps only visible issues of the right type', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => String(i + 1));
    setJiraHandler((as, path, init) => ({
      status: 200,
      body: {
        // Pretend every even id is hidden and id 3 is a Story.
        issues: init.body.issueIdsOrKeys
          .filter((id) => Number(id) % 2 === 1)
          .map((id) => ({ id, fields: { issuetype: { name: id === '3' ? 'Story' : 'Test' } } })),
      },
    }));
    const visible = await filterVisibleIssueIds(ids, 'Test');
    expect(jiraCalls).toHaveLength(3);
    expect(jiraCalls.every((call) => call.path === '/rest/api/3/issue/bulkfetch' && call.as === 'user')).toBe(true);
    expect(visible).not.toContain('2');
    expect(visible).not.toContain('3');
    expect(visible).toContain('1');
    expect(visible).toHaveLength(124);
  });

  it('makes no request for an empty list', async () => {
    expect(await filterVisibleIssueIds([])).toEqual([]);
    expect(jiraCalls).toHaveLength(0);
  });
});
