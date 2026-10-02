import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RUN_TOKEN_VARIABLE } from '@hushbox/db/test-db';

import { RUN_CLAIM_ENV } from '../claims/registry.js';
import {
  assertSchemaMatchesMigrations,
  createTestDbExecutor,
} from '../test-run/test-db-provision.js';
import { ensureStack, type EnsureStackDeps, type EnsureStackOptions } from './ensure-stack.js';

/**
 * That the migration skip names a database changed outside the migration chain,
 * executed against the live cluster rather than reasoned about.
 *
 * This worker's own database stands in both roles — a clone of the clone-source
 * template, so it starts holding exactly what the chain records. Drifted, it is
 * given one table no migration describes, named after the run so a table a
 * killed process leaves behind is attributable, and the `finally` covers every
 * path this process controls; matching, it is the same database read and not
 * written. The clone source itself is never read: a session on it is what stops
 * a worker of another run from cloning it.
 */

/** Nothing else on the cluster holds this slot, so the lock this takes is its own. */
const SLOT = 11;

function databaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new Error('DATABASE_URL is required for this test');
  }
  return url;
}

/** The table this suite adds outside the chain, named after the run that added it. */
function markerTable(): string {
  const token = process.env[RUN_TOKEN_VARIABLE];
  if (token === undefined || token === '') {
    throw new Error('the vitest global setup did not run');
  }
  return `hb_drift_stack_${token}`;
}

/** Runs `body` against a database holding one relation the migration chain does not describe. */
async function withDrift(body: (databaseUrl: string) => Promise<void>): Promise<void> {
  const executor = createTestDbExecutor(databaseUrl());
  const table = markerTable();
  await executor.exec(`CREATE TABLE "${table}" (id integer)`);
  try {
    await body(databaseUrl());
  } finally {
    await executor.exec(`DROP TABLE IF EXISTS "${table}"`);
    await executor.close();
  }
}

describe('the migration skip in the stack bring-up', () => {
  let workDir = '';

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'hb-drift-'));
    // The invocation running this suite is itself a registered run, and a
    // bring-up left to find it records its compose project against that run.
    vi.stubEnv(RUN_CLAIM_ENV, '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(workDir, { recursive: true, force: true });
  });

  /** Everything the bring-up needs to reach the skip, with only the comparison real. */
  function makeDeps(target: string): EnsureStackDeps {
    const inert = (): Promise<void> => Promise.resolve();
    return {
      generateEnvFiles: vi.fn(),
      generateComposeFiles: vi.fn(() => []),
      installDeps: inert,
      cleanupOrphans: inert,
      ensureContainersHealthy: inert,
      ensurePostgresAcceptsPassword: inert,
      ensureDatabase: inert,
      runMigrations: vi.fn(inert),
      installDevTracking: inert,
      provisionAdminSqlPanelRole: inert,
      readMeta: () => Promise.resolve({ seedHash: 'mig-fp', seededAt: new Date(), dirty: false }),
      markClean: inert,
      composeDown: inert,
      ensureDaemonRunning: inert,
      readDepsHash: () => Promise.resolve('deps-fp'),
      writeDepsHash: inert,
      computeDepsFingerprint: () => Promise.resolve('deps-fp'),
      computeMigrationFingerprint: () => Promise.resolve('mig-fp'),
      ensureTestTemplate: inert,
      assertNoSchemaDrift: () => assertSchemaMatchesMigrations(target),
      reportProgress: vi.fn(),
      auditStackWorld: inert,
      sqlExecutor: { exec: vi.fn(), query: vi.fn() },
    };
  }

  function makeOptions(): EnsureStackOptions {
    return {
      repoRoot: workDir,
      slot: SLOT,
      daemonScriptPath: path.join(workDir, 'daemon.ts'),
      idleDaemonPort: 7711,
    };
  }

  it('refuses the bring-up when the database the fingerprint accepted has drifted', async () => {
    await withDrift(async (url) => {
      await expect(ensureStack(makeOptions(), makeDeps(url))).rejects.toThrow(
        new RegExp(`table ${markerTable()}: the database has it`)
      );
    });
  });

  it('takes the skip when the database matches the schema the chain records', async () => {
    const deps = makeDeps(databaseUrl());
    await expect(ensureStack(makeOptions(), deps)).resolves.toBeUndefined();
    expect(deps.runMigrations).not.toHaveBeenCalled();
  });
});
