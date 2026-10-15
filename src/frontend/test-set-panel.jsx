/**
 * "Test Set" issue panel, shown only on issues of type Test Set.
 *
 * Membership is stored as Jira links ("Set contains Test"), so loading the
 * panel is ONE Jira request (the Set's links include the Tests' summary,
 * status and priority) plus ONE resolver call for test statuses.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ForgeReconciler, {
  Button,
  DynamicTable,
  EmptyState,
  Inline,
  Modal,
  ModalBody,
  ModalHeader,
  ModalTitle,
  ModalTransition,
  Stack,
  Text,
  Toggle,
  Label,
  useProductContext,
} from '@forge/react';
import { LINK_TYPES, SCOPE } from '../shared/constants';
import { countStatuses, overallStatus } from '../shared/status';
import { errorMessage } from './shared/api';
import { ErrorBanner, IssueLink, LastRun, Loading, RowActions, StatusLozenge, StatusSummary } from './shared/components';
import ExecuteForm from './shared/ExecuteForm';
import { createLink, deleteLink, getIssueLinks, linkedIssues, toRow } from './shared/jira';
import ScopePicker from './shared/ScopePicker';
import TestPicker from './shared/TestPicker';
import { useStatuses } from './shared/useStatuses';

// Jira has no bulk "create links" endpoint, so adding is one request per Test;
// cap it to keep a single click cheap and predictable.
const MAX_ADD_AT_ONCE = 100;

function App() {
  const context = useProductContext();
  const setId = context?.extension?.issue?.id ? String(context.extension.issue.id) : null;
  const projectKey = context?.extension?.project?.key;

  const [members, setMembers] = useState(null); // [{ linkId, ...row }]
  const [error, setError] = useState(null);
  const [scope, setScope] = useState({ kind: SCOPE.LATEST });
  const [onlyIncomplete, setOnlyIncomplete] = useState(false);
  const [executing, setExecuting] = useState(null);

  const loadMembers = useCallback(async () => {
    if (!setId) return;
    setError(null);
    try {
      const links = await getIssueLinks(setId);
      setMembers(
        linkedIssues(links, LINK_TYPES.TEST_SET.name, 'outward').map((entry) => ({
          linkId: entry.linkId,
          ...toRow(entry.issue),
        }))
      );
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [setId]);

  useEffect(() => {
    loadMembers();
  }, [loadMembers]);

  const testIds = useMemo(() => (members ? members.map((m) => m.id) : null), [members]);
  const { statuses, loading: statusLoading, error: statusError, reload } = useStatuses(testIds, scope);

  const counts = useMemo(() => countStatuses(testIds ?? [], statuses), [testIds, statuses]);

  const addTests = async (ids) => {
    const existing = new Set(testIds ?? []);
    const toAdd = ids.filter((id) => !existing.has(id)).slice(0, MAX_ADD_AT_ONCE);
    for (const testId of toAdd) {
      await createLink(LINK_TYPES.TEST_SET, setId, testId);
    }
    await loadMembers();
  };

  const remove = async (member) => {
    try {
      await deleteLink(member.linkId);
      await loadMembers();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  if (!context) return <Loading />;
  if (!setId) return <EmptyState header="This panel only works on a Jira issue." />;
  if (!members && !error) return <Loading />;

  const visibleMembers = (members ?? []).filter(
    (member) => !onlyIncomplete || statuses[member.id]?.status !== 'PASS'
  );

  return (
    <Stack space="space.200">
      <ErrorBanner error={error || statusError} />
      <Inline space="space.200" alignBlock="end" shouldWrap>
        <ScopePicker projectKey={projectKey} onChange={setScope} />
        <Inline space="space.100" alignBlock="center">
          <Toggle id="only-incomplete" isChecked={onlyIncomplete} onChange={() => setOnlyIncomplete((v) => !v)} />
          <Label labelFor="only-incomplete">Only tests not passed</Label>
        </Inline>
      </Inline>
      <StatusSummary counts={counts} overall={overallStatus(counts)} />
      <DynamicTable
        caption="Tests in this set"
        isLoading={statusLoading}
        rowsPerPage={20}
        // Fixed column widths (percent) keep the table inside the issue panel.
        isFixedSize
        head={{
          cells: [
            { key: 'key', content: 'Key', isSortable: true, width: 11 },
            { key: 'summary', content: 'Summary', width: 31 },
            { key: 'jira', content: 'Status', width: 12 },
            { key: 'test', content: 'Test status', width: 13 },
            { key: 'last', content: 'Last run', width: 18 },
            { key: 'actions', content: '', width: 15 },
          ],
        }}
        rows={visibleMembers.map((member) => {
          const run = statuses[member.id];
          return {
            key: member.id,
            cells: [
              { key: member.key, content: <IssueLink issueKey={member.key} /> },
              { key: 'summary', content: member.summary },
              { key: 'jira', content: member.jiraStatus },
              { key: 'test', content: <StatusLozenge status={run?.status} /> },
              { key: 'last', content: <LastRun run={run} /> },
              {
                key: 'actions',
                content: (
                  <RowActions>
                    <Button appearance="primary" spacing="compact" onClick={() => setExecuting(member)}>
                      Execute
                    </Button>
                    <Button appearance="subtle" spacing="compact" onClick={() => remove(member)}>
                      Remove
                    </Button>
                  </RowActions>
                ),
              },
            ],
          };
        })}
        emptyView={<Text>No Tests in this set yet. Add some below.</Text>}
      />
      <TestPicker projectKey={projectKey} onAdd={addTests} allowSets={false} />
      <ModalTransition>
        {executing && (
          <Modal onClose={() => setExecuting(null)} width="large">
            <ModalHeader>
              <ModalTitle>Execute {executing.key}</ModalTitle>
            </ModalHeader>
            <ModalBody>
              <ExecuteForm
                test={executing}
                onCancel={() => setExecuting(null)}
                onSaved={() => {
                  setExecuting(null);
                  reload();
                }}
              />
            </ModalBody>
          </Modal>
        )}
      </ModalTransition>
    </Stack>
  );
}

// No React.StrictMode: it runs effects twice in development, doubling Jira requests.
ForgeReconciler.render(<App />);
