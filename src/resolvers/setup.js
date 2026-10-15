/**
 * Admin setup and maintenance resolvers (Jira administrators only).
 *
 *  - getSetupState / runSetup: create the app's issue types and link types.
 *    Idempotent: anything that already exists is left alone.
 *  - purgeOrphans: delete app data for Jira issues that no longer exist.
 *    Manual and batched (no scheduled job), the UI calls it page by page.
 */
import { ISSUE_TYPES, LINK_TYPES } from '../shared/constants';
import { deleteDataForIssues, selectReferencedIssueIds } from '../db/queries';
import { bulkFetchIssues, jira, route } from './jira';
import { assertJiraAdmin } from './permissions';

const ISSUE_TYPE_DESCRIPTIONS = {
  [ISSUE_TYPES.TEST]: 'A manual test case with steps and expected results (jawdatrace).',
  [ISSUE_TYPES.TEST_SET]: 'A reusable group of Tests (jawdatrace).',
  [ISSUE_TYPES.TEST_PLAN]: 'Tests planned for a release or build, executed by Test Executions (jawdatrace).',
  [ISSUE_TYPES.TEST_EXECUTION]: 'One run of a set of Tests, e.g. per platform or build (jawdatrace).',
};

const PURGE_BATCH = 100;

async function readState() {
  const [issueTypes, linkTypes] = await Promise.all([
    jira('user', route`/rest/api/3/issuetype`),
    jira('user', route`/rest/api/3/issueLinkType`),
  ]);
  // Only global (company-managed) issue types count; team-managed projects
  // have project-scoped types with a `scope` property.
  const globalTypeNames = new Set((issueTypes ?? []).filter((t) => !t.scope).map((t) => t.name));
  const linkTypeNames = new Set((linkTypes?.issueLinkTypes ?? []).map((t) => t.name));
  return {
    issueTypes: Object.values(ISSUE_TYPES).map((name) => ({ name, exists: globalTypeNames.has(name) })),
    linkTypes: Object.values(LINK_TYPES).map((type) => ({ ...type, exists: linkTypeNames.has(type.name) })),
  };
}

export async function getSetupState() {
  await assertJiraAdmin();
  return readState();
}

export async function runSetup() {
  await assertJiraAdmin();
  const state = await readState();
  const created = [];
  const failed = [];

  // Not atomic: create what is missing one by one and report partial results.
  for (const type of state.issueTypes.filter((t) => !t.exists)) {
    try {
      await jira('user', route`/rest/api/3/issuetype`, {
        method: 'POST',
        body: { name: type.name, description: ISSUE_TYPE_DESCRIPTIONS[type.name], hierarchyLevel: 0 },
      });
      created.push(`Issue type: ${type.name}`);
    } catch {
      failed.push(`Issue type: ${type.name}`);
    }
  }
  for (const type of state.linkTypes.filter((t) => !t.exists)) {
    try {
      await jira('user', route`/rest/api/3/issueLinkType`, {
        method: 'POST',
        body: { name: type.name, inward: type.inward, outward: type.outward },
      });
      created.push(`Link type: ${type.name}`);
    } catch {
      failed.push(`Link type: ${type.name}`);
    }
  }

  return { created, failed, state: await readState() };
}

/**
 * Scan one batch of referenced issue ids and delete data for issues that no
 * longer exist. Runs AS THE APP after the admin check, because an admin may
 * not have "Browse" on every project and we must not confuse "hidden" with
 * "deleted".
 *
 * payload: { afterId?: string }
 */
export async function purgeOrphans(payload) {
  await assertJiraAdmin();
  const afterId = typeof payload?.afterId === 'string' && /^\d*$/.test(payload.afterId) ? payload.afterId : '';
  const ids = await selectReferencedIssueIds(afterId, PURGE_BATCH);
  if (ids.length === 0) return { scanned: 0, purged: 0, nextAfterId: null };

  const existing = new Set((await bulkFetchIssues('app', ids, ['issuetype'])).map((issue) => String(issue.id)));
  const missing = ids.filter((id) => !existing.has(id));
  await deleteDataForIssues(missing);

  return {
    scanned: ids.length,
    purged: missing.length,
    nextAfterId: ids.length === PURGE_BATCH ? ids[ids.length - 1] : null,
  };
}
