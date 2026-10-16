# Operations

## Inspecting Forge usage and billing

- **Developer console:** go to https://developer.atlassian.com/console/myapps/, choose **jawdatrace**, and open **Usage** (or **Metrics**). There you can see:
  - function invocations
  - invocation duration (GB-seconds)
  - Forge SQL requests and storage
  - errors, per environment
- **Logs:** run `forge logs -e development --since 15m`. Add `-n 200` for more lines. Resolvers log one line per unexpected failure (`[jawdatrace] <resolver> failed: <ErrorName> <status>`) and never log payloads.
- **Usage per installation:** the console's **Installations** view shows which sites use the app.

## Cost model per view

These are estimates from the code. Replace them with measured values (see Baseline below).

| View or action | Jira requests from the browser | Resolver invocations | Jira requests inside each resolver | SQL statements |
|---|---|---|---|---|
| Test panel, Steps tab | 1 | 0 | – | – |
| Test panel, Runs tab | 1 (attachments) | 1 `getRuns` | 1 (+1 if runs include Executions) | 1 |
| Save a run (ad-hoc) | 2 (steps + attachments, when the form opens) | 1 `recordRun` | 2 | 1 |
| Save a run (in an Execution) | 2 | 1 `recordRun` | 3 | 2 |
| Test Set panel | 1 (links) | 1 `getStatuses` (+1 `listEnvironments`) | 1 per 100 Tests (+1) | 1 (+1) |
| Story coverage panel | 1 (links) + 1 JQL (set members) | 1 `getStatuses` (+1 `listEnvironments`) | 1 per 100 Tests (+1) | 1 (+1) |
| Test Plan panel, Tests tab | 0 | 1 `getPlan` (+1 `listEnvironments`) | 1 + 1 per 100 Tests | 2 |
| Test Plan panel, Executions tab | 0 | 1 `listPlanExecutions` | 1 + 1 per 100 Executions | 2 |
| Test Execution panel | 0 | 1 `getExecution` | 1 + 1 per 100 Tests (+1 for the plan) | 3 |
| Coverage report, one page of 50 Stories | 2 JQL | 1 `getStatuses` per 500 Tests (+1 `listEnvironments` per page load) | 1 per 100 Tests | 1 |
| Coverage report, "Analyse Tests" (up to 1,000) | up to 10 JQL | 1 `getStatuses` per 500 Tests | 1 per 100 Tests | 1 per call |

Some actions cost one request per Test:
- Adding Tests to a **Test Set** creates one Jira link per Test, because Jira has no bulk link-create endpoint. This is capped at 100 per click.
- Adding Tests to a Plan or Execution is a single batched insert.

The scope picker (Test Set, Story coverage, coverage report) loads the project's environment list once per panel load with `listEnvironments`. Changing the environment or the "Final statuses have precedence" checkbox only repeats `getStatuses`.

## Baseline

Recorded on **2026-10-15** from the developer console (environment **development**, site `techstarter-test.atlassian.net`, one installation, one user). It covers the first install and the full end-to-end check:
- setup (issue types and link types)
- 4 Tests, 1 Test Set, 1 Story, and 1 Test Plan with 2 Test Executions
- 10 runs (8 Pass, 1 Fail with evidence, 1 Start/Executing)
- browsing every panel and the coverage report several times
- re-checks after four bug-fix redeploys

All usage is from that one day, because the app was first installed then.

| Metric | Value | Console page |
|---|---|---|
| Function invocations | **29** (0 errors, 100% success) | Invocation metrics, Development, last 24 h |
| Invocation response time | P50 **675 ms**, P90 1,590 ms, P95 1,815 ms | Invocation metrics |
| Functions compute | **10.77 GB-s** (about 0.37 GB-s per invocation at 256 MB) of 200,000 GB-s included per month | Usage and charges |
| Forge SQL requests | **106** (about 3.7 per invocation) of 100,000 included | Usage and charges |
| Forge SQL compute | **0.0008 h** of 1 h included | Usage and charges |
| Forge SQL storage | 0 GB-hours (rounds to zero) | Usage and charges |
| Outbound API requests from functions | **81**, all 2xx | API metrics, Development, last 24 h |
| Key-value store, object store, LLM, containers | 0 (not used) | Usage and charges |
| Extra charges | **$0** | Usage and charges |

How to read these numbers:
- **Not every resolver call is an invocation.** A Forge invocation is one function execution. Errors that resolvers return as `{ ok: false }`, such as the `getRuns` failure found during testing, count as successful invocations, so watch for them in the UI and with the `[jawdatrace] … failed` log line.
- **Browser requests aren't counted.** Jira requests made from the browser with `requestJira` (loading steps, links, JQL searches, creating links) aren't function invocations and don't appear in "API metrics". That traffic is why opening a panel usually costs only 0–1 invocations.
- **SQL requests per invocation:** about 3.7 is above the 1–3 per view in the cost model. It includes the migration runner checking which migrations have run each time a new runtime starts, plus the data setup during testing. Re-measure on a steady-state week before drawing conclusions.
- **Console lag:** usage data can be up to an hour behind, so activity in the last hour before 19:55 UTC may be missing.
- **Monthly runway:** at this rate a single active tester stays far below every free allowance, with compute about 0.005% and SQL requests about 0.1% of the monthly inclusion. Re-baseline once real teams use the app, and compare against the cost-per-view table above.

## Data retention, deletion and export

- **Retention:**
  - Test runs are immutable and kept indefinitely.
  - Removing a Test from an Execution or Plan removes only its membership, never its run history.
- **Deleted Jira issues:**
  - Their app data becomes unreachable right away, because every read is permission-checked against Jira.
  - To remove the data itself, go to **Jira settings → Apps → jawdatrace setup** and click **Purge data for deleted issues**.
  - The purge runs in batches of 100 issue references. It checks each issue as the app, so issues the app itself cannot access are treated as deleted.
- **Uninstall:** removes the app's Forge storage, following Forge's data retention policy.
- **Export:** not implemented in the MVP. Deferred by design.
- **Import from Xray:** a one-off admin import. See [Xray migration](#xray-migration) below.

## Xray migration

A one-off import copies the Xray Cloud data that Jira doesn't store: Test steps, Test Set and Test Plan membership, Test Executions (environment and plan) and their runs. Story↔Test/Set links ("Test") and Bug links ("Defect", "Blocks", "Relates") are already Jira links and need nothing.

**How it works**
- Code: `src/import/` (Xray client, mapping, worker) and `src/resolvers/xrayImport.js`.
- A Jira admin saves an Xray API key (Xray → Global Settings → API Keys) on **Jira settings → Apps → jawdatrace setup**. It is checked against Xray, then stored as a Forge KVS secret. It is never sent back to the browser.
- **Start import** saves the state in KVS (`xray-import:<KEY>`) and pushes one event to the `xray-import` queue. The `importWorker` consumer works through pages for up to about 9 minutes, saves its position after each page, then queues itself to continue. **Refresh status** shows the counters; nothing polls.
- This is the app's only background work, an approved exception to "no background jobs": it runs only when an admin starts it and stops when finished or failed.
- Stages and writes:
  1. **Tests** (50 per Xray call): the `jawdatrace.steps` property, one bulk Jira call per page (skipped when steps already exist). One Jira "Test Set" link per missing membership. One `plan_test` insert per page.
  2. **Executions** (50 per call): `test_execution` rows. Several Xray environments are joined into one ("Android, UAT"); only the first Plan is kept.
  3. **Runs** (100 per call): one `execution_test` insert and one `test_run` insert per page. `client_request_id = xray:<run id>` makes re-imports no-ops.
- Status mapping: PASSED→PASS, FAILED→FAIL, BLOCKED/ABORTED→BLOCKED, EXECUTING→EXECUTING. A TODO run becomes membership only. Custom statuses are skipped and counted.
- Not copied: step-level results, Xray evidence files, Test Case / Sub Test Execution / Precondition issues, Tests in more than 50 Sets or Plans (counted as "extra Sets/Plans not imported").
- Pacing: about 1 Xray request per second (Xray Standard allows 300 per 5 minutes). On 429 or 5xx the worker waits 120 s and continues by itself (status `waiting`). Any other error stops it (status `failed`) with a short code; fix the cause, then **Resume**.

**Estimated one-off cost for the BA project (Oct 2026: 8.7k Tests, 1.9k Executions)**
- Xray: about 175 Test pages + 40 Execution pages + about 750 run pages, so roughly 1,000 requests (about 20 minutes of pacing).
- Jira: about 175 bulk-fetch + 175 bulk-property calls, plus one link POST per Set membership (thousands, the slowest part).
- SQL: a few statements per page, and about 75k `test_run` rows (about 40 Tests × 1.9k Executions).
- Forge: a handful of consumer invocations of up to 9 minutes each. Record the measured numbers here after the run.

**Cutover runbook**
1. Install jawdatrace and run **Setup**. It reuses existing issue types and the "Test" link type with the same names, and creates the "Test Set" link type.
2. Ask testers to stop editing in Xray.
3. Save the Xray API key, enter the project key, and click **Start import**. Refresh until the status is `done`.
4. Spot-check:
   - a Story's coverage (for example BA-50427 should be NOK);
   - a Plan's counts (for example BA-51298: 19 passed, 5 executing, 17 to do, with all environments and final precedence);
   - an Execution's runs and environment.
5. Uninstall Xray only after the spot checks. Xray's own data is no longer reachable once it is uninstalled.
