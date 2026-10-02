import path from 'node:path';
import os from 'node:os';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { HOUR_MS, isoAt, MINUTE_MS, TEST_DAY_START } from '@hushbox/shared/test-time';

import {
  CREATED_COMMENT_PREFIX,
  STALE_DATABASE_AGE_MS,
  STAGE_DATABASE_PREFIX,
  TEMPLATE_DATABASE,
  commentDatabaseSql,
  createDatabaseSql,
  createdComment,
  dropDatabaseSql,
  dropIdleDatabaseSql,
  listStageDatabasesSql,
  listTestDatabasesSql,
  mintStageDatabaseName,
  publishTemplateSql,
  renameDatabaseSql,
  runDatabasePrefix,
  runIdFromToken,
  runTokenFor,
  slotDatabaseName,
  RUN_TOKEN_VARIABLE,
  SEED_INPUTS_DIGEST_VARIABLE,
  templateComment,
  TEST_DATABASE_VARIABLE,
  templateFingerprintSql,
  type DatabaseRow,
} from '@hushbox/db/test-db';
import { migrationsFingerprint } from '../cli/fingerprint.js';

import {
  buildTemplateDatabase,
  connectionCount,
  createTestDbExecutor,
  dropRunDatabases,
  ensureDatabaseExists,
  ensureSlotDatabase,
  ensureTemplateDatabase,
  prepareRun,
  templateFingerprint,
  provisionSlotDatabase,
  reclaimTestDatabases,
  runBuildCommand,
  sweepStageDatabases,
  teardownRun,
  templateVerifier,
  withMaintenanceExecutor,
} from './test-db-provision.js';
import { RUN_CLAIM_ENV, registerRun } from '../claims/registry.js';
import { currentRunId, readOwnership, recordOwnedResource } from '../claims/ownership.js';
import { withScratchDirectory } from '../scratch-directory.js';
import { seedInputsFingerprint } from './seed-fingerprint.js';
import type { SqlExecutor } from '../stack/stack-meta.js';

interface FakeExecutor {
  exec: (statement: string) => Promise<void>;
  query: <T>(statement: string) => Promise<T[]>;
  readonly statements: string[];
}

function fakeExecutor(rows: unknown[] = [], failures: Record<string, unknown> = {}): FakeExecutor {
  const statements: string[] = [];
  return {
    statements,
    exec: async (statement: string) => {
      statements.push(statement);
      for (const [needle, error] of Object.entries(failures)) {
        if (statement.includes(needle)) throw error;
      }
      await Promise.resolve();
    },
    query: async <T>(statement: string): Promise<T[]> => {
      statements.push(statement);
      await Promise.resolve();
      return rows as T[];
    },
  };
}

/** Answers each query from the next row set, then repeats the last one. */
function sequencedExecutor(rowSets: readonly unknown[][]): FakeExecutor {
  const statements: string[] = [];
  let queries = 0;
  return {
    statements,
    exec: async (statement: string) => {
      statements.push(statement);
      await Promise.resolve();
    },
    query: async <T>(statement: string): Promise<T[]> => {
      statements.push(statement);
      await Promise.resolve();
      const rows = rowSets[Math.min(queries, rowSets.length - 1)] ?? [];
      queries += 1;
      return rows as T[];
    },
  };
}

const NOW = new Date(TEST_DAY_START + 12 * HOUR_MS);
const STALE_CUTOFF = NOW.getTime() - STALE_DATABASE_AGE_MS;

const CHECKOUT = path.join(path.sep, 'checkout-under-test', '.git');

/** The registry the enclosing suite's run registers in, fresh for every test. */
let registryDir = '';

/**
 * Gives the enclosing suite a registry directory of its own per test. The
 * inherited claim is cleared with it: a run that adopts one registers nothing,
 * and every suite here is about what a registration does.
 *
 * Put back afterwards rather than left cleared. It is the claim of the run this
 * whole file is executing inside, and the suites that exercise the real
 * preparation path hold nothing else — cleared for good by the first suite to
 * use this, they would prepare a run whose databases and buckets no claim
 * names.
 */
function registryPerTest(): void {
  // Read here, while the suites are being collected and the variable still
  // holds the claim this file was invoked under. Reading it in the setup below
  // would read what the previous case blanked, and the teardown would then put
  // an empty string back — the leak it exists to prevent.
  const inheritedRunClaim = process.env[RUN_CLAIM_ENV];

  beforeEach(async () => {
    registryDir = await mkdtemp(path.join(os.tmpdir(), 'hushbox-claims-test-'));
    process.env[RUN_CLAIM_ENV] = '';
  });

  afterEach(async () => {
    await rm(registryDir, { recursive: true, force: true });
  });

  // Once per suite rather than per case, because a per-case restore is skipped
  // whole by a throw in any teardown that runs before it — and a suite this is
  // called from may register its own, later, which is what runs first. A
  // once-per-suite teardown is skipped only by another registered after it at
  // the same scope.
  //
  // Empty string rather than removed: every reader treats an empty claim
  // variable as no claim, and a computed key cannot be deleted.
  afterAll(() => {
    process.env[RUN_CLAIM_ENV] = inheritedRunClaim ?? '';
  });
}

/** The run every suite here registers, in the registry {@link registryPerTest} made. */
function run<T>(body: () => Promise<T>): Promise<T> {
  return registerRun(
    { command: 'pnpm test', mode: 'development', slot: 4, gitCommonDir: CHECKOUT, registryDir },
    body
  );
}

/**
 * Makes the enclosing run's record unreadable in the form that needs no
 * corruption: a record a wider checkout wrote names a mode this one has never
 * heard of. The run behind it goes on holding its lock.
 */
function damageOwnRecord(): string {
  const runDir = process.env[RUN_CLAIM_ENV] ?? '';
  const record = path.join(runDir, 'run.json');
  const written: unknown = JSON.parse(readFileSync(record, 'utf8'));
  writeFileSync(
    record,
    JSON.stringify({ ...(written as object), mode: 'a-mode-this-checkout-has-never-heard-of' })
  );
  return path.basename(runDir);
}

describe('reclaimTestDatabases', () => {
  registryPerTest();

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reclaims nothing and reports an empty pass when the cluster never holds still', async () => {
    let created = 0;
    const statements: string[] = [];
    const executor: SqlExecutor = {
      exec: (statement: string) => {
        statements.push(statement);
        return Promise.resolve();
      },
      query: <T>(): Promise<T[]> =>
        Promise.resolve(
          Array.from({ length: created++ }, (_, n) => ({
            datname: `hb_t_racing${String(n)}_w1`,
            comment: null,
          })) as T[]
        ),
    };

    const report = await reclaimTestDatabases(executor, NOW, { registryDir });

    expect(report).toEqual({ dropped: [], unowned: [] });
    expect(statements).toEqual([]);
  });

  it('leaves a database whose owning run still holds its claim', async () => {
    await run(async () => {
      await recordOwnedResource('database', runDatabasePrefix('live'));
      const executor = fakeExecutor([{ datname: 'hb_t_live_w1', comment: createdComment(NOW) }]);

      const report = await reclaimTestDatabases(executor, NOW, { registryDir });

      expect(report.dropped).toEqual([]);
      expect(executor.statements).not.toContain(
        'DROP DATABASE IF EXISTS "hb_t_live_w1" WITH (FORCE)'
      );
    });
  });

  it('drops a database whose owning run died', async () => {
    await expect(
      run(async () => {
        await recordOwnedResource('database', runDatabasePrefix('dead'));
        throw new Error('killed');
      })
    ).rejects.toThrow('killed');

    const executor = fakeExecutor([{ datname: 'hb_t_dead_w1', comment: createdComment(NOW) }]);

    const report = await reclaimTestDatabases(executor, NOW, { registryDir });

    expect(report.dropped).toEqual(['hb_t_dead_w1']);
    expect(executor.statements).toContain('DROP DATABASE IF EXISTS "hb_t_dead_w1" WITH (FORCE)');
  });

  /**
   * The run ended the way it meant to, so its record is gone and the only thing
   * left naming an owner is the run id the database carries in its own name.
   */
  it('drops a database of a run that ended and took its record with it', async () => {
    const ended = await run(() => Promise.resolve(currentRunId() ?? ''));
    const datname = slotDatabaseName(runTokenFor(ended), '1');
    const executor = fakeExecutor([{ datname, comment: createdComment(NOW) }]);

    const report = await reclaimTestDatabases(executor, NOW, { registryDir });

    expect(report.dropped).toEqual([datname]);
    expect(executor.statements).toContain(dropDatabaseSql(datname));
  });

  it('leaves a database standing whose named run is still holding its claim', async () => {
    await run(async () => {
      // Nothing is recorded here on purpose: the name is the whole attribution.
      const datname = slotDatabaseName(runTokenFor(currentRunId() ?? ''), '1');
      const executor = fakeExecutor([{ datname, comment: createdComment(NOW) }]);

      const report = await reclaimTestDatabases(executor, NOW, { registryDir });

      expect(report.dropped).toEqual([]);
      expect(executor.statements).not.toContain(dropDatabaseSql(datname));
    });
  });

  it('reports a database naming a run the registry never held and leaves it standing', async () => {
    const datname = slotDatabaseName(runTokenFor(crypto.randomUUID()), '1');
    const executor = fakeExecutor([{ datname, comment: createdComment(NOW) }]);

    const report = await reclaimTestDatabases(executor, NOW, { registryDir });

    expect(report.unowned).toEqual([datname]);
    expect(report.dropped).toEqual([]);
    expect(executor.statements).not.toContain(dropDatabaseSql(datname));
  });

  it('reports a database of a run that ended before names carried a run id', async () => {
    await run(() => Promise.resolve());
    const executor = fakeExecutor([
      { datname: 'hb_t_ab12cd34ef_w1', comment: createdComment(NOW) },
    ]);

    const report = await reclaimTestDatabases(executor, NOW, { registryDir });

    expect(report.unowned).toEqual(['hb_t_ab12cd34ef_w1']);
    expect(report.dropped).toEqual([]);
  });

  it('reports a database no claim names and leaves it standing', async () => {
    const executor = fakeExecutor([{ datname: 'hb_t_stranger_w1', comment: createdComment(NOW) }]);

    const report = await reclaimTestDatabases(executor, NOW, { registryDir });

    expect(report.unowned).toEqual(['hb_t_stranger_w1']);
    expect(report.dropped).toEqual([]);
    expect(executor.statements).not.toContain(
      'DROP DATABASE IF EXISTS "hb_t_stranger_w1" WITH (FORCE)'
    );
  });

  it('names an unowned database on the console rather than passing it in silence', async () => {
    const warn = vi.spyOn(console, 'warn');
    const executor = fakeExecutor([{ datname: 'hb_t_stranger_w1', comment: createdComment(NOW) }]);

    await reclaimTestDatabases(executor, NOW, { registryDir });

    expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).toContain('hb_t_stranger_w1');
  });

  it('drops an ownerless database past the age limit, as pre-registry debris', async () => {
    const executor = fakeExecutor([
      { datname: 'hb_t_old_w1', comment: createdComment(new Date(STALE_CUTOFF - HOUR_MS)) },
      { datname: 'hb_t_new_w1', comment: createdComment(new Date(STALE_CUTOFF + MINUTE_MS)) },
    ]);

    const report = await reclaimTestDatabases(executor, NOW, { registryDir });

    expect(report.dropped).toEqual(['hb_t_old_w1']);
    expect(executor.statements).toContain('DROP DATABASE IF EXISTS "hb_t_old_w1" WITH (FORCE)');
    expect(executor.statements).not.toContain('DROP DATABASE IF EXISTS "hb_t_new_w1" WITH (FORCE)');
  });

  it('drops a database no claim names whose creation stamp cannot be read', async () => {
    const executor = fakeExecutor([{ datname: 'hb_t_outsider_w1', comment: null }]);

    const report = await reclaimTestDatabases(executor, NOW, { registryDir });

    expect(report).toEqual({ dropped: ['hb_t_outsider_w1'], unowned: [] });
    expect(executor.statements).toContain(
      'DROP DATABASE IF EXISTS "hb_t_outsider_w1" WITH (FORCE)'
    );
  });

  it('leaves a comment-less database standing while the run that is creating it holds its claim', async () => {
    // The window a worker database sits in between its CREATE and its COMMENT:
    // two statements, so the row carries no comment in between. Its run
    // recorded the name's prefix before either statement ran, which is what
    // keeps that row out of the reading above.
    await run(async () => {
      await recordOwnedResource('database', runDatabasePrefix('creating'));
      const executor = fakeExecutor([{ datname: 'hb_t_creating_w1', comment: null }]);

      const report = await reclaimTestDatabases(executor, NOW, { registryDir });

      expect(report.dropped).toEqual([]);
      expect(executor.statements).not.toContain(dropDatabaseSql('hb_t_creating_w1'));
    });
  });

  it("spares a comment-less database while a live run's record could not be read", async () => {
    const executor = fakeExecutor([{ datname: 'hb_t_unreadable_w1', comment: null }]);

    const report = await run(async () => {
      damageOwnRecord();
      return reclaimTestDatabases(executor, NOW, { registryDir });
    });

    expect(report.dropped).toEqual([]);
    expect(executor.statements).not.toContain(dropDatabaseSql('hb_t_unreadable_w1'));
  });

  it("spares an aged database while a live run's record could not be read", async () => {
    const aged = {
      datname: 'hb_t_marathon_w1',
      comment: createdComment(new Date(STALE_CUTOFF - HOUR_MS)),
    };
    const executor = fakeExecutor([aged]);

    const report = await run(async () => {
      damageOwnRecord();
      return reclaimTestDatabases(executor, NOW, { registryDir });
    });

    expect(report.dropped).toEqual([]);
    expect(executor.statements).not.toContain(dropDatabaseSql('hb_t_marathon_w1'));
  });

  it('says which run directory stopped the age path, so a human can go and look', async () => {
    const warn = vi.spyOn(console, 'warn');
    const executor = fakeExecutor([
      { datname: 'hb_t_marathon_w1', comment: createdComment(new Date(STALE_CUTOFF - HOUR_MS)) },
    ]);

    const runId = await run(async () => {
      const named = damageOwnRecord();
      await reclaimTestDatabases(executor, NOW, { registryDir });
      return named;
    });

    const skipped = warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('left standing'));
    expect(skipped.join('\n')).toContain(runId);
  });

  it('drops that same aged database once the run behind an unreadable record has gone', async () => {
    const executor = fakeExecutor([
      { datname: 'hb_t_marathon_w1', comment: createdComment(new Date(STALE_CUTOFF - HOUR_MS)) },
    ]);

    await run(() => Promise.resolve(damageOwnRecord()));
    const report = await reclaimTestDatabases(executor, NOW, { registryDir });

    expect(report.dropped).toEqual(['hb_t_marathon_w1']);
  });

  it('spares a live long-running database that age alone would have dropped', async () => {
    await run(async () => {
      await recordOwnedResource('database', runDatabasePrefix('marathon'));
      const executor = fakeExecutor([
        {
          datname: 'hb_t_marathon_w1',
          comment: createdComment(new Date(STALE_CUTOFF - 10 * HOUR_MS)),
        },
      ]);

      const report = await reclaimTestDatabases(executor, NOW, { registryDir });

      expect(report.dropped).toEqual([]);
    });
  });
});

describe('sweepStageDatabases', () => {
  registryPerTest();

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('spares a staged database the build that made it still holds', async () => {
    const staged = mintStageDatabaseName(runTokenFor(crypto.randomUUID()));

    const report = await run(async () => {
      await recordOwnedResource('database', staged);
      const executor = fakeExecutor([{ datname: staged }]);
      const swept = await sweepStageDatabases(executor, { registryDir });
      expect(executor.statements).not.toContain(dropDatabaseSql(staged));
      return swept;
    });

    expect(report.dropped).toEqual([]);
  });

  it('drops a staged database whose owning build died before it could publish', async () => {
    const staged = mintStageDatabaseName(runTokenFor(crypto.randomUUID()));
    await expect(
      run(async () => {
        await recordOwnedResource('database', staged);
        throw new Error('killed');
      })
    ).rejects.toThrow('killed');
    const executor = fakeExecutor([{ datname: staged }]);

    const report = await sweepStageDatabases(executor, { registryDir });

    expect(report.dropped).toEqual([staged]);
    expect(executor.statements).toContain(listStageDatabasesSql());
  });

  it('reports a staged database no claim names and leaves it standing', async () => {
    const stranger = mintStageDatabaseName(runTokenFor(crypto.randomUUID()));
    const executor = fakeExecutor([{ datname: stranger }]);

    const report = await sweepStageDatabases(executor, { registryDir });

    expect(report).toEqual({ dropped: [], unowned: [stranger] });
    expect(executor.statements).not.toContain(dropDatabaseSql(stranger));
  });

  it('names an unowned staged database on the console rather than passing it in silence', async () => {
    const warn = vi.spyOn(console, 'warn');
    const stranger = mintStageDatabaseName(runTokenFor(crypto.randomUUID()));

    await sweepStageDatabases(fakeExecutor([{ datname: stranger }]), { registryDir });

    expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).toContain(stranger);
  });

  /**
   * The run ended the way it meant to, so its record is gone and the only thing
   * left naming an owner is the run id the staging name carries itself.
   */
  it('drops a staged database of a run that ended and took its record with it', async () => {
    const ended = await run(() => Promise.resolve(currentRunId() ?? ''));
    const staged = mintStageDatabaseName(runTokenFor(ended));
    const executor = fakeExecutor([{ datname: staged }]);

    const report = await sweepStageDatabases(executor, { registryDir });

    expect(report.dropped).toEqual([staged]);
    expect(executor.statements).toContain(dropDatabaseSql(staged));
  });

  it('leaves a staged database standing whose named run is still holding its claim', async () => {
    await run(async () => {
      // Nothing is recorded here on purpose: the name is the whole attribution.
      const staged = mintStageDatabaseName(runTokenFor(currentRunId() ?? ''));
      const executor = fakeExecutor([{ datname: staged }]);

      const report = await sweepStageDatabases(executor, { registryDir });

      expect(report.dropped).toEqual([]);
      expect(executor.statements).not.toContain(dropDatabaseSql(staged));
    });
  });

  it('reports a staged database naming a run the registry never held', async () => {
    const staged = mintStageDatabaseName(runTokenFor(crypto.randomUUID()));
    const executor = fakeExecutor([{ datname: staged }]);

    const report = await sweepStageDatabases(executor, { registryDir });

    expect(report.unowned).toEqual([staged]);
    expect(report.dropped).toEqual([]);
  });

  it('reports a staged database of a run that ended before names carried a run id', async () => {
    await run(() => Promise.resolve());
    const executor = fakeExecutor([{ datname: 'hb_stage_ab12cd34ef567890' }]);

    const report = await sweepStageDatabases(executor, { registryDir });

    expect(report.unowned).toEqual(['hb_stage_ab12cd34ef567890']);
    expect(report.dropped).toEqual([]);
  });

  it("leaves a staged database standing while a live run's record could not be read", async () => {
    const staged = mintStageDatabaseName(runTokenFor(crypto.randomUUID()));
    const executor = fakeExecutor([{ datname: staged }]);

    const report = await run(async () => {
      await recordOwnedResource('database', staged);
      damageOwnRecord();
      return sweepStageDatabases(executor, { registryDir });
    });

    expect(report.dropped).toEqual([]);
    expect(executor.statements).not.toContain(dropDatabaseSql(staged));
  });

  it('says which run directory left that staged database standing, so a human can go and look', async () => {
    const warn = vi.spyOn(console, 'warn');
    const staged = mintStageDatabaseName(runTokenFor(crypto.randomUUID()));

    const runId = await run(async () => {
      await recordOwnedResource('database', staged);
      const named = damageOwnRecord();
      await sweepStageDatabases(fakeExecutor([{ datname: staged }]), { registryDir });
      return named;
    });

    const standing = warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('left standing'));
    expect(standing.join('\n')).toContain(runId);
  });
});

describe('dropRunDatabases', () => {
  it('drops only the databases belonging to the given run', async () => {
    const executor = fakeExecutor([
      { datname: 'hb_t_mine_w1', comment: createdComment(NOW) },
      { datname: 'hb_t_mine_w2', comment: createdComment(NOW) },
      { datname: 'hb_t_theirs_w1', comment: createdComment(NOW) },
    ]);

    const dropped = await dropRunDatabases(executor, 'mine');

    expect(dropped).toEqual(['hb_t_mine_w1', 'hb_t_mine_w2']);
  });
});

describe('ensureSlotDatabase', () => {
  it('clones the template and stamps the creation time', async () => {
    const executor = fakeExecutor();

    await ensureSlotDatabase(executor, 'hb_t_a_w1', NOW);

    expect(executor.statements[0]).toBe(
      `CREATE DATABASE "hb_t_a_w1" TEMPLATE "${TEMPLATE_DATABASE}"`
    );
    expect(executor.statements[1]).toBe(
      `COMMENT ON DATABASE "hb_t_a_w1" IS '${CREATED_COMMENT_PREFIX}${isoAt(NOW.getTime())}'`
    );
  });

  it('treats an already-created database as done rather than re-stamping it', async () => {
    const executor = fakeExecutor([], { 'CREATE DATABASE': { code: '42P04' } });

    await ensureSlotDatabase(executor, 'hb_t_a_w1', NOW);

    expect(executor.statements).toHaveLength(1);
  });

  it('treats a duplicate wrapped by the query layer as done', async () => {
    // The driver error the harness actually sees is a drizzle
    // `Failed query: ...` wrapper; the Postgres code rides its cause.
    const wrapped = new Error('Failed query: CREATE DATABASE', { cause: { code: '42P04' } });
    const executor = fakeExecutor([], { 'CREATE DATABASE': wrapped });

    await ensureSlotDatabase(executor, 'hb_t_a_w1', NOW);

    expect(executor.statements).toHaveLength(1);
  });

  it('treats a truly simultaneous duplicate as done', async () => {
    // Two creates in the same instant collide on the pg_database unique index
    // and report a unique violation rather than duplicate_database.
    const executor = fakeExecutor([], { 'CREATE DATABASE': { code: '23505' } });

    await ensureSlotDatabase(executor, 'hb_t_a_w1', NOW);

    expect(executor.statements).toHaveLength(1);
  });

  it('propagates any other creation failure', async () => {
    const executor = fakeExecutor([], { 'CREATE DATABASE': { code: '53300' } });

    await expect(ensureSlotDatabase(executor, 'hb_t_a_w1', NOW)).rejects.toMatchObject({
      code: '53300',
    });
  });
});

describe('ensureDatabaseExists', () => {
  it('creates the database when the cluster does not have it', async () => {
    const executor = fakeExecutor();

    const created = await ensureDatabaseExists(executor, 'hushbox_e2e');

    expect(executor.statements).toEqual(['CREATE DATABASE "hushbox_e2e"']);
    expect(created).toBe(true);
  });

  it('creates an empty database rather than a clone of the test template', async () => {
    const executor = fakeExecutor();

    await ensureDatabaseExists(executor, 'hushbox_e2e');

    expect(executor.statements[0]).not.toContain('TEMPLATE');
  });

  it('reports a database that was already there as nothing to do', async () => {
    const executor = fakeExecutor([], { 'CREATE DATABASE': { code: '42P04' } });

    await expect(ensureDatabaseExists(executor, 'hushbox_e2e')).resolves.toBe(false);
  });

  it('propagates any other creation failure', async () => {
    const executor = fakeExecutor([], { 'CREATE DATABASE': { code: '53300' } });

    await expect(ensureDatabaseExists(executor, 'hushbox_e2e')).rejects.toMatchObject({
      code: '53300',
    });
  });
});

/**
 * One cluster, and an executor per checker looking at it. The live template's
 * comment is shared state, and a rename onto a name that already exists is
 * refused the way the cluster refuses it — which is the whole of the publish
 * race: whichever checker loses that rename used to propagate the refusal to
 * its caller.
 */
function sharedCluster(): { executor: () => SqlExecutor } {
  const comments = new Map<string, string>();
  /** The live template's comment, or `undefined` while no template exists. */
  let template: string | undefined;

  const exec = async (statement: string): Promise<void> => {
    await Promise.resolve();
    const commented = /^COMMENT ON DATABASE "([^"]+)" IS '(.*)'$/.exec(statement);
    if (commented?.[1] !== undefined) {
      comments.set(commented[1], commented[2] ?? '');
      return;
    }
    const renamed = /^ALTER DATABASE "([^"]+)" RENAME TO "([^"]+)"$/.exec(statement);
    if (renamed?.[2] === TEMPLATE_DATABASE) {
      if (template !== undefined) {
        throw Object.assign(new Error('duplicate_database'), { code: '42P04' });
      }
      template = comments.get(renamed[1] ?? '');
    }
  };

  const query = async <T>(statement: string): Promise<T[]> => {
    await Promise.resolve();
    if (statement !== templateFingerprintSql()) return [] as T[];
    return (template === undefined ? [] : [{ comment: template }]) as T[];
  };

  return { executor: (): SqlExecutor => ({ exec, query }) };
}

/** Writes one file of a fixture checkout, making its directories. */
function writeInCheckout(checkout: string, relativePath: string, contents: string): void {
  const file = path.join(checkout, ...relativePath.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

/**
 * A checkout whose seed reaches one module through another and a workspace
 * package through the link pnpm makes for it, beside a file it never reaches.
 */
async function seedCheckout(): Promise<string> {
  const checkout = await mkdtemp(path.join(os.tmpdir(), 'hushbox-seed-checkout-'));
  const write = (relativePath: string, contents: string): void => {
    writeInCheckout(checkout, relativePath, contents);
  };
  write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
  write(
    'scripts/tsconfig.json',
    JSON.stringify({ compilerOptions: { module: 'ESNext', moduleResolution: 'bundler' } })
  );
  write(
    'scripts/seed.ts',
    "import { first } from './lib/first.js';\nimport { shared } from '@hushbox/fixture';\n" +
      'export const seeded = first + shared;\n'
  );
  write('scripts/lib/first.ts', "export { second as first } from './second.js';\n");
  write('scripts/lib/second.ts', "export const second = 'two imports deep';\n");
  write('scripts/unreached.ts', "export const unreached = 'no import names this';\n");
  write(
    'packages/fixture/package.json',
    JSON.stringify({ name: '@hushbox/fixture', exports: { '.': './src/index.ts' } })
  );
  write('packages/fixture/src/index.ts', "export const shared = 'workspace source';\n");
  const link = path.join(checkout, 'scripts', 'node_modules', '@hushbox', 'fixture');
  mkdirSync(path.dirname(link), { recursive: true });
  // A junction, so the link needs no privilege on Windows; elsewhere the type is ignored.
  symlinkSync(path.join(checkout, 'packages', 'fixture'), link, 'junction');
  return checkout;
}

/** A stand-in template holds no chain-described schema, so nothing is compared against it. */
const verifyNothing = (): Promise<void> => Promise.resolve();

describe('templateVerifier', () => {
  registryPerTest();

  /** The clone this verifier made, read out of the statements it issued. */
  function clonedName(statements: readonly string[]): string {
    const created = statements.find((statement) =>
      statement.includes(`TEMPLATE "${TEMPLATE_DATABASE}"`)
    );
    return /CREATE DATABASE "([^"]+)"/.exec(created ?? '')?.[1] ?? '';
  }

  it('compares a clone of the clone source rather than the clone source itself', async () => {
    const executor = fakeExecutor([]);
    const compared: string[] = [];

    await run(() =>
      templateVerifier(executor, 'postgres://u:p@localhost:5432/hushbox', (url) => {
        compared.push(url);
        return Promise.resolve();
      })()
    );

    const clone = clonedName(executor.statements);
    expect(clone.startsWith(STAGE_DATABASE_PREFIX)).toBe(true);
    expect(compared).toEqual([`postgres://u:p@localhost:5432/${clone}`]);
  });

  it('drops the clone it made once the comparison returns', async () => {
    const executor = fakeExecutor([]);

    await run(() =>
      templateVerifier(executor, 'postgres://u:p@localhost:5432/hushbox', () => Promise.resolve())()
    );

    expect(executor.statements).toContain(dropIdleDatabaseSql(clonedName(executor.statements)));
  });

  it('drops the clone it made and lets a refusal through', async () => {
    const executor = fakeExecutor([]);

    await expect(
      run(() =>
        templateVerifier(executor, 'postgres://u:p@localhost:5432/hushbox', () =>
          Promise.reject(new Error('Schema drift: view growth_daily: the migrations record it'))
        )()
      )
    ).rejects.toThrow(/growth_daily/);
    expect(executor.statements).toContain(dropIdleDatabaseSql(clonedName(executor.statements)));
  });
});

describe('ensureTemplateDatabase', () => {
  registryPerTest();

  /** The seed-input digest every check in this group is handed. */
  const SEED_DIGEST = 'seed1';

  /** The stamp of a template built for migrations `fp1` and {@link SEED_DIGEST}. */
  function currentStamp(): string {
    return templateComment(templateFingerprint('fp1', SEED_DIGEST));
  }

  it('refuses to stage a template it cannot record against a run', async () => {
    const executor = fakeExecutor([]);

    await expect(
      ensureTemplateDatabase(executor, 'fp1', async () => {}, {
        registryDir,
        verifyTemplate: verifyNothing,
        seedInputsDigest: SEED_DIGEST,
      })
    ).rejects.toThrow(/run claim/);
    expect(executor.statements.filter((statement) => statement.startsWith('CREATE'))).toEqual([]);
  });

  it('compares the live template against the recorded schema before skipping the build', async () => {
    const order: string[] = [];
    const executor = fakeExecutor([{ comment: currentStamp() }]);

    const built = await run(() =>
      ensureTemplateDatabase(
        executor,
        'fp1',
        async () => {
          order.push('build');
          await Promise.resolve();
        },
        {
          registryDir,
          verifyTemplate: async () => {
            order.push('verifyTemplate');
            await Promise.resolve();
          },
          seedInputsDigest: SEED_DIGEST,
        }
      )
    );

    expect(built).toBe(false);
    expect(order).toEqual(['verifyTemplate']);
  });

  it('refuses when the template the fingerprint accepted has drifted', async () => {
    const executor = fakeExecutor([{ comment: currentStamp() }]);

    await expect(
      run(() =>
        ensureTemplateDatabase(executor, 'fp1', async () => {}, {
          registryDir,
          verifyTemplate: () =>
            Promise.reject(new Error('Schema drift: view growth_daily: the migrations record it')),
          seedInputsDigest: SEED_DIGEST,
        })
      )
    ).rejects.toThrow(/growth_daily/);
  });

  it('leaves the comparison to the build on the path that builds', async () => {
    // A build ends in `pnpm db:migrate`, which runs the same comparison as its
    // own second half, against the database it just filled.
    const verifyTemplate = vi.fn(() => Promise.resolve());
    const executor = fakeExecutor([]);

    await run(() =>
      ensureTemplateDatabase(executor, 'fp1', async () => {}, {
        registryDir,
        verifyTemplate,
        seedInputsDigest: SEED_DIGEST,
      })
    );

    expect(verifyTemplate).not.toHaveBeenCalled();
  });

  it('builds under a staging name and publishes it by rename when none is live', async () => {
    const executor = fakeExecutor([]);
    let staged = '';

    const built = await run(() =>
      ensureTemplateDatabase(
        executor,
        'fp1',
        async (databaseName) => {
          staged = databaseName;
          await Promise.resolve();
        },
        { registryDir, verifyTemplate: verifyNothing, seedInputsDigest: SEED_DIGEST }
      )
    );

    expect(built).toBe(true);
    expect(staged.startsWith(STAGE_DATABASE_PREFIX)).toBe(true);
    expect(executor.statements).toContain(`CREATE DATABASE "${staged}"`);
    expect(executor.statements).toContain(renameDatabaseSql(staged, TEMPLATE_DATABASE));
  });

  it('never creates or drops the live template name', async () => {
    const executor = fakeExecutor([{ comment: templateComment('stale') }]);

    await run(() =>
      ensureTemplateDatabase(executor, 'fp1', async () => {}, {
        registryDir,
        verifyTemplate: verifyNothing,
        seedInputsDigest: SEED_DIGEST,
      })
    );

    const naming = executor.statements.filter(
      (statement) =>
        statement.startsWith('CREATE DATABASE') || statement.startsWith('DROP DATABASE')
    );
    expect(naming.filter((statement) => statement.includes(`"${TEMPLATE_DATABASE}"`))).toEqual([]);
  });

  it('stamps the staged database after its build and before the rename that publishes it', async () => {
    const order: string[] = [];
    const executor = fakeExecutor([]);
    const originalExec = executor.exec;
    const tracking = {
      ...executor,
      exec: async (statement: string) => {
        order.push(statement.split(' ', 2).join(' ').toLowerCase());
        await originalExec(statement);
      },
    };

    await run(() =>
      ensureTemplateDatabase(
        tracking,
        'fp1',
        async () => {
          order.push('build');
          await Promise.resolve();
        },
        { registryDir, verifyTemplate: verifyNothing, seedInputsDigest: SEED_DIGEST }
      )
    );

    expect(order).toEqual(['create database', 'build', 'comment on', 'alter database']);
  });

  it('records the staging database against the run before it creates it', async () => {
    let stateWhenCreated: string | undefined;
    const executor = fakeExecutor([]);
    const watching: SqlExecutor = {
      query: executor.query,
      exec: async (statement: string) => {
        const created = /^CREATE DATABASE "([^"]+)"$/.exec(statement)?.[1];
        if (created !== undefined) {
          const ownership = await readOwnership(registryDir);
          stateWhenCreated = ownership.stateOfResource('database', created);
        }
        await executor.exec(statement);
      },
    };

    await run(() =>
      ensureTemplateDatabase(watching, 'fp1', async () => {}, {
        registryDir,
        verifyTemplate: verifyNothing,
        seedInputsDigest: SEED_DIGEST,
      })
    );

    expect(stateWhenCreated).toBe('owned-live');
  });

  it('records the retiring name before the publish brings a database into existence under it', async () => {
    let stateWhenPublished: string | undefined;
    const executor = fakeExecutor([{ comment: templateComment('stale') }]);
    const watching: SqlExecutor = {
      query: executor.query,
      exec: async (statement: string) => {
        // The outgoing template is renamed to the retiring name inside the
        // publish, so the first rename's target is the name being brought in.
        const retired = statement.startsWith('BEGIN;')
          ? /RENAME TO "([^"]+)"/.exec(statement)?.[1]
          : undefined;
        if (retired !== undefined) {
          const ownership = await readOwnership(registryDir);
          stateWhenPublished = ownership.stateOfResource('database', retired);
        }
        await executor.exec(statement);
      },
    };

    await run(() =>
      ensureTemplateDatabase(watching, 'fp1', async () => {}, {
        registryDir,
        verifyTemplate: verifyNothing,
        seedInputsDigest: SEED_DIGEST,
      })
    );

    expect(stateWhenPublished).toBe('owned-live');
  });

  it('compares against a seed-input digest it is handed instead of walking a checkout', async () => {
    const executor = fakeExecutor([
      { comment: templateComment(templateFingerprint('fp1', 'handed')) },
    ]);
    const build = vi.fn(async () => {});

    const built = await run(() =>
      ensureTemplateDatabase(executor, 'fp1', build, {
        registryDir,
        verifyTemplate: verifyNothing,
        seedInputsDigest: 'handed',
      })
    );

    expect(built).toBe(false);
    expect(build).not.toHaveBeenCalled();
  });

  it('checks the template against the seed inputs of its own checkout when handed no digest', async () => {
    const checkout = path.resolve(import.meta.dirname, '..', '..', '..');
    const executor = fakeExecutor([]);
    // Walked on both sides of the call, so one concurrent edit landing during it
    // still leaves the digest the call walked among the two.
    const before = seedInputsFingerprint(checkout);

    await run(() =>
      ensureTemplateDatabase(executor, 'fp1', async () => {}, {
        registryDir,
        verifyTemplate: verifyNothing,
      })
    );
    const after = seedInputsFingerprint(checkout);

    const stamp = executor.statements.find((statement) => statement.startsWith('COMMENT ON'));
    const written = /IS '(.*)'$/.exec(stamp ?? '')?.[1];
    expect(
      [before, after].map((digest) => templateComment(templateFingerprint('fp1', digest)))
    ).toContain(written);
  });

  it('leaves a template whose fingerprint already matches alone', async () => {
    const executor = fakeExecutor([{ comment: currentStamp() }]);
    const build = vi.fn(async () => {});

    const built = await ensureTemplateDatabase(executor, 'fp1', build, {
      registryDir,
      verifyTemplate: verifyNothing,
      seedInputsDigest: SEED_DIGEST,
    });

    expect(built).toBe(false);
    expect(build).not.toHaveBeenCalled();
    // Nothing was claimed either: the read that answered it came before the
    // claim, so a current template makes no caller wait for anything.
    expect(await readdir(registryDir)).not.toContainEqual(expect.stringMatching(/^test-template/));
  });

  it('retires the outgoing template in the one transaction that publishes the new one', async () => {
    const executor = fakeExecutor([{ comment: templateComment('stale') }]);
    let staged = '';

    const built = await run(() =>
      ensureTemplateDatabase(
        executor,
        'fp1',
        async (databaseName) => {
          staged = databaseName;
          await Promise.resolve();
        },
        { registryDir, verifyTemplate: verifyNothing, seedInputsDigest: SEED_DIGEST }
      )
    );
    const publish = executor.statements.find((statement) => statement.startsWith('BEGIN'));
    const retired = /RENAME TO "([^"]+)"/.exec(publish ?? '')?.[1] ?? '';

    expect(built).toBe(true);
    expect(publish).toBe(publishTemplateSql(staged, retired));
    expect(executor.statements.at(-1)).toBe(`DROP DATABASE IF EXISTS "${retired}"`);
  });

  it('drops the retired template without forcing sessions closed', async () => {
    const executor = fakeExecutor([{ comment: templateComment('stale') }]);

    await run(() =>
      ensureTemplateDatabase(executor, 'fp1', async () => {}, {
        registryDir,
        verifyTemplate: verifyNothing,
        seedInputsDigest: SEED_DIGEST,
      })
    );

    expect(executor.statements.filter((statement) => statement.includes('WITH (FORCE)'))).toEqual(
      []
    );
  });

  it('rebuilds a template left uncommented by an interrupted build', async () => {
    const executor = fakeExecutor([{ comment: null }]);
    const build = vi.fn(async () => {});

    expect(
      await run(() =>
        ensureTemplateDatabase(executor, 'fp1', build, {
          registryDir,
          verifyTemplate: verifyNothing,
          seedInputsDigest: SEED_DIGEST,
        })
      )
    ).toBe(true);
  });

  it('discards its own build when another checker published the same migrations first', async () => {
    const executor = sequencedExecutor([
      [{ comment: templateComment('stale') }],
      [{ comment: templateComment('stale') }],
      [{ comment: currentStamp() }],
    ]);
    let builds = 0;
    let staged = '';

    const built = await run(() =>
      ensureTemplateDatabase(
        executor,
        'fp1',
        async (databaseName) => {
          builds += 1;
          staged = databaseName;
          await Promise.resolve();
        },
        { registryDir, verifyTemplate: verifyNothing, seedInputsDigest: SEED_DIGEST }
      )
    );

    expect(built).toBe(false);
    expect(builds).toBe(1);
    expect(executor.statements.at(-1)).toBe(`DROP DATABASE IF EXISTS "${staged}"`);
    expect(executor.statements.filter((statement) => statement.startsWith('BEGIN'))).toEqual([]);
  });

  it('builds once when two checkers arrive on a template that is not there', async () => {
    const cluster = sharedCluster();
    const builds: string[] = [];
    let secondHasLooked = (): void => {};
    const looked = new Promise<void>((resolve) => {
      secondHasLooked = resolve;
    });
    const watched = cluster.executor();
    const second: SqlExecutor = {
      exec: watched.exec,
      query: async <T>(statement: string): Promise<T[]> => {
        if (statement === templateFingerprintSql()) secondHasLooked();
        return watched.query<T>(statement);
      },
    };

    const outcomes = await run(() =>
      Promise.all([
        ensureTemplateDatabase(
          cluster.executor(),
          'fp1',
          async (databaseName) => {
            builds.push(databaseName);
            // Held open until the second checker has looked at the template, so
            // the two are genuinely both inside the window this arbitrates.
            await looked;
          },
          { registryDir, verifyTemplate: verifyNothing, seedInputsDigest: SEED_DIGEST }
        ),
        ensureTemplateDatabase(
          second,
          'fp1',
          async (databaseName) => {
            builds.push(databaseName);
            await Promise.resolve();
          },
          { registryDir, verifyTemplate: verifyNothing, seedInputsDigest: SEED_DIGEST }
        ),
      ])
    );

    expect(builds).toHaveLength(1);
    expect(outcomes.toSorted()).toEqual([false, true]);
  });

  it('resolves both checkers when two publish onto a template name at once', async () => {
    const cluster = sharedCluster();
    const builds: string[] = [];
    const check = (): Promise<boolean> =>
      ensureTemplateDatabase(
        cluster.executor(),
        'fp1',
        async (databaseName) => {
          builds.push(databaseName);
          await Promise.resolve();
        },
        { registryDir, verifyTemplate: verifyNothing, seedInputsDigest: SEED_DIGEST }
      );

    const outcomes = await run(() => Promise.all([check(), check()]));

    expect(outcomes.toSorted()).toEqual([false, true]);
    expect(builds).toHaveLength(1);
  });

  it('leaves a build killed part-way nothing but a staged database its run claim names', async () => {
    const cluster = sharedCluster();
    let staged = '';

    await expect(
      run(() =>
        ensureTemplateDatabase(
          cluster.executor(),
          'fp1',
          async (databaseName) => {
            staged = databaseName;
            await Promise.resolve();
            throw new Error('killed part-way');
          },
          { registryDir, verifyTemplate: verifyNothing, seedInputsDigest: SEED_DIGEST }
        )
      )
    ).rejects.toThrow('killed part-way');

    // Nothing was published, so the live name is where it was: absent.
    expect(
      await cluster.executor().query<{ comment: string | null }>(templateFingerprintSql())
    ).toEqual([]);
    // And the staging database is the next run's to reclaim rather than a
    // human's to remove: the dead build recorded it before it created it.
    const sweeper = fakeExecutor([{ datname: staged }]);
    const swept = await sweepStageDatabases(sweeper, { registryDir });
    expect(swept.dropped).toEqual([staged]);
  });
});

describe('the template fingerprint over what the seed is built from', () => {
  registryPerTest();

  let checkout = '';

  beforeEach(async () => {
    checkout = await seedCheckout();
  });

  afterEach(async () => {
    await rm(checkout, { recursive: true, force: true });
  });

  /** One template check against `cluster`, for migrations that never change. */
  function check(cluster: ReturnType<typeof sharedCluster>): Promise<boolean> {
    return run(() =>
      ensureTemplateDatabase(cluster.executor(), 'fp1', async () => {}, {
        registryDir,
        verifyTemplate: verifyNothing,
        seedInputsDigest: seedInputsFingerprint(checkout),
      })
    );
  }

  it('rebuilds the template when a module the seed reaches two imports deep changes', async () => {
    const cluster = sharedCluster();
    expect(await check(cluster)).toBe(true);

    writeInCheckout(checkout, 'scripts/lib/second.ts', "export const second = 'edited';\n");

    expect(await check(cluster)).toBe(true);
  });

  it('rebuilds the template when a workspace package source the seed imports changes', async () => {
    const cluster = sharedCluster();
    expect(await check(cluster)).toBe(true);

    writeInCheckout(checkout, 'packages/fixture/src/index.ts', "export const shared = 'edited';\n");

    expect(await check(cluster)).toBe(true);
  });

  it('keeps the template when a file the seed does not reach changes', async () => {
    const cluster = sharedCluster();
    expect(await check(cluster)).toBe(true);

    writeInCheckout(checkout, 'scripts/unreached.ts', "export const unreached = 'edited';\n");

    expect(await check(cluster)).toBe(false);
  });

  it('rebuilds a template stamped from the migrations alone', async () => {
    const executor = fakeExecutor([{ comment: 'hushbox-test-template migrations=fp1' }]);

    const built = await run(() =>
      ensureTemplateDatabase(executor, 'fp1', async () => {}, {
        registryDir,
        verifyTemplate: verifyNothing,
        seedInputsDigest: seedInputsFingerprint(checkout),
      })
    );

    expect(built).toBe(true);
  });
});

describe('buildTemplateDatabase', () => {
  it('migrates then seeds, both retargeted at the template', async () => {
    const calls: { args: readonly string[]; database: string | undefined }[] = [];

    await buildTemplateDatabase('/repo', TEMPLATE_DATABASE, async (_command, args, options) => {
      calls.push({ args, database: options.env[TEST_DATABASE_VARIABLE] });
      await Promise.resolve();
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.args.join(' ')).toContain('db:migrate');
    expect(calls[1]?.args.join(' ')).toContain('db:seed');
    expect(calls.map((call) => call.database)).toEqual([TEMPLATE_DATABASE, TEMPLATE_DATABASE]);
  });

  it('fails loudly when a build step fails', async () => {
    await expect(
      buildTemplateDatabase('/repo', TEMPLATE_DATABASE, async () => {
        await Promise.resolve();
        throw new Error('migrate exploded');
      })
    ).rejects.toThrow('migrate exploded');
  });
});

describe('runBuildCommand', () => {
  it('resolves when the command succeeds', async () => {
    await expect(
      runBuildCommand('node', ['-e', ''], { cwd: process.cwd(), env: process.env })
    ).resolves.toBeUndefined();
  });

  it('rejects when the command fails', async () => {
    await expect(
      runBuildCommand('node', ['-e', 'process.exit(3)'], { cwd: process.cwd(), env: process.env })
    ).rejects.toThrow();
  });
});

describe('createTestDbExecutor', () => {
  it('runs statements against the live database and closes its connection', async () => {
    const url = process.env['DATABASE_URL'];
    if (url === undefined) throw new Error('DATABASE_URL is required for this test');
    const executor = createTestDbExecutor(url);

    try {
      const rows = await executor.query<{ one: number }>('SELECT 1 AS one');
      expect(rows[0]?.one).toBe(1);
      await executor.exec('SELECT 1');
    } finally {
      await executor.close();
    }
  });

  it('counts the sessions connected to a database', async () => {
    const url = process.env['DATABASE_URL'];
    if (url === undefined) throw new Error('DATABASE_URL is required for this test');
    const executor = createTestDbExecutor(url);

    try {
      expect(await connectionCount(executor, 'template0')).toBe(0);
    } finally {
      await executor.close();
    }
  });
});

describe('preconditions', () => {
  it('reports no connections when the count query yields no row', async () => {
    expect(await connectionCount(fakeExecutor([]), 'hb_tpl')).toBe(0);
  });

  it('refuses to provision a slot without a run token', async () => {
    await expect(provisionSlotDatabase({ DATABASE_URL: 'postgres://h/x' }, '1')).rejects.toThrow(
      /HB_TEST_RUN_TOKEN is unset/
    );
  });

  it('refuses to provision a slot without a database URL', async () => {
    await expect(provisionSlotDatabase({ HB_TEST_RUN_TOKEN: 'abc123' }, '1')).rejects.toThrow(
      /DATABASE_URL is required/
    );
  });

  it('names the entry point that loads the env files when DATABASE_URL is absent', async () => {
    // The reachable cause is a bare `npx vitest`, which never loads them.
    await expect(provisionSlotDatabase({ HB_TEST_RUN_TOKEN: 'abc123' }, '1')).rejects.toThrow(
      /scripts\/with-env\.ts/
    );
  });
});

/**
 * An executor that can name only the databases it was handed. Every statement
 * that acts on a database quotes its identifier, so a statement carrying one
 * outside the allowlist is refused here rather than sent to the cluster.
 *
 * This is what scopes the live tests below to their own databases, and it is a
 * guard on the test rather than a claim about the code: these tests run against
 * a cluster other runs are using at the same time, so a fault in what they
 * exercise must land as a refusal here instead of as someone else's dropped
 * database.
 */
function scopedTo(executor: SqlExecutor, allowed: readonly string[]): SqlExecutor {
  const permitted = new Set(allowed);
  const refuseOutsiders = (statement: string): void => {
    for (const [, name] of statement.matchAll(/"([^"]+)"/g)) {
      if (name !== undefined && !permitted.has(name)) {
        throw new Error(`out of scope: this executor may not name "${name}"`);
      }
    }
  };
  return {
    exec: async (statement: string) => {
      refuseOutsiders(statement);
      await executor.exec(statement);
    },
    query: async <T>(statement: string): Promise<T[]> => {
      refuseOutsiders(statement);
      return executor.query<T>(statement);
    },
  };
}

describe('the executor the live tests are scoped to', () => {
  let registryDir: string;

  beforeEach(async () => {
    registryDir = await mkdtemp(path.join(os.tmpdir(), 'hushbox-scope-db-'));
  });

  afterEach(async () => {
    await rm(registryDir, { recursive: true, force: true });
  });

  it('lets a reap that names nobody else through untouched', async () => {
    // The pass the reclaimer makes over a database it may not name: it
    // classifies the row and issues no statement carrying that name, so the
    // scope has nothing to refuse and the reap completes. The row carries a
    // readable stamp, which is what leaves it standing — an unreadable one is
    // reclaimed, and a reclaim is a statement naming it.
    const inner = fakeExecutor([{ datname: 'hb_t_someone_else_w1', comment: createdComment(NOW) }]);

    const report = await reclaimTestDatabases(scopedTo(inner, []), NOW, { registryDir });

    expect(report).toEqual({ dropped: [], unowned: ['hb_t_someone_else_w1'] });
    expect(inner.statements).not.toContain(dropDatabaseSql('hb_t_someone_else_w1'));
  });

  it('refuses a statement naming a database it was not given', async () => {
    const inner = fakeExecutor();
    const scoped = scopedTo(inner, ['hb_t_mine_w1']);

    await expect(scoped.exec(dropDatabaseSql('hb_t_someone_else_w1'))).rejects.toThrow(
      'hb_t_someone_else_w1'
    );
    expect(inner.statements).toEqual([]);
  });

  it('passes through a statement naming only a database it was given', async () => {
    const inner = fakeExecutor();
    const scoped = scopedTo(inner, ['hb_t_mine_w1']);

    await scoped.exec(dropDatabaseSql('hb_t_mine_w1'));

    expect(inner.statements).toEqual([dropDatabaseSql('hb_t_mine_w1')]);
  });

  it('passes through a listing, which names no database at all', async () => {
    const inner = fakeExecutor();
    const scoped = scopedTo(inner, []);

    await scoped.query(listTestDatabasesSql());

    expect(inner.statements).toEqual([listTestDatabasesSql()]);
  });

  it('refuses a listing statement that was rewritten to name an outsider', async () => {
    const inner = fakeExecutor();
    const scoped = scopedTo(inner, []);

    await expect(scoped.query(dropDatabaseSql('hb_t_someone_else_w1'))).rejects.toThrow(
      'hb_t_someone_else_w1'
    );
    expect(inner.statements).toEqual([]);
  });
});

describe('the live run lifecycle', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');

  /**
   * The build for a case that expects the live template current, as this run's
   * global setup left it. It refuses rather than doing nothing: if the template
   * no longer matches by then, as when another run has published a newer one,
   * a build that did nothing would publish an empty database under the
   * template's name.
   */
  const refuseToBuild = (): Promise<void> =>
    Promise.reject(new Error('the live template was expected current, so nothing builds'));

  /**
   * The seed-input digest this run's global setup made the live template
   * current against. The cases here that prepare a run check the template
   * against it rather than walking the checkout again, so a source edit made
   * since setup is not read as a stale template.
   */
  function digestOfThisRun(): string {
    const digest = process.env[SEED_INPUTS_DIGEST_VARIABLE];
    if (digest === undefined || digest === '') {
      throw new Error(
        `${SEED_INPUTS_DIGEST_VARIABLE} is unset: the vitest global setup did not export it`
      );
    }
    return digest;
  }

  // Everything `prepareRun` requires and nothing else, so a variable it starts
  // reading fails this test rather than silently falling back to the ambient one.
  const REQUIRED = [
    'DATABASE_URL',
    'R2_S3_ENDPOINT',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
  ] as const;

  function liveEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const name of REQUIRED) {
      const value = process.env[name];
      if (value === undefined) throw new Error(`${name} is required for this test`);
      env[name] = value;
    }
    return env;
  }

  async function withExecutor<T>(use: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    return withMaintenanceExecutor(liveEnv()['DATABASE_URL']!, use);
  }

  it(
    'leaves a current template with no connection holding it open',
    { timeout: 180_000 },
    async () => {
      const env = liveEnv();

      await prepareRun(
        env,
        await migrationsFingerprint(repoRoot),
        (name) => buildTemplateDatabase(repoRoot, name, runBuildCommand),
        digestOfThisRun()
      );

      const [connections, fingerprint] = await withExecutor(async (executor) => [
        await connectionCount(executor, TEMPLATE_DATABASE),
        await executor.query<{ comment: string | null }>(templateFingerprintSql()),
      ]);
      expect(connections).toBe(0);
      expect(fingerprint[0]?.comment).toBe(
        templateComment(
          templateFingerprint(await migrationsFingerprint(repoRoot), digestOfThisRun())
        )
      );
    }
  );

  it('mints one run token and keeps it across repeated preparation', async () => {
    const env = liveEnv();
    const build = vi.fn(refuseToBuild);
    const fingerprint = await migrationsFingerprint(repoRoot);

    const first = await prepareRun(env, fingerprint, build, digestOfThisRun());
    const second = await prepareRun(env, fingerprint, build, digestOfThisRun());

    expect(runIdFromToken(first)).toBe(currentRunId());
    expect(second).toBe(first);
    expect(build).not.toHaveBeenCalled();
  });

  it('exports the seed-input digest it prepared the template against', async () => {
    const env = liveEnv();

    await prepareRun(env, await migrationsFingerprint(repoRoot), refuseToBuild, digestOfThisRun());

    expect(env[SEED_INPUTS_DIGEST_VARIABLE]).toBe(digestOfThisRun());
  });

  it('refuses to prepare a run it cannot record, before it creates anything', async () => {
    // The record is the only thing that can name this run's databases and
    // buckets to a later reclaimer, so a process holding no claim is refused
    // rather than left to create what nothing could ever attribute.
    vi.stubEnv(RUN_CLAIM_ENV, '');
    // An unparseable URL is what the first database call would reject, so the
    // refusal is only this one if it fires before any of that work — the same
    // shape the object-store precondition below is proven by.
    const env: NodeJS.ProcessEnv = { ...liveEnv(), DATABASE_URL: 'not-a-connection-string' };
    const build = vi.fn(async () => {});

    await expect(prepareRun(env, 'fingerprint', build)).rejects.toThrow('holds no run claim');
    expect(build).not.toHaveBeenCalled();
    expect(env[RUN_TOKEN_VARIABLE]).toBeUndefined();
  });

  it('refuses a missing object-store variable before it does any database work', async () => {
    // An unparseable URL is what the first database call would reject: whichever
    // precondition is checked first decides which of the two errors comes out.
    const env: NodeJS.ProcessEnv = { DATABASE_URL: 'not-a-connection-string' };
    const build = vi.fn(async () => {});

    await expect(prepareRun(env, 'fingerprint', build)).rejects.toThrow('R2_S3_ENDPOINT');
    expect(build).not.toHaveBeenCalled();
  });

  it("reclaims a dead run's database against the live cluster, and only that one", async () => {
    // The invocation running this suite is itself a registered run, and it
    // stamps its run directory into the environment every child inherits. Left
    // in place, `registerRun` below adopts that run instead of registering in
    // the scratch registry, and this case reads the machine-wide registry every
    // other process on this machine is writing.
    vi.stubEnv(RUN_CLAIM_ENV, '');

    const stamp = Math.random().toString(36).slice(2, 8);
    const names = {
      live: `hb_t_${stamp}live_w1`,
      dead: `hb_t_${stamp}dead_w1`,
      stranger: `hb_t_${stamp}else_w1`,
    };

    await withScratchDirectory('hushbox-live-reclaim-', async (registryDir) => {
      function asRun<T>(body: () => Promise<T>): Promise<T> {
        return registerRun(
          {
            command: 'pnpm test',
            mode: 'development',
            slot: 4,
            gitCommonDir: CHECKOUT,
            registryDir,
          },
          body
        );
      }

      try {
        await expect(
          asRun(async () => {
            await recordOwnedResource('database', runDatabasePrefix(`${stamp}dead`));
            throw new Error('killed');
          })
        ).rejects.toThrow('killed');

        await asRun(async () => {
          await recordOwnedResource('database', runDatabasePrefix(`${stamp}live`));
          await withExecutor(async (executor) => {
            for (const name of Object.values(names)) {
              await executor.exec(createDatabaseSql(name));
              await executor.exec(commentDatabaseSql(name, createdComment(new Date())));
            }
          });

          // The scoped executor is what keeps this test off a database it did not
          // create, whatever the code under test decides; the ceiling keeps the
          // three it did create out of the pre-registry migration's reach, so the
          // claims are what the assertions below are reading.
          const report = await withExecutor((executor) =>
            reclaimTestDatabases(scopedTo(executor, Object.values(names)), new Date(), {
              registryDir,
              maxAgeMs: Number.MAX_SAFE_INTEGER,
            })
          );

          expect(report.dropped).toContain(names.dead);
          expect(report.dropped).not.toContain(names.live);
          expect(report.unowned).toContain(names.stranger);

          const survivors = await withExecutor((executor) =>
            executor.query<DatabaseRow>(listTestDatabasesSql())
          );
          const present = survivors.map((row) => row.datname);
          expect(present).toContain(names.live);
          expect(present).toContain(names.stranger);
          expect(present).not.toContain(names.dead);
        });
      } finally {
        await withExecutor(async (executor) => {
          for (const name of Object.values(names)) await executor.exec(dropDatabaseSql(name));
        });
      }
    });
  });

  it("spares a live run's aged database on the cluster when its record cannot be read", async () => {
    // The same environment clearing the case above needs, and for the same
    // reason: this invocation is itself a registered run.
    vi.stubEnv(RUN_CLAIM_ENV, '');

    const stamp = Math.random().toString(36).slice(2, 8);
    const name = `hb_t_${stamp}unread_w1`;

    await withScratchDirectory('hushbox-live-unread-', async (registryDir) => {
      try {
        await registerRun(
          {
            command: 'pnpm test',
            mode: 'development',
            slot: 4,
            gitCommonDir: CHECKOUT,
            registryDir,
          },
          async () => {
            await recordOwnedResource('database', runDatabasePrefix(`${stamp}unread`));
            // The version-skew form of an unreadable record: a mode this
            // checkout has never heard of, written by a wider one. The run goes
            // on holding its lock, so it is as live as any other.
            const record = path.join(process.env[RUN_CLAIM_ENV] ?? '', 'run.json');
            const written: unknown = JSON.parse(readFileSync(record, 'utf8'));
            writeFileSync(
              record,
              JSON.stringify({
                ...(written as object),
                mode: 'a-mode-this-checkout-has-never-heard-of',
              })
            );

            await withExecutor(async (executor) => {
              await executor.exec(createDatabaseSql(name));
              // Old enough for the pre-registry age path to select it, which is
              // the path that used to issue a FORCE drop on this database.
              await executor.exec(
                commentDatabaseSql(name, createdComment(new Date(STALE_CUTOFF - HOUR_MS)))
              );
            });

            // Scoped to this test's own database: whatever the code under test
            // decides, a statement naming anyone else's is refused here.
            const report = await withExecutor((executor) =>
              reclaimTestDatabases(scopedTo(executor, [name]), NOW, { registryDir })
            );

            // The cluster first: what the report says is a claim about the
            // world, and the world is what a live run loses.
            const survivors = await withExecutor((executor) =>
              executor.query<DatabaseRow>(listTestDatabasesSql())
            );
            expect(survivors.map((row) => row.datname)).toContain(name);
            expect(report.dropped).toEqual([]);
          }
        );
      } finally {
        await withExecutor((executor) => executor.exec(dropDatabaseSql(name)));
      }
    });
  });

  it('gives a slot its own database, retargets the environment, and drops it at teardown', async () => {
    // A run of this case's own, in a registry of its own, because teardown
    // drops every database whose name carries the prepared run's token. Left
    // to adopt the invocation's own run, this case prepares under the token
    // every worker of that invocation is named under, and its teardown drops
    // all of their databases along with the one it created.
    vi.stubEnv(RUN_CLAIM_ENV, '');

    try {
      await withScratchDirectory('hushbox-live-slot-', async (registryDir) => {
        await registerRun(
          {
            command: 'pnpm test',
            mode: 'development',
            slot: 4,
            gitCommonDir: CHECKOUT,
            registryDir,
          },
          async () => {
            const env = liveEnv();
            const runToken = await prepareRun(
              env,
              await migrationsFingerprint(repoRoot),
              refuseToBuild,
              digestOfThisRun()
            );
            expect(runIdFromToken(runToken)).toBe(currentRunId());

            const databaseName = await provisionSlotDatabase(env, '97');

            expect(databaseName).toBe(slotDatabaseName(runToken, '97'));
            expect(env['DATABASE_URL']).toContain(`/${databaseName}`);
            expect(await withExecutor((executor) => connectionCount(executor, databaseName))).toBe(
              0
            );

            const repeat = await provisionSlotDatabase(env, '97');
            expect(repeat).toBe(databaseName);

            const dropped = await teardownRun(env);

            expect(dropped).toEqual([databaseName]);
            const survivors = await withExecutor((executor) =>
              executor.query<DatabaseRow>(listTestDatabasesSql())
            );
            expect(survivors.map((row) => row.datname)).not.toContain(databaseName);
          }
        );
      });
    } finally {
      // The runner restores stubs before each case and never after the last
      // one, and this is the last: without this the file hands back an empty
      // claim variable and the package's restoration guard refuses it.
      vi.unstubAllEnvs();
    }
  });
});
