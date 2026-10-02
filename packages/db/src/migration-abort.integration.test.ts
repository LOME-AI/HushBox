import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';

import {
  applyMigrations,
  readMigrationChain,
  splitChainAt,
  withRehearsalDatabase,
} from './migration-rehearsal';

import type { ChainMigration } from './migration-rehearsal';
import type { Database } from './client';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for integration tests');
}

const DROP_LEGACY_TABLES = '0037_drop-legacy-tables';

/** Created by the migration that follows the drop, so its absence proves the drop never ran. */
const POST_DROP_TABLE = 'jobs';

function dropMigration(): ChainMigration {
  const [migration] = splitChainAt(readMigrationChain(), DROP_LEGACY_TABLES).from;
  if (migration === undefined) {
    throw new Error(`no migration tagged "${DROP_LEGACY_TABLES}"`);
  }
  return migration;
}

function droppedTableNames(migration: ChainMigration): string[] {
  return migration.statements.flatMap((statement) =>
    [...statement.matchAll(/DROP TABLE "([^"]+)"/g)].map(([, name]) => name ?? '')
  );
}

function guardedTableNames(migration: ChainMigration): string[] {
  const preamble = migration.statements[0] ?? '';
  const list = /IN ARRAY ARRAY\[([\s\S]*?)]/.exec(preamble)?.[1] ?? '';
  return [...list.matchAll(/'([^']+)'/g)].map(([, name]) => name ?? '');
}

function alphabetical(names: readonly string[]): string[] {
  return names.toSorted((left, right) => left.localeCompare(right));
}

async function publicTableNames(db: Database): Promise<string[]> {
  const result = await db.execute(
    sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`
  );
  return result.rows.map((row) => String(row['table_name']));
}

async function abortReason(attempt: Promise<unknown>): Promise<string> {
  try {
    await attempt;
  } catch (error: unknown) {
    const messages: string[] = [];
    for (let current = error; current instanceof Error; current = current.cause) {
      messages.push(current.message);
    }
    return messages.join('\n');
  }
  throw new Error('expected the migration chain to abort');
}

async function seedLegacyUser(db: Database): Promise<void> {
  await db.execute(sql`
    insert into users (username, opaque_registration, public_key, password_wrapped_private_key, recovery_wrapped_private_key)
    values ('rehearsal', decode('00', 'hex'), decode('00', 'hex'), decode('00', 'hex'), decode('00', 'hex'))
  `);
}

describe('legacy-table drop migration', () => {
  it('guards every table it drops', () => {
    const migration = dropMigration();
    const dropped = droppedTableNames(migration);

    expect(dropped).toHaveLength(22);
    expect(alphabetical(guardedTableNames(migration))).toEqual(alphabetical(dropped));
  });

  it('aborts the chain and changes nothing when a legacy table holds rows', async () => {
    await withRehearsalDatabase(DATABASE_URL, async (db) => {
      const { before, from } = splitChainAt(readMigrationChain(), DROP_LEGACY_TABLES);
      await applyMigrations(db, before);
      await seedLegacyUser(db);

      // Matched against the whole cause chain and quoting the interpolated table
      // name, so it cannot pass on the guard's own SQL text appearing in a
      // "failed query" wrapper.
      expect(await abortReason(applyMigrations(db, from))).toContain(
        'legacy tables still hold rows: users'
      );

      const survivors = await db.execute(sql`select count(*)::int as n from users`);
      expect(survivors.rows[0]?.['n']).toBe(1);
      const tables = await publicTableNames(db);
      expect(tables).toEqual(expect.arrayContaining(droppedTableNames(dropMigration())));
      expect(tables).not.toContain(POST_DROP_TABLE);
    });
  }, 60_000);
});
