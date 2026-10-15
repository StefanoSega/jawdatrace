import { describe, expect, it } from 'vitest';
import {
  ValidationError,
  bindAttachmentsToTest,
  isSafeUrl,
  normaliseEvidence,
  parseStoredEvidence,
} from '../src/shared/evidence';

describe('isSafeUrl', () => {
  it('accepts http and https only', () => {
    expect(isSafeUrl('https://example.com/video')).toBe(true);
    expect(isSafeUrl('http://example.com')).toBe(true);
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeUrl('data:text/html,hi')).toBe(false);
    expect(isSafeUrl('/relative/path')).toBe(false);
    expect(isSafeUrl('')).toBe(false);
  });
});

describe('normaliseEvidence', () => {
  it('returns an empty, versioned document when there is no evidence', () => {
    expect(normaliseEvidence(undefined)).toEqual({ v: 1, items: [] });
  });

  it('keeps only the attachment id (metadata comes from Jira later) and drops duplicates', () => {
    const result = normaliseEvidence({
      items: [
        { type: 'jira-attachment', attachmentId: '10001', filename: 'spoofed.png' },
        { type: 'jira-attachment', attachmentId: 10001 },
        { type: 'url', url: ' https://example.com/a ', label: ' Video ' },
      ],
    });
    expect(result.items).toEqual([
      { type: 'jira-attachment', attachmentId: '10001' },
      { type: 'url', url: 'https://example.com/a', label: 'Video' },
    ]);
  });

  it('rejects unsafe URLs, unknown types and bad attachment ids', () => {
    expect(() => normaliseEvidence({ items: [{ type: 'url', url: 'javascript:x' }] })).toThrow(ValidationError);
    expect(() => normaliseEvidence({ items: [{ type: 'upload', id: 1 }] })).toThrow(ValidationError);
    expect(() => normaliseEvidence({ items: [{ type: 'jira-attachment', attachmentId: '1 OR 1=1' }] })).toThrow(
      ValidationError
    );
  });

  it('limits the number of items', () => {
    const items = Array.from({ length: 21 }, (_, i) => ({ type: 'url', url: `https://e.com/${i}` }));
    expect(() => normaliseEvidence({ items })).toThrow(/At most 20/);
  });
});

describe('bindAttachmentsToTest', () => {
  const attachments = [{ id: '10001', filename: 'pay.png', mimeType: 'image/png', size: 123 }];

  it("fills metadata from the Test's real attachments", () => {
    const bound = bindAttachmentsToTest(
      { v: 1, items: [{ type: 'jira-attachment', attachmentId: '10001' }] },
      attachments
    );
    expect(bound.items[0]).toEqual({
      type: 'jira-attachment',
      attachmentId: '10001',
      filename: 'pay.png',
      mimeType: 'image/png',
      size: 123,
    });
  });

  it('rejects an attachment that belongs to another issue', () => {
    expect(() =>
      bindAttachmentsToTest({ v: 1, items: [{ type: 'jira-attachment', attachmentId: '99999' }] }, attachments)
    ).toThrow(/does not belong/);
  });
});

describe('parseStoredEvidence', () => {
  it('tolerates empty and corrupt values', () => {
    expect(parseStoredEvidence(null)).toEqual({ v: 1, items: [] });
    expect(parseStoredEvidence('{not json')).toEqual({ v: 1, items: [] });
    expect(parseStoredEvidence('{"v":1,"items":[{"type":"url","url":"https://a.b"}]}').items).toHaveLength(1);
  });
});
