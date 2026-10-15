/**
 * Minimal in-memory mock of @forge/api for unit tests.
 *
 * Tests install a handler with `setJiraHandler((as, path, init) => ({ status, body }))`
 * and can inspect every call in `jiraCalls`.
 */
export const jiraCalls = [];
let handler = () => ({ status: 404, body: null });

export function setJiraHandler(fn) {
  handler = fn;
}

export function resetJira() {
  jiraCalls.length = 0;
  handler = () => ({ status: 404, body: null });
}

function client(as) {
  return {
    requestJira: async (path, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      jiraCalls.push({ as, path, method: init.method ?? 'GET', body });
      const result = (await handler(as, path, { ...init, body })) ?? { status: 404 };
      const status = result.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => null },
        text: async () => (result.body === undefined ? '' : JSON.stringify(result.body)),
      };
    },
  };
}

// `route` is a tagged template; the real one escapes params, ours just joins.
export function route(strings, ...values) {
  return strings.reduce((out, part, index) => out + part + (index < values.length ? String(values[index]) : ''), '');
}

const api = { asUser: () => client('user'), asApp: () => client('app') };
export default api;
