/**
 * Jira admin page: one-time setup and maintenance.
 *
 *  - Creates the app's issue types (Test, Test Set, Test Plan, Test Execution)
 *    and link types ("Test", "Test Set"). Safe to run again.
 *  - Purges app data for Jira issues that were deleted (manual, batched).
 */
import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  DynamicTable,
  Heading,
  List,
  ListItem,
  LoadingButton,
  Lozenge,
  SectionMessage,
  Stack,
  Text,
} from '@forge/react';
import { callResolver, errorMessage } from './shared/api';
import { ErrorBanner, Loading } from './shared/components';

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

function App() {
  return (
    <Stack space="space.400">
      <SetupSection />
      <PurgeSection />
    </Stack>
  );
}

// No React.StrictMode: it runs effects twice in development, doubling Jira requests.
ForgeReconciler.render(<App />);
