import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';

import { applyMigrations, readMigrationChain, withRehearsalDatabase } from './migration-rehearsal';
import { assertNoSchemaDrift, checkSchemaDrift, readLatestSnapshot } from './schema-drift';

import type { Database } from './client';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for integration tests');
}

/**
 * One database, built from the whole migration chain and torn down at the end:
 * every case here mutates it and puts it back, so the chain is applied once
 * rather than per case. It is minted for this file alone — the shared local
 * databases are never the subject.
 */
let db: Database;
let finish: () => void;
let rehearsal: Promise<void>;

beforeAll(async () => {
  const ready = Promise.withResolvers<Database>();
  const done = Promise.withResolvers<boolean>();
  finish = (): void => {
    done.resolve(true);
  };
  rehearsal = withRehearsalDatabase(DATABASE_URL, async (rehearsalDb) => {
    ready.resolve(rehearsalDb);
    await done.promise;
  });
  db = await ready.promise;
  await applyMigrations(db, readMigrationChain());
}, 120_000);

afterAll(async () => {
  finish();
  await rehearsal;
});

/** A view the chain creates, chosen from the snapshot rather than named here. */
function someRecordedView(): string {
  const [view] = Object.values(readLatestSnapshot().snapshot.views);
  if (view === undefined) throw new Error('the migration snapshot records no view');
  return view.name;
}

async function definitionOf(view: string): Promise<string> {
  const qualified = `public.${view}`;
  const result = await db.execute(
    sql`select pg_get_viewdef(${qualified}::regclass, true) as definition`
  );
  return String(result.rows[0]?.['definition']);
}

describe('schema drift against a database built from the migration chain', () => {
  it('finds nothing to report', async () => {
    expect(await checkSchemaDrift(db)).toEqual([]);
  });

  it('names a view the chain creates once the database no longer has it', async () => {
    const view = someRecordedView();
    const definition = await definitionOf(view);
    await db.execute(sql.raw(`DROP VIEW "${view}"`));

    try {
      expect(await checkSchemaDrift(db)).toEqual([
        { kind: 'view', direction: 'absent', name: view },
      ]);
      await expect(assertNoSchemaDrift(db)).rejects.toThrow(
        `view ${view}: the migrations record it; the database does not have it`
      );
    } finally {
      await db.execute(sql.raw(`CREATE VIEW "${view}" AS ${definition}`));
    }

    await expect(assertNoSchemaDrift(db)).resolves.toBeUndefined();
  });

  it('names a view the database holds that the chain never creates', async () => {
    await db.execute(sql.raw(`CREATE VIEW "leftover_totals" AS SELECT 1 AS one`));

    try {
      expect(await checkSchemaDrift(db)).toEqual([
        { kind: 'view', direction: 'unexpected', name: 'leftover_totals' },
      ]);
    } finally {
      await db.execute(sql.raw(`DROP VIEW "leftover_totals"`));
    }
  });
});
