/**
 * Personal data reporting (Atlassian user privacy guidelines).
 *
 * The app stores Atlassian account ids, and nothing else about people:
 *  - test_run.executed_by        who recorded a run
 *  - test_execution.created_by   who first set up an Execution
 *  - import_job state.startedBy  the admin who started a data import
 *
 * Marketplace apps that store account ids must report them to Atlassian
 * regularly (the default cycle is 7 days) and erase the data of accounts that
 * were closed. This scheduled trigger runs once a week:
 *  1. read the distinct stored account ids, 900 per SQL page
 *  2. report them, 90 per call (privacy.reportPersonalData -> /app/report-accounts)
 *  3. for every "closed" account, replace its id with "unknown" everywhere;
 *     the run itself stays (it is project history), only the person is removed.
 *     "updated" needs no action: we store no profile data to refresh.
 *
 * This is the app's second background job, an approved exception to the "no
 * background jobs" rule (docs/ENGINEERING_PRINCIPLES.md). Cost: one weekly
 * invocation with one SQL page and one report call per 90 people; most sites
 * have a few dozen testers, so typically one of each.
 */
import { privacy } from '@forge/api';
import { runMigrations } from '../db/migrations';
import { anonymiseAccountsInTables, saveImportJob, selectImportJobs, selectStoredAccounts } from '../db/queries';
import { UNKNOWN_ACCOUNT } from '../shared/constants';
const SQL_PAGE = 900;
const REPORT_BATCH = 90; // the API's limit per request

/**
 * Report one batch and return the ids Atlassian says were closed.
 * Called with at most 90 accounts, so the helper makes exactly one request.
 */
async function closedAccounts(batch) {
  const updates = await privacy.reportPersonalData(
    batch.map((row) => ({ accountId: row.accountId, updatedAt: row.storedSince }))
  );
  return (updates ?? []).filter((update) => update.status === 'closed').map((update) => update.accountId);
}

/** Replace closed accounts everywhere they are stored. */
async function anonymise(accountIds) {
  if (accountIds.length === 0) return;
  await anonymiseAccountsInTables(accountIds, UNKNOWN_ACCOUNT);
  const closed = new Set(accountIds);
  for (const job of await selectImportJobs()) {
    if (closed.has(job.startedBy)) await saveImportJob({ ...job, startedBy: UNKNOWN_ACCOUNT });
  }
}

/** Scheduled trigger entry point (manifest: function `privacyReport`). */
export async function handler() {
  let reported = 0;
  let closed = 0;
  const seen = new Set();
  const report = async (accounts) => {
    for (let index = 0; index < accounts.length; index += REPORT_BATCH) {
      const batch = accounts.slice(index, index + REPORT_BATCH);
      const ids = await closedAccounts(batch);
      await anonymise(ids);
      reported += batch.length;
      closed += ids.length;
    }
  };
  try {
    await runMigrations();
    // Runs and executions, paged by account id.
    let afterId = '';
    for (;;) {
      const page = await selectStoredAccounts(afterId, SQL_PAGE, UNKNOWN_ACCOUNT);
      page.forEach((row) => seen.add(row.accountId));
      await report(page);
      if (page.length < SQL_PAGE) break;
      afterId = page[page.length - 1].accountId;
    }
    // Admins who started an import, unless already reported above.
    const admins = new Map();
    for (const job of await selectImportJobs()) {
      const id = job.startedBy;
      if (!id || id === UNKNOWN_ACCOUNT || seen.has(id) || admins.has(id)) continue;
      admins.set(id, { accountId: id, storedSince: job.startedAt ?? job.updatedAt });
    }
    await report([...admins.values()]);
  } catch (error) {
    // The next weekly run tries again; never log account ids.
    const status = error?.status ? ` ${error.status}` : '';
    console.error(`[jawdatrace] personal data report failed after ${reported} accounts: ${error?.name ?? 'Error'}${status}`);
    return;
  }
  console.log(`[jawdatrace] personal data report: ${reported} accounts, ${closed} closed`);
}
