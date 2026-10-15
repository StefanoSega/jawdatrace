/**
 * Constants shared by the frontend (UI Kit) and the backend (resolvers).
 *
 * Only NAMES live here. Jira IDs (issue type IDs, link type IDs, project IDs…)
 * differ on every site, so they are always looked up at runtime by name.
 */

// Jira issue type names created by the admin "setup" page.
export const ISSUE_TYPES = Object.freeze({
  TEST: 'Test',
  TEST_SET: 'Test Set',
  TEST_PLAN: 'Test Plan',
  TEST_EXECUTION: 'Test Execution',
});

// All four app issue types, handy for "is this one of ours?" checks.
export const APP_ISSUE_TYPE_NAMES = Object.freeze(Object.values(ISSUE_TYPES));

/**
 * Jira issue link types created by the setup page.
 *
 * Jira link semantics (easy to get backwards!):
 * when creating a link with POST /rest/api/3/issueLink, the issue passed as
 * `inwardIssue` is the one described by the `outward` text. For example, with
 * the "Test" link type, `{ inwardIssue: TEST-1, outwardIssue: STORY-9 }`
 * reads "TEST-1 tests STORY-9" and "STORY-9 is tested by TEST-1".
 */
export const LINK_TYPES = Object.freeze({
  // Story (or any requirement) <-> Test / Test Set
  TEST: Object.freeze({ name: 'Test', outward: 'tests', inward: 'is tested by' }),
  // Test Set <-> Test
  TEST_SET: Object.freeze({ name: 'Test Set', outward: 'contains', inward: 'is contained in' }),
});

// Issue entity property that stores a Test's manual steps.
export const STEPS_PROPERTY_KEY = 'jawdatrace.steps';
export const STEPS_SCHEMA_VERSION = 1;

/**
 * Run statuses that can be recorded.
 * EXECUTING means "a tester started this test" and is NOT a final result.
 */
export const RUN_STATUS = Object.freeze({
  EXECUTING: 'EXECUTING',
  PASS: 'PASS',
  FAIL: 'FAIL',
  BLOCKED: 'BLOCKED',
});
export const RECORDABLE_STATUSES = Object.freeze(Object.values(RUN_STATUS));
export const FINAL_STATUSES = Object.freeze([RUN_STATUS.PASS, RUN_STATUS.FAIL, RUN_STATUS.BLOCKED]);

// Display-only status for a Test that has no run in the current scope.
export const TODO = 'TODO';

// Overall (aggregated) status of a Story, Test Set, Test Plan or Test Execution.
export const OVERALL = Object.freeze({
  OK: 'OK',
  NOK: 'NOK',
  INCOMPLETE: 'INCOMPLETE',
  NO_TESTS: 'NO_TESTS',
});

// Status scopes understood by the `getStatuses` resolver.
export const SCOPE = Object.freeze({
  LATEST: 'latest', // latest final run anywhere
  PLAN: 'plan', // latest final run within a Test Plan's executions
  EXECUTION: 'execution', // latest run within one Test Execution
});

// Input limits (validated on the backend; mirrored in the UI for nicer errors).
export const LIMITS = Object.freeze({
  COMMENT_MAX: 5000,
  EVIDENCE_ITEMS_MAX: 20,
  URL_MAX: 2000,
  LABEL_MAX: 200,
  ENVIRONMENT_MAX: 100,
  STATUS_IDS_MAX: 500, // max Test IDs per getStatuses call
  ADD_TESTS_MAX: 500, // max Tests added to a plan/execution per call
  RUNS_PAGE_SIZE: 20,
  JQL_PAGE_SIZE: 100,
});

// Schema version stamped on every SQL row we write.
export const DATA_SCHEMA_VERSION = 1;
