/**
 * Thin wrapper around Forge's Jira REST client for use inside resolvers.
 *
 * - Always calls Jira AS THE USER unless explicitly told otherwise, so Jira
 *   enforces the user's own permissions.
 * - Retries a small number of times on rate limiting (429) and transient
 *   server errors (502/503/504), honouring Retry-After when present.
 * - Throws a JiraError with the HTTP status on failure; never logs payloads.
 */
import api, { route } from '@forge/api';

export { route };

const RETRYABLE = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

export class JiraError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'JiraError';
    this.status = status;
    this.code = status === 403 || status === 404 ? 'NOT_FOUND_OR_FORBIDDEN' : 'JIRA_ERROR';
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {'user' | 'app'} as - who makes the call; 'app' only after an explicit permission check
 * @param {ReturnType<typeof route>} path - built with the `route` tagged template (escapes params)
 * @param {RequestInit & { body?: object }} [options]
 * @returns {Promise<any>} parsed JSON (or null for 204)
 */
export async function jira(as, path, options = {}) {
  const client = as === 'app' ? api.asApp() : api.asUser();
  const init = {
    method: options.method ?? 'GET',
    headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  };

  for (let attempt = 1; ; attempt += 1) {
    const response = await client.requestJira(path, init);
    if (response.ok) {
      if (response.status === 204) return null;
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    }
    if (RETRYABLE.has(response.status) && attempt < MAX_ATTEMPTS) {
      const retryAfter = Number(response.headers?.get?.('Retry-After'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 5) * 1000 : 300 * attempt);
      continue;
    }
    throw new JiraError(response.status, `Jira request failed with status ${response.status}`);
  }
}

/**
 * Fetch many issues by id in as few requests as possible (100 per request).
 * Issues that are deleted or not visible to the caller are simply omitted.
 *
 * @param {'user' | 'app'} as
 * @param {string[]} issueIds
 * @param {string[]} fields - e.g. ['issuetype'] or ['summary', 'status']
 * @param {string[]} [properties] - issue property keys to include
 * @returns {Promise<object[]>}
 */
export async function bulkFetchIssues(as, issueIds, fields, properties = []) {
  const issues = [];
  for (let index = 0; index < issueIds.length; index += 100) {
    const chunk = issueIds.slice(index, index + 100);
    const result = await jira(as, route`/rest/api/3/issue/bulkfetch`, {
      method: 'POST',
      body: { issueIdsOrKeys: chunk, fields, ...(properties.length ? { properties } : {}) },
    });
    issues.push(...(result?.issues ?? []));
  }
  return issues;
}

/**
 * Run a JQL search as the user, following `nextPageToken` until done or until
 * `maxResults` items were collected. Uses the enhanced search endpoint.
 *
 * @param {string} jql
 * @param {string[]} fields - keep this minimal; [] returns ids only
 * @param {number} maxResults - hard cap across pages
 */
export async function searchJql(jql, fields, maxResults) {
  const issues = [];
  let nextPageToken;
  do {
    const page = await jira('user', route`/rest/api/3/search/jql`, {
      method: 'POST',
      body: {
        jql,
        fields: fields.length ? fields : ['id'],
        maxResults: Math.min(100, maxResults - issues.length),
        ...(nextPageToken ? { nextPageToken } : {}),
      },
    });
    issues.push(...(page?.issues ?? []));
    nextPageToken = page?.nextPageToken;
  } while (nextPageToken && issues.length < maxResults);
  return issues;
}
