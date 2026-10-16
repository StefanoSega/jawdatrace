/**
 * Jira admin page: one-time setup and maintenance.
 *
 *  - Creates the app's issue types (Test, Test Set, Test Plan, Test Execution)
 *    and link types ("Test", "Test Set"). Safe to run again.
 *  - Purges app data for Jira issues that were deleted (manual, batched).
 *  - One-off import from Xray Cloud (steps, Set/Plan membership, executions
 *    and runs). The work runs in a queue consumer; this page only starts it
 *    and shows progress when the admin presses "Refresh" (no polling).
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
  Select,
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

const XRAY_REGION_OPTIONS = [
  { label: 'Global (auto)', value: 'global' },
  { label: 'United States', value: 'us' },
  { label: 'Europe', value: 'eu' },
  { label: 'Australia', value: 'au' },
];

const IMPORT_STATUS_APPEARANCE = { running: 'inprogress', waiting: 'moved', done: 'success', failed: 'removed' };

const IMPORT_COUNT_LABELS = [
  ['tests', 'Tests read from Xray'],
  ['stepsWritten', 'Tests given steps'],
  ['setLinks', 'Test Set links created'],
  ['planTests', 'Plan memberships'],
  ['executions', 'Test Executions'],
  ['runs', 'Runs imported'],
  ['todo', 'TODO runs (membership only)'],
  ['skippedStatus', 'Runs skipped (custom Xray status)'],
  ['truncated', 'Issues with extra Sets/Plans not imported'],
  ['failedLinks', 'Links Jira refused'],
];

function XrayImportSection() {
  // Text inputs are uncontrolled (defaultValue + onChange): see CLAUDE.md.
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [region, setRegion] = useState(XRAY_REGION_OPTIONS[0]);
  const [projectKey, setProjectKey] = useState('');
  const [info, setInfo] = useState(null); // { hasCredentials, region, state }
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  useEffect(() => {
    callResolver('getXrayImportState')
      .then(setInfo)
      .catch((err) => setError(errorMessage(err)));
  }, []);

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

  const saveKey = () =>
    act('save', async () => {
      const result = await callResolver('saveXrayCredentials', { clientId, clientSecret, region: region.value });
      setInfo((current) => ({ ...current, ...result }));
    });
  const start = (restart) =>
    act(restart ? 'start' : 'resume', async () => {
      const result = await callResolver('startXrayImport', { projectKey, restart });
      setInfo((current) => ({ ...current, state: result.state }));
    });
  const refresh = () =>
    act('refresh', async () => setInfo(await callResolver('getXrayImportState', { projectKey })));

  const state = info?.state;

  return (
    <Stack space="space.200">
      <Heading size="medium">Import from Xray</Heading>
      <Text>
        Copies Xray data that is not stored in Jira: Test steps, Test Set and Test Plan membership, Test Executions
        (environment, plan) and their runs. Existing data is kept and re-running is safe. Xray evidence files and
        step-level results are not copied.
      </Text>
      <ErrorBanner error={error} />
      <Text>
        Xray API key: {info?.hasCredentials ? `saved (${info.region})` : 'not saved'}. Create one in Xray → Global
        Settings → API Keys.
      </Text>
      <Label labelFor="xray-client-id">Client ID</Label>
      <Textfield id="xray-client-id" defaultValue="" onChange={(e) => setClientId(e.target.value)} />
      <Label labelFor="xray-client-secret">Client Secret</Label>
      <Textfield
        id="xray-client-secret"
        type="password"
        defaultValue=""
        onChange={(e) => setClientSecret(e.target.value)}
      />
      <Label labelFor="xray-region">Xray region</Label>
      <Select
        inputId="xray-region"
        options={XRAY_REGION_OPTIONS}
        value={region}
        onChange={(option) => setRegion(option ?? XRAY_REGION_OPTIONS[0])}
      />
      <LoadingButton isLoading={busy === 'save'} isDisabled={!clientId || !clientSecret} onClick={saveKey}>
        Check and save API key
      </LoadingButton>

      <Label labelFor="xray-project">Project key</Label>
      <Textfield
        id="xray-project"
        defaultValue=""
        onChange={(e) => setProjectKey(e.target.value.trim().toUpperCase())}
      />
      <ButtonGroup>
        <LoadingButton
          appearance="primary"
          isLoading={busy === 'start'}
          isDisabled={!projectKey || !info?.hasCredentials}
          onClick={() => start(true)}
        >
          Start import
        </LoadingButton>
        <LoadingButton
          isLoading={busy === 'resume'}
          isDisabled={!projectKey || !info?.hasCredentials}
          onClick={() => start(false)}
        >
          Resume
        </LoadingButton>
        <Button isDisabled={!projectKey || busy !== null} onClick={refresh}>
          Refresh status
        </Button>
      </ButtonGroup>

      {state && (
        <Stack space="space.100">
          <Inline space="space.100" alignBlock="center" shouldWrap>
            <Text>{state.projectKey}</Text>
            <Lozenge appearance={IMPORT_STATUS_APPEARANCE[state.status] ?? 'default'}>{state.status}</Lozenge>
            <Text>
              Stage: {state.stage}
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
                {
                  key: 'count',
                  content:
                    key === 'tests' && state.totals?.tests
                      ? `${state.counts?.[key] ?? 0} of ${state.totals.tests}`
                      : key === 'executions' && state.totals?.executions
                        ? `${state.counts?.[key] ?? 0} of ${state.totals.executions}`
                        : String(state.counts?.[key] ?? 0),
                },
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
      <XrayImportSection />
    </Stack>
  );
}

// No React.StrictMode: it runs effects twice in development, doubling Jira requests.
ForgeReconciler.render(<App />);
