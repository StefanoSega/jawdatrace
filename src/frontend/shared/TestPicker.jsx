/**
 * Picker for adding Tests to a Test Set / Test Plan / Test Execution.
 *
 * Two ways to add:
 *  - search Tests by key or summary (typeahead, 1 JQL request per pause in typing)
 *  - pick a Test Set and add all of its Tests (1 JQL request)
 *
 * Calls `onAdd(testIds)`; the parent decides how to store them.
 */
import React, { useEffect, useState } from 'react';
import { Box, Inline, Label, LoadingButton, Select, Stack, xcss } from '@forge/react';
import { ISSUE_TYPES } from '../../shared/constants';
import { errorMessage } from './api';
import { ErrorBanner } from './components';
import { getTestSetMembers, searchIssuesOfType } from './jira';

const SEARCH_DELAY_MS = 350;
const growStyle = xcss({ flexGrow: 1 });

/** Debounced typeahead options for one issue type. */
function useIssueSearch(issueTypeName, projectKey) {
  const [input, setInput] = useState('');
  const [options, setOptions] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      const results = await searchIssuesOfType(issueTypeName, input, projectKey);
      if (!cancelled) {
        setOptions(results);
        setLoading(false);
      }
    }, SEARCH_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [issueTypeName, input, projectKey]);

  return { options, loading, setInput };
}

/**
 * @param {{ projectKey?: string, onAdd: (ids: string[]) => Promise<void>, allowSets?: boolean }} props
 */
export default function TestPicker({ projectKey, onAdd, allowSets = true }) {
  const tests = useIssueSearch(ISSUE_TYPES.TEST, projectKey);
  const sets = useIssueSearch(ISSUE_TYPES.TEST_SET, projectKey);
  const [selectedTests, setSelectedTests] = useState([]);
  const [selectedSet, setSelectedSet] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const run = async (work) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const addSelectedTests = () =>
    run(async () => {
      await onAdd(selectedTests.map((option) => option.value));
      setSelectedTests([]);
    });

  const addSet = () =>
    run(async () => {
      // Option label starts with the issue key ("KEY summary").
      const setKey = selectedSet.label.split(' ')[0];
      const { issues, truncated } = await getTestSetMembers([setKey]);
      if (issues.length === 0) throw new Error('That Test Set has no Tests.');
      await onAdd(issues.map((issue) => String(issue.id)));
      setSelectedSet(null);
      if (truncated) setError('Only the first 500 Tests of the set were added.');
    });

  return (
    <Stack space="space.150">
      <ErrorBanner error={error} />
      <Inline space="space.100" alignBlock="end">
        <Box xcss={growStyle}>
          <Label labelFor="test-search">Add Tests</Label>
          <Select
            inputId="test-search"
            isMulti
            isLoading={tests.loading}
            options={tests.options}
            value={selectedTests}
            placeholder="Search by key or summary"
            onInputChange={(value) => tests.setInput(value)}
            onChange={(value) => setSelectedTests(value ?? [])}
          />
        </Box>
        <LoadingButton isLoading={busy} isDisabled={selectedTests.length === 0} onClick={addSelectedTests}>
          Add
        </LoadingButton>
      </Inline>
      {allowSets && (
        <Inline space="space.100" alignBlock="end">
          <Box xcss={growStyle}>
            <Label labelFor="set-search">Add all Tests from a Test Set</Label>
            <Select
              inputId="set-search"
              isClearable
              isLoading={sets.loading}
              options={sets.options}
              value={selectedSet}
              placeholder="Search Test Sets"
              onInputChange={(value) => sets.setInput(value)}
              onChange={(value) => setSelectedSet(value)}
            />
          </Box>
          <LoadingButton isLoading={busy} isDisabled={!selectedSet} onClick={addSet}>
            Add set
          </LoadingButton>
        </Inline>
      )}
    </Stack>
  );
}
