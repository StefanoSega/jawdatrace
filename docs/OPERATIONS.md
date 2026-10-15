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

## Baseline (to record after the first install)

On the dev site, run the end-to-end scenario from the plan:
- 4 Tests
- 1 Test Set
- 1 Story
- 1 Plan with 2 Executions
- about 10 runs

Then copy these numbers from the developer console:

| Metric | Value | Date |
|---|---|---|
| Function invocations | | |
| Total duration (GB-s) | | |
| Forge SQL requests | | |
| Jira API requests (approx., from the table above) | | |

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
- **Import from other tools:** out of scope.
