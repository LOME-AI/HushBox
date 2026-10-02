/**
 * The dump is proved against the running local stack rather than against a
 * stubbed client: what is being asserted is that the counts recorded under the
 * exported snapshot are the database's real counts, which only a real server
 * can answer.
 *
 * Two URLs name one database here. The driver holding the snapshot open reaches
 * Postgres through the stack's WebSocket proxy; `pg_dump` reaches the same
 * cluster directly over TCP. The dumped database is the per-worker one vitest
 * provisioned, so the direct URL takes its database name from the driver's.
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sql } from 'drizzle-orm';
import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LOCAL_NEON_DEV_CONFIG, createDb, type Database } from '@hushbox/db';

import {
  DUMP_MANIFEST_FILE,
  DumpManifestSchema,
  POSTGRES_IMAGE,
  containerConnection,
  containerUser,
  dumpDatabase,
  migrationHeadQuery,
} from './postgres.js';
import type { DumpManifest } from './postgres.js';

function requiredUrl(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`backup/postgres integration: ${name} is required`);
  }
  return value;
}

const DRIVER_URL = requiredUrl('DATABASE_URL');
const DIRECT_URL = requiredUrl('MIGRATION_DATABASE_URL');

function directUrlForDriverDatabase(): string {
  const direct = new URL(DIRECT_URL);
  direct.pathname = new URL(DRIVER_URL).pathname;
  return direct.toString();
}

/** Long enough for a cold `docker run` plus a full dump of the seeded database. */
const DUMP_TIMEOUT_MS = 180_000;

async function directoryExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

describe('dumpDatabase against the local stack', () => {
  let db: Database;
  let outDir: string;

  async function readManifest(): Promise<DumpManifest> {
    return DumpManifestSchema.parse(
      JSON.parse(await readFile(path.join(outDir, DUMP_MANIFEST_FILE), 'utf8'))
    );
  }

  /**
   * The census the manifest is checked against, read from the database rather
   * than from the manifest: a key set derived from the value under test would
   * make an empty or narrowed census compare equal to itself.
   */
  async function publicTables(): Promise<string[]> {
    const listed = await db.execute(
      sql`select tablename from pg_tables where schemaname = 'public' order by tablename`
    );
    return listed.rows.map((row) => String(row['tablename']));
  }

  beforeAll(async () => {
    db = createDb(DRIVER_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
    outDir = path.join(await mkdtemp(path.join(os.tmpdir(), 'hb-backup-pg-')), 'dump');
    await dumpDatabase({
      databaseUrl: directUrlForDriverDatabase(),
      snapshotUrl: DRIVER_URL,
      outDir,
      image: POSTGRES_IMAGE,
    });
  }, DUMP_TIMEOUT_MS);

  afterAll(async () => {
    await db.$client.end();
    await rm(path.dirname(outDir), { recursive: true, force: true });
  });

  it(
    'counts every table the public schema holds',
    async () => {
      const manifest = await readManifest();
      const tables = await publicTables();

      const byName = (a: string, b: string): number => a.localeCompare(b);
      expect(tables.length).toBeGreaterThan(0);
      expect(Object.keys(manifest.tables).toSorted(byName)).toEqual(tables.toSorted(byName));
    },
    DUMP_TIMEOUT_MS
  );

  it(
    'records a row count equal to the count the database reports for every table',
    async () => {
      const manifest = await readManifest();

      const directly: Record<string, number> = {};
      for (const table of await publicTables()) {
        const counted = await db.execute(
          sql`select count(*) as row_count from public.${sql.identifier(table)}`
        );
        directly[table] = Number(counted.rows[0]?.['row_count']);
      }

      expect(manifest.tables).toEqual(directly);
    },
    DUMP_TIMEOUT_MS
  );

  it(
    'records the migration head the journal holds',
    async () => {
      const manifest = await readManifest();
      const head = await db.execute(sql.raw(migrationHeadQuery()));

      expect(manifest.migrationHead).toBe(head.rows[0]?.['hash']);
    },
    DUMP_TIMEOUT_MS
  );

  it(
    'writes a dump the same image can read back',
    async () => {
      const user = containerUser(process);
      const listed = await execa(
        'docker',
        [
          'run',
          '--rm',
          ...(user === undefined ? [] : ['--user', user]),
          '-v',
          `${outDir}:/dump`,
          POSTGRES_IMAGE,
          'pg_restore',
          '--list',
          '/dump',
        ],
        { reject: false }
      );

      expect(listed.exitCode).toBe(0);
      expect(listed.stdout).toContain('TABLE DATA');
    },
    DUMP_TIMEOUT_MS
  );
});

describe('dumpDatabase when pg_dump cannot connect', () => {
  it(
    'throws and leaves no output directory behind',
    async () => {
      const parent = await mkdtemp(path.join(os.tmpdir(), 'hb-backup-pg-fail-'));
      const outDir = path.join(parent, 'dump');
      const unreachable = new URL(directUrlForDriverDatabase());
      unreachable.port = '1';

      try {
        await expect(
          dumpDatabase({
            databaseUrl: unreachable.toString(),
            snapshotUrl: DRIVER_URL,
            outDir,
            image: POSTGRES_IMAGE,
          })
        ).rejects.toThrow(/pg_dump exited/);
        await expect(directoryExists(outDir)).resolves.toBe(false);
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    },
    DUMP_TIMEOUT_MS
  );

  it(
    'names no credential in what it throws',
    async () => {
      const parent = await mkdtemp(path.join(os.tmpdir(), 'hb-backup-pg-secret-'));
      const outDir = path.join(parent, 'dump');
      const unreachable = new URL(directUrlForDriverDatabase());
      unreachable.port = '1';
      const password = containerConnection(unreachable.toString()).env['PGPASSWORD'];
      if (password === undefined) {
        throw new Error('backup/postgres integration: the stack URL carries no password to check');
      }

      try {
        await expect(
          dumpDatabase({
            databaseUrl: unreachable.toString(),
            snapshotUrl: DRIVER_URL,
            outDir,
            image: POSTGRES_IMAGE,
          })
        ).rejects.toThrow(
          expect.objectContaining({
            message: expect.not.stringContaining(password),
          })
        );
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    },
    DUMP_TIMEOUT_MS
  );
});
