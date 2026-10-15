/**
 * Scope selector for status views, like Xray's "Analysis & Scope":
 *  - "Latest result"  -> latest final run anywhere
 *  - a Test Plan      -> latest final run within that plan's executions
 */
import React, { useEffect, useState } from 'react';
import { Box, Label, Select } from '@forge/react';
import { ISSUE_TYPES, SCOPE } from '../../shared/constants';
import { searchIssuesOfType } from './jira';

const LATEST_OPTION = { label: 'Latest result (all runs)', value: '' };

/**
 * @param {{ projectKey?: string, value: object, onChange: (scope: object) => void }} props
 */
export default function ScopePicker({ projectKey, onChange }) {
  const [input, setInput] = useState('');
  const [options, setOptions] = useState([LATEST_OPTION]);
  const [selected, setSelected] = useState(LATEST_OPTION);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      const plans = await searchIssuesOfType(ISSUE_TYPES.TEST_PLAN, input, projectKey);
      if (!cancelled) setOptions([LATEST_OPTION, ...plans]);
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [input, projectKey]);

  return (
    <Box>
      <Label labelFor="scope">Scope</Label>
      <Select
        inputId="scope"
        options={options}
        value={selected}
        onInputChange={(value) => setInput(value)}
        onChange={(option) => {
          const next = option ?? LATEST_OPTION;
          setSelected(next);
          onChange(next.value ? { kind: SCOPE.PLAN, id: next.value } : { kind: SCOPE.LATEST });
        }}
      />
    </Box>
  );
}
