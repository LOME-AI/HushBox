import { describe, it, expect, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';

import { createDb, LOCAL_NEON_DEV_CONFIG } from './client';
import { waitForNoConnections, withRehearsalDatabase } from './migration-rehearsal';

import type { Database } from './client';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for integration tests');
}

// `pg_database` and `pg_stat_activity` are cluster-wide, so the suite's own
// database is a valid vantage point for observing another one.
const observer = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

afterAll(async () => {
  await observer.$client.end();
});

async function databaseExists(name: string): Promise<boolean> {
  const result = await observer.execute(sql`select 1 from pg_database where datname = ${name}`);
  return result.rows.length > 0;
}

async function currentDatabaseName(db: Database): Promise<string> {
  const result = await db.execute(sql`select current_database() as name`);
  return String(result.rows[0]?.['name']);
}

describe('rehearsal database', () => {
  it('drops the database it minted', async () => {
    let name = '';

    await withRehearsalDatabase(DATABASE_URL, async (db) => {
      name = await currentDatabaseName(db);
    });

    expect(name).toMatch(/^hb_rehearsal_/);
    // The drop carries no FORCE, so it can only have succeeded on a database
    // nothing was still attached to.
    expect(await databaseExists(name)).toBe(false);
  });

  it('refuses to call a database drained while a connection is attached', async () => {
    await withRehearsalDatabase(DATABASE_URL, async (db) => {
      const name = await currentDatabaseName(db);

      await expect(waitForNoConnections(observer, name, 50)).rejects.toThrow('did not drain');
    });
  });
});
