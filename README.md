# jawdatrace

Lightweight test management for Jira Cloud, built on Atlassian Forge (UI Kit).

jawdatrace adds what a team needs for manual testing inside Jira, without leaving the issue view:

- **Tests** with manual steps (action, data, expected result).
- **Test Sets** to group reusable Tests.
- **Test Plans** for a release or build, run through one or more **Test Executions** (for example one per platform: iOS, Android, Web).
- **Runs** with Passed, Failed, Blocked or Executing status, a comment, and evidence (Jira attachments or links). Run history is never overwritten.
- **Traceability**: link Tests or Test Sets to Stories and see their coverage on the Story.
- **Coverage report** per project, filtered by Test Plan and environment.
- **Import and export** of steps, memberships, executions and runs as JSON files (`docs/IMPORT_FORMAT.md`).

It runs entirely on Atlassian's infrastructure ("Runs on Atlassian"): no external servers and no outbound network access.

## How it works

| Data | Where it is stored |
|---|---|
| Tests, Sets, Plans, Executions | Ordinary Jira issues, using four issue types the setup page creates |
| Steps | An issue property on each Test (`jawdatrace.steps`) |
| Set membership, Story ↔ Test traceability | Jira issue links ("Test Set", "Test") |
| Runs, Plan and Execution membership | The app's Forge SQL database |

The app reads and writes Jira as the current user, so Jira permissions always apply. Every server call checks that the user can see the issue, and that they can edit it before writing.

## Setup (Jira administrator)

1. Install the app, then open **Jira settings → Apps → jawdatrace setup** and click **Run setup**. This creates the issue types (Test, Test Set, Test Plan, Test Execution) and the link types ("Test", "Test Set"). Types that already exist with those names are reused.
2. **Company-managed projects:** add the four issue types to the project's issue type scheme.
3. **Team-managed projects:** in **Project settings → Issue types**, create issue types with exactly the same names. Team-managed projects can't use global issue types, and Jira doesn't let apps create project-scoped types.
4. Each user adds the jawdatrace panel to an issue once, from the **Apps** button under the issue title. Jira remembers this for that issue type.

### Compatibility

- The panels appear on issue types by **name**: "Test", "Test Set", "Test Plan" and "Test Execution". If another app on your site already uses these names, jawdatrace reuses those issue types and its panel appears next to the other app's. Data isn't shared between the apps.
- Sub-tasks are not supported as Tests, Sets, Plans or Executions.

## Data, privacy and licensing

- **Personal data:** the app stores only Atlassian account ids: who recorded a run, who set up an Execution, and who started an import. It reports them to Atlassian weekly, as Atlassian requires. If an account is closed, its id is replaced with "unknown" and the run shows "Former user".
- **Retention and deletion:** data is kept until the issues are deleted (an admin purge removes app data for deleted issues) or the app is uninstalled (Forge deletes the app's storage). Steps and links are Jira data and stay with the issues. See `docs/OPERATIONS.md`.
- **Export:** an admin can export a project's app data as JSON attachments from the setup page.
- **Licensing:** a paid app. While a site's license is inactive, the panels show a notice and the app's server calls are refused. Jira data such as steps, links and issues is not changed.

## Development

See `CLAUDE.md` for architecture and conventions, `docs/ENGINEERING_PRINCIPLES.md` for scope and cost rules, and `docs/OPERATIONS.md` for operations.

```bash
npm install
npm test            # unit tests (vitest)
npm run lint
forge lint          # manifest
forge deploy --non-interactive -e development
```
