/**
 * Jira REST helpers for the UI.
 *
 * These run in the browser through `requestJira`, which always acts AS THE
 * CURRENT USER, so Jira enforces permissions for us and no backend function
 * invocation is needed (cheaper than going through a resolver).
 *
 * Every helper requests only the fields the views need.
 */
import { requestJira } from '@forge/bridge';
import { ISSUE_TYPES, LINK_TYPES, STEPS_PROPERTY_KEY, STEPS_SCHEMA_VERSION } from '../../shared/constants';

async function jiraJson(path, options = {}) {
  const response = await requestJira(path, {
    method: options.method ?? 'GET',
    headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  if (response.status === 404 && options.allow404) return null;
  if (!response.ok) {
    const error = new Error(
      response.status === 403 || response.status === 401
        ? 'You do not have permission to do this.'
        : `Jira request failed (${response.status}).`
    );
    error.status = response.status;
    throw error;
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

/** Escape a value for use inside a double-quoted JQL string. */
export function jqlString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9_]+-\d+$/;

// Fields every test table needs.
export const TABLE_FIELDS = ['summary', 'status', 'priority', 'issuetype'];

/** Normalise a Jira issue into the flat shape our tables use. */
export function toRow(issue) {
  return {
    id: String(issue.id),
    key: issue.key,
    summary: issue.fields?.summary ?? '',
    jiraStatus: issue.fields?.status?.name ?? '',
    statusCategory: issue.fields?.status?.statusCategory?.key ?? '',
    priority: issue.fields?.priority?.name ?? '',
    issueType: issue.fields?.issuetype?.name ?? '',
  };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** One page of a JQL search (enhanced search API with token pagination). */
export async function searchPage(jql, fields, { maxResults = 50, nextPageToken } = {}) {
  const page = await jiraJson('/rest/api/3/search/jql', {
    method: 'POST',
    body: { jql, fields, maxResults, ...(nextPageToken ? { nextPageToken } : {}) },
  });
  return { issues: page?.issues ?? [], nextPageToken: page?.nextPageToken ?? null };
}

/** Follow pages until done or `cap` issues were collected. */
export async function searchAll(jql, fields, cap = 500) {
  const issues = [];
  let nextPageToken = null;
  do {
    const page = await searchPage(jql, fields, { maxResults: Math.min(100, cap - issues.length), nextPageToken });
    issues.push(...page.issues);
    nextPageToken = page.nextPageToken;
  } while (nextPageToken && issues.length < cap);
  return { issues, truncated: Boolean(nextPageToken) };
}

/**
 * Typeahead search for issues of a given type, by key or summary text.
 * Returns Select options `{ label, value }` where value is the issue id.
 */
export async function searchIssuesOfType(issueTypeName, text, projectKey) {
  const trimmed = String(text ?? '').trim();
  const clauses = [`issuetype = ${jqlString(issueTypeName)}`];
  if (projectKey) clauses.push(`project = ${jqlString(projectKey)}`);
  if (ISSUE_KEY_PATTERN.test(trimmed.toUpperCase())) {
    clauses.push(`key = ${jqlString(trimmed.toUpperCase())}`);
  } else if (trimmed) {
    clauses.push(`summary ~ ${jqlString(`${trimmed.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim()}*`)}`);
  }
  try {
    const { issues } = await searchPage(`${clauses.join(' AND ')} ORDER BY updated DESC`, ['summary'], {
      maxResults: 20,
    });
    return issues.map((issue) => ({ label: `${issue.key} ${issue.fields?.summary ?? ''}`, value: String(issue.id) }));
  } catch {
    // e.g. a key that doesn't exist makes JQL fail; treat as "no results".
    return [];
  }
}

// ---------------------------------------------------------------------------
// Links (Test Set membership and Story traceability)
// ---------------------------------------------------------------------------

/** The issue's links, with the linked issues' summary/status/type included by Jira. */
export async function getIssueLinks(issueIdOrKey) {
  const issue = await jiraJson(`/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}?fields=issuelinks`);
  return issue?.fields?.issuelinks ?? [];
}

/**
 * From an issue's links, pick the linked issues on one side of a link type.
 *
 * Jira link objects on issue X contain EITHER `outwardIssue` (meaning
 * "X <outward text> outwardIssue") OR `inwardIssue` (meaning
 * "inwardIssue <outward text> X").
 *
 * @param {'outward' | 'inward'} direction
 *   'outward': issues X points to (e.g. on a Test Set, the Tests it "contains")
 *   'inward':  issues pointing at X (e.g. on a Story, the Tests that "test" it)
 */
export function linkedIssues(links, linkTypeName, direction) {
  return links
    .filter((link) => link.type?.name === linkTypeName)
    .map((link) => ({ linkId: link.id, issue: direction === 'outward' ? link.outwardIssue : link.inwardIssue }))
    .filter((entry) => entry.issue);
}

/**
 * Create a link "fromId <outward text> toId", e.g.
 * createLink(LINK_TYPES.TEST, testId, storyId)  =>  "TEST tests STORY".
 */
export async function createLink(linkType, fromId, toId) {
  await jiraJson('/rest/api/3/issueLink', {
    method: 'POST',
    body: { type: { name: linkType.name }, inwardIssue: { id: fromId }, outwardIssue: { id: toId } },
  });
}

export async function deleteLink(linkId) {
  await jiraJson(`/rest/api/3/issueLink/${encodeURIComponent(linkId)}`, { method: 'DELETE' });
}

/** Members (Tests) of one or more Test Sets in ONE JQL search. */
export async function getTestSetMembers(testSetKeys, cap = 500) {
  if (testSetKeys.length === 0) return { issues: [], truncated: false };
  const clauses = testSetKeys.map(
    (key) => `issue in linkedIssues(${jqlString(key)}, ${jqlString(LINK_TYPES.TEST_SET.outward)})`
  );
  const jql = `issuetype = ${jqlString(ISSUE_TYPES.TEST)} AND (${clauses.join(' OR ')}) ORDER BY key`;
  return searchAll(jql, [...TABLE_FIELDS, 'issuelinks'], cap);
}

// ---------------------------------------------------------------------------
// Steps (issue entity property on the Test)
// ---------------------------------------------------------------------------

export function emptySteps() {
  return { v: STEPS_SCHEMA_VERSION, revision: 0, steps: [] };
}

export async function getSteps(issueId) {
  const property = await jiraJson(
    `/rest/api/3/issue/${encodeURIComponent(issueId)}/properties/${encodeURIComponent(STEPS_PROPERTY_KEY)}`,
    { allow404: true }
  );
  const value = property?.value;
  if (!value || !Array.isArray(value.steps)) return emptySteps();
  return { v: value.v ?? STEPS_SCHEMA_VERSION, revision: Number(value.revision) || 0, steps: value.steps };
}

/**
 * Save steps with an optimistic concurrency check: if someone else saved since
 * we loaded (revision changed), refuse and let the user reload. This is a
 * best-effort check (Jira has no conditional PUT), but it prevents the common
 * "two people editing at once" overwrite.
 */
export async function saveSteps(issueId, loadedRevision, steps) {
  const current = await getSteps(issueId);
  if (current.revision !== loadedRevision) {
    const error = new Error('These steps were changed by someone else. Reload to see the latest version.');
    error.code = 'CONFLICT';
    throw error;
  }
  const next = { v: STEPS_SCHEMA_VERSION, revision: loadedRevision + 1, steps };
  await jiraJson(
    `/rest/api/3/issue/${encodeURIComponent(issueId)}/properties/${encodeURIComponent(STEPS_PROPERTY_KEY)}`,
    { method: 'PUT', body: next }
  );
  return next;
}

// ---------------------------------------------------------------------------
// Attachments (evidence)
// ---------------------------------------------------------------------------

/** Current attachments of an issue: [{ id, filename, mimeType, size, content }]. */
export async function getAttachments(issueId) {
  const issue = await jiraJson(`/rest/api/3/issue/${encodeURIComponent(issueId)}?fields=attachment`);
  return (issue?.fields?.attachment ?? []).map((attachment) => ({
    id: String(attachment.id),
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    size: attachment.size,
    content: attachment.content,
  }));
}
