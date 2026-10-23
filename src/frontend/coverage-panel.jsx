/**
 * "Test Coverage" issue panel for Stories (and other requirement issues).
 *
 * Shows the Tests linked to this issue ("Test tests Story"), expanding any
 * linked Test Sets into their Tests, with an overall OK/NOK status.
 *
 * Load cost: 1 Jira request (this issue's links) + 1 JQL request (members of
 * all linked Test Sets at once) + 1 resolver call (statuses).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  DynamicTable,
  EmptyState,
  Inline,
  Label,
  LoadingButton,
  Select,
  Stack,
  Text,
  useProductContext,
  xcss,
} from '@forge/react';
import { ISSUE_TYPES, LINK_TYPES, SCOPE } from '../shared/constants';
import { countStatuses, overallStatus } from '../shared/status';
import { errorMessage } from './shared/api';
import { ErrorBanner, IssueLink, Loading, StatusLozenge, StatusSummary, formatDate } from './shared/components';
import { createLink, deleteLink, getIssueLinks, getTestSetMembers, linkedIssues, searchIssuesOfType, toRow } from './shared/jira';
import ScopePicker from './shared/ScopePicker';
import { useStatuses } from './shared/useStatuses';

const growStyle = xcss({ flexGrow: 1 });

/**
 * Load direct links + Test Set members and merge them into one list of Tests,
 * each annotated with where it came from. Exported shape:
 *  { tests: [{ ...row, sources: ['Direct' | SET-KEY] }], directLinks: [{ linkId, ...row }], truncated }
 */
async function loadCoverage(issueId) {
  const links = await getIssueLinks(issueId);
  // On the Story, "X tests Story" links have X as the inward issue.
  const direct = linkedIssues(links, LINK_TYPES.TEST.name, 'inward').map((entry) => ({
    linkId: entry.linkId,
    ...toRow(entry.issue),
  }));
  const directTests = direct.filter((row) => row.issueType === ISSUE_TYPES.TEST);
  const linkedSets = direct.filter((row) => row.issueType === ISSUE_TYPES.TEST_SET);

  const byId = new Map(directTests.map((row) => [row.id, { ...row, sources: ['Direct'] }]));
  const setKeyById = new Map(linkedSets.map((set) => [set.id, set.key]));
  const { issues, truncated } = await getTestSetMembers(linkedSets.map((set) => set.key));
  for (const issue of issues) {
    // Which of the linked sets contain this Test? ("Set contains Test" => Set is inward on the Test)
    const fromSets = linkedIssues(issue.fields?.issuelinks ?? [], LINK_TYPES.TEST_SET.name, 'inward')
      .map((entry) => setKeyById.get(String(entry.issue.id)))
      .filter(Boolean);
    const existing = byId.get(String(issue.id));
    if (existing) existing.sources.push(...fromSets);
    else byId.set(String(issue.id), { ...toRow(issue), sources: fromSets });
  }
  return { tests: [...byId.values()], directLinks: direct, truncated };
}

/** Typeahead + button to link a Test or Test Set to this issue. */
function LinkPicker({ issueId, projectKey, onLinked }) {
  const [input, setInput] = useState('');
  const [options, setOptions] = useState([]);
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      const [tests, sets] = await Promise.all([
        searchIssuesOfType(ISSUE_TYPES.TEST, input, projectKey),
        searchIssuesOfType(ISSUE_TYPES.TEST_SET, input, projectKey),
      ]);
      if (!cancelled) {
        setOptions([
          { label: 'Test Sets', options: sets },
          { label: 'Tests', options: tests },
        ]);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [input, projectKey]);

  const link = async () => {
    setBusy(true);
    setError(null);
    try {
      // "Test (or Set) tests Story"
      await createLink(LINK_TYPES.TEST, selected.value, issueId);
      setSelected(null);
      onLinked();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack space="space.100">
      <ErrorBanner error={error} />
      <Inline space="space.100" alignBlock="end">
        <Box xcss={growStyle}>
          <Label labelFor="link-search">Link a Test or Test Set</Label>
          <Select
            inputId="link-search"
            isClearable
            options={options}
            value={selected}
            placeholder="Search by key or summary"
            onInputChange={(value) => setInput(value)}
            onChange={(value) => setSelected(value)}
          />
        </Box>
        <LoadingButton isLoading={busy} isDisabled={!selected} onClick={link}>
          Link
        </LoadingButton>
      </Inline>
    </Stack>
  );
}

function App() {
  const context = useProductContext();
  const issueId = context?.extension?.issue?.id ? String(context.extension.issue.id) : null;
  const projectKey = context?.extension?.project?.key;
  const projectId = context?.extension?.project?.id ? String(context.extension.project.id) : undefined;

  const [coverage, setCoverage] = useState(null);
  const [error, setError] = useState(null);
  const [scope, setScope] = useState({ kind: SCOPE.LATEST });

  const load = useCallback(async () => {
    if (!issueId) return;
    setError(null);
    try {
      setCoverage(await loadCoverage(issueId));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [issueId]);

  useEffect(() => {
    load();
  }, [load]);

  const testIds = useMemo(() => (coverage ? coverage.tests.map((test) => test.id) : null), [coverage]);
  const { statuses, loading, error: statusError } = useStatuses(testIds, scope);
  const counts = useMemo(() => countStatuses(testIds ?? [], statuses), [testIds, statuses]);

  const unlink = async (linkId) => {
    try {
      await deleteLink(linkId);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  if (!context) return <Loading />;
  if (!issueId) return <EmptyState header="This panel only works on a Jira issue." />;
  if (!coverage && !error) return <Loading />;

  return (
    <Stack space="space.200">
      <ErrorBanner error={error || statusError} />
      <ScopePicker projectKey={projectKey} projectId={projectId} onChange={setScope} />
      <StatusSummary counts={counts} overall={overallStatus(counts)} />
      {coverage?.truncated && <Text>Only the first 500 Tests from linked Test Sets are shown.</Text>}
      <DynamicTable
        caption="Covering Tests"
        isLoading={loading}
        rowsPerPage={20}
        head={{
          cells: [
            { key: 'key', content: 'Key' },
            { key: 'summary', content: 'Summary' },
            { key: 'jira', content: 'Status' },
            { key: 'test', content: 'Test status' },
            { key: 'when', content: 'Last run' },
            { key: 'source', content: 'Linked via' },
          ],
        }}
        rows={(coverage?.tests ?? []).map((test) => ({
          key: test.id,
          cells: [
            { key: 'key', content: <IssueLink issueKey={test.key} /> },
            { key: 'summary', content: test.summary },
            { key: 'jira', content: test.jiraStatus },
            { key: 'test', content: <StatusLozenge status={statuses[test.id]?.status} /> },
            { key: 'when', content: formatDate(statuses[test.id]?.executedAt) },
            { key: 'source', content: test.sources.join(', ') },
          ],
        }))}
        emptyView={<Text>No Tests cover this issue yet. Link a Test or a Test Set below.</Text>}
      />
      {coverage?.directLinks.length > 0 && (
        <DynamicTable
          caption="Direct links"
          head={{
            cells: [
              { key: 'key', content: 'Key' },
              { key: 'type', content: 'Type' },
              { key: 'summary', content: 'Summary' },
              { key: 'actions', content: '' },
            ],
          }}
          rows={coverage.directLinks.map((row) => ({
            key: row.linkId,
            cells: [
              { key: 'key', content: <IssueLink issueKey={row.key} /> },
              { key: 'type', content: row.issueType },
              { key: 'summary', content: row.summary },
              {
                key: 'actions',
                content: (
                  <Button appearance="subtle" onClick={() => unlink(row.linkId)}>
                    Unlink
                  </Button>
                ),
              },
            ],
          }))}
        />
      )}
      <LinkPicker issueId={issueId} projectKey={projectKey} onLinked={load} />
    </Stack>
  );
}

// No React.StrictMode: it runs effects twice in development, doubling Jira requests.
ForgeReconciler.render(<App />);
