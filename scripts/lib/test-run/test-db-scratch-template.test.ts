import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

import { execa } from 'execa';
import { describe, it, expect, afterAll, beforeAll } from 'vitest';

import {
  commentDatabaseSql,
  createDatabaseSql,
  dropDatabaseSql,
  listStageDatabasesSql,
  mintStageDatabaseName,
  runTokenFor,
  templateComment,
  withDatabaseName,
} from '@hushbox/db/test-db';
import {
  createTestDbExecutor,
  ensureTemplateDatabase,
  templateFingerprint,
  sweepStageDatabases,
  withMaintenanceExecutor,
} from './test-db-provision.js';
import {
  MARKER_TABLE,
  retargetTemplate,
  runScratchTemplateStep,
  withStandInSession,
  writeMarker,
} from './test-db-scratch-template.js';
import { RUN_CLAIM_ENV, registerRun } from '../claims/registry.js';
import { recordOwnedResource } from '../claims/ownership.js';
import type { SqlExecutor } from '../stack/stack-meta.js';

const CHILD_ENTRY = path.join(import.meta.dirname, 'test-db-scratch-template.ts');
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');

/**
 * The seed-input digest every stand-in template step is handed. A constant, so a
 * stamp read back is compared against what the step was given and never against
 * a second walk of a checkout another process may be editing.
 */
const SEED_INPUTS_DIGEST = 'stand-in-seed-inputs';

/** The stamp the template step writes for `migrationFingerprint` and {@link SEED_INPUTS_DIGEST}. */
function stampFor(migrationFingerprint: string): string {
  return templateComment(templateFingerprint(migrationFingerprint, SEED_INPUTS_DIGEST));
}

/** The fan-out the shared vitest config produces: thirteen configs plus spares. */
const CONCURRENT_PROCESSES = 15;

/**
 * What a case that reaches the live cluster may spend.
 *
 * Every case below opens a maintenance session against the running Postgres,
 * and several fan a template build out across a process per package, so what
 * they wait on is a database round trip on a host that is also running the
 * suite. Driven beside this package's own suite, the costliest of them
 * completed in 28.4 seconds against the 4.4 it takes on a quiet host. This is
 * the bound the fan-out cases already stood on, roughly four times that worst,
 * kept rather than re-derived because it is the one already proven under load.
 *
 * It now sits on every case that reaches the cluster rather than on the heavy
 * ones alone, which is the repair: the sweep cases were left at the runner's
 * default, and one of them was measured at 18.8 seconds — past that default
 * outside a coverage run.
 */
const LIVE_CLUSTER_BUDGET_MS = 120_000;

function databaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (url === undefined) throw new Error('DATABASE_URL is required for this test');
  return url;
}

async function withExecutor<T>(use: (executor: SqlExecutor) => Promise<T>): Promise<T> {
  return withMaintenanceExecutor(databaseUrl(), use);
}

async function dropDatabases(names: readonly string[]): Promise<void> {
  await withExecutor(async (executor) => {
    for (const name of names) {
      await executor.exec(dropDatabaseSql(name));
    }
  });
}

async function existingStageDatabases(names: readonly string[]): Promise<string[]> {
  const rows = await withExecutor((executor) =>
    executor.query<{ datname: string }>(listStageDatabasesSql())
  );
  return names.filter((name) => rows.some((row) => row.datname === name));
}

// Nothing else can reclaim these: they sit outside `hb_t_` on purpose, so the
// run sweep never lists them, and a proof killed before its `finally` leaves
// one behind. Its own run's claim is what says it may go, so a proof running
// right now is untouched however long it has been running.
beforeAll(async () => {
  await withExecutor((executor) => sweepStageDatabases(executor));
}, LIVE_CLUSTER_BUDGET_MS);

/**
 * Where every stand-in build in this file takes the builder's claim. Its own,
 * so these builds arbitrate against each other and never against the real
 * template: a stand-in queued behind a live migrate-and-seed would wait for a
 * build it has no interest in, and hold up the run that wanted one.
 */
let lockDir = '';

beforeAll(async () => {
  lockDir = await mkdtemp(path.join(os.tmpdir(), 'hb-template-lock-'));
});

afterAll(async () => {
  await rm(lockDir, { recursive: true, force: true });
});

async function readComment(databaseName: string): Promise<string | null> {
  const rows = await withExecutor((executor) =>
    executor.query<{ comment: string | null }>(
      `SELECT shobj_description(oid, 'pg_database') AS comment FROM pg_database ` +
        `WHERE datname = '${databaseName}'`
    )
  );
  return rows[0]?.comment ?? null;
}

async function readMarker(databaseName: string): Promise<string | undefined> {
  const executor = createTestDbExecutor(withDatabaseName(databaseUrl(), databaseName));
  try {
    const rows = await executor.query<{ fingerprint: string }>(
      `SELECT fingerprint FROM ${MARKER_TABLE}`
    );
    return rows[0]?.fingerprint;
  } finally {
    await executor.close();
  }
}

/** The database a CREATE or DROP acts on, ignoring a clone's TEMPLATE clause. */
function targets(statement: string): string | undefined {
  return /^(?:CREATE|DROP) DATABASE (?:IF EXISTS )?"([^"]+)"/.exec(statement)?.[1];
}

/** The template step the production code runs, pointed at a stand-in. */
async function templateStep(
  standIn: string,
  fingerprint: string,
  build: (databaseName: string) => Promise<void>
): Promise<boolean> {
  return withMaintenanceExecutor(databaseUrl(), (maintenance) =>
    ensureTemplateDatabase(retargetTemplate(maintenance, standIn), fingerprint, build, {
      registryDir: lockDir,
      seedInputsDigest: SEED_INPUTS_DIGEST,
      // The stand-in holds a marker table and nothing the migration chain
      // describes, so there is nothing to compare it against.
      verifyTemplate: () => Promise.resolve(),
    })
  );
}

interface TemplateObservation {
  readonly present: boolean;
  readonly comment: string | null;
}

async function readTemplateState(
  executor: SqlExecutor,
  databaseName: string
): Promise<TemplateObservation> {
  const rows = await executor.query<{ comment: string | null }>(
    `SELECT shobj_description(oid, 'pg_database') AS comment FROM pg_database ` +
      `WHERE datname = '${databaseName}'`
  );
  return { present: rows.length > 0, comment: rows[0]?.comment ?? null };
}

describe('retargetTemplate', () => {
  it('rewrites the production template name in both statement channels', async () => {
    const seen: string[] = [];
    const recorder: SqlExecutor = {
      exec: async (statement) => {
        seen.push(statement);
        await Promise.resolve();
      },
      query: async <T>(statement: string): Promise<T[]> => {
        seen.push(statement);
        await Promise.resolve();
        return [];
      },
    };

    const executor = retargetTemplate(recorder, 'hb_tplscratch_1');
    await executor.exec('CREATE DATABASE "hb_tpl"');
    await executor.query("SELECT 1 FROM pg_database WHERE datname = 'hb_tpl'");

    expect(seen).toEqual([
      'CREATE DATABASE "hb_tplscratch_1"',
      "SELECT 1 FROM pg_database WHERE datname = 'hb_tplscratch_1'",
    ]);
  });
});

/**
 * Runs `body` against a registry of its own, so the sweep it drives classifies
 * this test's claims and finds every other staged database on the cluster
 * unowned — the state it reports and never destroys. The inherited claim is put
 * back afterwards because registering a run clears it on the way out, and the
 * proofs below spawn children that need it.
 */
async function withOwnRegistry<T>(body: (registryDir: string) => Promise<T>): Promise<T> {
  const inherited = process.env[RUN_CLAIM_ENV];
  const registryDir = await mkdtemp(path.join(os.tmpdir(), 'hb-stage-'));
  process.env[RUN_CLAIM_ENV] = '';
  try {
    return await body(registryDir);
  } finally {
    process.env[RUN_CLAIM_ENV] = inherited ?? '';
    await rm(registryDir, { recursive: true, force: true });
  }
}

/** Registers a run standing in for the template build that stages a database. */
function asBuild<T>(registryDir: string, body: () => Promise<T>): Promise<T> {
  return registerRun(
    {
      command: 'a template build',
      mode: 'development',
      slot: 0,
      gitCommonDir: path.join(import.meta.dirname, '..', '..', '..', '.git'),
      registryDir,
    },
    body
  );
}

describe(
  'sweepStageDatabases against the live cluster',
  { timeout: LIVE_CLUSTER_BUDGET_MS },
  () => {
    it('spares a staged database the build that made it still holds', async () => {
      const staged = mintStageDatabaseName(runTokenFor(crypto.randomUUID()));

      try {
        await withOwnRegistry((registryDir) =>
          asBuild(registryDir, async () => {
            await recordOwnedResource('database', staged);
            await withExecutor((executor) => executor.exec(createDatabaseSql(staged)));

            const report = await withExecutor((executor) =>
              sweepStageDatabases(executor, { registryDir })
            );

            expect(report.dropped).toEqual([]);
            expect(await existingStageDatabases([staged])).toEqual([staged]);
          })
        );
      } finally {
        await dropDatabases([staged]);
      }
    });

    it('drops a staged database whose build died before it could publish', async () => {
      const staged = mintStageDatabaseName(runTokenFor(crypto.randomUUID()));

      try {
        await withOwnRegistry(async (registryDir) => {
          await expect(
            asBuild(registryDir, async () => {
              await recordOwnedResource('database', staged);
              await withExecutor((executor) => executor.exec(createDatabaseSql(staged)));
              throw new Error('killed');
            })
          ).rejects.toThrow('killed');

          const report = await withExecutor((executor) =>
            sweepStageDatabases(executor, { registryDir })
          );

          expect(report.dropped).toEqual([staged]);
          expect(await existingStageDatabases([staged])).toEqual([]);
        });
      } finally {
        await dropDatabases([staged]);
      }
    });

    it('reports a staged database no claim names and leaves it standing', async () => {
      const stranger = mintStageDatabaseName(runTokenFor(crypto.randomUUID()));

      try {
        await withExecutor((executor) => executor.exec(createDatabaseSql(stranger)));

        const report = await withOwnRegistry((registryDir) =>
          withExecutor((executor) => sweepStageDatabases(executor, { registryDir }))
        );

        expect(report.unowned).toContain(stranger);
        expect(report.dropped).toEqual([]);
        expect(await existingStageDatabases([stranger])).toEqual([stranger]);
      } finally {
        await dropDatabases([stranger]);
      }
    });
  }
);

describe('the template under a concurrent fan-out', () => {
  it(
    'is built once ahead of the fan-out, then cloned by every process with no duplicate escaping',
    { timeout: LIVE_CLUSTER_BUDGET_MS },
    async () => {
      const scratchTemplate = mintStageDatabaseName(runTokenFor(crypto.randomUUID()));
      const slotDatabase = `hb_t_${scratchTemplate.slice(-8)}_w1`;
      const fingerprint = 'fan-out-fingerprint';

      try {
        // What ensure-stack now does, once, before turbo forks anything.
        const ahead = await runScratchTemplateStep({
          connectionString: databaseUrl(),
          scratchTemplate,
          fingerprint,
          slotDatabase,
          registryDir: lockDir,
          seedInputsDigest: SEED_INPUTS_DIGEST,
        });
        expect(ahead.built).toBe(true);

        // What the fan-out then does: every package's vitest process reaching
        // the same template step, and the same slot clone, at once.
        const children = await Promise.all(
          Array.from({ length: CONCURRENT_PROCESSES }, () =>
            execa(
              TSX,
              [
                CHILD_ENTRY,
                scratchTemplate,
                fingerprint,
                slotDatabase,
                lockDir,
                SEED_INPUTS_DIGEST,
              ],
              {
                env: process.env,
                all: true,
                reject: false,
              }
            )
          )
        );

        const failed = children.filter((child) => child.exitCode !== 0);
        expect(failed.map((child) => child.all)).toEqual([]);

        const outcomes = children.map(
          (child) => JSON.parse(child.stdout) as { built: boolean; createdSlot: boolean }
        );
        expect(outcomes.filter((outcome) => outcome.built)).toEqual([]);
        expect(outcomes.filter((outcome) => outcome.createdSlot)).toEqual([]);
      } finally {
        await dropDatabases([slotDatabase, scratchTemplate]);
      }
    }
  );
});

describe('the template step reached twice', () => {
  it(
    'skips the build the second time and compares the stand-in against nothing',
    { timeout: LIVE_CLUSTER_BUDGET_MS },
    async () => {
      const scratchTemplate = mintStageDatabaseName(runTokenFor(crypto.randomUUID()));
      const slotDatabase = `hb_t_${scratchTemplate.slice(-8)}_w1`;
      const fingerprint = 'twice-fingerprint';
      const options = {
        connectionString: databaseUrl(),
        scratchTemplate,
        fingerprint,
        slotDatabase,
        registryDir: lockDir,
        seedInputsDigest: SEED_INPUTS_DIGEST,
      };

      try {
        const first = await runScratchTemplateStep(options);
        expect(first.built).toBe(true);
        const second = await runScratchTemplateStep(options);
        expect(second.built).toBe(false);
      } finally {
        await dropDatabases([slotDatabase, scratchTemplate]);
      }
    }
  );
});

describe('template staleness', () => {
  it(
    'detects a poisoned fingerprint and republishes the template by rename',
    { timeout: LIVE_CLUSTER_BUDGET_MS },
    async () => {
      const scratchTemplate = mintStageDatabaseName(runTokenFor(crypto.randomUUID()));
      const slotDatabase = `hb_t_${scratchTemplate.slice(-8)}_w1`;
      const original = 'migrations-before';
      const rebuilt = 'migrations-after';

      try {
        await runScratchTemplateStep({
          connectionString: databaseUrl(),
          scratchTemplate,
          fingerprint: original,
          slotDatabase,
          registryDir: lockDir,
          seedInputsDigest: SEED_INPUTS_DIGEST,
        });
        expect(await readComment(scratchTemplate)).toBe(stampFor(original));
        expect(await readMarker(scratchTemplate)).toBe(original);

        await withExecutor((executor) =>
          executor.exec(commentDatabaseSql(scratchTemplate, templateComment('poisoned')))
        );

        const outcome = await runScratchTemplateStep({
          connectionString: databaseUrl(),
          scratchTemplate,
          fingerprint: rebuilt,
          slotDatabase,
          registryDir: lockDir,
          seedInputsDigest: SEED_INPUTS_DIGEST,
        });

        expect(outcome.built).toBe(true);
        expect(outcome.statements[0]).toContain('shobj_description');
        // Read a second time inside the builder's claim: that read is what a
        // checker which queued behind a build answers itself from.
        expect(outcome.statements[1]).toContain('shobj_description');
        expect(outcome.statements[2]).toMatch(/^CREATE DATABASE "hb_stage_/);
        expect(
          outcome.statements.filter((statement) => targets(statement) === scratchTemplate)
        ).toEqual([]);
        expect(outcome.statements.some((statement) => statement.startsWith('BEGIN'))).toBe(true);
        expect(await readComment(scratchTemplate)).toBe(stampFor(rebuilt));
        expect(await readMarker(scratchTemplate)).toBe(rebuilt);
      } finally {
        await dropDatabases([slotDatabase, scratchTemplate]);
      }
    }
  );
});

describe('two checkers rebuilding the same stale template', () => {
  it(
    'both settle, with the built marker and the requested stamp surviving',
    { timeout: LIVE_CLUSTER_BUDGET_MS },
    async () => {
      const standIn = mintStageDatabaseName(runTokenFor(crypto.randomUUID()));
      const fingerprint = 'concurrent-fingerprint';
      // Long enough that the second checker reaches the template while the
      // first checker's build still holds a session on the database it built.
      const buildHoldMs = 2000;

      try {
        await withExecutor(async (executor) => {
          await executor.exec(createDatabaseSql(standIn));
          await executor.exec(commentDatabaseSql(standIn, templateComment('stale')));
        });

        const build = (databaseName: string): Promise<void> =>
          writeMarker(databaseUrl(), databaseName, fingerprint, buildHoldMs);

        const first = templateStep(standIn, fingerprint, build);
        // Staggered rather than simultaneous: the failure being pinned is the
        // second checker reaching the template mid-build, which a coin-flip on
        // who arrives first would only sometimes produce.
        await delay(300);
        const second = templateStep(standIn, fingerprint, build);

        const settled = await Promise.allSettled([first, second]);
        expect(
          settled.map((outcome) =>
            outcome.status === 'rejected' ? String(outcome.reason) : 'fulfilled'
          )
        ).toEqual(['fulfilled', 'fulfilled']);

        expect(await readComment(standIn)).toBe(stampFor(fingerprint));
        expect(await readMarker(standIn)).toBe(fingerprint);
      } finally {
        await dropDatabases([standIn]);
      }
    }
  );
});

describe('the live template name through a rebuild', () => {
  it(
    'is absent or stamped at every observation, never present and half-built',
    { timeout: LIVE_CLUSTER_BUDGET_MS },
    async () => {
      const standIn = mintStageDatabaseName(runTokenFor(crypto.randomUUID()));
      const fingerprint = 'polled-fingerprint';
      // The gap between the migrate child exiting and the seed child attaching:
      // no session holds the database, so a clone of it would succeed.
      const gapMs = 2000;
      const pollMs = 50;

      const observations: TemplateObservation[] = [];
      const gapObservations: TemplateObservation[] = [];
      let inGap = false;
      let building = true;

      const poll = withMaintenanceExecutor(databaseUrl(), async (executor) => {
        while (building) {
          const state = await readTemplateState(executor, standIn);
          observations.push(state);
          if (inGap) gapObservations.push(state);
          await delay(pollMs);
        }
      });

      try {
        const built = await templateStep(standIn, fingerprint, async (databaseName) => {
          // Two phases with no session between them, exactly like the migrate
          // child exiting before the seed child attaches.
          await writeMarker(databaseUrl(), databaseName, 'migrated');
          inGap = true;
          await delay(gapMs);
          inGap = false;
          await withStandInSession(databaseUrl(), databaseName, (executor) =>
            executor.exec(`UPDATE ${MARKER_TABLE} SET fingerprint = '${fingerprint}'`)
          );
        });
        expect(built).toBe(true);
      } finally {
        building = false;
        await poll;
      }
      const published = await withExecutor((executor) => readTemplateState(executor, standIn));
      observations.push(published);

      try {
        const halfBuilt = observations.filter(
          (state) => state.present && state.comment !== stampFor(fingerprint)
        );
        expect(halfBuilt).toEqual([]);
        // Without these the assertion above passes on an empty or all-absent
        // sample, which would prove nothing about the window.
        expect(gapObservations.length).toBeGreaterThan(0);
        expect(observations.filter((state) => !state.present).length).toBeGreaterThan(0);
        expect(published).toEqual({ present: true, comment: stampFor(fingerprint) });
        expect(await readMarker(standIn)).toBe(fingerprint);
      } finally {
        await dropDatabases([standIn]);
      }
    }
  );
});
