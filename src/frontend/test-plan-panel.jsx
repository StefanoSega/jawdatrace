/**
 * "Test Plan" issue panel, shown only on issues of type Test Plan.
 *
 * Tabs:
 *  - Tests:           plan members with their plan-level status (latest final
 *                     result across the plan's executions, optional environment
 *                     filter), add/remove Tests. One resolver call to load.
 *  - Test Executions: the plan's executions with progress, and "Create Test
 *                     Execution". One resolver call to load.
 */
import React, { useCallback, useEffect, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  DynamicTable,
  EmptyState,
  Inline,
  Label,
  LoadingButton,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  ModalTransition,
  ProgressBar,
  RadioGroup,
  SectionMessage,
  Select,
  Stack,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Text,
  Textfield,
  useProductContext,
} from '@forge/react';
import { ratio } from '../shared/status';
import { callResolver, errorMessage } from './shared/api';
import {
  ErrorBanner,
  HiddenNotice,
  IssueLink,
  Loading,
  OverallLozenge,
  StatusLozenge,
  StatusSummary,
  formatDate,
} from './shared/components';
import TestPicker from './shared/TestPicker';

const ALL_ENVIRONMENTS = { label: 'All environments', value: '' };

// ---------------------------------------------------------------------------
// Tests tab
// ---------------------------------------------------------------------------

function TestsTab({ planIssueId, projectId, projectKey }) {
  const [environment, setEnvironment] = useState(ALL_ENVIRONMENTS);
  const [environments, setEnvironments] = useState([]);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await callResolver('getPlan', { planIssueId, environment: environment.value || null }));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [planIssueId, environment]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!projectId) return;
    callResolver('listEnvironments', { projectId })
      .then((result) => setEnvironments(result.environments))
      .catch(() => setEnvironments([]));
  }, [projectId]);

  const addTests = async (ids) => {
    const result = await callResolver('addPlanTests', { planIssueId, testIssueIds: ids });
    setNotice(
      result.skipped
        ? `${result.added} added; ${result.skipped} skipped (not a Test or not accessible).`
        : `${result.added} added.`
    );
    await load();
  };

  const remove = async (test) => {
    try {
      await callResolver('removePlanTests', { planIssueId, testIssueIds: [test.id] });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  if (!data && !error) return <Loading />;

  return (
    <Stack space="space.200">
      <ErrorBanner error={error} />
      <Box>
        <Label labelFor="env-filter">Environment</Label>
        <Select
          inputId="env-filter"
          options={[ALL_ENVIRONMENTS, ...environments.map((value) => ({ label: value, value }))]}
          value={environment}
          onChange={(option) => setEnvironment(option ?? ALL_ENVIRONMENTS)}
        />
      </Box>
      {data && (
        <>
          <StatusSummary counts={data.counts} overall={data.overall} />
          <HiddenNotice count={data.hiddenCount} />
          <DynamicTable
            caption="Tests in this plan"
            rowsPerPage={20}
            head={{
              cells: [
                { key: 'key', content: 'Key' },
                { key: 'summary', content: 'Summary' },
                { key: 'priority', content: 'Priority' },
                { key: 'execs', content: '# Executions' },
                { key: 'status', content: 'Latest status' },
                { key: 'when', content: 'When' },
                { key: 'actions', content: '' },
              ],
            }}
            rows={data.tests.map((test) => ({
              key: test.id,
              cells: [
                { key: 'key', content: <IssueLink issueKey={test.key} /> },
                { key: 'summary', content: test.summary },
                { key: 'priority', content: test.priority },
                { key: 'execs', content: test.executionCount },
                { key: 'status', content: <StatusLozenge status={test.run?.status} /> },
                { key: 'when', content: formatDate(test.run?.executedAt) },
                {
                  key: 'actions',
                  content: (
                    <Button appearance="subtle" onClick={() => remove(test)}>
                      Remove
                    </Button>
                  ),
                },
              ],
            }))}
            emptyView={<Text>No Tests in this plan yet. Add Tests or whole Test Sets below.</Text>}
          />
        </>
      )}
      {notice && (
        <SectionMessage appearance="information">
          <Text>{notice}</Text>
        </SectionMessage>
      )}
      <TestPicker projectKey={projectKey} onAdd={addTests} />
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Executions tab
// ---------------------------------------------------------------------------

const INCLUDE_OPTIONS = [
  { name: 'include', value: 'all', label: 'All Tests in the plan' },
  { name: 'include', value: 'notPassed', label: 'Only Tests not yet passed (in this environment)' },
];

function CreateExecutionModal({ planIssueId, planKey, onClose, onCreated }) {
  const [environment, setEnvironment] = useState('');
  const [summary, setSummary] = useState(`Test Execution for ${planKey}`);
  const [include, setInclude] = useState('all');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const create = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await callResolver('createExecution', { planIssueId, summary, environment, include });
      onCreated(result);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <ModalHeader>
        <ModalTitle>Create Test Execution</ModalTitle>
      </ModalHeader>
      <ModalBody>
        <Stack space="space.150">
          <ErrorBanner error={error} />
          <Box>
            <Label labelFor="exec-summary">Summary</Label>
            <Textfield id="exec-summary" defaultValue={summary} onChange={(e) => setSummary(e.target.value)} />
          </Box>
          <Box>
            <Label labelFor="exec-env">Environment (e.g. iOS, Android)</Label>
            <Textfield id="exec-env" defaultValue={environment} onChange={(e) => setEnvironment(e.target.value)} />
          </Box>
          <RadioGroup
            name="include"
            options={INCLUDE_OPTIONS}
            value={include}
            onChange={(event) => setInclude(event.target.value)}
          />
        </Stack>
      </ModalBody>
      <ModalFooter>
        <Button appearance="subtle" onClick={onClose}>
          Cancel
        </Button>
        <LoadingButton appearance="primary" isLoading={saving} isDisabled={!summary.trim()} onClick={create}>
          Create
        </LoadingButton>
      </ModalFooter>
    </Modal>
  );
}

function ExecutionsTab({ planIssueId, planKey }) {
  const [executions, setExecutions] = useState(null);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await callResolver('listPlanExecutions', { planIssueId });
      setExecutions(result.executions);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [planIssueId]);

  useEffect(() => {
    load();
  }, [load]);

  if (!executions && !error) return <Loading />;

  return (
    <Stack space="space.200">
      <ErrorBanner error={error} />
      {created && (
        <SectionMessage appearance={created.warning ? 'warning' : 'success'}>
          <Inline space="space.050">
            <Text>Created</Text>
            <IssueLink issueKey={created.key} />
            <Text>{created.warning ?? `with ${created.testCount} Tests.`}</Text>
          </Inline>
        </SectionMessage>
      )}
      <Box>
        <Button appearance="primary" onClick={() => setCreating(true)}>
          Create Test Execution
        </Button>
      </Box>
      <DynamicTable
        caption="Test Executions"
        rowsPerPage={20}
        head={{
          cells: [
            { key: 'key', content: 'Key' },
            { key: 'summary', content: 'Summary' },
            { key: 'env', content: 'Environment' },
            { key: 'progress', content: 'Progress' },
            { key: 'overall', content: 'Overall' },
            { key: 'created', content: 'Created' },
          ],
        }}
        rows={(executions ?? []).map((execution) => ({
          key: execution.id,
          cells: [
            { key: 'key', content: <IssueLink issueKey={execution.key} /> },
            { key: 'summary', content: execution.summary },
            { key: 'env', content: execution.environment ?? '' },
            {
              key: 'progress',
              content: (
                <Stack space="space.050">
                  <ProgressBar
                    value={ratio(execution.counts.PASS, execution.counts.total)}
                    ariaLabel="Share of tests passed"
                  />
                  <Text>
                    {execution.counts.PASS} passed · {execution.counts.FAIL} failed · {execution.counts.BLOCKED}{' '}
                    blocked · {execution.counts.EXECUTING} executing · {execution.counts.TODO} to do
                  </Text>
                </Stack>
              ),
            },
            { key: 'overall', content: <OverallLozenge overall={execution.overall} /> },
            { key: 'created', content: formatDate(execution.createdAt) },
          ],
        }))}
        emptyView={<Text>No Test Executions yet.</Text>}
      />
      <ModalTransition>
        {creating && (
          <CreateExecutionModal
            planIssueId={planIssueId}
            planKey={planKey}
            onClose={() => setCreating(false)}
            onCreated={(result) => {
              setCreating(false);
              setCreated(result);
              load();
            }}
          />
        )}
      </ModalTransition>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

function App() {
  const context = useProductContext();
  const [tab, setTab] = useState(0);
  const issue = context?.extension?.issue;
  const project = context?.extension?.project;

  if (!context) return <Loading />;
  if (!issue?.id) return <EmptyState header="This panel only works on a Jira issue." />;
  const planIssueId = String(issue.id);

  return (
    <Tabs id="plan-tabs" selected={tab} onChange={setTab}>
      <TabList>
        <Tab>Tests</Tab>
        <Tab>Test Executions</Tab>
      </TabList>
      <TabPanel>
        {tab === 0 ? (
          <TestsTab planIssueId={planIssueId} projectId={project?.id ? String(project.id) : null} projectKey={project?.key} />
        ) : null}
      </TabPanel>
      <TabPanel>{tab === 1 ? <ExecutionsTab planIssueId={planIssueId} planKey={issue.key} /> : null}</TabPanel>
    </Tabs>
  );
}

// No React.StrictMode: it runs effects twice in development, doubling Jira requests.
ForgeReconciler.render(<App />);
