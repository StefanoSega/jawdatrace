import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit tests run outside Forge, so the Forge runtime packages are replaced by
// small in-memory mocks (see test/mocks).
export default defineConfig({
  resolve: {
    alias: {
      '@forge/api': fileURLToPath(new URL('./test/mocks/forge-api.js', import.meta.url)),
      '@forge/sql': fileURLToPath(new URL('./test/mocks/forge-sql.js', import.meta.url)),
      '@forge/events': fileURLToPath(new URL('./test/mocks/forge-events.js', import.meta.url)),
      '@forge/kvs': fileURLToPath(new URL('./test/mocks/forge-kvs.js', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.js'],
  },
});
