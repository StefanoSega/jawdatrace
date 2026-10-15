/**
 * Test Run resolvers: record a run and read a Test's run history.
 *
 * Cost per call:
 *  - recordRun (ad-hoc):        2 Jira requests + 1 SQL insert
 *  - recordRun (in Execution):  3 Jira requests + 2 SQL statements
 *  - getRuns:                   1 Jira request + 1 SQL select (+1 bulk fetch when
 *                               the page contains runs from Test Executions)
 */
import { randomUUID } from 'node:crypto';
import { ISSUE_TYPES, LIMITS, RECORDABLE_STATUSES } from '../shared/constants';
import {
  ValidationError,
  bindAttachmentsToTest,
  normaliseEvidence,
  parseStoredEvidence,
  EVIDENCE_TYPES,
} from '../shared/evidence';
import { fromSqlDateTime, insertRun, isTestInExecution, selectRunsPage, toSqlDateTime } from '../db/queries';
import {
  ForbiddenError,
  assertIssueId,
  describeVisibleIssues,
  getEditableIssue,
  getVisibleIssue,
} from './permissions';

/**
 * Validate the non-Jira parts of a run submission.
 * Exported for unit tests.
 */
export function validateRunInput(payload) {
  const status = String(payload?.status ?? '');
  if (!RECORDABLE_STATUSES.includes(status)) throw new ValidationError('Invalid run status.');

  const comment = payload?.comment == null ? '' : String(payload.comment);
  if (comment.length > LIMITS.COMMENT_MAX) {
    throw new ValidationError(`Comments are limited to ${LIMITS.COMMENT_MAX} characters.`);
  }

  // The UI generates a random id per form submission so a double click or a
  // network retry doesn't create two runs.
  const clientRequestId = String(payload?.clientRequestId ?? '');
  if (!/^[A-Za-z0-9-]{8,64}$/.test(clientRequestId)) throw new ValidationError('Invalid request id.');

  const stepsRevision = payload?.stepsRevision == null ? null : Number(payload.stepsRevision);
  if (stepsRevision !== null && !Number.isInteger(stepsRevision)) {
    throw new ValidationError('Invalid steps revision.');
  }

  return {
    status,
    comment: comment.trim() || null,
    clientRequestId,
    stepsRevision,
    evidence: normaliseEvidence(payload?.evidence),
  };
}

/** Record one immutable Test Run. */
export async function recordRun(payload, accountId) {
  const testIssueId = assertIssueId(payload?.testIssueId, 'test id');
  const executionIssueId =
    payload?.executionIssueId == null ? null : assertIssueId(payload.executionIssueId, 'execution id');
  const input = validateRunInput(payload);

  // Authorization:
  //  - ad-hoc run: the user must be able to edit the Test
  //  - run inside an Execution: the user must be able to edit the Execution
  //    and see the Test, and the Test must belong to that Execution
  let testIssue;
  if (executionIssueId) {
    await getEditableIssue(executionIssueId, ISSUE_TYPES.TEST_EXECUTION);
    testIssue = await getVisibleIssue(testIssueId, ISSUE_TYPES.TEST, ['attachment']);
    if (!(await isTestInExecution(executionIssueId, testIssueId))) {
      throw new ForbiddenError('This Test is not part of the Test Execution.');
    }
  } else {
    testIssue = await getEditableIssue(testIssueId, ISSUE_TYPES.TEST, ['attachment']);
  }

  const evidence = bindAttachmentsToTest(input.evidence, testIssue.fields?.attachment ?? []);
  const executedAt = new Date();
  const { inserted } = await insertRun({
    id: randomUUID(),
    testIssueId,
    executionIssueId,
    status: input.status,
    comment: input.comment,
    evidence,
    stepsRevision: input.stepsRevision,
    executedBy: accountId,
    executedAt,
    clientRequestId: input.clientRequestId,
  });

  return {
    duplicate: !inserted,
    run: {
      status: input.status,
      executedAt: executedAt.toISOString(),
      executedBy: accountId,
    },
  };
}

/** Opaque pagination cursor (base64 JSON) so the UI never handles raw row data. */
export function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ t: fromSqlDateTime(row.executed_at), i: row.id })).toString('base64url');
}

export function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const { t, i } = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    const date = new Date(t);
    if (Number.isNaN(date.getTime()) || typeof i !== 'string' || !/^[0-9a-f-]{36}$/.test(i)) {
      throw new Error('bad cursor');
    }
    return { executedAt: toSqlDateTime(date), id: i };
  } catch {
    throw new ValidationError('Invalid page cursor.');
  }
}

/** One page of a Test's run history, newest first. */
export async function getRuns(payload) {
  const testIssueId = assertIssueId(payload?.testIssueId, 'test id');
  await getVisibleIssue(testIssueId, ISSUE_TYPES.TEST);

  const rows = await selectRunsPage(testIssueId, decodeCursor(payload?.cursor), LIMITS.RUNS_PAGE_SIZE);
  const hasMore = rows.length > LIMITS.RUNS_PAGE_SIZE;
  const pageRows = hasMore ? rows.slice(0, LIMITS.RUNS_PAGE_SIZE) : rows;

  // Resolve Execution keys in ONE request, and only show Executions the user can see.
  const executionIds = [...new Set(pageRows.map((row) => row.execution_issue_id).filter(Boolean))];
  const executions = new Map((await describeVisibleIssues(executionIds)).map((issue) => [issue.id, issue]));

  const runs = pageRows.map((row) => {
    const execution = row.execution_issue_id ? executions.get(row.execution_issue_id) : null;
    return {
      status: row.status,
      comment: row.comment,
      executedBy: row.executed_by,
      executedAt: fromSqlDateTime(row.executed_at),
      stepsRevision: row.steps_revision,
      // Hidden Executions are shown as "restricted" rather than leaking their key.
      execution: row.execution_issue_id
        ? execution
          ? { key: execution.key, summary: execution.summary, environment: row.environment }
          : { restricted: true }
        : null,
      evidence: parseStoredEvidence(row.evidence).items.filter((item) =>
        Object.values(EVIDENCE_TYPES).includes(item.type)
      ),
    };
  });

  return {
    runs,
    nextCursor: hasMore ? encodeCursor(pageRows[pageRows.length - 1]) : null,
  };
}
