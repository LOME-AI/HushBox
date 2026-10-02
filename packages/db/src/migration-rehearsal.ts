import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';

import { createDb, LOCAL_NEON_DEV_CONFIG } from './client';
import { isLocalHostUrl } from './local-host-url';
import { TEST_DATABASE_PREFIX, withDatabaseName } from './test-db';

import type { Database } from './client';

/**
 * Rehearses the migration chain against a throwaway database, so a migration
 * that must refuse to run can be proven to refuse. It exists because the deploy
 * job applies this chain to production before shipping the Worker, and a
 * migration whose abort condition is never exercised is an untested one.
 *
 * Dev and test only: it mints databases on the local cluster and reaches it
 * through the local neon-proxy.
 */

/**
 * Outside {@link TEST_DATABASE_PREFIX}, so the reclamation that enumerates
 * everything under that prefix never sees a rehearsal database and can never
 * take one still running. A rehearsal records no run claim, so one sitting
 * under that prefix would be read as owned by nothing. The two are independent
 * literals, so a test is what holds them apart.
 */
export const REHEARSAL_DATABASE_PREFIX = 'hb_rehearsal_';

/** `CREATE DATABASE` cannot run from the database being created. */
const MAINTENANCE_DATABASE = 'postgres';

const REMOTE_REFUSAL_MESSAGE =
  'Refusing to rehearse migrations: the connection string does not point at a local database. ' +
  'The rehearsal creates and drops databases on whatever cluster it is given.';

/** Poll interval while waiting for an ended pool's backends to disappear. */
const DRAIN_POLL_MS = 20;

/**
 * Ceiling on that wait. Only the rehearsal's own pool is ever attached, so
 * reaching this means something else opened the database.
 */
const DRAIN_TIMEOUT_MS = 10_000;

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url));

export interface ChainMigration {
  readonly tag: string;
  readonly statements: readonly string[];
}

interface MigrationJournal {
  readonly entries: readonly { readonly tag: string }[];
}

/**
 * Pairs journal tags with parsed SQL by position — `readMigrationFiles` builds
 * its array by walking the same journal, so index `i` is the same migration on
 * both sides. The throw is what keeps a tag from being attached to another
 * migration's statements should that ever stop holding.
 */
export function pairJournalWithSql(
  tags: readonly string[],
  parsed: readonly { readonly sql: string[] }[]
): ChainMigration[] {
  return tags.map((tag, index) => {
    const file = parsed[index];
    if (file === undefined) {
      throw new Error(`migration rehearsal: no SQL parsed for "${tag}"`);
    }
    return { tag, statements: file.sql };
  });
}

/**
 * The chain in journal order. The SQL comes from `readMigrationFiles`, the same
 * parser the deploy runner uses, so the rehearsal executes exactly the
 * statements production would; the journal supplies the tags that parser drops.
 */
export function readMigrationChain(): ChainMigration[] {
  const journal = JSON.parse(
    readFileSync(`${MIGRATIONS_FOLDER}/meta/_journal.json`, 'utf8')
  ) as MigrationJournal;
  return pairJournalWithSql(
    journal.entries.map((entry) => entry.tag),
    readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER })
  );
}

interface ChainSplit {
  readonly before: ChainMigration[];
  readonly from: ChainMigration[];
}

/** Splits the chain into what precedes a migration and what it leads. */
export function splitChainAt(chain: readonly ChainMigration[], tag: string): ChainSplit {
  const index = chain.findIndex((migration) => migration.tag === tag);
  if (index === -1) {
    throw new Error(`migration rehearsal: no migration tagged "${tag}"`);
  }
  return { before: chain.slice(0, index), from: chain.slice(index) };
}

/**
 * Applies migrations the way the deploy runner does — the whole pending set in
 * one transaction — which is what makes an abort anywhere in the set leave the
 * database exactly as it was.
 */
export async function applyMigrations(
  db: Database,
  migrations: readonly ChainMigration[]
): Promise<void> {
  await db.transaction(async (tx) => {
    for (const migration of migrations) {
      for (const statement of migration.statements) {
        await tx.execute(sql.raw(statement));
      }
    }
  });
}

/**
 * Resolves once no backend is attached to `databaseName`.
 *
 * Draining first lets the drop run without `DROP DATABASE … WITH (FORCE)`, so a
 * database something else is holding open fails the drop loudly instead of
 * having its connection killed from under it.
 */
export async function waitForNoConnections(
  observer: Database,
  databaseName: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const attached = await observer.execute(
      sql`select 1 from pg_stat_activity where datname = ${databaseName}`
    );
    if (attached.rows.length === 0) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `migration rehearsal: connections to "${databaseName}" did not drain within ${String(timeoutMs)} ms`
      );
    }
    await delay(DRAIN_POLL_MS);
  }
}

/**
 * Runs `use` against a freshly created, empty database on the same cluster as
 * `connectionString`, and drops it afterwards.
 */
export async function withRehearsalDatabase<T>(
  connectionString: string,
  use: (db: Database) => Promise<T>
): Promise<T> {
  if (!isLocalHostUrl(connectionString)) {
    throw new Error(REMOTE_REFUSAL_MESSAGE);
  }
  const name = `${REHEARSAL_DATABASE_PREFIX}${randomBytes(6).toString('hex')}`;
  const maintenance = createDb(withDatabaseName(connectionString, MAINTENANCE_DATABASE), {
    neonDev: LOCAL_NEON_DEV_CONFIG,
  });
  try {
    await maintenance.execute(sql.raw(`CREATE DATABASE "${name}"`));
    const db = createDb(withDatabaseName(connectionString, name), {
      neonDev: LOCAL_NEON_DEV_CONFIG,
    });
    try {
      return await use(db);
    } finally {
      await db.$client.end();
      await waitForNoConnections(maintenance, name, DRAIN_TIMEOUT_MS);
      await maintenance.execute(sql.raw(`DROP DATABASE IF EXISTS "${name}"`));
    }
  } finally {
    await maintenance.$client.end();
  }
}
