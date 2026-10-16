/**
 * Scope selector for status views, like Xray's "Analysis & Scope":
 *  - "Latest result"  -> latest run anywhere
 *  - a Test Plan      -> latest run within that plan's executions
 *  - Environment      -> only runs from Executions in that environment
 *                        (e.g. "iOS"); ad-hoc runs drop out when one is set
 *  - "Final statuses have precedence over non-final" -> see
 *    resolveDisplayStatus() in src/shared/status.js (on by default, as in Xray)
 *
 * It reports the combined scope object that the `getStatuses` resolver
 * understands: { kind, id?, environment, finalPrecedence }.
 */
import React, { useEffect, useState } from 'react';
import { Box, Checkbox, Inline, Label, Select } from '@forge/react';
import { ISSUE_TYPES, SCOPE } from '../../shared/constants';
import { callResolver } from './api';
import { searchIssuesOfType } from './jira';

const LATEST_OPTION = { label: 'Latest result (all runs)', value: '' };
const ALL_ENVIRONMENTS = { label: 'All environments', value: '' };

/**
 * @param {{
 *   projectKey?: string,
 *   projectId?: string,   // needed for the environment list; without it the filter is hidden
 *   onChange: (scope: object) => void,
 * }} props
 */
export default function ScopePicker({ projectKey, projectId, onChange }) {
  const [input, setInput] = useState('');
  const [options, setOptions] = useState([LATEST_OPTION]);
  const [selected, setSelected] = useState(LATEST_OPTION);
  const [environments, setEnvironments] = useState([]);
  const [environment, setEnvironment] = useState(ALL_ENVIRONMENTS);
  const [finalPrecedence, setFinalPrecedence] = useState(true);

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

  // Environment suggestions: values earlier Executions in this project used.
  // One resolver call per panel load (one SQL SELECT DISTINCT).
  useEffect(() => {
    if (!projectId) return;
    callResolver('listEnvironments', { projectId })
      .then((result) => setEnvironments(result.environments))
      .catch(() => setEnvironments([]));
  }, [projectId]);

  // Report the combined scope whenever any part of it changes.
  const emit = (next) => {
    const plan = next.plan ?? selected;
    const env = next.environment ?? environment;
    const precedence = next.finalPrecedence ?? finalPrecedence;
    onChange({
      ...(plan.value ? { kind: SCOPE.PLAN, id: plan.value } : { kind: SCOPE.LATEST }),
      environment: env.value || null,
      finalPrecedence: precedence,
    });
  };

  return (
    <Box>
      <Inline space="space.200" alignBlock="end" shouldWrap>
        <Box>
          <Label labelFor="scope">Scope</Label>
          <Select
            inputId="scope"
            options={options}
            value={selected}
            onInputChange={(value) => setInput(value)}
            onChange={(option) => {
              const plan = option ?? LATEST_OPTION;
              setSelected(plan);
              emit({ plan });
            }}
          />
        </Box>
        {projectId && (
          <Box>
            <Label labelFor="scope-env">Environment</Label>
            <Select
              inputId="scope-env"
              options={[ALL_ENVIRONMENTS, ...environments.map((value) => ({ label: value, value }))]}
              value={environment}
              onChange={(option) => {
                const next = option ?? ALL_ENVIRONMENTS;
                setEnvironment(next);
                emit({ environment: next });
              }}
            />
          </Box>
        )}
      </Inline>
      <Checkbox
        name="final-precedence"
        value="final-precedence"
        label="Final statuses have precedence over non-final"
        isChecked={finalPrecedence}
        onChange={(event) => {
          const checked = Boolean(event?.target?.checked);
          setFinalPrecedence(checked);
          emit({ finalPrecedence: checked });
        }}
      />
    </Box>
  );
}
