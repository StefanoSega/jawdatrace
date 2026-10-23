# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

`jawdatrace` is an Atlassian Forge app (UI Kit, Node.js 24 runtime) that adds lightweight test management to Jira. It covers Tests with manual steps, Test Sets, Test Plans, Test Executions, Story→Test traceability, manual runs with evidence, and coverage reporting.

- **Read first:** `docs/ENGINEERING_PRINCIPLES.md`. It covers cost efficiency, MVP scope and security. Before building a significant feature, propose the design together with its Forge invocations, storage operations and Jira API calls.
- **Forge rules:** `AGENTS.md` has the full set. The key ones are summarised below.
- **Operations:** `docs/OPERATIONS.md` covers usage and billing, logs, the cost baseline, and the data retention rules.

## Commands

All `forge` commands (except `create`, `version` and `login`) must run from the repo root, where `manifest.yml` lives.

```bash
forge lint                         # validate manifest.yml and the app; run after every manifest change
forge deploy --non-interactive -e development
forge install --non-interactive --site <site-url> --product jira --environment development
forge install --non-interactive --upgrade --site <site-url> --product jira --environment development   # after scope changes
forge tunnel                       # hot-reloads code against an installed dev app
forge logs -e development -n 100 --since 15m
```

- **Dev site:** `techstarter-test.atlassian.net`, where the app is installed in `development`. The sandbox project is **JDT** ("JDT Sandbox", company-managed) and contains test data: Tests JDT-1–4, Test Set JDT-5, Story JDT-6, Test Plan JDT-7, and Test Executions JDT-8 (iOS) and JDT-9 (Android). Use it for end-to-end checks rather than creating new projects.
- Use the `development` environment unless told otherwise.
- Never pass `--no-verify` unless asked.
- Use `--non-interactive` only with `deploy`, `environments` and `install`.
- Manifest changes need a redeploy. New scopes also need `install --upgrade`. While tunnelling, restart the tunnel after manifest changes, but don't redeploy for code-only changes.

## Architecture

### Modules and wiring

Every UI module in `manifest.yml` shares one resolver function (`index.handler` → `src/resolvers/index.js`). The UI calls it with `invoke('<name>', payload)` through `callResolver()` in `src/frontend/shared/api.js`.

Issue panels use `displayConditions.jiraExpression` on the issue type name, so a hidden panel costs nothing. Resources live in `src/frontend/`, one per module in `manifest.yml`.

A `trigger` on `avi:forge:installed:app` / `avi:forge:upgraded:app` runs the SQL migrations (`index.onLifecycle`). Resolvers also run them lazily through `runMigrations()` in `src/db/migrations.js`. Migrations are append-only: never edit one that has shipped.

### Where data lives

Jira is the source of truth. Only app-specific data goes into Forge storage.

| Data | Where it lives |
|---|---|
| Steps | Issue property `jawdatrace.steps` on the Test: `{ v, revision, steps[] }`. Read and written directly from the UI as the user. Saves check `revision` first, but this is best effort, not atomic. |
| Test Set membership | Jira link type **"Test Set"** (`contains` / `is contained in`) |
| Story→Test/Set traceability | Jira link type **"Test"** (`tests` / `is tested by`) |
| Test runs and plan/execution data | Forge SQL tables `test_run` (insert-only), `test_execution`, `execution_test`, `plan_test`; import/export progress in `import_job` / `export_job` |

Link direction is easy to get backwards. When you create a link, the `inwardIssue` is the one described by the outward text, so `createLink(LINK_TYPES.TEST, testId, storyId)` means "Test tests Story". When you read links, use `linkedIssues(links, name, 'outward' | 'inward')` in `src/frontend/shared/jira.js`.

Status logic (`src/shared/status.js`, shared by the UI and resolvers):
- Statuses are `EXECUTING` (not final), `PASS`, `FAIL` and `BLOCKED`. A Test with no run is `TODO`.
- A Test's status in a scope is worked out per **environment** first: the latest final run, or `EXECUTING` if there is no final run yet (`resolveDisplayStatus`). The environments are then combined with the worst result winning: FAIL > BLOCKED > EXECUTING > PASS (`combineEnvironmentStatuses`). A later Android pass must never hide an iOS failure. Ad-hoc runs count as their own environment.
- A final result has precedence over a newer `EXECUTING` re-run by default. This is `finalPrecedence` in the scope, and the scope picker has a checkbox for it. With it off, or in the Execution panel (which turns it off), a newer `EXECUTING` re-run wins.
- Scopes can filter by environment. Ad-hoc runs then drop out.
- The overall status is NOK if anything failed, otherwise INCOMPLETE, otherwise OK.
- SQL computes the latest runs for many Tests in one statement (`selectLatestRuns`, using `ROW_NUMBER()`).

Evidence (`src/shared/evidence.js`) is a versioned list of typed references: Jira attachment IDs on the Test, and URLs. Binary files are never copied. Attachment metadata is filled in from Jira on the server, not taken from the client.

### Authorization model (important)

Forge SQL doesn't know about Jira permissions, so **every resolver checks access as the user before touching SQL**. The helpers are in `src/resolvers/permissions.js`:
- `getVisibleIssue`: one `GET issue` as the user. A 403 or 404 becomes `ForbiddenError`, and it also checks the issue type.
- `getEditableIssue`: additionally checks the `EDIT_ISSUES` permission. Required for writes to the Execution, the Plan, or the Test (for ad-hoc runs).
- `filterVisibleIssueIds` / `fetchVisibleTests`: use bulk fetch (`/rest/api/3/issue/bulkfetch`, 100 IDs per request) to drop Tests the user can't see. Don't use JQL `id in (…)` for this, because it fails outright when any ID is missing.
- Admin resolvers call `assertJiraAdmin()`. Only `purgeOrphans` uses `asApp()`, after that check.
- All IDs are validated as numeric strings (`assertIssueId`) before they reach a path or JQL.

Resolvers return `{ ok, data }` or `{ ok: false, error: { code, message } }` via `wrap()`. Only `ValidationError` and `ForbiddenError` messages reach users. Logs are one short line, with no payloads.

### Cost conventions

- Jira reads that don't involve app data happen in the UI through `requestJira`, not through resolvers.
- Batch: one bulk fetch per 100 issues and one SQL statement per view. Never one request per Test.
- Paginate run history with an opaque keyset cursor.
- No polling, scheduled jobs or webhooks. The approved exceptions are the admin-started data import and export queues (`src/importer/worker.js`, `src/exporter/worker.js`) and the weekly personal data report (`src/privacy/report.js`); see `docs/OPERATIONS.md`.
- Don't wrap panels in `React.StrictMode`, because it doubles effect requests in dev.

### Testing

Unit tests in `test/` run under vitest. `vitest.config.mjs` aliases `@forge/api`, `@forge/sql` and `@forge/events` to the in-memory mocks in `test/mocks/`. Use `setJiraHandler` / `setSqlHandler` / `setPrivacyHandler` to script responses, and assert on `jiraCalls` / `sqlCalls` / `pushedEvents` / `privacyCalls`. When a bug is found on the dev site, add a regression test that reproduces the real data (see the "regression: dev-site Plan JDT-7" test in `test/status-resolver.test.js`).

There are no UI component tests, and the mocks can't catch Forge SQL or Jira expression quirks. After deploying, check UI and SQL changes on the dev site using the `verify-on-dev-site` skill.

## Forge constraints (from AGENTS.md)

- **UI Kit only:** use components from `@forge/react`. No HTML elements, no `@forge/ui`, no third-party React components. Use `DynamicTable` (there is no `Table`). Use `<Text weight="bold">` instead of the deprecated `Strong`. Use `xcss()` for `Box` styles. Hooks come from `react`.
- **Text inputs must be uncontrolled.** Give `Textfield` and `TextArea` a `defaultValue` plus an `onChange`, never a `value`. A controlled `value` drops keystrokes, so only the last character survives fast typing, because each keystroke round-trips through the UI Kit bridge. To clear or prefill an input from code, change its `key` to remount it. `Select`, `Checkbox` and `RadioGroup` are fine controlled.
- Prefer `.asUser()`. If you use `.asApp()` on a user's behalf, check permissions explicitly. Keep scopes minimal: currently `read:jira-work`, `write:jira-work`, `manage:jira-configuration` (setup only) and `report:personal-data` (weekly privacy report). No external network access.
- **Licensing:** `app.licensing.enabled`. `wrap()` in `src/resolvers/index.js` refuses every resolver call while `context.license.active === false`, and `LicenseGate` wraps every UI module (`src/shared/license.js`). No license object (development, staging, direct installs) means allowed.
- **Personal data:** store account ids only, never names or emails. Closed accounts become `UNKNOWN_ACCOUNT` ("unknown"); render authors with `RunAuthor`. A new table or field holding account ids must be added to `src/privacy/report.js`.
- Custom UI is not allowed.
- Code style: vanilla JavaScript with thorough comments aimed at intermediate JS developers who are new to Forge.

## Platform gotchas (found on the dev site)

- **Forge SQL:** a bound `LIMIT ?` parameter makes the query fail. Inline the limit through `toLimit()` in `src/db/queries.js` instead.
- **Jira expressions:** `IssueType` has no `subtask` property, and using it makes the display condition fail silently, so the panel never appears. Use `issue.issueType.hierarchyLevel >= 0` to exclude sub-tasks, which have level -1.
- **Panels:** issue panels don't appear on an issue automatically. Each user adds a panel once per issue type from the Apps button under the issue title, and Jira then remembers it.
- **Charts:** a chart's `colorPalette` takes **hex** values, as `[{ key: <label>, value: '#RRGGBB' }]`. Design tokens such as `color.chart.success.bold` render every slice black.
- **Wide tables:** `DynamicTable` overflows narrow issue panels. Set `isFixedSize` and give each head cell a percentage `width` that adds up to 100. Combine related columns into one cell (see `LastRun`), and use `RowActions` with `spacing="compact"` buttons.
