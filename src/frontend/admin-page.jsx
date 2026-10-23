/**
 * Jira admin page: one-time setup and maintenance.
 *
 *  - Creates the app's issue types (Test, Test Set, Test Plan, Test Execution)
 *    and link types ("Test", "Test Set"). Safe to run again.
 *  - Purges app data for Jira issues that were deleted (manual, batched).
 *  - Imports data from `jawdatrace-import*.json` files attached to an issue
 *    (docs/IMPORT_FORMAT.md). The work runs in a queue consumer; this page
 *    only starts it and shows progress when the admin presses "Refresh"
 *    (no polling).
 */
import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Button,
  ButtonGroup,
  DynamicTable,
  Heading,
  Inline,
  Label,
  List,
  ListItem,
  LoadingButton,
  Lozenge,
  SectionMessage,
  Stack,
  Text,
  Textfield,
} from '@forge/react';
import { callResolver, errorMessage } from './shared/api';
import { ErrorBanner, Loading, formatDate } from './shared/components';

function ExistsLozenge({ exists }) {
  return <Lozenge appearance={exists ? 'success' : 'removed'}>{exists ? 'Exists' : 'Missing'}</Lozenge>;
}

function SetupSection() {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    callResolver('getSetupState')
      .then(setState)
      .catch((err) => setError(errorMessage(err)));
  }, []);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const response = await callResolver('runSetup');
      setResult(response);
      setState(response.state);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRunning(false);
    }
  };

  if (error && !state) return <ErrorBanner error={error} />;
  if (!state) return <Loading />;

  const missing = [...state.issueTypes, ...state.linkTypes].filter((item) => !item.exists).length;

  return (
    <Stack space="space.200">
      <Heading size="medium">Setup</Heading>
      <ErrorBanner error={error} />
      <DynamicTable
        caption="Required configuration"
        head={{
          cells: [
            { key: 'kind', content: 'Kind' },
            { key: 'name', content: 'Name' },
            { key: 'state', content: 'State' },
          ],
        }}
        rows={[
          ...state.issueTypes.map((type) => ({
            key: `it-${type.name}`,
            cells: [
              { key: 'kind', content: 'Issue type' },
              { key: 'name', content: type.name },
              { key: 'state', content: <ExistsLozenge exists={type.exists} /> },
            ],
          })),
          ...state.linkTypes.map((type) => ({
            key: `lt-${type.name}`,
            cells: [
              { key: 'kind', content: 'Link type' },
              { key: 'name', content: `${type.name} (${type.outward} / ${type.inward})` },
              { key: 'state', content: <ExistsLozenge exists={type.exists} /> },
            ],
          })),
        ]}
      />
      <LoadingButton appearance="primary" isLoading={running} isDisabled={missing === 0} onClick={run}>
        {missing === 0 ? 'Everything is set up' : `Create ${missing} missing item${missing === 1 ? '' : 's'}`}
      </LoadingButton>
      {result && (
        <SectionMessage appearance={result.failed.length ? 'warning' : 'success'}>
          <Text>
            Created: {result.created.length ? result.created.join(', ') : 'nothing'}.
            {result.failed.length ? ` Failed: ${result.failed.join(', ')}.` : ''}
          </Text>
        </SectionMessage>
      )}
      <SectionMessage appearance="information" title="Next step (manual)">
        <List type="ordered">
          <ListItem>
            <Text>
              Company-managed projects: add the four issue types to the project's issue type scheme (Project settings →
              Issue types).
            </Text>
          </ListItem>
          <ListItem>
            <Text>
              Team-managed projects: create issue types with the same names in Project settings → Issue types.
            </Text>
          </ListItem>
          <ListItem>
            <Text>
              Open the project's "Test coverage" page from the project sidebar to see the coverage report.
            </Text>
          </ListItem>
        </List>
      </SectionMessage>
    </Stack>
  );
}

function PurgeSection() {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);

  // Calls the resolver batch by batch (100 issue ids each) until done.
  const purge = async () => {
    setRunning(true);
    setError(null);
    const totals = { scanned: 0, purged: 0 };
    setProgress({ ...totals, done: false });
    try {
      let afterId = '';
      do {
        const batch = await callResolver('purgeOrphans', { afterId });
        totals.scanned += batch.scanned;
        totals.purged += batch.purged;
        setProgress({ ...totals, done: false });
        afterId = batch.nextAfterId;
      } while (afterId);
      setProgress({ ...totals, done: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Stack space="space.200">
      <Heading size="medium">Maintenance</Heading>
      <Text>
        Test runs and plan/execution memberships are kept indefinitely. When Jira issues are deleted, their app data
        becomes unreachable. Use this to remove it. Issues the app itself cannot access are treated as deleted.
      </Text>
      <ErrorBanner error={error} />
      <LoadingButton isLoading={running} onClick={purge}>
        Purge data for deleted issues
      </LoadingButton>
      {progress && (
        <Text>
          {progress.done ? 'Done. ' : 'Working… '}Scanned {progress.scanned} issue references, removed data for{' '}
          {progress.purged} deleted issues.
        </Text>
      )}
    </Stack>
  );
}

const IMPORT_STATUS_APPEARANCE = { running: 'inprogress', waiting: 'moved', done: 'success', failed: 'removed' };

const IMPORT_COUNT_LABELS = [
  ['stepsWritten', 'Tests given steps'],
  ['stepsKept', 'Tests that already had steps (kept)'],
  ['setLinks', 'Test Set links created'],
  ['failedLinks', 'Links Jira refused'],
  ['planTests', 'Plan memberships'],
  ['executions', 'Test Executions'],
  ['runs', 'Runs imported'],
  ['skipped', 'Entries skipped (missing issue, other project or wrong type)'],
];

function ImportSection() {
  // Text inputs are uncontrolled (defaultValue + onChange): see CLAUDE.md.
  const [projectKey, setProjectKey] = useState('');
  const [issueKey, setIssueKey] = useState('');
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  const act = async (name, fn) => {
    setBusy(name);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const start = (restart) =>
    act(restart ? 'start' : 'resume', async () => {
      const result = await callResolver('startImport', { projectKey, issueKey, restart });
      setState(result.state);
    });
  const refresh = () =>
    act('refresh', async () => setState((await callResolver('getImportState', { projectKey })).state));

  return (
    <Stack space="space.200">
      <Heading size="medium">Import data</Heading>
      <Text>
        Imports Test steps, Test Set and Test Plan membership, Test Executions and their runs from
        jawdatrace-import*.json files attached to a Jira issue (see the import format documentation). Existing data is
        kept and re-running is safe. Entries whose issues are missing, in another project or of the wrong type are
        skipped.
      </Text>
      <ErrorBanner error={error} />
      <Label labelFor="import-project">Project key</Label>
      <Textfield id="import-project" defaultValue="" onChange={(e) => setProjectKey(e.target.value.trim().toUpperCase())} />
      <Label labelFor="import-issue">Issue with the import files</Label>
      <Textfield id="import-issue" defaultValue="" onChange={(e) => setIssueKey(e.target.value.trim().toUpperCase())} />
      <ButtonGroup>
        <LoadingButton
          appearance="primary"
          isLoading={busy === 'start'}
          isDisabled={!projectKey || !issueKey}
          onClick={() => start(true)}
        >
          Start import
        </LoadingButton>
        <LoadingButton isLoading={busy === 'resume'} isDisabled={!projectKey} onClick={() => start(false)}>
          Resume
        </LoadingButton>
        <Button isDisabled={!projectKey || busy !== null} onClick={refresh}>
          Refresh status
        </Button>
      </ButtonGroup>

      {state && (
        <Stack space="space.100">
          <Inline space="space.100" alignBlock="center" shouldWrap>
            <Text>
              {state.projectKey} from {state.sourceIssueKey}
            </Text>
            <Lozenge appearance={IMPORT_STATUS_APPEARANCE[state.status] ?? 'default'}>{state.status}</Lozenge>
            <Text>
              File {Math.min(state.fileIndex + 1, state.files.length)} of {state.files.length}
              {state.status === 'done' ? '' : `, ${state.section}`}
              {state.error ? ` (${state.error})` : ''}. Last update: {formatDate(state.updatedAt ?? state.startedAt)}.
            </Text>
          </Inline>
          <DynamicTable
            caption="Import progress"
            head={{
              cells: [
                { key: 'what', content: 'What' },
                { key: 'count', content: 'Count' },
              ],
            }}
            rows={IMPORT_COUNT_LABELS.map(([key, label]) => ({
              key,
              cells: [
                { key: 'what', content: label },
                { key: 'count', content: String(state.counts?.[key] ?? 0) },
              ],
            }))}
          />
        </Stack>
      )}
    </Stack>
  );
}

function App() {
  return (
    <Stack space="space.400">
      <SetupSection />
      <PurgeSection />
      <ImportSection />
    </Stack>
  );
}

// No React.StrictMode: it runs effects twice in development, doubling Jira requests.
ForgeReconciler.render(<App />);
