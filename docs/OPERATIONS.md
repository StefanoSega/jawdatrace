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
| Test Set panel | 1 (links) | 1 `getStatuses` | 1 per 100 Tests | 1 |
| Story coverage panel | 1 (links) + 1 JQL (set members) | 1 `getStatuses` | 1 per 100 Tests | 1 |
| Test Plan panel, Tests tab | 0 | 1 `getPlan` (+1 `listEnvironments`) | 1 + 1 per 100 Tests | 2 |
| Test Plan panel, Executions tab | 0 | 1 `listPlanExecutions` | 1 + 1 per 100 Executions | 2 |
| Test Execution panel | 0 | 1 `getExecution` | 1 + 1 per 100 Tests (+1 for the plan) | 3 |
| Coverage report, one page of 50 Stories | 2 JQL | 1 `getStatuses` per 500 Tests | 1 per 100 Tests | 1 |
| Coverage report, "Analyse Tests" (up to 1,000) | up to 10 JQL | 1 `getStatuses` per 500 Tests | 1 per 100 Tests | 1 per call |

Some actions cost one request per Test:
- Adding Tests to a **Test Set** creates one Jira link per Test, because Jira has no bulk link-create endpoint. This is capped at 100 per click.
- Adding Tests to a Plan or Execution is a single batched insert.

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
- **Export:** see Data export below.
- **Personal data:** see Personal data reporting below.
- **Import from other tools:** see Data import below.

## Data import

Jira admins can import Test steps, Test Set and Test Plan membership, Test Executions and runs from another tool. The format is described in `docs/IMPORT_FORMAT.md`.

**Runbook**
1. Produce one or more `jawdatrace-import*.json` files, each at most 10 MB. Split large exports; files are imported in name order.
2. Attach them to any issue in the target project, for example a "Migration" task.
3. In **Jira settings → Apps → jawdatrace setup → Import data**, enter the project key and that issue's key, then click **Start import**.
4. Click **Refresh status** until the status is `done`. `waiting` means Jira rate-limited the import; it continues by itself after 2 minutes. `failed` shows the file and entry that was rejected; fix the file, re-attach it, and click **Start import** again.
5. Review the counters. `skipped` counts entries whose issues are missing, in another project, or of the wrong issue type.

Re-running is safe: Tests that already have steps keep them, existing links and memberships are not duplicated, and runs are keyed by their `id` in the file (`client_request_id = imp:<id>`), so the same run is never inserted twice. A run whose status changed in the source tool must get a new `id` to be imported again; the newest run then wins.

**Cost**
- One queue invocation per ~9 minutes of work. Each page of 100 entries costs one Jira bulk fetch plus one SQL statement (one per Execution for the executions section), one bulk property write for steps, and one Jira POST per new Test Set link.
- Rough guide: 10k Tests and 75k runs is about 1,000 pages, which takes tens of minutes and a handful of invocations.
- Progress lives in the `import_job` SQL table, one row per project.

## Data export

Jira admins can export a project's app data from **Jira settings → Apps → jawdatrace setup → Export data**. The export covers Test steps, Test Set and Test Plan membership, Test Executions (plan, environment, members) and all runs. It is attached to an issue the admin chooses, as `jawdatrace-export-<timestamp>-NNN.json` files of about 5 MB each, in the import format. Files from an export can be imported again; runs keep their ids, so importing an export into its own site adds nothing.

- **Not exported:** evidence references (the evidence files are Jira attachments on the Tests).
- **Account ids:** the files contain the account ids of the people who recorded runs, so attach them to an issue with suitable visibility, and delete the attachments when they're no longer needed.
- **Cost:** one queue invocation per export. It makes one JQL page per 100 Tests, Sets or Plans, one SQL statement per 100 Executions, Plans or Tests, and one attachment upload per file.
- **Limit:** the export runs in one invocation (15 minutes). A project too large for that fails with a code shown on the admin page.
- Progress is stored in the `export_job` SQL table, one row per project.

## Personal data reporting

The app stores Atlassian account ids only, never names or emails:
- `test_run.executed_by`
- `test_execution.created_by`
- the import job's `startedBy`

As Atlassian's user privacy guidelines require, a weekly scheduled trigger (`src/privacy/report.js`, scope `report:personal-data`) reports these ids, 90 per request. For every account Atlassian reports as closed, the id is replaced with `unknown` in all three places; the UI then shows "Former user". Runs themselves are kept as project history.

- **Cost:** one invocation a week, one SQL page per 900 accounts and one report call per 90 accounts.
- **Failures:** if a run fails (for example because of rate limiting), it logs one line and the next weekly run tries again.

## Licensing

The app is paid via Atlassian (`app.licensing.enabled`). When a site's license is inactive, every resolver call returns `LICENSE_INACTIVE` and every module shows a notice. Development and staging installs, and direct installs, have no license object and are not restricted. To test licensing, install with `forge install --license active|inactive` in a non-production environment.
