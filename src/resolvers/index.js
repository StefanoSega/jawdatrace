/**
 * Resolver entry point: maps `invoke('<name>', payload)` calls from the UI to
 * backend functions.
 *
 * Every resolver:
 *  1. makes sure the SQL schema is migrated (cheap after the first call),
 *  2. runs the function, which performs its own authorization checks,
 *  3. returns `{ ok: true, data }` or `{ ok: false, error: { code, message } }`.
 *
 * Errors are logged as ONE short line (no payloads, no user data).
 */
import Resolver from '@forge/resolver';
import { runMigrations } from '../db/migrations';
import { createExecution, getExecution, updateExecution, addExecutionTests, removeExecutionTests, listEnvironments } from './executions';
import { addPlanTests, getPlan, getTestPlans, listPlanExecutions, removePlanTests } from './plans';
import { getRuns, recordRun } from './runs';
import { getSetupState, purgeOrphans, runSetup } from './setup';
import { getStatuses } from './status';
import { getImportState, startImport } from './dataImport';

/** Turn any thrown error into a safe, user-facing error object. Exported for tests. */
export function toErrorResponse(error) {
  const code = error?.code ?? 'INTERNAL';
  // Only messages we wrote ourselves are shown; anything else is generic.
  const known = ['VALIDATION', 'FORBIDDEN', 'NOT_FOUND_OR_FORBIDDEN'];
  const message = known.includes(code) ? error.message : 'Something went wrong. Please try again.';
  return { ok: false, error: { code, message } };
}

/**
 * Wrap a function so it receives (payload, accountId) and returns a uniform
 * response. `needsSql` lets pure-Jira resolvers (setup state) skip migrations.
 */
export function wrap(name, fn, { needsSql = true } = {}) {
  return async ({ payload, context }) => {
    try {
      if (needsSql) await runMigrations();
      return { ok: true, data: await fn(payload ?? {}, context?.accountId) };
    } catch (error) {
      const response = toErrorResponse(error);
      if (response.error.code === 'INTERNAL' || response.error.code === 'JIRA_ERROR') {
        // Name, HTTP status and error code only (e.g. a Forge SQL error code);
        // never the message or payload, which could contain user data.
        const details = [error?.name ?? 'Error', error?.status, error?.code].filter(Boolean).join(' ');
        console.error(`[jawdatrace] ${name} failed: ${details}`);
      }
      return response;
    }
  };
}

const resolver = new Resolver();

// Runs
resolver.define('recordRun', wrap('recordRun', recordRun));
resolver.define('getRuns', wrap('getRuns', getRuns));
// Statuses
resolver.define('getStatuses', wrap('getStatuses', getStatuses));
// Plans
resolver.define('getPlan', wrap('getPlan', getPlan));
resolver.define('addPlanTests', wrap('addPlanTests', addPlanTests));
resolver.define('removePlanTests', wrap('removePlanTests', removePlanTests));
resolver.define('listPlanExecutions', wrap('listPlanExecutions', listPlanExecutions));
resolver.define('getTestPlans', wrap('getTestPlans', getTestPlans));
// Executions
resolver.define('createExecution', wrap('createExecution', createExecution));
resolver.define('getExecution', wrap('getExecution', getExecution));
resolver.define('updateExecution', wrap('updateExecution', updateExecution));
resolver.define('addExecutionTests', wrap('addExecutionTests', addExecutionTests));
resolver.define('removeExecutionTests', wrap('removeExecutionTests', removeExecutionTests));
resolver.define('listEnvironments', wrap('listEnvironments', listEnvironments));
// Admin
resolver.define('getSetupState', wrap('getSetupState', getSetupState, { needsSql: false }));
resolver.define('runSetup', wrap('runSetup', runSetup, { needsSql: false }));
resolver.define('purgeOrphans', wrap('purgeOrphans', purgeOrphans));
// Data import (admin; the work happens in the queue consumer)
resolver.define('getImportState', wrap('getImportState', getImportState));
resolver.define('startImport', wrap('startImport', startImport));

export const handler = resolver.getDefinitions();
