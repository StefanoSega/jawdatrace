/**
 * Project page: basic Test coverage report.
 *
 * Tabs:
 *  - Stories:       requirement issues with their test count and overall status,
 *                   loaded 50 at a time (2 JQL requests + 1 resolver call per page).
 *  - Tests:         scans the project's Tests (up to 1,000, on demand) and lists
 *                   failing and never-executed Tests, with a status chart.
 *
 * Both tabs honour the scope picker (latest result, or one Test Plan).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ForgeReconciler, {
  Box,
  DynamicTable,
  EmptyState,
  Heading,
  Inline,
  Label,
  LoadingButton,
  PieChart,
  Stack,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Text,
  Toggle,
  useProductContext,
} from '@forge/react';
import { APP_ISSUE_TYPE_NAMES, ISSUE_TYPES, LINK_TYPES, SCOPE, TODO } from '../shared/constants';
import { countStatuses, overallStatus } from '../shared/status';
import { errorMessage } from './shared/api';
import { ErrorBanner, IssueLink, OverallLozenge, StatusLozenge, formatDate } from './shared/components';
import { getTestSetMembers, jqlString, linkedIssues, searchAll, searchPage, toRow } from './shared/jira';
import ScopePicker from './shared/ScopePicker';
import { fetchStatuses } from './shared/useStatuses';

const STORY_PAGE_SIZE = 50;
const TEST_SCAN_CAP = 1000;

// ---------------------------------------------------------------------------
// Stories tab
// ---------------------------------------------------------------------------

/**
 * Load one page of requirement issues and compute their coverage.
 * Linked Test Sets of the whole page are expanded in ONE JQL request.
 */
async function loadStoryPage(projectKey, scope, nextPageToken) {
  const excluded = APP_ISSUE_TYPE_NAMES.map(jqlString).join(', ');
  const jql =
    `project = ${jqlString(projectKey)} AND issuetype in standardIssueTypes() ` +
    `AND issuetype not in (${excluded}) ORDER BY created DESC`;
  const page = await searchPage(jql, ['summary', 'status', 'issuetype', 'issuelinks'], {
    maxResults: STORY_PAGE_SIZE,
    nextPageToken,
  });

  // Direct Tests and Test Sets per story.
  const perStory = page.issues.map((issue) => {
    const linked = linkedIssues(issue.fields?.issuelinks ?? [], LINK_TYPES.TEST.name, 'inward').map((entry) =>
      toRow(entry.issue)
    );
    return {
      story: toRow(issue),
      testIds: linked.filter((row) => row.issueType === ISSUE_TYPES.TEST).map((row) => row.id),
      setKeys: linked.filter((row) => row.issueType === ISSUE_TYPES.TEST_SET).map((row) => row.key),
    };
  });

  // Expand all sets on this page at once, then map members back to their sets.
  const allSetKeys = [...new Set(perStory.flatMap((entry) => entry.setKeys))];
  const { issues: members } = await getTestSetMembers(allSetKeys, 1000);
  const membersBySetKey = new Map(allSetKeys.map((key) => [key, []]));
  for (const member of members) {
    for (const entry of linkedIssues(member.fields?.issuelinks ?? [], LINK_TYPES.TEST_SET.name, 'inward')) {
      membersBySetKey.get(entry.issue.key)?.push(String(member.id));
    }
  }
  for (const entry of perStory) {
    entry.testIds = [...new Set([...entry.testIds, ...entry.setKeys.flatMap((key) => membersBySetKey.get(key) ?? [])])];
  }

  const allTestIds = [...new Set(perStory.flatMap((entry) => entry.testIds))];
  const statuses = await fetchStatuses(allTestIds, scope);
  const rows = perStory.map((entry) => {
    const counts = countStatuses(entry.testIds, statuses);
    return { ...entry.story, counts, overall: overallStatus(counts) };
  });
  return { rows, nextPageToken: page.nextPageToken };
}

function StoriesTab({ projectKey, scope }) {
  const [rows, setRows] = useState([]);
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [onlyUncovered, setOnlyUncovered] = useState(false);

  const load = useCallback(
    async (pageToken) => {
      setLoading(true);
      setError(null);
      try {
        const page = await loadStoryPage(projectKey, scope, pageToken);
        setRows((current) => (pageToken ? [...current, ...page.rows] : page.rows));
        setToken(page.nextPageToken);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setLoading(false);
      }
    },
    [projectKey, scope]
  );

  useEffect(() => {
    load(null);
  }, [load]);

  const shown = onlyUncovered ? rows.filter((row) => row.counts.total === 0) : rows;
  const covered = rows.filter((row) => row.counts.total > 0).length;

  return (
    <Stack space="space.200">
      <ErrorBanner error={error} />
      <Inline space="space.300" alignBlock="center" shouldWrap>
        <Text>
          {covered} of {rows.length} loaded issues have Tests.
        </Text>
        <Inline space="space.100" alignBlock="center">
          <Toggle id="uncovered" isChecked={onlyUncovered} onChange={() => setOnlyUncovered((v) => !v)} />
          <Label labelFor="uncovered">Only issues without Tests</Label>
        </Inline>
      </Inline>
      <DynamicTable
        caption="Requirement coverage"
        isLoading={loading && rows.length === 0}
        rowsPerPage={25}
        head={{
          cells: [
            { key: 'key', content: 'Key' },
            { key: 'type', content: 'Type' },
            { key: 'summary', content: 'Summary' },
            { key: 'status', content: 'Status' },
            { key: 'tests', content: 'Tests' },
            { key: 'result', content: 'Passed / Failed / Not run' },
            { key: 'overall', content: 'Coverage' },
          ],
        }}
        rows={shown.map((row) => ({
          key: row.id,
          cells: [
            { key: 'key', content: <IssueLink issueKey={row.key} /> },
            { key: 'type', content: row.issueType },
            { key: 'summary', content: row.summary },
            { key: 'status', content: row.jiraStatus },
            { key: 'tests', content: row.counts.total },
            {
              key: 'result',
              content: `${row.counts.PASS} / ${row.counts.FAIL} / ${row.counts.TODO + row.counts.EXECUTING}`,
            },
            { key: 'overall', content: <OverallLozenge overall={row.overall} /> },
          ],
        }))}
        emptyView={<Text>No issues found.</Text>}
      />
      {token && (
        <Box>
          <LoadingButton isLoading={loading} onClick={() => load(token)}>
            Load more
          </LoadingButton>
        </Box>
      )}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Tests tab (failing / not executed)
// ---------------------------------------------------------------------------

function TestsTab({ projectKey, scope }) {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Results depend on the scope; clear them when it changes.
  useEffect(() => setResult(null), [scope]);

  const scan = async () => {
    setLoading(true);
    setError(null);
    try {
      const jql = `project = ${jqlString(projectKey)} AND issuetype = ${jqlString(ISSUE_TYPES.TEST)} ORDER BY key`;
      const { issues, truncated } = await searchAll(jql, ['summary', 'status', 'priority', 'issuetype'], TEST_SCAN_CAP);
      const tests = issues.map(toRow);
      const statuses = await fetchStatuses(
        tests.map((test) => test.id),
        scope
      );
      setResult({ tests, statuses, truncated, counts: countStatuses(tests.map((t) => t.id), statuses) });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const failing = useMemo(
    () => (result ? result.tests.filter((test) => result.statuses[test.id]?.status === 'FAIL') : []),
    [result]
  );
  const notExecuted = useMemo(
    () => (result ? result.tests.filter((test) => !result.statuses[test.id]) : []),
    [result]
  );

  const table = (caption, tests, emptyText) => (
    <DynamicTable
      caption={caption}
      rowsPerPage={20}
      head={{
        cells: [
          { key: 'key', content: 'Key' },
          { key: 'summary', content: 'Summary' },
          { key: 'priority', content: 'Priority' },
          { key: 'status', content: 'Test status' },
          { key: 'when', content: 'Last run' },
        ],
      }}
      rows={tests.map((test) => ({
        key: test.id,
        cells: [
          { key: 'key', content: <IssueLink issueKey={test.key} /> },
          { key: 'summary', content: test.summary },
          { key: 'priority', content: test.priority },
          { key: 'status', content: <StatusLozenge status={result.statuses[test.id]?.status ?? TODO} /> },
          { key: 'when', content: formatDate(result.statuses[test.id]?.executedAt) },
        ],
      }))}
      emptyView={<Text>{emptyText}</Text>}
    />
  );

  return (
    <Stack space="space.200">
      <ErrorBanner error={error} />
      <Box>
        <LoadingButton appearance="primary" isLoading={loading} onClick={scan}>
          {result ? 'Refresh' : 'Analyse Tests'}
        </LoadingButton>
      </Box>
      {!result && !loading && (
        <Text>Scans up to {TEST_SCAN_CAP} Tests in this project and lists failing and never-executed Tests.</Text>
      )}
      {result && (
        <>
          {result.truncated && <Text>Only the first {TEST_SCAN_CAP} Tests were analysed.</Text>}
          <Inline space="space.400" shouldWrap>
            <Stack>
              <Heading size="large">{result.counts.total}</Heading>
              <Text>Tests</Text>
            </Stack>
            <Stack>
              <Heading size="large">{failing.length}</Heading>
              <Text>Failing</Text>
            </Stack>
            <Stack>
              <Heading size="large">{notExecuted.length}</Heading>
              <Text>Never executed</Text>
            </Stack>
          </Inline>
          {result.counts.total > 0 && (
            <PieChart
              title="Latest test status"
              data={[
                { label: 'Passed', value: result.counts.PASS },
                { label: 'Failed', value: result.counts.FAIL },
                { label: 'Blocked', value: result.counts.BLOCKED },
                { label: 'Executing', value: result.counts.EXECUTING },
                { label: 'To do', value: result.counts.TODO },
              ].filter((slice) => slice.value > 0)}
              colorAccessor="label"
              labelAccessor="label"
              valueAccessor="value"
            />
          )}
          {table('Failing Tests', failing, 'No failing Tests.')}
          {table('Tests never executed', notExecuted, 'Every Test has been executed at least once.')}
        </>
      )}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function App() {
  const context = useProductContext();
  const projectKey = context?.extension?.project?.key;
  const [tab, setTab] = useState(0);
  const [scope, setScope] = useState({ kind: SCOPE.LATEST });

  if (!context) return <Text>Loading…</Text>;
  if (!projectKey) return <EmptyState header="Open this page from a project." />;

  return (
    <Stack space="space.200">
      <ScopePicker projectKey={projectKey} onChange={setScope} />
      <Tabs id="report-tabs" selected={tab} onChange={setTab}>
        <TabList>
          <Tab>Stories</Tab>
          <Tab>Tests</Tab>
        </TabList>
        <TabPanel>{tab === 0 ? <StoriesTab projectKey={projectKey} scope={scope} /> : null}</TabPanel>
        <TabPanel>{tab === 1 ? <TestsTab projectKey={projectKey} scope={scope} /> : null}</TabPanel>
      </Tabs>
    </Stack>
  );
}

// No React.StrictMode: it runs effects twice in development, doubling Jira requests.
ForgeReconciler.render(<App />);
