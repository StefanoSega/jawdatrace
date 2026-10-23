/**
 * Forge SQL schema migrations.
 *
 * Migrations are append-only: never edit a migration that has shipped; add a
 * new one instead. The migration runner records which ones already ran, so
 * calling `runMigrations()` repeatedly is cheap and safe.
 *
 * Notes on the schema:
 *  - Jira ids (issue ids, project ids) are stored as VARCHAR because Jira
 *    returns them as strings and we never do arithmetic on them.
 *  - No foreign keys (not supported by Forge SQL); integrity is enforced in code.
 *  - `executed_at` uses DATETIME(3) (UTC, millisecond precision) so runs that
 *    happen in quick succession still order correctly; `id` breaks ties.
 */
import { migrationRunner } from '@forge/sql';

const MIGRATIONS = [
  [
    'v001_create_test_run',
    `CREATE TABLE IF NOT EXISTS test_run (
       id VARCHAR(36) NOT NULL PRIMARY KEY,
       test_issue_id VARCHAR(32) NOT NULL,
       execution_issue_id VARCHAR(32) NULL,
       status VARCHAR(16) NOT NULL,
       comment TEXT NULL,
       evidence TEXT NULL,
       steps_revision INT NULL,
       executed_by VARCHAR(128) NOT NULL,
       executed_at DATETIME(3) NOT NULL,
       client_request_id VARCHAR(64) NOT NULL,
       schema_version INT NOT NULL,
       UNIQUE KEY uq_test_run_request (test_issue_id, client_request_id),
       KEY idx_test_run_test (test_issue_id, executed_at),
       KEY idx_test_run_execution (execution_issue_id, test_issue_id, executed_at)
     )`,
  ],
  [
    'v002_create_test_execution',
    `CREATE TABLE IF NOT EXISTS test_execution (
       execution_issue_id VARCHAR(32) NOT NULL PRIMARY KEY,
       project_id VARCHAR(32) NOT NULL,
       plan_issue_id VARCHAR(32) NULL,
       environment VARCHAR(100) NULL,
       created_by VARCHAR(128) NOT NULL,
       created_at DATETIME(3) NOT NULL,
       schema_version INT NOT NULL,
       KEY idx_test_execution_plan (plan_issue_id),
       KEY idx_test_execution_project_env (project_id, environment)
     )`,
  ],
  [
    'v003_create_execution_test',
    `CREATE TABLE IF NOT EXISTS execution_test (
       execution_issue_id VARCHAR(32) NOT NULL,
       test_issue_id VARCHAR(32) NOT NULL,
       sort_order INT NOT NULL,
       added_at DATETIME(3) NOT NULL,
       PRIMARY KEY (execution_issue_id, test_issue_id),
       KEY idx_execution_test_test (test_issue_id)
     )`,
  ],
  [
    'v004_create_plan_test',
    `CREATE TABLE IF NOT EXISTS plan_test (
       plan_issue_id VARCHAR(32) NOT NULL,
       test_issue_id VARCHAR(32) NOT NULL,
       added_at DATETIME(3) NOT NULL,
       PRIMARY KEY (plan_issue_id, test_issue_id),
       KEY idx_plan_test_test (test_issue_id)
     )`,
  ],
  [
    // Progress of an admin-started data import, one row per project.
    'v005_create_import_job',
    `CREATE TABLE IF NOT EXISTS import_job (
       project_key VARCHAR(50) NOT NULL PRIMARY KEY,
       state TEXT NOT NULL,
       updated_at DATETIME(3) NOT NULL
     )`,
  ],
];

// Migrations only need to run once per warm runtime; remember the promise so
// concurrent resolver calls in the same runtime don't race each other.
let migrationsPromise = null;

/** Run any pending migrations (idempotent). */
export function runMigrations() {
  if (!migrationsPromise) {
    let runner = migrationRunner;
    for (const [name, statement] of MIGRATIONS) {
      runner = runner.enqueue(name, statement);
    }
    migrationsPromise = runner.run().catch((error) => {
      // Allow a retry on the next call instead of caching the failure forever.
      migrationsPromise = null;
      throw error;
    });
  }
  return migrationsPromise;
}

// Exported for tests.
export const _MIGRATIONS = MIGRATIONS;
export function _resetMigrationsForTests() {
  migrationsPromise = null;
}
