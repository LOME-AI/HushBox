import { randomInt, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  RUN_TOKEN_VARIABLE,
  dropDatabaseSql,
  slotDatabaseName,
  withDatabaseName,
} from '@hushbox/db/test-db';

import {
  createTestDbExecutor,
  ensureDatabaseExists,
  withMaintenanceExecutor,
} from '../test-run/test-db-provision.js';
import { ensureStack, type EnsureStackDeps } from './ensure-stack.js';
import { databaseNameOf, stackDatabaseName } from './stack-database.js';
import {
  installDevOnlyTracking,
  markClean,
  readMeta,
  type SqlExecutor,
  type StackMeta,
} from './stack-meta.js';
import { STACK_MODES, type StackMode } from './port-plan.js';

/**
 * That preparing one stack writes nothing into another stack's database,
 * executed against the live cluster rather than reasoned about.
 *
 * The whole point of the per-stack database is that one command's bring-up
 * cannot land on the database another command is using, and the write that
 * would land there is the migration stamp: `ensureStack` reads `__stack_meta`,
 * migrates when the recorded fingerprint is stale, and stamps the new one. So
 * this drives a real `ensureStack` and reads the development stack's stamp on
 * either side of it.
 *
 * The bring-up writes to a scratch database this test creates and drops, not to
 * another stack's long-lived one: a test that mutates a stack a developer or a
 * concurrent run may be holding is a hazard whatever it restores afterwards,
 * and the sibling Redis test already settles the discipline — a uniquely-named,
 * self-removing probe, never an existing value. What that costs is the live
 * demonstration that the end-to-end stack resolves elsewhere, which the
 * assertion on the observer's own connection buys back.
 *
 * Where the connection strings come from: the cluster coordinates are this
 * run's own `DATABASE_URL` and the observer's database is
 * {@link stackDatabaseName}, which is the single source the generator
 * substitutes into every stack's files. That the generated files carry what it
 * derives is asserted by the generator's own tests; what only a live cluster
 * can answer, and what this asserts, is that the database a stack's derivation
 * actually reaches is that stack's alone and that `ensureStack`'s stamp lands
 * in the one its executor names.
 *
 * The dependencies that decide *where* a write lands are real — database
 * creation, the SQL executor, and the three stack-meta calls. The ones that
 * build the world are stubbed: this runs against a stack other work is using,
 * so it starts no container, installs nothing, spawns no daemon and builds no
 * template. Its repository root is a temporary directory for the same reason,
 * so the section lock it takes is its own and no concurrent `ensure-stack`
 * queues behind it.
 *
 * It needs the local stack, which is what `pnpm test` brings up.
 */

/** The stack that must come out of a foreign bring-up unchanged, and is only read. */
const OBSERVER: StackMode = 'development';

function requireDatabaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new Error(
      'DATABASE_URL is required for the stack Postgres-isolation test — run vitest through `tsx scripts/with-env.ts`, which is what loads the env files'
    );
  }
  return url;
}

/** The connection a run of that stack reaches Postgres with. */
function stackDatabaseUrl(stackMode: StackMode): string {
  return withDatabaseName(requireDatabaseUrl(), stackDatabaseName(stackMode));
}

/** The databases of every stack but the observer's. */
function foreignStackDatabases(): string[] {
  return STACK_MODES.filter((stackMode) => stackMode !== OBSERVER).map((stackMode) =>
    stackDatabaseName(stackMode)
  );
}

/**
 * A database of this run's own, named the way the per-worker provisioning names
 * its databases so that the machinery already reclaiming those reclaims this
 * one too: the run token in the name is what a sweep attributes it to, the
 * claim this run already holds covers it, and teardown drops every database
 * carrying that token. That is the path a killed process leaves behind — the
 * `finally` covers every path this one controls.
 *
 * The uniqueness rides in the slot field because that is the only free field in
 * the shape, and a value of this size is not a slot any worker can hold:
 * `VITEST_POOL_ID` numbers workers from one.
 */
function mintScratchDatabaseName(): string {
  const runToken = process.env[RUN_TOKEN_VARIABLE];
  if (runToken === undefined || runToken === '') {
    throw new Error(
      `${RUN_TOKEN_VARIABLE} is required for the stack Postgres-isolation test — it is minted by the vitest global setup, which did not run`
    );
  }
  return slotDatabaseName(runToken, String(randomInt(10 ** 12, 10 ** 13)));
}

/** The database a live connection is actually on, asked of the server. */
async function currentDatabase(executor: SqlExecutor): Promise<string | undefined> {
  const rows = await executor.query<{ current: string }>('SELECT current_database() AS current');
  return rows[0]?.current;
}

/**
 * The stamp, or null when the database has no `__stack_meta` yet. Asked rather
 * than caught: a missing table and a refused connection are different answers
 * and only the first one is this test's business.
 */
async function readStampIfPresent(executor: SqlExecutor): Promise<StackMeta | null> {
  const rows = await executor.query<{ present: boolean }>(
    "SELECT to_regclass('public.__stack_meta') IS NOT NULL AS present"
  );
  return rows[0]?.present === true ? readMeta(executor) : null;
}

/**
 * Everything `ensureStack` needs, with the world-building half inert. The
 * fingerprint is the caller's, so a stamp that already records the real one
 * does not send the run down the skip path and leave nothing written.
 */
function stackDeps(
  connectionString: string,
  executor: SqlExecutor,
  migrationFingerprint: string
): EnsureStackDeps {
  const inert = async (): Promise<void> => {};
  const depsFingerprint = 'unchanged';

  return {
    generateEnvFiles: () => {},
    generateComposeFiles: () => [],
    installDeps: inert,
    cleanupOrphans: inert,
    ensureContainersHealthy: inert,
    ensurePostgresAcceptsPassword: inert,
    ensureDatabase: async () => {
      await withMaintenanceExecutor(connectionString, (maintenance) =>
        ensureDatabaseExists(maintenance, databaseNameOf(connectionString))
      );
    },
    runMigrations: inert,
    installDevTracking: (target) => installDevOnlyTracking(target, []),
    provisionAdminSqlPanelRole: inert,
    readMeta,
    markClean,
    composeDown: inert,
    ensureDaemonRunning: inert,
    readDepsHash: () => Promise.resolve(depsFingerprint),
    writeDepsHash: inert,
    computeDepsFingerprint: () => Promise.resolve(depsFingerprint),
    computeMigrationFingerprint: () => Promise.resolve(migrationFingerprint),
    ensureTestTemplate: inert,
    // Inert like the rest of the world-building half: this database is built by
    // the dev-tracking install alone, so there is no migration chain to compare
    // it against.
    assertNoSchemaDrift: inert,
    reportProgress: () => {},
    auditStackWorld: inert,
    sqlExecutor: executor,
  };
}

describe('Postgres isolation between stacks', () => {
  it('leaves the development stamp untouched while stamping a database of its own', async () => {
    const observer = createTestDbExecutor(stackDatabaseUrl(OBSERVER));
    const scratch = mintScratchDatabaseName();
    const scratchUrl = withDatabaseName(requireDatabaseUrl(), scratch);
    const writer = createTestDbExecutor(scratchUrl);
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'hb-stack-isolation-'));
    const fingerprint = randomUUID();

    try {
      // Live: the database the development stack's derivation actually reached
      // belongs to no other stack. Derivation alone is a unit-test question;
      // that the cluster agrees is this one's.
      expect(foreignStackDatabases()).not.toContain(await currentDatabase(observer));
      const observerBefore = await readStampIfPresent(observer);

      await ensureStack(
        {
          repoRoot,
          slot: 0,
          daemonScriptPath: path.join(repoRoot, 'no-daemon.ts'),
          idleDaemonPort: 1,
        },
        stackDeps(scratchUrl, writer, fingerprint)
      );

      await expect(readStampIfPresent(writer)).resolves.toMatchObject({
        seedHash: fingerprint,
      });
      await expect(readStampIfPresent(observer)).resolves.toEqual(observerBefore);
    } finally {
      await writer.close();
      await observer.close();
      await withMaintenanceExecutor(scratchUrl, (maintenance) =>
        maintenance.exec(dropDatabaseSql(scratch))
      );
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});
