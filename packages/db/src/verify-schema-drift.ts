import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createEnvUtilities } from '@hushbox/shared';

import { resolveMigrationConnectionString } from '../drizzle.config';
import { LOCAL_NEON_DEV_CONFIG, createDb } from './client';
import { assertNoSchemaDrift, assertSameDatabase } from './schema-drift';

/**
 * The migration step's second half: having applied the chain, prove the
 * database now holds what the chain says it holds. A database recording its
 * migrations as applied is not evidence its objects are there — a schema
 * changed outside the chain reports itself as current, and the first thing to
 * notice is some later migration failing on an object that is not where it
 * should be.
 *
 * It reads through `DATABASE_URL` rather than the connection the migration
 * itself used, because this package's client speaks the WebSocket protocol the
 * local proxy serves and the direct migration URL does not; the two are
 * generated from one database name, and {@link assertSameDatabase} refuses the
 * pair if that ever stops holding.
 */
/* v8 ignore start -- CLI wiring: environment resolution and a live connection. The comparison it drives is covered by the unit tests, and by the integration test that drops a recorded view from a database built for it, reads the refusal, and restores it. */
async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error(
      'schema drift: DATABASE_URL is required to read the schema the migration step just applied'
    );
  }
  assertSameDatabase(databaseUrl, resolveMigrationConnectionString(process.env));
  const { isDev } = createEnvUtilities(process.env);
  const db = isDev
    ? createDb(databaseUrl, { neonDev: LOCAL_NEON_DEV_CONFIG })
    : createDb(databaseUrl);
  try {
    await assertNoSchemaDrift(db);
  } finally {
    await db.$client.end();
  }
}

const invoked = process.argv[1];
if (invoked !== undefined && path.resolve(invoked) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
/* v8 ignore stop */
