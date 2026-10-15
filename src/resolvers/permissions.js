/**
 * Authorization checks used by every resolver BEFORE touching app storage.
 *
 * Forge SQL is app-level storage: it does not know about Jira permissions.
 * So the rule is simple: a resolver may only read or write rows for issues
 * that the CURRENT USER can see (and, for writes, edit) in Jira.
 */
import { ValidationError } from '../shared/evidence';
import { bulkFetchIssues, jira, route, JiraError } from './jira';

export class ForbiddenError extends Error {
  constructor(message = 'You do not have permission to do this.') {
    super(message);
    this.name = 'ForbiddenError';
    this.code = 'FORBIDDEN';
  }
}

/** Jira ids are numeric strings; reject anything else early (also blocks JQL injection). */
export function assertIssueId(value, label = 'issue id') {
  const id = String(value ?? '');
  if (!/^\d{1,18}$/.test(id)) throw new ValidationError(`Invalid ${label}.`);
  return id;
}

export function assertIssueIdList(values, max) {
  if (!Array.isArray(values)) throw new ValidationError('Expected a list of issue ids.');
  if (values.length > max) throw new ValidationError(`At most ${max} issues per request.`);
  return [...new Set(values.map((value) => assertIssueId(value)))];
}

/**
 * Load an issue as the user and confirm its type. A 403/404 means the user
 * cannot see it (or it doesn't exist); both are reported the same way so we
 * don't leak which ids exist.
 *
 * @param {string} issueId
 * @param {string | string[] | null} expectedTypes - issue type name(s), or null for any
 * @param {string[]} extraFields - additional fields to fetch in the same request
 */
export async function getVisibleIssue(issueId, expectedTypes, extraFields = []) {
  let issue;
  try {
    const fields = ['issuetype', 'project', ...extraFields].join(',');
    issue = await jira('user', route`/rest/api/3/issue/${issueId}?fields=${fields}`);
  } catch (error) {
    if (error instanceof JiraError && (error.status === 403 || error.status === 404)) {
      throw new ForbiddenError('Issue not found or not accessible.');
    }
    throw error;
  }
  const typeName = issue?.fields?.issuetype?.name;
  const allowed = expectedTypes === null ? null : [].concat(expectedTypes);
  if (allowed && !allowed.includes(typeName)) {
    throw new ValidationError(`Expected an issue of type ${allowed.join(' or ')}.`);
  }
  return issue;
}

/** Throws unless the user has the given project permission on the issue. */
export async function assertIssuePermission(issueId, permission) {
  const result = await jira(
    'user',
    route`/rest/api/3/mypermissions?issueId=${issueId}&permissions=${permission}`
  );
  if (!result?.permissions?.[permission]?.havePermission) {
    throw new ForbiddenError();
  }
}

/** Convenience: issue is visible, has the right type, and the user can edit it. */
export async function getEditableIssue(issueId, expectedTypes, extraFields = []) {
  const issue = await getVisibleIssue(issueId, expectedTypes, extraFields);
  await assertIssuePermission(issueId, 'EDIT_ISSUES');
  return issue;
}

/** Throws unless the user is a Jira administrator. */
export async function assertJiraAdmin() {
  const result = await jira('user', route`/rest/api/3/mypermissions?permissions=ADMINISTER`);
  if (!result?.permissions?.ADMINISTER?.havePermission) {
    throw new ForbiddenError('Only Jira administrators can do this.');
  }
}

/**
 * Keep only the issue ids the user can see, optionally restricted to an issue
 * type. Uses Jira's bulk fetch endpoint (100 ids per request) instead of one
 * request per issue. Unlike a JQL `id in (…)` search, bulk fetch does not fail
 * the whole request when one id is deleted or hidden; it just omits it.
 *
 * @param {string[]} issueIds - already validated with assertIssueIdList
 * @param {string | null} issueTypeName
 * @returns {Promise<string[]>} visible ids, in the original order
 */
export async function filterVisibleIssueIds(issueIds, issueTypeName = null) {
  if (issueIds.length === 0) return [];
  const issues = await bulkFetchIssues('user', issueIds, ['issuetype']);
  const visible = new Set(
    issues
      .filter((issue) => !issueTypeName || issue.fields?.issuetype?.name === issueTypeName)
      .map((issue) => String(issue.id))
  );
  return issueIds.filter((id) => visible.has(id));
}

/**
 * Visible Tests with the details the UI tables need, from the SAME bulk
 * request used for the permission filter (so panels don't refetch them).
 *
 * @returns {Promise<Map<string, { id, key, summary, jiraStatus, statusCategory, priority }>>}
 */
export async function fetchVisibleTests(issueIds) {
  if (issueIds.length === 0) return new Map();
  const issues = await bulkFetchIssues('user', issueIds, ['summary', 'status', 'priority', 'issuetype']);
  return new Map(
    issues.map((issue) => [
      String(issue.id),
      {
        id: String(issue.id),
        key: issue.key,
        summary: issue.fields?.summary ?? '',
        jiraStatus: issue.fields?.status?.name ?? '',
        statusCategory: issue.fields?.status?.statusCategory?.key ?? '',
        priority: issue.fields?.priority?.name ?? '',
      },
    ])
  );
}

/**
 * Like filterVisibleIssueIds, but returns { id, key, summary, status } for
 * each visible issue, for showing linked Executions/Plans in the UI.
 */
export async function describeVisibleIssues(issueIds) {
  if (issueIds.length === 0) return [];
  const issues = await bulkFetchIssues('user', issueIds, ['summary', 'status']);
  return issues.map((issue) => ({
    id: String(issue.id),
    key: issue.key,
    summary: issue.fields?.summary ?? '',
    status: issue.fields?.status?.name ?? '',
  }));
}
