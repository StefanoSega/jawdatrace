/**
 * Evidence model for Test Runs.
 *
 * Evidence is stored as a small, versioned JSON document of typed items.
 * We only ever store REFERENCES (Jira attachment ids, URLs) and never copy
 * binary content into Forge storage. New evidence providers (e.g. direct
 * uploads later) can be added as new `type` values without a migration.
 *
 * {
 *   v: 1,
 *   items: [
 *     { type: 'jira-attachment', attachmentId, filename, mimeType, size },
 *     { type: 'url', url, label }
 *   ]
 * }
 */
import { LIMITS } from './constants';

export const EVIDENCE_VERSION = 1;
export const EVIDENCE_TYPES = Object.freeze({
  JIRA_ATTACHMENT: 'jira-attachment',
  URL: 'url',
});

/** Error thrown for invalid user input; resolvers map it to a 400-style response. */
export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.code = 'VALIDATION';
  }
}

/** True for absolute http(s) URLs only (rejects javascript:, data:, relative…). */
export function isSafeUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > LIMITS.URL_MAX) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Validate and normalise evidence submitted by the UI.
 *
 * Attachment ownership (that the attachment really belongs to the Test) is NOT
 * checked here because it needs a Jira call; the resolver does that using the
 * Test's attachment list. This function only checks shape and limits.
 *
 * @param {unknown} input
 * @returns {{ v: number, items: object[] }}
 */
export function normaliseEvidence(input) {
  if (input === undefined || input === null) return { v: EVIDENCE_VERSION, items: [] };
  const items = Array.isArray(input) ? input : input.items;
  if (!Array.isArray(items)) throw new ValidationError('Evidence must be a list.');
  if (items.length > LIMITS.EVIDENCE_ITEMS_MAX) {
    throw new ValidationError(`At most ${LIMITS.EVIDENCE_ITEMS_MAX} evidence items are allowed.`);
  }

  const seen = new Set();
  const normalised = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') throw new ValidationError('Invalid evidence item.');

    if (item.type === EVIDENCE_TYPES.JIRA_ATTACHMENT) {
      const attachmentId = String(item.attachmentId ?? '');
      if (!/^\d+$/.test(attachmentId)) throw new ValidationError('Invalid attachment id.');
      const key = `a:${attachmentId}`;
      if (seen.has(key)) continue; // silently drop duplicates
      seen.add(key);
      // Only the id matters for security; the rest is filled from Jira by the resolver.
      normalised.push({ type: EVIDENCE_TYPES.JIRA_ATTACHMENT, attachmentId });
    } else if (item.type === EVIDENCE_TYPES.URL) {
      const url = typeof item.url === 'string' ? item.url.trim() : '';
      if (!isSafeUrl(url)) throw new ValidationError('Evidence links must be http(s) URLs.');
      const label = typeof item.label === 'string' ? item.label.trim().slice(0, LIMITS.LABEL_MAX) : '';
      const key = `u:${url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      normalised.push({ type: EVIDENCE_TYPES.URL, url, label });
    } else {
      throw new ValidationError('Unsupported evidence type.');
    }
  }
  return { v: EVIDENCE_VERSION, items: normalised };
}

/**
 * Fill attachment metadata from the Test's real attachment list and reject any
 * attachment that does not belong to the Test.
 *
 * @param {{ v: number, items: object[] }} evidence - output of normaliseEvidence
 * @param {Array<{id: string, filename: string, mimeType: string, size: number}>} testAttachments
 */
export function bindAttachmentsToTest(evidence, testAttachments) {
  const byId = new Map((testAttachments ?? []).map((a) => [String(a.id), a]));
  return {
    v: evidence.v,
    items: evidence.items.map((item) => {
      if (item.type !== EVIDENCE_TYPES.JIRA_ATTACHMENT) return item;
      const attachment = byId.get(item.attachmentId);
      if (!attachment) {
        throw new ValidationError('An evidence attachment does not belong to this Test.');
      }
      return {
        type: EVIDENCE_TYPES.JIRA_ATTACHMENT,
        attachmentId: item.attachmentId,
        filename: String(attachment.filename ?? '').slice(0, 255),
        mimeType: String(attachment.mimeType ?? '').slice(0, 100),
        size: Number(attachment.size) || 0,
      };
    }),
  };
}

/** Parse evidence JSON read back from SQL; tolerate bad/legacy rows. */
export function parseStoredEvidence(raw) {
  if (!raw) return { v: EVIDENCE_VERSION, items: [] };
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return { v: parsed.v ?? EVIDENCE_VERSION, items: Array.isArray(parsed.items) ? parsed.items : [] };
  } catch {
    return { v: EVIDENCE_VERSION, items: [] };
  }
}
