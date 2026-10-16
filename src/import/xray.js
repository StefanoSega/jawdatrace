/**
 * Minimal Xray Cloud API client (used only by the one-off importer).
 *
 * Xray keeps steps, Test Set / Plan / Execution membership and test runs in
 * its own backend, not in Jira, so the importer reads them from Xray's GraphQL
 * API. Authentication uses an Xray API key (Client ID + Client Secret) created
 * by a Jira admin in Xray's Global Settings; it is exchanged for a short-lived
 * token. The hosts must be listed under `permissions.external.fetch.backend`
 * in manifest.yml, otherwise Forge blocks the request.
 *
 * Xray limits (2026): 100 items per connection, 10,000 items and 25 resolvers
 * per query, 300 requests per 5 minutes (Standard). The importer paces itself.
 */
import { fetch } from '@forge/api';

/** Xray regions -> base URL. "global" routes to the right region itself. */
export const XRAY_REGIONS = Object.freeze({
  global: 'https://xray.cloud.getxray.app',
  us: 'https://us.xray.cloud.getxray.app',
  eu: 'https://eu.xray.cloud.getxray.app',
  au: 'https://au.xray.cloud.getxray.app',
});

export class XrayError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'XrayError';
    this.status = status;
    this.code = status === 429 ? 'XRAY_RATE_LIMITED' : status === 401 ? 'XRAY_UNAUTHORIZED' : 'XRAY_ERROR';
  }
}

/** Exchange the API key for a token. Throws XrayError (401 for bad keys). */
export async function authenticate(region, clientId, clientSecret) {
  const response = await fetch(`${XRAY_REGIONS[region] ?? XRAY_REGIONS.global}/api/v2/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
  });
  if (!response.ok) throw new XrayError(response.status, `Xray authentication failed with status ${response.status}`);
  // The token comes back as a JSON string: "eyJ...".
  const token = JSON.parse(await response.text());
  if (typeof token !== 'string' || !token) throw new XrayError(500, 'Xray returned no token');
  return token;
}

/**
 * Run one GraphQL query. Throws XrayError on HTTP errors and on GraphQL
 * errors (reported as status 400, or 429 when Xray says we hit a limit).
 */
export async function graphql(region, token, query, variables) {
  const response = await fetch(`${XRAY_REGIONS[region] ?? XRAY_REGIONS.global}/api/v2/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new XrayError(response.status, `Xray request failed with status ${response.status}`);
  const result = JSON.parse(await response.text());
  if (result.errors?.length) {
    const limited = result.errors.some((error) => /limit/i.test(String(error?.message)));
    throw new XrayError(limited ? 429 : 400, 'Xray GraphQL query failed');
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Queries. Page sizes keep each query under Xray's 10,000-item limit:
// 50 Tests x (50 Sets + 50 Plans) = 5,050 items.
// ---------------------------------------------------------------------------

export const TESTS_PAGE = 50;
export const EXECUTIONS_PAGE = 50;
export const RUNS_PAGE = 100;

export const TESTS_QUERY = `
  query ($jql: String!, $start: Int!) {
    getTests(jql: $jql, limit: ${TESTS_PAGE}, start: $start) {
      total
      results {
        issueId
        steps { id action data result }
        testSets(limit: 50) { total results { issueId } }
        testPlans(limit: 50) { total results { issueId } }
      }
    }
  }`;

export const EXECUTIONS_QUERY = `
  query ($jql: String!, $start: Int!) {
    getTestExecutions(jql: $jql, limit: ${EXECUTIONS_PAGE}, start: $start) {
      total
      results {
        issueId
        testEnvironments
        testPlans(limit: 5) { total results { issueId } }
      }
    }
  }`;

export const RUNS_QUERY = `
  query ($execIds: [String], $start: Int!) {
    getTestRuns(testExecIssueIds: $execIds, limit: ${RUNS_PAGE}, start: $start) {
      total
      results {
        id
        status { name }
        test { issueId }
        testExecution { issueId }
        executedById
        startedOn
        finishedOn
        comment
      }
    }
  }`;
