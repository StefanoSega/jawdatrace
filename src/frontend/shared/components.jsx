/**
 * Small presentational components shared by all panels.
 * UI Kit only: every element comes from @forge/react.
 */
import React from 'react';
import {
  Badge,
  Box,
  Inline,
  Link,
  Lozenge,
  ProgressBar,
  SectionMessage,
  Spinner,
  Stack,
  Text,
  User,
  xcss,
} from '@forge/react';
import { OVERALL, TODO, UNKNOWN_ACCOUNT } from '../../shared/constants';
import { ratio } from '../../shared/status';

const STATUS_APPEARANCE = {
  PASS: 'success',
  FAIL: 'removed',
  BLOCKED: 'moved',
  EXECUTING: 'inprogress',
  [TODO]: 'default',
};
const STATUS_LABEL = { PASS: 'Passed', FAIL: 'Failed', BLOCKED: 'Blocked', EXECUTING: 'Executing', [TODO]: 'To do' };

/** Lozenge for a single Test status (PASS / FAIL / BLOCKED / EXECUTING / TODO). */
export function StatusLozenge({ status }) {
  const key = status ?? TODO;
  return (
    <Lozenge appearance={STATUS_APPEARANCE[key] ?? 'default'}>
      {STATUS_LABEL[key] ?? key}
    </Lozenge>
  );
}

const OVERALL_APPEARANCE = {
  [OVERALL.OK]: 'success',
  [OVERALL.NOK]: 'removed',
  [OVERALL.INCOMPLETE]: 'inprogress',
  [OVERALL.NO_TESTS]: 'default',
};
const OVERALL_LABEL = {
  [OVERALL.OK]: 'OK',
  [OVERALL.NOK]: 'NOK',
  [OVERALL.INCOMPLETE]: 'Incomplete',
  [OVERALL.NO_TESTS]: 'No tests',
};

export function OverallLozenge({ overall }) {
  return (
    <Lozenge appearance={OVERALL_APPEARANCE[overall] ?? 'default'}>
      {OVERALL_LABEL[overall] ?? overall}
    </Lozenge>
  );
}

/**
 * "Overall Execution Status" block: progress bar + per-status counts.
 * @param {{ counts: object, overall: string }} props
 */
export function StatusSummary({ counts, overall }) {
  if (!counts) return null;
  const done = counts.PASS + counts.FAIL + counts.BLOCKED;
  return (
    <Stack space="space.100">
      <Inline space="space.100" alignBlock="center">
        <Text weight="bold">Overall status</Text>
        <OverallLozenge overall={overall} />
        <Text>
          {done} of {counts.total} executed
        </Text>
      </Inline>
      <ProgressBar
        value={ratio(counts.PASS, counts.total)}
        appearance={counts.FAIL > 0 ? 'default' : 'success'}
        ariaLabel="Share of tests passed"
      />
      <Inline space="space.150" shouldWrap>
        <CountBadge label="Passed" value={counts.PASS} appearance="added" />
        <CountBadge label="Failed" value={counts.FAIL} appearance="removed" />
        <CountBadge label="Blocked" value={counts.BLOCKED} appearance="important" />
        <CountBadge label="Executing" value={counts.EXECUTING} appearance="primary" />
        <CountBadge label="To do" value={counts.TODO} appearance="default" />
        <CountBadge label="Total" value={counts.total} appearance="default" />
      </Inline>
    </Stack>
  );
}

function CountBadge({ label, value, appearance }) {
  return (
    <Inline space="space.050" alignBlock="center">
      <Badge appearance={appearance} max={false}>
        {value}
      </Badge>
      <Text>{label}</Text>
    </Inline>
  );
}

/**
 * Who recorded a run. Accounts closed since then are stored as "unknown"
 * (src/privacy/report.js), and show as "Former user".
 */
export function RunAuthor({ accountId }) {
  if (!accountId) return null;
  if (accountId === UNKNOWN_ACCOUNT) return <Text>Former user</Text>;
  return <User accountId={accountId} />;
}

/**
 * "Last run" table cell: who ran it, with the date underneath. One column
 * instead of two keeps wide tables inside a narrow issue panel.
 */
export function LastRun({ run }) {
  if (!run) return <Text>—</Text>;
  return (
    <Stack space="space.050">
      <RunAuthor accountId={run.executedBy} />
      <Text size="small">{formatDate(run.executedAt)}</Text>
    </Stack>
  );
}

/** Row action buttons that wrap onto a new line instead of overflowing the table. */
export function RowActions({ children }) {
  return (
    <Inline space="space.050" shouldWrap>
      {children}
    </Inline>
  );
}

/** Link to a Jira issue by key (relative link, opens inside Jira). */
export function IssueLink({ issueKey }) {
  return <Link href={`/browse/${issueKey}`}>{issueKey}</Link>;
}

export function Loading({ label = 'Loading…' }) {
  return (
    <Inline space="space.100" alignBlock="center">
      <Spinner size="small" label={label} />
      <Text>{label}</Text>
    </Inline>
  );
}

export function ErrorBanner({ error, title = 'Something went wrong' }) {
  if (!error) return null;
  return (
    <SectionMessage appearance="error" title={title}>
      <Text>{typeof error === 'string' ? error : error.message}</Text>
    </SectionMessage>
  );
}

/** Notice for items the user is not allowed to see (counts only). */
export function HiddenNotice({ count }) {
  if (!count) return null;
  return (
    <SectionMessage appearance="information">
      <Text>
        {count} test{count === 1 ? ' is' : 's are'} hidden because you don't have permission to view{' '}
        {count === 1 ? 'it' : 'them'}.
      </Text>
    </SectionMessage>
  );
}

const cardStyle = xcss({ paddingBlock: 'space.100' });
export function Section({ children }) {
  return <Box xcss={cardStyle}>{children}</Box>;
}

/** Format an ISO date for tables (viewer's locale). */
export function formatDate(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}
