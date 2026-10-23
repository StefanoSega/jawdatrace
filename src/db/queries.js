/**
 * All SQL used by the app, in one place.
 *
 * Every query is parameterised (`?` placeholders + bindParams). Dynamic parts
 * are limited to the NUMBER of placeholders for IN (…) lists; the values
 * themselves are always bound, never concatenated.
 *
 * Callers (resolvers) are responsible for authorization BEFORE calling these.
 */
import sql from '@forge/sql';
import { DATA_SCHEMA_VERSION, RUN_STATUS } from '../shared/constants';

/** "?, ?, ?" for an IN (…) list. */
export function placeholders(count) {
  return new Array(count).fill('?').join(', ');
}

/** A safe integer for an inlined LIMIT clause (1..1000). */
export function toLimit(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 1000) throw new Error('Invalid LIMIT value');
  return number;
}

/** JS Date -> 'YYYY-MM-DD HH:MM:SS.mmm' (UTC) for DATETIME(3) columns. */
export function toSqlDateTime(date = new Date()) {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

/** SQL DATETIME string (UTC) -> ISO-8601 string for the UI. */
export function fromSqlDateTime(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  return text.includes('T') ? text : `${text.replace(' ', 'T')}Z`;
}

async function query(statement, params = []) {
  const prepared = sql.prepare(statement);
  const result = await (params.length ? prepared.bindParams(...params) : prepared).execute();
  return result.rows;
}

// ---------------------------------------------------------------------------
// Test runs
// ---------------------------------------------------------------------------

/**
 * Insert a run. Idempotent per (test_issue_id, client_request_id): a repeated
 * submission of the same form is ignored, and the existing row is returned.
 *
 * @returns {Promise<{ inserted: boolean }>}
 */
export async function insertRun(run) {
  const result = await query(
    `INSERT IGNORE INTO test_run
       (id, test_issue_id, execution_issue_id, status, comment, evidence, steps_revision,
        executed_by, executed_at, client_request_id, schema_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      run.id,
      run.testIssueId,
      run.executionIssueId ?? null,
      run.status,
      run.comment ?? null,
      JSON.stringify(run.evidence),
      run.stepsRevision ?? null,
      run.executedBy,
      toSqlDateTime(run.executedAt),
      run.clientRequestId,
      DATA_SCHEMA_VERSION,
    ]
  );
  return { inserted: (result?.affectedRows ?? 0) > 0 };
}

/**
 * One page of a Test's run history, newest first (keyset pagination).
 * Joins the execution so the UI can show which Execution/environment it ran in.
 *
 * @param {string} testIssueId
 * @param {{ executedAt: string, id: string } | null} cursor - last row of the previous page
 * @param {number} pageSize
 */
export async function selectRunsPage(testIssueId, cursor, pageSize) {
  const params = [testIssueId];
  let cursorClause = '';
  if (cursor) {
    cursorClause = 'AND (r.executed_at < ? OR (r.executed_at = ? AND r.id < ?))';
    params.push(cursor.executedAt, cursor.executedAt, cursor.id);
  }
  // Fetch one extra row to know whether another page exists. LIMIT is inlined
  // as a validated integer: Forge SQL rejects a bound `LIMIT ?` parameter.
  const limit = toLimit(pageSize + 1);
  return query(
    `SELECT r.id, r.status, r.comment, r.evidence, r.steps_revision, r.executed_by,
            r.executed_at, r.execution_issue_id, e.environment
       FROM test_run r
       LEFT JOIN test_execution e ON e.execution_issue_id = r.execution_issue_id
      WHERE r.test_issue_id = ? ${cursorClause}
      ORDER BY r.executed_at DESC, r.id DESC
      LIMIT ${limit}`,
    params
  );
}

/**
 * Latest runs per Test AND ENVIRONMENT for a scope, in ONE statement.
 *
 * For every requested Test and every environment it ran in, it returns up to
 * two rows:
 *   - the newest run of any status   (rn_any = 1)
 *   - the newest FINAL run           (rn_final = 1, status <> EXECUTING)
 * The caller resolves each environment with resolveDisplayStatus() (so a
 * freshly started re-run shows as EXECUTING) and then combines environments
 * with combineEnvironmentStatuses() (so a failure on iOS isn't hidden by a
 * later pass on Android). Ad-hoc runs (no execution) form their own bucket.
 *
 * @param {string[]} testIssueIds - already permission-filtered
 * @param {{ kind: 'latest' | 'plan' | 'execution', id?: string, environment?: string | null }} scope
 *   environment applies to the latest and plan scopes (an execution has one environment already)
 */
export async function selectLatestRuns(testIssueIds, scope) {
  if (testIssueIds.length === 0) return [];
  const params = [...testIssueIds];
  let scopeWhere = '';
  if (scope.kind === 'execution') {
    scopeWhere = 'AND r.execution_issue_id = ?';
    params.push(scope.id);
  } else if (scope.kind === 'plan') {
    scopeWhere = 'AND e.plan_issue_id = ?';
    params.push(scope.id);
  }
  // Environment filter for the latest and plan scopes. Ad-hoc runs have no
  // execution row (e.* is NULL), so they drop out when a filter is set.
  if (scope.environment && scope.kind !== 'execution') {
    scopeWhere += ' AND e.environment = ?';
    params.push(scope.environment);
  }
  return query(
    `SELECT test_issue_id, env, status, executed_at, executed_by, rn_any, rn_final
       FROM (
         SELECT r.test_issue_id, COALESCE(e.environment, '') AS env, r.status, r.executed_at, r.executed_by,
                ROW_NUMBER() OVER (PARTITION BY r.test_issue_id, COALESCE(e.environment, '')
                                   ORDER BY r.executed_at DESC, r.id DESC) AS rn_any,
                ROW_NUMBER() OVER (PARTITION BY r.test_issue_id, COALESCE(e.environment, ''),
                                                (r.status = '${RUN_STATUS.EXECUTING}')
                                   ORDER BY r.executed_at DESC, r.id DESC) AS rn_final
           FROM test_run r
           LEFT JOIN test_execution e ON e.execution_issue_id = r.execution_issue_id
          WHERE r.test_issue_id IN (${placeholders(testIssueIds.length)}) ${scopeWhere}
       ) ranked
      WHERE rn_any = 1 OR (rn_final = 1 AND status <> '${RUN_STATUS.EXECUTING}')`,
    params
  );
}

// ---------------------------------------------------------------------------
// Test executions
// ---------------------------------------------------------------------------

export async function selectExecution(executionIssueId) {
  const rows = await query(
    `SELECT execution_issue_id, project_id, plan_issue_id, environment, created_by, created_at
       FROM test_execution WHERE execution_issue_id = ?`,
    [executionIssueId]
  );
  return rows[0] ?? null;
}

/**
 * Create the execution row only if it is missing; never overwrites plan or
 * environment. Used when Tests are added to an Execution that was created
 * with Jira's native "Create" button (so the app has no row for it yet).
 */
export async function ensureExecution({ executionIssueId, projectId, createdBy }) {
  await query(
    `INSERT IGNORE INTO test_execution
       (execution_issue_id, project_id, plan_issue_id, environment, created_by, created_at, schema_version)
     VALUES (?, ?, NULL, NULL, ?, ?, ?)`,
    [executionIssueId, projectId, createdBy, toSqlDateTime(), DATA_SCHEMA_VERSION]
  );
}

/** True when the Test is a member of the Execution. */
export async function isTestInExecution(executionIssueId, testIssueId) {
  const rows = await query(
    'SELECT 1 AS found FROM execution_test WHERE execution_issue_id = ? AND test_issue_id = ? LIMIT 1',
    [executionIssueId, testIssueId]
  );
  return rows.length > 0;
}

/** Create or update the execution row (sets plan and environment). */
export async function upsertExecution({ executionIssueId, projectId, planIssueId, environment, createdBy }) {
  await query(
    `INSERT INTO test_execution
       (execution_issue_id, project_id, plan_issue_id, environment, created_by, created_at, schema_version)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE plan_issue_id = VALUES(plan_issue_id), environment = VALUES(environment)`,
    [
      executionIssueId,
      projectId,
      planIssueId ?? null,
      environment ?? null,
      createdBy,
      toSqlDateTime(),
      DATA_SCHEMA_VERSION,
    ]
  );
}

export async function selectExecutionTests(executionIssueId) {
  return query(
    `SELECT test_issue_id, sort_order FROM execution_test
      WHERE execution_issue_id = ? ORDER BY sort_order, test_issue_id`,
    [executionIssueId]
  );
}

/** Append Tests to an execution, keeping existing order; duplicates are ignored. */
export async function insertExecutionTests(executionIssueId, testIssueIds) {
  if (testIssueIds.length === 0) return;
  const [{ max_order: maxOrder } = {}] = await query(
    'SELECT MAX(sort_order) AS max_order FROM execution_test WHERE execution_issue_id = ?',
    [executionIssueId]
  );
  const start = Number(maxOrder ?? 0);
  const now = toSqlDateTime();
  const values = [];
  testIssueIds.forEach((testId, index) => {
    values.push(executionIssueId, testId, start + index + 1, now);
  });
  await query(
    `INSERT IGNORE INTO execution_test (execution_issue_id, test_issue_id, sort_order, added_at)
     VALUES ${testIssueIds.map(() => '(?, ?, ?, ?)').join(', ')}`,
    values
  );
}

export async function deleteExecutionTests(executionIssueId, testIssueIds) {
  if (testIssueIds.length === 0) return;
  await query(
    `DELETE FROM execution_test
      WHERE execution_issue_id = ? AND test_issue_id IN (${placeholders(testIssueIds.length)})`,
    [executionIssueId, ...testIssueIds]
  );
}

/** Executions of a plan with per-status counts, in one statement. */
export async function selectPlanExecutionsWithCounts(planIssueId) {
  return query(
    `SELECT e.execution_issue_id, e.environment, e.created_at,
            COUNT(et.test_issue_id) AS total
       FROM test_execution e
       LEFT JOIN execution_test et ON et.execution_issue_id = e.execution_issue_id
      WHERE e.plan_issue_id = ?
      GROUP BY e.execution_issue_id, e.environment, e.created_at
      ORDER BY e.created_at DESC`,
    [planIssueId]
  );
}

/**
 * Latest run status per (execution, test) for all executions of a plan, used
 * to compute each execution's progress bar without one query per execution.
 */
export async function selectPlanExecutionStatuses(planIssueId) {
  return query(
    `SELECT execution_issue_id, test_issue_id, status FROM (
       SELECT r.execution_issue_id, r.test_issue_id, r.status,
              ROW_NUMBER() OVER (PARTITION BY r.execution_issue_id, r.test_issue_id
                                 ORDER BY r.executed_at DESC, r.id DESC) AS rn
         FROM test_run r
         JOIN test_execution e ON e.execution_issue_id = r.execution_issue_id
         JOIN execution_test et ON et.execution_issue_id = r.execution_issue_id
                               AND et.test_issue_id = r.test_issue_id
        WHERE e.plan_issue_id = ?
     ) ranked WHERE rn = 1`,
    [planIssueId]
  );
}

/** Distinct environments used in a project (for suggestions). */
export async function selectEnvironments(projectId) {
  const rows = await query(
    `SELECT DISTINCT environment FROM test_execution
      WHERE project_id = ? AND environment IS NOT NULL AND environment <> ''
      ORDER BY environment LIMIT 50`,
    [projectId]
  );
  return rows.map((row) => row.environment);
}

// ---------------------------------------------------------------------------
// Test plans
// ---------------------------------------------------------------------------

/** Plan members plus how many of the plan's executions include each Test. */
export async function selectPlanTests(planIssueId) {
  return query(
    `SELECT pt.test_issue_id, pt.added_at,
            (SELECT COUNT(*) FROM execution_test et
               JOIN test_execution e ON e.execution_issue_id = et.execution_issue_id
              WHERE e.plan_issue_id = pt.plan_issue_id AND et.test_issue_id = pt.test_issue_id
            ) AS execution_count
       FROM plan_test pt
      WHERE pt.plan_issue_id = ?
      ORDER BY pt.added_at, pt.test_issue_id`,
    [planIssueId]
  );
}

export async function insertPlanTests(planIssueId, testIssueIds) {
  if (testIssueIds.length === 0) return;
  const now = toSqlDateTime();
  const values = testIssueIds.flatMap((testId) => [planIssueId, testId, now]);
  await query(
    `INSERT IGNORE INTO plan_test (plan_issue_id, test_issue_id, added_at)
     VALUES ${testIssueIds.map(() => '(?, ?, ?)').join(', ')}`,
    values
  );
}

export async function deletePlanTests(planIssueId, testIssueIds) {
  if (testIssueIds.length === 0) return;
  await query(
    `DELETE FROM plan_test WHERE plan_issue_id = ? AND test_issue_id IN (${placeholders(testIssueIds.length)})`,
    [planIssueId, ...testIssueIds]
  );
}

/** Plans that contain a Test (for the Test panel's "Plans" tab). */
export async function selectPlansForTest(testIssueId) {
  const rows = await query('SELECT plan_issue_id FROM plan_test WHERE test_issue_id = ? LIMIT 200', [
    testIssueId,
  ]);
  return rows.map((row) => row.plan_issue_id);
}

// ---------------------------------------------------------------------------
// Maintenance (admin purge)
// ---------------------------------------------------------------------------

/**
 * Distinct issue ids referenced by app data, paged by id. Used by the admin
 * purge to find rows whose Jira issue no longer exists.
 */
export async function selectReferencedIssueIds(afterId, limit) {
  const rows = await query(
    `SELECT issue_id FROM (
       SELECT test_issue_id AS issue_id FROM test_run
       UNION SELECT execution_issue_id FROM test_execution
       UNION SELECT test_issue_id FROM execution_test
       UNION SELECT plan_issue_id FROM plan_test
       UNION SELECT test_issue_id FROM plan_test
     ) ids
     WHERE issue_id > ?
     ORDER BY issue_id
     LIMIT ${toLimit(limit)}`,
    [afterId ?? '']
  );
  return rows.map((row) => row.issue_id);
}

/** Delete every row that references any of the given (deleted) issue ids. */
export async function deleteDataForIssues(issueIds) {
  if (issueIds.length === 0) return;
  const list = placeholders(issueIds.length);
  await query(`DELETE FROM test_run WHERE test_issue_id IN (${list}) OR execution_issue_id IN (${list})`, [
    ...issueIds,
    ...issueIds,
  ]);
  await query(`DELETE FROM execution_test WHERE test_issue_id IN (${list}) OR execution_issue_id IN (${list})`, [
    ...issueIds,
    ...issueIds,
  ]);
  await query(`DELETE FROM plan_test WHERE test_issue_id IN (${list}) OR plan_issue_id IN (${list})`, [
    ...issueIds,
    ...issueIds,
  ]);
  await query(`DELETE FROM test_execution WHERE execution_issue_id IN (${list})`, issueIds);
  // Executions whose plan was deleted keep their runs but lose the plan reference.
  await query(`UPDATE test_execution SET plan_issue_id = NULL WHERE plan_issue_id IN (${list})`, issueIds);
}

// ---------------------------------------------------------------------------
// Data import (bulk, idempotent inserts; one statement per page)
// ---------------------------------------------------------------------------

/** Many (plan, test) pairs in one statement; existing pairs are ignored. */
export async function insertPlanTestPairs(pairs) {
  if (pairs.length === 0) return;
  const now = toSqlDateTime();
  await query(
    `INSERT IGNORE INTO plan_test (plan_issue_id, test_issue_id, added_at)
     VALUES ${pairs.map(() => '(?, ?, ?)').join(', ')}`,
    pairs.flatMap((pair) => [pair.planIssueId, pair.testIssueId, now])
  );
}

/** Many execution memberships in one statement; existing rows keep their order. */
export async function insertExecutionTestRows(rows) {
  if (rows.length === 0) return;
  const now = toSqlDateTime();
  await query(
    `INSERT IGNORE INTO execution_test (execution_issue_id, test_issue_id, sort_order, added_at)
     VALUES ${rows.map(() => '(?, ?, ?, ?)').join(', ')}`,
    rows.flatMap((row) => [row.executionIssueId, row.testIssueId, row.sortOrder, now])
  );
}

/**
 * Many runs in one statement. Idempotent through the unique key
 * (test_issue_id, client_request_id): importing the same run again is a no-op.
 *
 * @returns {Promise<number>} rows actually inserted
 */
export async function insertRuns(runs) {
  if (runs.length === 0) return 0;
  const result = await query(
    `INSERT IGNORE INTO test_run
       (id, test_issue_id, execution_issue_id, status, comment, evidence, steps_revision,
        executed_by, executed_at, client_request_id, schema_version)
     VALUES ${runs.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
    runs.flatMap((run) => [
      run.id,
      run.testIssueId,
      run.executionIssueId ?? null,
      run.status,
      run.comment ?? null,
      JSON.stringify(run.evidence),
      null,
      run.executedBy,
      toSqlDateTime(run.executedAt),
      run.clientRequestId,
      DATA_SCHEMA_VERSION,
    ])
  );
  return result?.affectedRows ?? 0;
}

/** The import job of a project (state is a JSON object), or null. */
export async function selectImportJob(projectKey) {
  const rows = await query('SELECT state, updated_at FROM import_job WHERE project_key = ?', [projectKey]);
  if (rows.length === 0) return null;
  return { ...JSON.parse(rows[0].state), updatedAt: fromSqlDateTime(rows[0].updated_at) };
}

/** Create or replace the import job of a project. */
export async function saveImportJob(job) {
  const { updatedAt, ...state } = job;
  await query(
    `INSERT INTO import_job (project_key, state, updated_at) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE state = VALUES(state), updated_at = VALUES(updated_at)`,
    [state.projectKey, JSON.stringify(state), toSqlDateTime()]
  );
}

/** Every import job (one per project; a handful of rows at most). */
export async function selectImportJobs() {
  const rows = await query('SELECT state, updated_at FROM import_job');
  return rows.map((row) => ({ ...JSON.parse(row.state), updatedAt: fromSqlDateTime(row.updated_at) }));
}

// ---------------------------------------------------------------------------
// Personal data (src/privacy/report.js)
// ---------------------------------------------------------------------------

/**
 * Distinct account ids stored in runs and executions, paged by id, with the
 * oldest time each was stored (what the reporting API calls `updatedAt`).
 * The placeholder `excludeId` ("unknown") is never reported.
 */
export async function selectStoredAccounts(afterId, limit, excludeId = 'unknown') {
  const rows = await query(
    `SELECT account_id, MIN(stored_at) AS stored_since FROM (
       SELECT executed_by AS account_id, executed_at AS stored_at FROM test_run
       UNION ALL SELECT created_by, created_at FROM test_execution
     ) accounts
     WHERE account_id > ? AND account_id <> ?
     GROUP BY account_id
     ORDER BY account_id
     LIMIT ${toLimit(limit)}`,
    [afterId ?? '', excludeId]
  );
  return rows.map((row) => ({ accountId: row.account_id, storedSince: fromSqlDateTime(row.stored_since) }));
}

/** Replace closed accounts' ids with a placeholder in runs and executions. */
export async function anonymiseAccountsInTables(accountIds, replacement) {
  if (accountIds.length === 0) return;
  const list = placeholders(accountIds.length);
  await query(`UPDATE test_run SET executed_by = ? WHERE executed_by IN (${list})`, [replacement, ...accountIds]);
  await query(`UPDATE test_execution SET created_by = ? WHERE created_by IN (${list})`, [replacement, ...accountIds]);
}

// ---------------------------------------------------------------------------
// Data export (src/exporter/worker.js); ids come from the job's project only
// ---------------------------------------------------------------------------

/** All Executions of a project with their plan and environment. */
export async function selectProjectExecutions(projectId) {
  return query(
    `SELECT execution_issue_id, plan_issue_id, environment FROM test_execution
     WHERE project_id = ? ORDER BY execution_issue_id`,
    [projectId]
  );
}

/** Members of many Executions, in each Execution's order. */
export async function selectExecutionMembers(executionIssueIds) {
  if (executionIssueIds.length === 0) return [];
  return query(
    `SELECT execution_issue_id, test_issue_id FROM execution_test
     WHERE execution_issue_id IN (${placeholders(executionIssueIds.length)})
     ORDER BY execution_issue_id, sort_order, test_issue_id`,
    executionIssueIds
  );
}

/** Plan memberships of many Plans. */
export async function selectPlanMembers(planIssueIds) {
  if (planIssueIds.length === 0) return [];
  return query(
    `SELECT plan_issue_id, test_issue_id FROM plan_test
     WHERE plan_issue_id IN (${placeholders(planIssueIds.length)})
     ORDER BY plan_issue_id, test_issue_id`,
    planIssueIds
  );
}

const EXPORT_RUN_COLUMNS = 'id, test_issue_id, execution_issue_id, status, comment, executed_by, executed_at, client_request_id';

/** Runs recorded in many Executions. */
export async function selectRunsOfExecutions(executionIssueIds) {
  if (executionIssueIds.length === 0) return [];
  return query(
    `SELECT ${EXPORT_RUN_COLUMNS} FROM test_run
     WHERE execution_issue_id IN (${placeholders(executionIssueIds.length)})
     ORDER BY executed_at, id`,
    executionIssueIds
  );
}

/** Ad-hoc runs (no Execution) of many Tests. */
export async function selectAdHocRuns(testIssueIds) {
  if (testIssueIds.length === 0) return [];
  return query(
    `SELECT ${EXPORT_RUN_COLUMNS} FROM test_run
     WHERE execution_issue_id IS NULL AND test_issue_id IN (${placeholders(testIssueIds.length)})
     ORDER BY executed_at, id`,
    testIssueIds
  );
}

/** The export job of a project, or null. */
export async function selectExportJob(projectKey) {
  const rows = await query('SELECT state, updated_at FROM export_job WHERE project_key = ?', [projectKey]);
  if (rows.length === 0) return null;
  return { ...JSON.parse(rows[0].state), updatedAt: fromSqlDateTime(rows[0].updated_at) };
}

/** Create or replace the export job of a project. */
export async function saveExportJob(job) {
  const { updatedAt, ...state } = job;
  await query(
    `INSERT INTO export_job (project_key, state, updated_at) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE state = VALUES(state), updated_at = VALUES(updated_at)`,
    [state.projectKey, JSON.stringify(state), toSqlDateTime()]
  );
}
