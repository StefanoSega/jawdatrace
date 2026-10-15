/**
 * Shows a run's evidence.
 *
 * Attachment references are checked against the Test's CURRENT attachment list
 * (loaded once per panel, as the viewer), so a deleted attachment, or one the
 * viewer can't access, is shown as unavailable instead of a broken link. This
 * is one Jira request for the whole history, not one per attachment.
 */
import React from 'react';
import { Inline, Link, Lozenge, Stack, Text } from '@forge/react';

/**
 * @param {{ items: object[], attachmentsById: Map<string, { content: string }> | null }} props
 *   attachmentsById null = attachment list could not be loaded
 */
export default function EvidenceList({ items, attachmentsById }) {
  if (!items || items.length === 0) return <Text>—</Text>;
  return (
    <Stack space="space.050">
      {items.map((item, index) => {
        if (item.type === 'url') {
          return (
            <Link key={`u-${index}`} href={item.url} openNewTab>
              {item.label || item.url}
            </Link>
          );
        }
        if (item.type === 'jira-attachment') {
          const current = attachmentsById?.get(String(item.attachmentId));
          return current ? (
            <Link key={`a-${index}`} href={current.content} openNewTab>
              {item.filename || 'Attachment'}
            </Link>
          ) : (
            <Inline key={`a-${index}`} space="space.050" alignBlock="center">
              <Text>{item.filename || 'Attachment'}</Text>
              <Lozenge>deleted or not accessible</Lozenge>
            </Inline>
          );
        }
        // Unknown evidence types (from a future version) are listed generically.
        return <Text key={`x-${index}`}>Unsupported evidence</Text>;
      })}
    </Stack>
  );
}
