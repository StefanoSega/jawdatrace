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
- **Export:** not implemented in the MVP. Deferred by design.
- **Import from Xray:** out of scope.
