/**
 * Small client for our own resolvers.
 *
 * Every resolver returns `{ ok, data }` or `{ ok: false, error: { code, message } }`.
 * `callResolver` unwraps that so UI code can use plain try/catch.
 */
import { invoke } from '@forge/bridge';

export class AppError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export async function callResolver(name, payload = {}) {
  const response = await invoke(name, payload);
  if (!response?.ok) {
    throw new AppError(response?.error?.code ?? 'INTERNAL', response?.error?.message ?? 'Something went wrong.');
  }
  return response.data;
}

/**
 * Random id for idempotent submissions (one per form submit, reused on retry).
 * Uses crypto.randomUUID when the sandbox provides it.
 */
export function newRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Turn any error into a user-facing message. */
export function errorMessage(error) {
  return error?.message || 'Something went wrong.';
}
