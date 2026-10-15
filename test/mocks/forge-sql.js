/**
 * Minimal mock of @forge/sql: records every statement and returns rows from a
 * handler installed by the test with `setSqlHandler((query, params) => rows)`.
 */
export const sqlCalls = [];
let handler = () => [];

export function setSqlHandler(fn) {
  handler = fn;
}

export function resetSql() {
  sqlCalls.length = 0;
  handler = () => [];
}

const sql = {
  prepare(query) {
    let params = [];
    return {
      bindParams(...args) {
        params = args;
        return this;
      },
      async execute() {
        sqlCalls.push({ query: query.replace(/\s+/g, ' ').trim(), params });
        return { rows: await handler(query, params) };
      },
    };
  },
};

export const migrationRunner = {
  enqueue() {
    return migrationRunner;
  },
  async run() {
    return [];
  },
};

export default sql;
