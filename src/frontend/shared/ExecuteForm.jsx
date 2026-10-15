/**
 * Form to record a Test Run: steps checklist, result, comment and evidence.
 *
 * Used by the Test panel (ad-hoc run) and by Test Execution / Test Set panels
 * (inside a Modal). Loads the Test's steps and attachments in parallel (two
 * Jira requests) and saves with ONE resolver call.
 */
import React, { useEffect, useState } from 'react';
import {
  Box,
  Button,
  ButtonGroup,
  Checkbox,
  Heading,
  Inline,
  Label,
  List,
  ListItem,
  LoadingButton,
  RadioGroup,
  SectionMessage,
  Stack,
  Text,
  TextArea,
  Textfield,
} from '@forge/react';
import { LIMITS, RUN_STATUS } from '../../shared/constants';
import { isSafeUrl } from '../../shared/evidence';
import { callResolver, errorMessage, newRequestId } from './api';
import { ErrorBanner, Loading } from './components';
import { getAttachments, getSteps } from './jira';

const RESULT_OPTIONS = [
  { name: 'result', value: RUN_STATUS.PASS, label: 'Pass' },
  { name: 'result', value: RUN_STATUS.FAIL, label: 'Fail' },
  { name: 'result', value: RUN_STATUS.BLOCKED, label: 'Blocked' },
];

/**
 * @param {{
 *   test: { id: string, key?: string, summary?: string },
 *   executionIssueId?: string,
 *   onSaved?: (result: object) => void,
 *   onCancel?: () => void,
 * }} props
 */
export default function ExecuteForm({ test, executionIssueId, onSaved, onCancel }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [steps, setSteps] = useState({ revision: 0, steps: [] });
  const [attachments, setAttachments] = useState([]);

  const [status, setStatus] = useState(null);
  const [comment, setComment] = useState('');
  const [selectedAttachments, setSelectedAttachments] = useState([]);
  const [links, setLinks] = useState([]);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkLabel, setLinkLabel] = useState('');
  // UI Kit text inputs must be uncontrolled (defaultValue): a controlled
  // `value` drops keystrokes because each one round-trips through the bridge.
  // Bumping this key remounts the link inputs to clear them.
  const [linkFieldsKey, setLinkFieldsKey] = useState(0);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  // One id per form: a retried or double-clicked submit is stored only once.
  const [requestId] = useState(newRequestId);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getSteps(test.id), getAttachments(test.id)])
      .then(([loadedSteps, loadedAttachments]) => {
        if (cancelled) return;
        setSteps(loadedSteps);
        setAttachments(loadedAttachments);
      })
      .catch((error) => !cancelled && setLoadError(errorMessage(error)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [test.id]);

  const toggleAttachment = (id) =>
    setSelectedAttachments((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id]
    );

  const addLink = () => {
    const url = linkUrl.trim();
    if (!isSafeUrl(url)) {
      setSaveError('Links must start with http:// or https://');
      return;
    }
    setSaveError(null);
    setLinks((current) => [...current, { url, label: linkLabel.trim() }]);
    setLinkUrl('');
    setLinkLabel('');
    setLinkFieldsKey((value) => value + 1);
  };

  const save = async () => {
    if (!status) {
      setSaveError('Choose a result: Pass, Fail or Blocked.');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const result = await callResolver('recordRun', {
        testIssueId: test.id,
        executionIssueId: executionIssueId ?? null,
        status,
        comment,
        stepsRevision: steps.revision,
        clientRequestId: requestId,
        evidence: {
          items: [
            ...selectedAttachments.map((attachmentId) => ({ type: 'jira-attachment', attachmentId })),
            ...links.map((link) => ({ type: 'url', url: link.url, label: link.label })),
          ],
        },
      });
      onSaved?.(result);
    } catch (error) {
      setSaveError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Loading />;
  if (loadError) return <ErrorBanner error={loadError} />;

  return (
    <Stack space="space.200">
      {test.key && (
        <Heading size="small">
          {test.key} {test.summary}
        </Heading>
      )}

      <Stack space="space.100">
        <Text weight="bold">Steps</Text>
        {steps.steps.length === 0 ? (
          <Text>This Test has no steps yet.</Text>
        ) : (
          <List type="ordered">
            {steps.steps.map((step) => (
              <ListItem key={step.id}>
                <Text>{step.action}</Text>
                {step.data ? <Text>Data: {step.data}</Text> : null}
                {step.expected ? <Text>Expected: {step.expected}</Text> : null}
              </ListItem>
            ))}
          </List>
        )}
      </Stack>

      <Stack space="space.050">
        <Label labelFor="result">Result</Label>
        <RadioGroup
          name="result"
          options={RESULT_OPTIONS}
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        />
      </Stack>

      <Stack space="space.050">
        <Label labelFor="comment">Comment</Label>
        <TextArea
          id="comment"
          defaultValue={comment}
          maxLength={LIMITS.COMMENT_MAX}
          placeholder="What did you observe?"
          onChange={(event) => setComment(event.target.value)}
        />
      </Stack>

      <Stack space="space.100">
        <Text weight="bold">Evidence (optional)</Text>
        {attachments.length === 0 ? (
          <Text>No attachments on this Test. Attach screenshots to the Test issue to select them here.</Text>
        ) : (
          attachments.map((attachment) => (
            <Checkbox
              key={attachment.id}
              label={attachment.filename}
              isChecked={selectedAttachments.includes(attachment.id)}
              onChange={() => toggleAttachment(attachment.id)}
            />
          ))
        )}
        {links.map((link, index) => (
          <Inline key={`${link.url}-${index}`} space="space.100" alignBlock="center">
            <Text>{link.label || link.url}</Text>
            <Button
              appearance="subtle"
              onClick={() => setLinks((current) => current.filter((_, i) => i !== index))}
            >
              Remove
            </Button>
          </Inline>
        ))}
        <Inline space="space.100" alignBlock="end">
          <Box>
            <Label labelFor="link-url">Link URL</Label>
            <Textfield key={`url-${linkFieldsKey}`} id="link-url" defaultValue="" onChange={(event) => setLinkUrl(event.target.value)} />
          </Box>
          <Box>
            <Label labelFor="link-label">Label</Label>
            <Textfield key={`label-${linkFieldsKey}`} id="link-label" defaultValue="" onChange={(event) => setLinkLabel(event.target.value)} />
          </Box>
          <Button onClick={addLink} isDisabled={!linkUrl.trim()}>
            Add link
          </Button>
        </Inline>
      </Stack>

      {saveError && (
        <SectionMessage appearance="error">
          <Text>{saveError}</Text>
        </SectionMessage>
      )}

      <ButtonGroup>
        <LoadingButton appearance="primary" isLoading={saving} onClick={save}>
          Save result
        </LoadingButton>
        {onCancel && (
          <Button appearance="subtle" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </ButtonGroup>
    </Stack>
  );
}
