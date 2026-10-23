import { describe, expect, it, vi } from 'vitest';
import { toErrorResponse, wrap } from '../src/resolvers/index';
import { ForbiddenError } from '../src/resolvers/permissions';
import { ValidationError } from '../src/shared/evidence';

describe('toErrorResponse', () => {
  it('shows our own validation/permission messages', () => {
    expect(toErrorResponse(new ValidationError('Bad input.'))).toEqual({
      ok: false,
      error: { code: 'VALIDATION', message: 'Bad input.' },
    });
    expect(toErrorResponse(new ForbiddenError()).error.code).toBe('FORBIDDEN');
  });

  it('hides unexpected error details', () => {
    const response = toErrorResponse(new Error('SQL syntax near secret_table'));
    expect(response.error.message).not.toContain('secret_table');
    expect(response.error.code).toBe('INTERNAL');
  });
});

describe('wrap', () => {
  it('passes payload and accountId, and wraps results', async () => {
    const fn = vi.fn(async (payload, accountId) => ({ payload, accountId }));
    const handler = wrap('test', fn, { needsSql: false });
    const response = await handler({ payload: { a: 1 }, context: { accountId: 'acc-1' } });
    expect(response).toEqual({ ok: true, data: { payload: { a: 1 }, accountId: 'acc-1' } });
  });

  it('refuses every call while the license is inactive, and allows active or missing licenses', async () => {
    const fn = vi.fn(async () => 'ran');
    const handler = wrap('test', fn, { needsSql: false });

    const refused = await handler({ payload: {}, context: { license: { active: false } } });
    expect(refused).toEqual({ ok: false, error: { code: 'LICENSE_INACTIVE', message: expect.stringContaining('not active') } });
    expect(fn).not.toHaveBeenCalled();

    expect((await handler({ payload: {}, context: { license: { active: true, isEvaluation: true } } })).ok).toBe(true);
    // No license object: development/staging, or a direct install.
    expect((await handler({ payload: {}, context: {} })).ok).toBe(true);
  });

  it('logs only a short line for unexpected errors', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = wrap('boom', async () => {
      throw new Error('payload with personal data');
    }, { needsSql: false });
    const response = await handler({ payload: {}, context: {} });
    expect(response.ok).toBe(false);
    expect(spy.mock.calls[0][0]).not.toContain('personal data');
    spy.mockRestore();
  });
});
