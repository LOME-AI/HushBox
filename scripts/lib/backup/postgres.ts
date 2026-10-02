import { chmod, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { sql } from 'drizzle-orm';
import { execa } from 'execa';
import { z } from 'zod';

import { LOCAL_NEON_DEV_CONFIG, createDb, type Database } from '@hushbox/db';
import { isLocalHostUrl } from '@hushbox/db/local-host-url';

import { redactCredentials } from '../publication/git.js';
import type { SQL } from 'drizzle-orm';

/**
 * The database half of a backup run: one directory-format dump, plus the exact
 * per-table row counts and migration head that a restore is later proved
 * against.
 *
 * Both readings come from the transaction that exported the snapshot `pg_dump`
 * then runs under, so "the counts the dump saw" is a fact rather than a
 * near-simultaneous second reading. That is the whole reason the transaction is
 * held open across a subprocess: it is what makes the drill's comparison exact.
 *
 * The client runs in a container rather than on the machine: a dump must be
 * taken by a client at least as new as the server, and the runner image ships
 * an older one. The image is the one the local stack already runs, so CI and
 * local development take the same path.
 */

/**
 * The Postgres client and server image. Pinned to the tag `docker-compose.yml`
 * gives the local cluster — a dump taken by an older client than the server is
 * refused, so the two cannot drift apart.
 */
export const POSTGRES_IMAGE = 'postgres:18-alpine';

/** Where the dump directory is bind-mounted inside the container. */
const CONTAINER_DUMP_DIR = '/dump';

/** Name of the manifest written beside the dump's own files. */
export const DUMP_MANIFEST_FILE = 'manifest.json';

/** Stamped into every manifest, and bumped whenever the manifest's shape changes. */
const DUMP_MANIFEST_FORMAT_VERSION = 1;

/**
 * How long `pg_dump` waits for a table lock before giving up. A dump that
 * queues behind a long transaction would hold its own snapshot open for as
 * long, so it fails and the next hourly run takes its place.
 */
const LOCK_WAIT_TIMEOUT_MS = 60_000;

/**
 * Ceiling on one `pg_dump` run, and the only bound inside this module on how
 * long the exporting session may sit idle in its transaction: the server-side
 * backstop is deliberately lifted for that transaction (see {@link dumpDatabase}),
 * and an open repeatable-read transaction holds back the xmin horizon, so a hung
 * client stops the production database from vacuuming for as long as it hangs.
 * Far above any plausible dump of this database — it exists to turn a hang into a
 * failure, not to police a slow run.
 */
const DUMP_RUNTIME_LIMIT_MS = 20 * 60_000;

/** How much of a failed `pg_dump`'s stderr is carried into the thrown error. */
const STDERR_TAIL_CHARACTERS = 2000;

/**
 * The name a container resolves to the machine running it. A loopback host in
 * the URL names the container itself once the client moves inside one, so it is
 * rewritten to this and published with `--add-host`.
 */
const HOST_GATEWAY_ALIAS = 'host.docker.internal';

/**
 * Drizzle's applied-migration table, drizzle-kit's default and re-declared
 * nowhere in `packages/db`. Its newest row's hash is the schema the dump was
 * taken at, and a restore that lands a different one is a restore of something
 * else. This is the name's only home: {@link migrationHeadQuery} builds the
 * query from it and takes no journal argument, so no caller — the restore
 * drill included — can spell the name a second time.
 */
const MIGRATION_JOURNAL = 'drizzle.__drizzle_migrations';

/**
 * libpq's environment variable per connection-string parameter. libpq's naming
 * is irregular enough (`application_name` is `PGAPPNAME`, `channel_binding` is
 * `PGCHANNELBINDING`) that the mapping is written out rather than derived, and a
 * parameter absent from it fails the run rather than being silently dropped.
 */
const LIBPQ_VARIABLE_BY_PARAMETER: Readonly<Record<string, string>> = {
  application_name: 'PGAPPNAME',
  channel_binding: 'PGCHANNELBINDING',
  connect_timeout: 'PGCONNECT_TIMEOUT',
  options: 'PGOPTIONS',
  sslmode: 'PGSSLMODE',
  sslrootcert: 'PGSSLROOTCERT',
};

export const DumpManifestSchema = z.object({
  /** The exported snapshot the dump and the counts below were both taken under. */
  snapshotId: z.string().min(1),
  /** Exact `count(*)` per table in `public`. */
  tables: z.record(z.string(), z.int().nonnegative()),
  /** Hash of the newest row in Drizzle's applied-migration table. */
  migrationHead: z.string().min(1),
  formatVersion: z.int().positive(),
});

export type DumpManifest = z.infer<typeof DumpManifestSchema>;

export interface ContainerConnection {
  /** libpq variables. The password reaches the client here and in no argument. */
  readonly env: Readonly<Record<string, string>>;
  /** Whether the container has to be told how to reach the host machine. */
  readonly needsHostGateway: boolean;
}

/**
 * Decomposes a Postgres URL into the libpq variables the containerised client
 * reads. Decomposed rather than passed whole because libpq expands a URI only
 * from the `dbname` argument and never from `PGDATABASE`: handing the client a
 * URL means putting a password on a command line.
 */
function postgresUrl(databaseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('containerConnection: the database URL is not a URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(
      `containerConnection: '${url.protocol}' is not a postgres:// or postgresql:// URL`
    );
  }
  if (url.username === '') {
    throw new Error('containerConnection: the database URL names no user');
  }
  return url;
}

export function containerConnection(databaseUrl: string): ContainerConnection {
  const url = postgresUrl(databaseUrl);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (database === '') {
    throw new Error('containerConnection: the database URL names no database');
  }

  const needsHostGateway = isLocalHostUrl(databaseUrl);
  const env: Record<string, string> = {
    PGHOST: needsHostGateway ? HOST_GATEWAY_ALIAS : url.hostname,
    PGPORT: url.port === '' ? '5432' : url.port,
    PGUSER: decodeURIComponent(url.username),
  };
  if (url.password !== '') {
    env['PGPASSWORD'] = decodeURIComponent(url.password);
  }
  env['PGDATABASE'] = database;
  for (const [parameter, value] of url.searchParams) {
    const variable = LIBPQ_VARIABLE_BY_PARAMETER[parameter];
    if (variable === undefined) {
      throw new Error(
        `containerConnection: connection parameter '${parameter}' has no libpq variable here`
      );
    }
    env[variable] = value;
  }
  return { env, needsHostGateway };
}

/**
 * The `uid:gid` the container writes the dump as, so its files belong to the
 * invoking user rather than to root. Windows has neither, and Docker Desktop
 * maps ownership itself there.
 */
export function containerUser(ids: {
  readonly getuid?: () => number;
  readonly getgid?: () => number;
}): string | undefined {
  const uid = ids.getuid?.();
  const gid = ids.getgid?.();
  if (uid === undefined || gid === undefined) return undefined;
  return `${String(uid)}:${String(gid)}`;
}

export interface DumpCommandInput {
  readonly image: string;
  readonly outDir: string;
  readonly snapshotId: string;
  readonly connection: ContainerConnection;
  /** From {@link containerUser}. */
  readonly user: string | undefined;
}

/**
 * The full `docker run` argument list. `-Fd` with `-Z0` is what makes the dump
 * deduplicate: one uncompressed file per table, so an unchanged table is
 * unchanged bytes. Every `-e` names a variable and never its value, so nothing
 * secret is ever an argument.
 */
export function dumpCommandArguments(input: DumpCommandInput): string[] {
  const { image, outDir, snapshotId, connection, user } = input;
  return [
    'run',
    '--rm',
    ...(connection.needsHostGateway ? [`--add-host=${HOST_GATEWAY_ALIAS}:host-gateway`] : []),
    ...(user === undefined ? [] : ['--user', user]),
    ...Object.keys(connection.env).flatMap((variable) => ['-e', variable]),
    '-v',
    `${outDir}:${CONTAINER_DUMP_DIR}`,
    image,
    'pg_dump',
    '-Fd',
    '-Z0',
    '--jobs',
    '4',
    '--no-owner',
    '--no-privileges',
    `--lock-wait-timeout=${String(LOCK_WAIT_TIMEOUT_MS)}`,
    `--snapshot=${snapshotId}`,
    '-f',
    CONTAINER_DUMP_DIR,
  ];
}

/** Runs one statement inside the snapshot-holding transaction. */
export type SnapshotQuery = (statement: SQL) => Promise<Record<string, unknown>[]>;

function expectSingleRow(rows: Record<string, unknown>[], what: string): Record<string, unknown> {
  const [row] = rows;
  if (row === undefined) {
    throw new Error(`dumpDatabase: ${what} returned no row`);
  }
  return row;
}

function expectCount(value: unknown, table: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count)) {
    throw new TypeError(`dumpDatabase: the row count of '${table}' is not a whole number`);
  }
  return count;
}

/**
 * The applied migration the database stands at: the newest row of the journal,
 * by insertion order within a timestamp.
 *
 * Written once because the restore drill reads the same head out of a restored
 * database and compares it to the one this recorded. Two orderings that drifted
 * apart would report a mismatch on a correct restore — a false alarm on the
 * proof the backups rest on. It names its own journal for the same reason: an
 * argument is a second place the name could be written.
 */
export function migrationHeadQuery(): string {
  return `select hash from ${MIGRATION_JOURNAL} order by created_at desc, id desc limit 1`;
}

/**
 * Everything the manifest records, read through one already-open repeatable-read
 * transaction. The snapshot is exported first so that every reading after it —
 * and `pg_dump` itself — sees the one database state.
 */
export async function readSnapshotFacts(
  query: SnapshotQuery
): Promise<Omit<DumpManifest, 'formatVersion'>> {
  const exported = expectSingleRow(
    await query(sql`select pg_export_snapshot() as snapshot_id`),
    'pg_export_snapshot()'
  );
  const snapshotId = String(exported['snapshot_id']);

  const tableRows = await query(
    sql`select tablename from pg_tables where schemaname = 'public' order by tablename`
  );
  const tables: Record<string, number> = {};
  for (const tableRow of tableRows) {
    const table = String(tableRow['tablename']);
    const counted = expectSingleRow(
      await query(sql`select count(*) as row_count from public.${sql.identifier(table)}`),
      `count(*) on '${table}'`
    );
    tables[table] = expectCount(counted['row_count'], table);
  }

  const headRows = await query(sql.raw(migrationHeadQuery()));
  const [head] = headRows;
  if (head === undefined) {
    throw new Error(`dumpDatabase: ${MIGRATION_JOURNAL} holds no applied migration`);
  }
  return { snapshotId, tables, migrationHead: String(head['hash']) };
}

export interface DumpDatabaseOptions {
  /**
   * The connection `pg_dump` makes from inside the container. On Neon this is
   * the direct (unpooled) endpoint: the pooler serves no exported snapshot.
   */
  readonly databaseUrl: string;
  /**
   * The connection the Node session holding the snapshot open makes. Defaults
   * to `databaseUrl`, which is right wherever one endpoint answers both the
   * WebSocket driver and libpq — Neon's does. The local stack's does not: the
   * driver reaches Postgres through the WebSocket proxy while libpq reaches it
   * directly, on two different ports. Both must name the same database, because
   * an exported snapshot is only valid within the database that exported it.
   */
  readonly snapshotUrl?: string;
  /** Absent or empty; the dump's files and the manifest are written here. */
  readonly outDir: string;
  /** Normally {@link POSTGRES_IMAGE}. */
  readonly image: string;
}

type SnapshotTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Makes an empty directory for the dump, reachable by nobody but its owner: what
 * lands in it is every user's account data in plaintext, for the whole staging
 * window before it is encrypted. The mode is given twice because neither spelling
 * covers both cases — creation is masked by the process umask, and a directory
 * the caller already made keeps whatever mode it was made with.
 */
export async function prepareOutDir(outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  await chmod(outDir, 0o700);
  const existing = await readdir(outDir);
  if (existing.length > 0) {
    throw new Error('the backup output directory is not empty');
  }
}

export interface DumpCommandOptions {
  /** The password reaches the client here and in no argument. */
  readonly env: Readonly<Record<string, string>>;
  readonly timeout: number;
  readonly reject: false;
}

/**
 * The subprocess options. A non-zero exit is a value rather than a throw because
 * the failure is reported with its stderr tail redacted, which needs the result.
 */
export function dumpCommandOptions(connection: ContainerConnection): DumpCommandOptions {
  return { env: connection.env, timeout: DUMP_RUNTIME_LIMIT_MS, reject: false };
}

/** The part of the client's result the outcome is read from. */
export interface DumpOutcome {
  /** Absent for a client killed by a signal, which is how the ceiling ends one. */
  readonly exitCode?: number | undefined;
  readonly timedOut: boolean;
  readonly stderr: string;
}

/**
 * Throws unless the client dumped. A client killed at the runtime ceiling has no
 * exit code to report, so it is named as what it is.
 */
export function assertDumpSucceeded(outcome: DumpOutcome): void {
  if (outcome.timedOut) {
    throw new Error(
      `dumpDatabase: pg_dump ran past its limit of ${String(DUMP_RUNTIME_LIMIT_MS)} ms and was killed`
    );
  }
  if (outcome.exitCode === 0) return;
  const tail = redactCredentials(outcome.stderr).slice(-STDERR_TAIL_CHARACTERS);
  throw new Error(`dumpDatabase: pg_dump exited ${String(outcome.exitCode)}\n${tail}`);
}

async function runPgDump(input: DumpCommandInput): Promise<void> {
  assertDumpSucceeded(
    await execa('docker', dumpCommandArguments(input), dumpCommandOptions(input.connection))
  );
}

/**
 * Dumps the database into `outDir` and returns — and writes there — the counts
 * and migration head taken under the dump's own snapshot.
 *
 * The transaction is held open across `pg_dump` because an exported snapshot
 * lives only as long as the session that exported it; it commits once the
 * client exits. `idle_in_transaction_session_timeout` is lifted for that
 * transaction alone: to the server the exporting session is idle in a
 * transaction for the whole dump, so any non-zero value on the endpoint would
 * end the session and invalidate the snapshot the running client depends on.
 *
 * A failure removes `outDir`, so a partial dump can never be mistaken for one.
 */
export async function dumpDatabase(options: DumpDatabaseOptions): Promise<DumpManifest> {
  const { databaseUrl, outDir, image } = options;
  const snapshotUrl = options.snapshotUrl ?? databaseUrl;
  const connection = containerConnection(databaseUrl);
  await prepareOutDir(outDir);

  const db = createDb(
    snapshotUrl,
    isLocalHostUrl(snapshotUrl) ? { neonDev: LOCAL_NEON_DEV_CONFIG } : {}
  );
  try {
    const manifest = await db.transaction(
      async (tx: SnapshotTransaction): Promise<DumpManifest> => {
        await tx.execute(sql`set local idle_in_transaction_session_timeout = 0`);
        const facts = await readSnapshotFacts(async (statement) => {
          const result = await tx.execute(statement);
          return result.rows;
        });
        await runPgDump({
          image,
          outDir,
          snapshotId: facts.snapshotId,
          connection,
          user: containerUser(process),
        });
        return { ...facts, formatVersion: DUMP_MANIFEST_FORMAT_VERSION };
      },
      { isolationLevel: 'repeatable read' }
    );
    await writeFile(
      path.join(outDir, DUMP_MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`
    );
    return manifest;
  } catch (error) {
    await rm(outDir, { recursive: true, force: true });
    throw error;
  } finally {
    await db.$client.end();
  }
}
