/**
 * "Test Execution" issue panel, shown only on issues of type Test Execution.
 *
 * One resolver call (`getExecution`) returns the Tests (with their Jira
 * details), each Test's status in this execution, the counts, the plan and
 * the environment. Runs are recorded with `recordRun` (Start = EXECUTING).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  ButtonGroup,
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
  Select,
  Stack,
  Text,
  Textfield,
  Toggle,
  User,
  useProductContext,
} from '@forge/react';
import { ISSUE_TYPES, RUN_STATUS } from '../shared/constants';
import { callResolver, errorMessage, newRequestId } from './shared/api';
import {
  ErrorBanner,
  HiddenNotice,
  IssueLink,
  Loading,
  StatusLozenge,
  StatusSummary,
  formatDate,
} from './shared/components';
import ExecuteForm from './shared/ExecuteForm';
import { searchIssuesOfType } from './shared/jira';
import TestPicker from './shared/TestPicker';

/** Modal to change the execution's Test Plan and environment. */
function SettingsModal({ executionIssueId, projectId, projectKey, current, onClose, onSaved }) {
  const [environment, setEnvironment] = useState(current.environment ?? '');
  // The environment input is uncontrolled (see ExecuteForm); bump the key to
  // show a value picked from the suggestions.
  const [envFieldKey, setEnvFieldKey] = useState(0);
  const [suggestions, setSuggestions] = useState([]);
  const [planInput, setPlanInput] = useState('');
  const [planOptions, setPlanOptions] = useState([]);
  const [plan, setPlan] = useState(
    current.plan && !current.plan.restricted ? { label: `${current.plan.key} ${current.plan.summary}`, value: current.plan.id } : null
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    callResolver('listEnvironments', { projectId })
      .then((result) => setSuggestions(result.environments))
      .catch(() => setSuggestions([]));
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      const options = await searchIssuesOfType(ISSUE_TYPES.TEST_PLAN, planInput, projectKey);
      if (!cancelled) setPlanOptions(options);
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [planInput, projectKey]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await callResolver('updateExecution', {
        executionIssueId,
        environment,
        planIssueId: plan?.value ?? null,
      });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <ModalHeader>
        <ModalTitle>Execution settings</ModalTitle>
      </ModalHeader>
      <ModalBody>
        <Stack space="space.150">
          <ErrorBanner error={error} />
          <Box>
            <Label labelFor="plan">Test Plan</Label>
            <Select
              inputId="plan"
              isClearable
              options={planOptions}
              value={plan}
              placeholder="Search Test Plans"
              onInputChange={(value) => setPlanInput(value)}
              onChange={(value) => setPlan(value)}
            />
          </Box>
          <Box>
            <Label labelFor="environment">Environment (e.g. iOS, Android, UAT)</Label>
            <Textfield key={`env-${envFieldKey}`} id="environment" defaultValue={environment} onChange={(e) => setEnvironment(e.target.value)} />
          </Box>
          {suggestions.length > 0 && (
            <Inline space="space.050" shouldWrap>
              {suggestions.map((value) => (
                <Button
                  key={value}
                  appearance="subtle"
                  onClick={() => {
                    setEnvironment(value);
                    setEnvFieldKey((n) => n + 1);
                  }}
                >
                  {value}
                </Button>
              ))}
            </Inline>
          )}
        </Stack>
      </ModalBody>
      <ModalFooter>
        <Button appearance="subtle" onClick={onClose}>
          Cancel
        </Button>
        <LoadingButton appearance="primary" isLoading={saving} onClick={save}>
          Save
        </LoadingButton>
      </ModalFooter>
    </Modal>
  );
}

function App() {
  const context = useProductContext();
  const executionIssueId = context?.extension?.issue?.id ? String(context.extension.issue.id) : null;
  const projectKey = context?.extension?.project?.key;
  const accountId = context?.accountId;

  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [onlyMine, setOnlyMine] = useState(false);
  const [executing, setExecuting] = useState(null);
  const [editingSettings, setEditingSettings] = useState(false);
  const [busyTestId, setBusyTestId] = useState(null);

  const load = useCallback(async () => {
    if (!executionIssueId) return;
    setError(null);
    try {
      setData(await callResolver('getExecution', { executionIssueId }));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [executionIssueId]);

  useEffect(() => {
    load();
  }, [load]);

  const addTests = async (ids) => {
    await callResolver('addExecutionTests', { executionIssueId, testIssueIds: ids });
    await load();
  };

  const addFromPlan = async () => {
    try {
      const plan = await callResolver('getPlan', { planIssueId: data.plan.id });
      await addTests(plan.tests.map((test) => test.id));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const start = async (test) => {
    setBusyTestId(test.id);
    try {
      await callResolver('recordRun', {
        testIssueId: test.id,
        executionIssueId,
        status: RUN_STATUS.EXECUTING,
        clientRequestId: newRequestId(),
      });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyTestId(null);
    }
  };

  const remove = async (test) => {
    setBusyTestId(test.id);
    try {
      await callResolver('removeExecutionTests', { executionIssueId, testIssueIds: [test.id] });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyTestId(null);
    }
  };

  const rows = useMemo(() => {
    const tests = data?.tests ?? [];
    return onlyMine ? tests.filter((test) => test.run?.executedBy === accountId) : tests;
  }, [data, onlyMine, accountId]);

  if (!context) return <Loading />;
  if (!executionIssueId) return <EmptyState header="This panel only works on a Jira issue." />;
  if (!data && !error) return <Loading />;
  if (!data) return <ErrorBanner error={error} />;

  return (
    <Stack space="space.200">
      <ErrorBanner error={error} />
      <Inline space="space.200" alignBlock="center" shouldWrap>
        <Inline space="space.050" alignBlock="center">
          <Text weight="bold">Test Plan:</Text>
          {data.plan?.restricted ? (
            <Text>Restricted</Text>
          ) : data.plan ? (
            <IssueLink issueKey={data.plan.key} />
          ) : (
            <Text>None</Text>
          )}
        </Inline>
        <Inline space="space.050" alignBlock="center">
          <Text weight="bold">Environment:</Text>
          <Text>{data.environment || 'None'}</Text>
        </Inline>
        <Button appearance="subtle" onClick={() => setEditingSettings(true)}>
          Edit
        </Button>
      </Inline>

      <StatusSummary counts={data.counts} overall={data.overall} />
      <HiddenNotice count={data.hiddenCount} />

      <Inline space="space.100" alignBlock="center">
        <Toggle id="only-mine" isChecked={onlyMine} onChange={() => setOnlyMine((value) => !value)} />
        <Label labelFor="only-mine">Only my test runs</Label>
      </Inline>

      <DynamicTable
        caption="Tests in this execution"
        rowsPerPage={20}
        head={{
          cells: [
            { key: 'rank', content: '#' },
            { key: 'key', content: 'Key' },
            { key: 'summary', content: 'Summary' },
            { key: 'priority', content: 'Priority' },
            { key: 'status', content: 'Test status' },
            { key: 'by', content: 'Executed by' },
            { key: 'when', content: 'When' },
            { key: 'actions', content: '' },
          ],
        }}
        rows={rows.map((test, index) => ({
          key: test.id,
          cells: [
            { key: 'rank', content: index + 1 },
            { key: 'key', content: <IssueLink issueKey={test.key} /> },
            { key: 'summary', content: test.summary },
            { key: 'priority', content: test.priority },
            { key: 'status', content: <StatusLozenge status={test.run?.status} /> },
            { key: 'by', content: test.run ? <User accountId={test.run.executedBy} /> : '' },
            { key: 'when', content: formatDate(test.run?.executedAt) },
            {
              key: 'actions',
              content: (
                <ButtonGroup>
                  <LoadingButton
                    appearance="subtle"
                    isLoading={busyTestId === test.id}
                    isDisabled={test.run?.status === RUN_STATUS.EXECUTING}
                    onClick={() => start(test)}
                  >
                    Start
                  </LoadingButton>
                  <Button appearance="primary" onClick={() => setExecuting(test)}>
                    Execute
                  </Button>
                  <Button appearance="subtle" onClick={() => remove(test)}>
                    Remove
                  </Button>
                </ButtonGroup>
              ),
            },
          ],
        }))}
        emptyView={<Text>No Tests in this execution yet. Add Tests below.</Text>}
      />

      <Stack space="space.100">
        <Text weight="bold">Add Tests</Text>
        {data.plan && !data.plan.restricted && (
          <Box>
            <Button onClick={addFromPlan}>Add all Tests from {data.plan.key}</Button>
          </Box>
        )}
        <TestPicker projectKey={projectKey} onAdd={addTests} />
      </Stack>

      <ModalTransition>
        {executing && (
          <Modal onClose={() => setExecuting(null)} width="large">
            <ModalHeader>
              <ModalTitle>Execute {executing.key}</ModalTitle>
            </ModalHeader>
            <ModalBody>
              <ExecuteForm
                test={executing}
                executionIssueId={executionIssueId}
                onCancel={() => setExecuting(null)}
                onSaved={() => {
                  setExecuting(null);
                  load();
                }}
              />
            </ModalBody>
          </Modal>
        )}
        {editingSettings && (
          <SettingsModal
            executionIssueId={executionIssueId}
            projectId={data.projectId}
            projectKey={projectKey}
            current={data}
            onClose={() => setEditingSettings(false)}
            onSaved={() => {
              setEditingSettings(false);
              load();
            }}
          />
        )}
      </ModalTransition>
    </Stack>
  );
}

// No React.StrictMode: it runs effects twice in development, doubling Jira requests.
ForgeReconciler.render(<App />);
