/**
 * "Test details" issue panel, shown only on issues of type Test.
 *
 * Tabs (each loads its data only when opened):
 *  - Steps:        edit manual steps (issue property, saved as the user)
 *  - Execute:      record an ad-hoc run (not part of a Test Execution)
 *  - Runs:         paginated run history with evidence
 *  - Sets & Plans: Test Sets (Jira links) and Test Plans (app data) containing this Test
 */
import React, { useCallback, useEffect, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  ButtonGroup,
  DynamicTable,
  EmptyState,
  Label,
  LoadingButton,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  ModalTransition,
  SectionMessage,
  Stack,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Text,
  TextArea,
  useProductContext,
} from '@forge/react';
import { LINK_TYPES } from '../shared/constants';
import { callResolver, errorMessage } from './shared/api';
import { ErrorBanner, IssueLink, Loading, RunAuthor, StatusLozenge, formatDate } from './shared/components';
import EvidenceList from './shared/EvidenceList';
import ExecuteForm from './shared/ExecuteForm';
import { getAttachments, getIssueLinks, getSteps, linkedIssues, saveSteps } from './shared/jira';
import { LicenseGate } from './shared/LicenseGate';

// ---------------------------------------------------------------------------
// Steps tab
// ---------------------------------------------------------------------------

const newStepId = () => `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

function StepModal({ step, onSave, onClose }) {
  const [action, setAction] = useState(step?.action ?? '');
  const [data, setData] = useState(step?.data ?? '');
  const [expected, setExpected] = useState(step?.expected ?? '');
  return (
    <Modal onClose={onClose}>
      <ModalHeader>
        <ModalTitle>{step ? 'Edit step' : 'Add step'}</ModalTitle>
      </ModalHeader>
      <ModalBody>
        <Stack space="space.150">
          <Box>
            <Label labelFor="step-action">Action</Label>
            <TextArea id="step-action" defaultValue={action} onChange={(e) => setAction(e.target.value)} />
          </Box>
          <Box>
            <Label labelFor="step-data">Data</Label>
            <TextArea id="step-data" defaultValue={data} onChange={(e) => setData(e.target.value)} />
          </Box>
          <Box>
            <Label labelFor="step-expected">Expected result</Label>
            <TextArea id="step-expected" defaultValue={expected} onChange={(e) => setExpected(e.target.value)} />
          </Box>
        </Stack>
      </ModalBody>
      <ModalFooter>
        <Button appearance="subtle" onClick={onClose}>
          Cancel
        </Button>
        <Button
          appearance="primary"
          isDisabled={!action.trim()}
          onClick={() =>
            onSave({ id: step?.id ?? newStepId(), action: action.trim(), data: data.trim(), expected: expected.trim() })
          }
        >
          Done
        </Button>
      </ModalFooter>
    </Modal>
  );
}

function StepsTab({ issueId }) {
  const [loaded, setLoaded] = useState(null); // { revision, steps } as last loaded/saved
  const [steps, setSteps] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [editing, setEditing] = useState(null); // { step } or { step: null } for new
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const value = await getSteps(issueId);
      setLoaded(value);
      setSteps(value.steps);
      setDirty(false);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [issueId]);

  useEffect(() => {
    load();
  }, [load]);

  const update = (next) => {
    setSteps(next);
    setDirty(true);
  };
  const move = (index, delta) => {
    const next = [...steps];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item);
    update(next);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = await saveSteps(issueId, loaded.revision, steps);
      setLoaded(saved);
      setDirty(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (!loaded && !error) return <Loading />;

  return (
    <Stack space="space.150">
      <ErrorBanner error={error} />
      {error && (
        <Button appearance="link" onClick={load}>
          Reload steps
        </Button>
      )}
      <DynamicTable
        caption="Manual steps"
        head={{
          cells: [
            { key: 'n', content: '#' },
            { key: 'action', content: 'Action' },
            { key: 'data', content: 'Data' },
            { key: 'expected', content: 'Expected result' },
            { key: 'actions', content: '' },
          ],
        }}
        rows={steps.map((step, index) => ({
          key: step.id,
          cells: [
            { key: 'n', content: index + 1 },
            { key: 'action', content: step.action },
            { key: 'data', content: step.data },
            { key: 'expected', content: step.expected },
            {
              key: 'actions',
              content: (
                <ButtonGroup>
                  <Button appearance="subtle" isDisabled={index === 0} onClick={() => move(index, -1)}>
                    Up
                  </Button>
                  <Button appearance="subtle" isDisabled={index === steps.length - 1} onClick={() => move(index, 1)}>
                    Down
                  </Button>
                  <Button appearance="subtle" onClick={() => setEditing({ step })}>
                    Edit
                  </Button>
                  <Button appearance="subtle" onClick={() => update(steps.filter((s) => s.id !== step.id))}>
                    Delete
                  </Button>
                </ButtonGroup>
              ),
            },
          ],
        }))}
        emptyView={<Text>No steps yet. Add the first step.</Text>}
      />
      <ButtonGroup>
        <Button onClick={() => setEditing({ step: null })}>Add step</Button>
        <LoadingButton appearance="primary" isDisabled={!dirty} isLoading={saving} onClick={save}>
          Save steps
        </LoadingButton>
        {dirty && (
          <Button appearance="subtle" onClick={load}>
            Discard changes
          </Button>
        )}
      </ButtonGroup>
      <ModalTransition>
        {editing && (
          <StepModal
            step={editing.step}
            onClose={() => setEditing(null)}
            onSave={(step) => {
              update(editing.step ? steps.map((s) => (s.id === step.id ? step : s)) : [...steps, step]);
              setEditing(null);
            }}
          />
        )}
      </ModalTransition>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Runs tab
// ---------------------------------------------------------------------------

function RunsTab({ issueId }) {
  const [runs, setRuns] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [attachmentsById, setAttachmentsById] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const loadPage = useCallback(
    async (pageCursor) => {
      setLoading(true);
      setError(null);
      try {
        const page = await callResolver('getRuns', { testIssueId: issueId, cursor: pageCursor });
        setRuns((current) => (pageCursor ? [...current, ...page.runs] : page.runs));
        setCursor(page.nextCursor);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setLoading(false);
      }
    },
    [issueId]
  );

  useEffect(() => {
    loadPage(null);
    // Current attachments, once, to resolve evidence links (see EvidenceList).
    getAttachments(issueId)
      .then((list) => setAttachmentsById(new Map(list.map((a) => [a.id, a]))))
      .catch(() => setAttachmentsById(null));
  }, [issueId, loadPage]);

  return (
    <Stack space="space.150">
      <ErrorBanner error={error} />
      <DynamicTable
        caption="Run history"
        isLoading={loading && runs.length === 0}
        head={{
          cells: [
            { key: 'when', content: 'When' },
            { key: 'status', content: 'Result' },
            { key: 'by', content: 'By' },
            { key: 'execution', content: 'Test Execution' },
            { key: 'comment', content: 'Comment' },
            { key: 'evidence', content: 'Evidence' },
          ],
        }}
        rows={runs.map((run, index) => ({
          key: `${run.executedAt}-${index}`,
          cells: [
            { key: 'when', content: formatDate(run.executedAt) },
            { key: 'status', content: <StatusLozenge status={run.status} /> },
            { key: 'by', content: <RunAuthor accountId={run.executedBy} /> },
            {
              key: 'execution',
              content: run.execution?.restricted ? (
                <Text>Restricted</Text>
              ) : run.execution ? (
                <Stack>
                  <IssueLink issueKey={run.execution.key} />
                  {run.execution.environment ? <Text>{run.execution.environment}</Text> : null}
                </Stack>
              ) : (
                <Text>Ad-hoc</Text>
              ),
            },
            { key: 'comment', content: run.comment ?? '' },
            { key: 'evidence', content: <EvidenceList items={run.evidence} attachmentsById={attachmentsById} /> },
          ],
        }))}
        emptyView={<Text>This Test has not been executed yet.</Text>}
      />
      {cursor && (
        <LoadingButton isLoading={loading} onClick={() => loadPage(cursor)}>
          Load older runs
        </LoadingButton>
      )}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Sets & Plans tab
// ---------------------------------------------------------------------------

function SetsAndPlansTab({ issueId }) {
  const [sets, setSets] = useState(null);
  const [plans, setPlans] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    // Test Sets come from Jira links ("Set contains Test" => the Set is the
    // inward side on this Test); Plans come from app data.
    Promise.all([getIssueLinks(issueId), callResolver('getTestPlans', { testIssueId: issueId })])
      .then(([links, planResult]) => {
        setSets(linkedIssues(links, LINK_TYPES.TEST_SET.name, 'inward').map((entry) => entry.issue));
        setPlans(planResult.plans);
      })
      .catch((err) => setError(errorMessage(err)));
  }, [issueId]);

  if (error) return <ErrorBanner error={error} />;
  if (!sets || !plans) return <Loading />;

  const table = (caption, issues, emptyText) => (
    <DynamicTable
      caption={caption}
      head={{
        cells: [
          { key: 'key', content: 'Key' },
          { key: 'summary', content: 'Summary' },
          { key: 'status', content: 'Status' },
        ],
      }}
      rows={issues.map((issue) => ({
        key: String(issue.id),
        cells: [
          { key: 'key', content: <IssueLink issueKey={issue.key} /> },
          { key: 'summary', content: issue.summary ?? issue.fields?.summary ?? '' },
          { key: 'status', content: issue.status?.name ?? issue.fields?.status?.name ?? issue.status ?? '' },
        ],
      }))}
      emptyView={<Text>{emptyText}</Text>}
    />
  );

  return (
    <Stack space="space.200">
      {table('Test Sets', sets, 'Not in any Test Set.')}
      {table('Test Plans', plans, 'Not in any Test Plan.')}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

function App() {
  const context = useProductContext();
  const [tab, setTab] = useState(0);
  const [lastSaved, setLastSaved] = useState(null);
  // Changing this key remounts the Execute form (fresh request id) after a save.
  const [formKey, setFormKey] = useState(0);

  const issueId = context?.extension?.issue?.id ? String(context.extension.issue.id) : null;
  if (!context) return <Loading />;
  if (!issueId) return <EmptyState header="This panel only works on a Jira issue." />;

  return (
    <Tabs id="test-tabs" selected={tab} onChange={setTab}>
      <TabList>
        <Tab>Steps</Tab>
        <Tab>Execute</Tab>
        <Tab>Runs</Tab>
        <Tab>Sets & Plans</Tab>
      </TabList>
      <TabPanel>{tab === 0 ? <StepsTab issueId={issueId} /> : null}</TabPanel>
      <TabPanel>
        {tab === 1 ? (
          <Stack space="space.150">
            {lastSaved && (
              <SectionMessage appearance="success">
                <Text>
                  {lastSaved.duplicate ? 'This result was already saved.' : 'Result saved.'} See the Runs tab for
                  history.
                </Text>
              </SectionMessage>
            )}
            <ExecuteForm
              key={formKey}
              test={{ id: issueId }}
              onSaved={(result) => {
                setLastSaved(result);
                setFormKey((value) => value + 1);
              }}
            />
          </Stack>
        ) : null}
      </TabPanel>
      <TabPanel>{tab === 2 ? <RunsTab issueId={issueId} /> : null}</TabPanel>
      <TabPanel>{tab === 3 ? <SetsAndPlansTab issueId={issueId} /> : null}</TabPanel>
    </Tabs>
  );
}

// No React.StrictMode: it runs effects twice in development, doubling Jira requests.
ForgeReconciler.render(
  <LicenseGate>
    <App />
  </LicenseGate>
);
