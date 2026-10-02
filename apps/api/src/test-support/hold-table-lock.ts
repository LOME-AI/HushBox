import { sql } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, createDb } from '@hushbox/db';
import type { PgTable } from 'drizzle-orm/pg-core';

/**
 * Takes `ACCESS EXCLUSIVE` on `table` from a second session and holds it for
 * `holdMs`. Resolves once the lock is held; `released` settles when it lets go.
 * The lock lands in the database `DATABASE_URL` names, which in a test is the
 * calling vitest worker's own clone: nothing outside the calling file reads it
 * while that file runs.
 */
export async function holdTableLock(
  table: PgTable,
  holdMs: number
): Promise<{ readonly released: Promise<void> }> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to hold a table lock');
  }
  const holder = createDb(databaseUrl, { neonDev: LOCAL_NEON_DEV_CONFIG });
  let markHeld!: () => void;
  const held = new Promise<void>((resolve) => {
    markHeld = resolve;
  });
  const released = (async (): Promise<void> => {
    try {
      await holder.transaction(async (tx) => {
        await tx.execute(sql`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
        markHeld();
        await new Promise((resolve) => setTimeout(resolve, holdMs));
      });
    } finally {
      await holder.$client.end();
    }
  })();
  await Promise.race([held, released]);
  return { released };
}
