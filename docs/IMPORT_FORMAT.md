# Import file format (version 1)

The admin page's **Import data** reads JSON files named `jawdatrace-import*.json` that are attached to a Jira issue in the target project. Files are imported in name order. Each file is at most 10 MB and 100,000 entries; split larger exports. The runbook is in `docs/OPERATIONS.md` → Data import.

The issues themselves (Tests, Test Sets, Test Plans, Test Executions) must already exist in Jira, with jawdatrace's issue type names. The file only carries the data jawdatrace keeps outside Jira's own fields.

```json
{
  "format": "jawdatrace-import",
  "version": 1,
  "projectKey": "ABC",
  "tests": [
    { "test": "10001", "steps": [{ "action": "Open the app", "data": "", "expected": "Home screen shows" }] }
  ],
  "setMembers": [{ "set": "10050", "tests": ["10001", "10002"] }],
  "planTests": [{ "plan": "10060", "tests": ["10001"] }],
  "executions": [{ "execution": "10070", "plan": "10060", "environment": "iOS", "tests": ["10001"] }],
  "runs": [
    {
      "id": "run-123",
      "test": "10001",
      "execution": "10070",
      "status": "PASS",
      "executedBy": "5b10ac8d82e05b22cc7d4ef5",
      "executedAt": "2026-10-01T10:00:00Z",
      "comment": "Imported"
    }
  ]
}
```

## Fields

All issue references are **numeric Jira issue ids** (strings or numbers), not keys. Every section is optional.

| Section | Field | Rules |
|---|---|---|
| top level | `format`, `version`, `projectKey` | Must be `"jawdatrace-import"`, `1`, and the project being imported into. |
| `tests` | `test` | A Test. |
| | `steps` | Up to 100 steps of `action`, `data`, `expected` (each up to 5,000 characters) and an optional `id`. Empty steps are dropped. Written only if the Test has no jawdatrace steps yet. |
| `setMembers` | `set`, `tests` | A Test Set and the Tests it contains. Creates missing "Test Set" links. |
| `planTests` | `plan`, `tests` | A Test Plan and its Tests. |
| `executions` | `execution` | A Test Execution. Its plan and environment are set (or replaced). |
| | `plan` | Optional Test Plan. |
| | `environment` | Optional free text, up to 100 characters. |
| | `tests` | The Execution's Tests, in order. |
| `runs` | `id` | 1–48 letters, digits or `. _ : -`, unique per run **and state** in the source tool. Importing the same `id` again is a no-op. |
| | `test`, `execution` | The Test, and the optional Test Execution (none means an ad-hoc run). A run also makes the Test a member of its Execution. |
| | `status` | `PASS`, `FAIL`, `BLOCKED` or `EXECUTING`. Tests that were never run have no run; list them in the Execution's `tests` instead. |
| | `executedBy` | Optional Atlassian account id; defaults to the admin who started the import. |
| | `executedAt` | ISO 8601 date-time. |
| | `comment` | Optional, up to 5,000 characters. |

## What is checked

- A file that is not valid JSON, has the wrong `format`, `version` or `projectKey`, or has an invalid entry stops the import with a message such as `runs[12].status: unknown status`.
- Entries whose issues don't exist, belong to another project, or have the wrong issue type are **skipped and counted**, not imported. The import runs as the app, so this check is what keeps a file inside its project.
- Evidence files are not imported.
