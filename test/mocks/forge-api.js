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

// External fetch (e.g. Xray): `setFetchHandler((url, init) => ({ status, body }))`.
export const fetchCalls = [];
let fetchHandler = () => ({ status: 404, body: null });

export function setFetchHandler(fn) {
  fetchHandler = fn;
}

export function resetFetch() {
  fetchCalls.length = 0;
  fetchHandler = () => ({ status: 404, body: null });
}

export async function fetch(url, init = {}) {
  const body = init.body ? JSON.parse(init.body) : undefined;
  fetchCalls.push({ url, method: init.method ?? 'GET', body });
  const result = (await fetchHandler(url, { ...init, body })) ?? { status: 404 };
  const status = result.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (result.body === undefined ? '' : JSON.stringify(result.body)),
  };
}

const api = { asUser: () => client('user'), asApp: () => client('app') };
export default api;
