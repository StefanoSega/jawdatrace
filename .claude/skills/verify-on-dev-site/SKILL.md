---
name: verify-on-dev-site
description: Check jawdatrace UI, SQL or display-condition changes end-to-end on the dev Jira site (techstarter-test, project JDT) after deploying. Use whenever a change needs verifying in the real Jira rather than only in unit tests.
---

# Verify a change on the dev site

The unit-test mocks can't catch Forge SQL or Jira expression quirks, so check UI and SQL changes on `techstarter-test.atlassian.net` after `forge deploy --non-interactive -e development`. The sandbox data is described in `CLAUDE.md`.

- Open issues through `https://techstarter-test.atlassian.net/jira/software/c/projects/JDT/issues/JDT-<n>`, then use the expand button for the full view. Plain `/browse/JDT-<n>` links currently redirect to a Jira onboarding screen.
- The coverage report is under **More → Test coverage** in the JDT project's tabs.
- To set up data quickly, or to inspect what Jira stored (links, issue properties, attachments), call the REST API with `fetch` from a signed-in Jira tab. Writes need the header `X-Atlassian-Token: no-check`.
- To test a display condition before deploying, POST it to `/rest/api/3/expression/evaluate` with `{ expression, context: { issue: { key } } }`. The older `/expression/eval` endpoint has been removed.
- `forge logs` has returned nothing for this app so far. Don't rely on it, and use the UI error plus code inspection instead.
- When you find a bug on the site, add a regression test that reproduces the real data (see the "regression: dev-site Plan JDT-7" test in `test/status-resolver.test.js`).
