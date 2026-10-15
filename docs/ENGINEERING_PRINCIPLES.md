# Jawdatrace — Engineering Principles

## Product objective

Build a lightweight, cost-efficient Jira Cloud test-management app using Atlassian Forge.

The goal is to provide the essential features of a basic test management tool: reusable Tests, Test Sets, Story traceability, manual Test Runs, execution history, evidence, and basic reporting.

Prioritize simplicity, reliability, low operating costs, and maintainability. Do not introduce enterprise-level complexity without a demonstrated product requirement.

## 1. Forge cost efficiency

- Minimize Forge function invocations, execution duration, and storage operations.
- Avoid calling backend resolvers for computations that can safely run in the frontend.
- Batch related operations where supported instead of making one request per item.
- Avoid N+1 queries when loading Tests, Test Sets, Stories, and run history.
- Fetch only the data needed by the current view.
- Paginate large collections and execution histories.
- Avoid repeatedly fetching the same data within a single user interaction.
- Cache read-heavy, non-sensitive data only where invalidation and consistency can be handled safely.
- Avoid unnecessary background jobs, scheduled tasks, polling, and webhooks.
- Keep production logging concise and never log sensitive information or full payloads unnecessarily.
- Use the simplest Forge storage option that supports the required query patterns, access controls, and expected data volume.
- Avoid introducing external infrastructure solely to reduce Forge costs without a documented cost-benefit analysis.

## 2. Data modelling

- Jira is the source of truth for Jira issues, projects, issue relationships, and attachments.
- Do not duplicate Jira issue fields unless there is a concrete requirement.
- Store only app-specific data in Forge storage.
- Keep Test definitions separate from Test Runs.
- Treat each Test Run as a distinct historical record; never overwrite previous execution results.
- Support optional Execution Sessions to group runs into regression cycles, releases, or builds. *(Implemented as Test Execution issues grouped under Test Plans.)*
- Store references to Jira attachments instead of copying their binary content.
- Do not store redundant copies of Test definitions or entire Jira issue objects in every run.
- Use stable identifiers and explicit schema versions.
- Define retention, deletion, and data-export behaviour deliberately.

## 3. Jira API efficiency

- Use the appropriate Jira REST APIs and Forge-supported access mechanisms.
- Request only required fields and use pagination.
- Prefer bulk endpoints when supported and appropriate.
- Avoid repeated issue lookups when existing context already contains the required information.
- Handle rate limits, retries, transient failures, and partial failures.
- Never assume a multi-step operation is atomic.
- Do not issue one API request per Test when a supported batch operation can achieve the same result.
- Respect Jira permissions and verify authorization for sensitive operations.

## 4. Frontend efficiency

- Use Forge UI Kit (`@forge/react`) with plain JavaScript, per `AGENTS.md`. *(User decision: this replaces the original "React and TypeScript with Custom UI" line.)*
- Avoid unnecessary re-renders, duplicate data fetching, and excessive state duplication.
- Use client-side sorting, filtering, and pagination when the complete relevant dataset is already loaded and small enough.
- Use server-side filtering and pagination for large datasets.
- Avoid loading all Test Runs merely to display a Test's latest status.
- Keep UI components simple, reusable, and accessible.
- Display loading, empty, error, and partial-result states properly.

## 5. MVP scope discipline

Implement only the agreed MVP:

- Test definitions and structured manual steps.
- Test Sets and membership management.
- Story-to-Test traceability.
- Manual execution with Pass, Fail, and Blocked results.
- Immutable run history, comments, and evidence references.
- Basic Test Set execution summaries and coverage reporting.
- Test Plans and Test Executions (added to the MVP by the user).

Defer automated test imports, CI/CD integrations, BDD, advanced Test Plans, complex workflows, AI features, and external infrastructure unless explicitly approved.

Before adding a feature, explain its implementation cost, recurring Forge consumption, and maintenance implications.

## 6. Security and multi-tenancy

- Follow Forge's supported tenant-isolation and authorization mechanisms.
- Never assume a project, issue, attachment, or stored record is accessible just because its identifier is known.
- Validate user input and enforce authorization on the backend.
- Use least-privilege scopes and permissions.
- Never hardcode site IDs, project IDs, issue IDs, or custom field IDs.
- Avoid exposing secrets, internal storage identifiers, or unauthorized data to the frontend.

## 7. Quality and observability

- Add automated tests for core business logic, permissions, data integrity, and failure cases.
- Test pagination, concurrent updates, duplicate requests, and partial failures.
- Use representative datasets to test performance and storage query patterns.
- Document how to inspect Forge usage and billing.
- Record a baseline for function invocations, duration, storage operations, and Jira API requests.
- Before adding expensive features, estimate their incremental consumption.
- Prefer straightforward, readable code over abstractions that do not solve a real problem.

## Implementation rule

Before implementing a significant feature:

1. Propose the simplest viable design.
2. Identify the relevant Forge invocations, storage operations, and Jira API calls.
3. Identify security, consistency, and scaling risks.
4. Implement the design in small, testable steps.
5. Run the relevant tests and build checks.
6. Report significant trade-offs and any remaining cost risks.

Do not introduce dependencies, infrastructure, abstractions, or features without a clear justification.
