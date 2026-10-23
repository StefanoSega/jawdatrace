import { runMigrations } from './db/migrations';

// Resolver functions used by every UI module (see manifest.yml `function: resolver`).
export { handler } from './resolvers';

// Queue consumer for the admin-started data import (see manifest.yml `consumer`).
export { handler as importWorker } from './importer/worker';

// Queue consumer for the admin-started data export.
export { handler as exportWorker } from './exporter/worker';

// Weekly personal data report (see manifest.yml `scheduledTrigger`).
export { handler as privacyReport } from './privacy/report';

/**
 * Lifecycle trigger (app installed / upgraded): create or update the SQL
 * schema up front so the first user doesn't pay for it. Resolvers also run
 * migrations lazily as a fallback, so a failure here is not fatal.
 */
export async function onLifecycle() {
  try {
    await runMigrations();
  } catch (error) {
    console.error(`[jawdatrace] migrations failed on lifecycle event: ${error?.name ?? 'Error'}`);
  }
}
