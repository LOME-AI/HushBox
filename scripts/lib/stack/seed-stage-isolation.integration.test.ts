import { randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { execa } from 'execa';
import { describe, expect, it, vi } from 'vitest';

import { RUN_TOKEN_VARIABLE, withDatabaseName } from '@hushbox/db/test-db';

import { createTestDbExecutor, withMaintenanceExecutor } from '../test-run/test-db-provision.js';
import { bodiesReachedBy, rootScripts, tokensOf } from '../root-manifest.js';
import { envFilesFor, parseEnvModeSelection } from '../../with-env.js';
import { stackDatabaseName } from './stack-database.js';
import { stackModeFor } from './stack-mode.js';
import { STACK_MODES, type StackMode } from './port-plan.js';
import type { SqlExecutor } from './stack-meta.js';

/**
 * That the end-to-end chain's seed stage writes into its own stack's database
 * and into no other stack's, executed against the live cluster rather than
 * reasoned about.
 *
 * Neither the stage nor the stack it addresses is spelled here. The stage is
 * read out of the root manifest — the one stage reachable from the command a
 * developer types that runs the seed module — and the stack is read off that
 * stage with the wrapper's own reader, so what this asserts about is what the
 * chain runs rather than a copy of it kept in agreement by nobody. A stage that
 * stops naming a stack is refused with its own message, because a stage naming
 * none inherits whichever stack launched it, and that is the defect: a command
 * whose whole purpose is preparing one stack reaching into another's data.
 *
 * Only the seed module's own token is replaced, by a probe that keeps the
 * seed's shape and none of its content, so what runs is the real chain's real
 * wrapper resolving a real stack. The probe writes into a table of its own that
 * this test drops, never into a stack's seeded state: a test that seeds a stack
 * a developer or a concurrent run is holding is a hazard whatever it restores
 * afterwards, and the sibling stack-isolation tests already settle that
 * discipline. The table name carries the run token for the same reason a
 * scratch database's does — so a table left by a killed process is
 * attributable — and the `finally` covers every path this process controls.
 *
 * Every other stack the cluster holds is an observer, read and never written,
 * rather than the development stack alone: the stack a flagless stage would
 * inherit is whichever one launched it, and which stack runs this suite is not
 * this file's to know.
 *
 * Both halves of that reach one Postgres: `postgres` and `neon` are declared
 * unbanded in the port plan, so one container serves every stack of a slot and
 * the database name is the whole of the split. That is what lets this reach
 * every stack from the cluster coordinates it was handed.
 *
 * It needs a stack `pnpm test` does not bring up: a stack's env files and
 * database come from a bring-up in that stack's own mode, which a checkout gets
 * from its first end-to-end run. Where that has never happened there is nothing
 * here to observe, and the case skips saying so rather than failing over a
 * subject it does not have.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

/** The command a developer types to prepare and run the end-to-end suite. */
const CHAIN = 'e2e';

/** The module whose stage this is, named as the manifest names it. */
const SEED_MODULE = 'scripts/seed.ts';

/** What stands in for it, named the same way so the substitution is one token. */
const PROBE_MODULE = 'scripts/lib/stack/seed-stage-probe-entry.mjs';

/** The wrapper a stage names to load a stack's env files, as the manifest names it. */
const ENV_WRAPPER = 'scripts/with-env.ts';

function requireDatabaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new Error(
      'DATABASE_URL is required for the seed-stage isolation test — run vitest through `tsx scripts/with-env.ts`, which is what loads the env files'
    );
  }
  return url;
}

/** The connection a run of that stack reaches Postgres with. */
function stackDatabaseUrl(stackMode: StackMode): string {
  return withDatabaseName(requireDatabaseUrl(), stackDatabaseName(stackMode));
}

interface SeedStage {
  /** The stack the stage names for itself, read by the wrapper's own reader. */
  readonly stack: StackMode;
  /** The stage's command line, with the probe in the seed module's place. */
  readonly tokens: readonly string[];
}

/**
 * The chain's seed stage, as the scripts it is handed declare it.
 *
 * It refuses on anything but one match: no stage running the seed module means
 * the chain no longer seeds, and several means the one this asserts about is a
 * guess.
 *
 * The scripts are a parameter so the refusals can be fired on records written
 * in a case. Reading the manifest in here would leave them reachable only by
 * doctoring the repository's own manifest, which is a hazard to every
 * concurrent reader of that file and buys an answer nothing keeps.
 */
function seedStage(scripts: Readonly<Record<string, string>>): SeedStage {
  const stages = bodiesReachedBy(CHAIN, scripts).filter((body) =>
    tokensOf(body).includes(SEED_MODULE)
  );
  const [stage] = stages;
  if (stage === undefined || stages.length > 1) {
    throw new Error(
      `Expected exactly one stage of \`pnpm ${CHAIN}\` to run ${SEED_MODULE}, found ${String(stages.length)}`
    );
  }
  const tokens = tokensOf(stage);
  const wrapper = tokens.indexOf(ENV_WRAPPER);
  if (wrapper === -1) {
    throw new Error(
      `The seed stage of \`pnpm ${CHAIN}\` does not run through ${ENV_WRAPPER}, so nothing loads a stack's env files for it`
    );
  }
  const { envMode } = parseEnvModeSelection(tokens.slice(wrapper + 1));
  if (envMode === undefined) {
    throw new Error(
      `The seed stage of \`pnpm ${CHAIN}\` names no mode, so it seeds whichever stack the run that launched it happens to name`
    );
  }
  return {
    stack: stackModeFor(envMode),
    tokens: tokens.map((token) => (token === SEED_MODULE ? PROBE_MODULE : token)),
  };
}

/**
 * A table name of this run's own, carrying the run token the per-worker
 * databases carry so that a table a killed process leaves behind names what
 * made it. The random tail is what keeps two workers of one run apart.
 */
function mintProbeTableName(): string {
  const runToken = process.env[RUN_TOKEN_VARIABLE];
  if (runToken === undefined || runToken === '') {
    throw new Error(
      `${RUN_TOKEN_VARIABLE} is required for the seed-stage isolation test — it is minted by the vitest global setup, which did not run`
    );
  }
  return `seed_stage_probe_${runToken}_${String(randomInt(10 ** 12, 10 ** 13))}`;
}

/** Runs the chain's seed stage with the probe in place, refusing anything but success. */
async function runSeedStage(stage: SeedStage, table: string): Promise<void> {
  const [command, ...args] = stage.tokens;
  if (command === undefined) throw new Error('The chain names an empty seed stage');
  const result = await execa(command, [...args, table], {
    cwd: REPO_ROOT,
    preferLocal: true,
    all: true,
    reject: false,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `The chain's seed stage failed (exit ${String(result.exitCode)})\n${result.all}`
    );
  }
}

/** Whether a stack's generated env files are here for a stage to resolve. */
function stackFilesPresent(stackMode: StackMode): boolean {
  return envFilesFor(stackMode).every((file) => existsSync(path.join(REPO_ROOT, file)));
}

/** The stacks whose databases this cluster actually holds. */
async function stacksOnCluster(): Promise<StackMode[]> {
  const rows = await withMaintenanceExecutor(requireDatabaseUrl(), (maintenance) =>
    maintenance.query<{ name: string }>('SELECT datname AS name FROM pg_database')
  );
  const names = new Set(rows.map((row) => row.name));
  return STACK_MODES.filter((stackMode) => names.has(stackDatabaseName(stackMode)));
}

/** The database a live connection is actually on, asked of the server. */
async function currentDatabase(executor: SqlExecutor): Promise<string | undefined> {
  const rows = await executor.query<{ current: string }>('SELECT current_database() AS current');
  return rows[0]?.current;
}

/**
 * How many rows the probe left in that database, or null where it left no table
 * at all. Asked in two steps rather than caught: a missing table and a refused
 * connection are different answers and only the first one is this test's
 * business.
 */
async function probeRows(executor: SqlExecutor, table: string): Promise<number | null> {
  const found = await executor.query<{ present: boolean }>(
    `SELECT to_regclass('public.${table}') IS NOT NULL AS present`
  );
  if (found[0]?.present !== true) return null;
  const counted = await executor.query<{ rows: string }>(`SELECT count(*) AS rows FROM ${table}`);
  return Number(counted[0]?.rows ?? 0);
}

/**
 * A skip, said aloud.
 *
 * The reporters this repository configures — both package runners pass
 * `--reporter=default --reporter=json` — print neither a skipped case's name
 * nor the note it carries; a skipped file still counts under the passing test
 * files, and the whole visible trace is one aggregate skipped count. A reason
 * that lives only in the note is therefore honest in the source and invisible
 * to whoever reads the run, which is the shape `docs/CODE-RULES.md` §Never Hide
 * Problems refuses. `console.warn` is a channel the reporters do print, and
 * lint permits it everywhere.
 */
function skipAloud(
  skip: (condition: boolean, note: string) => void,
  condition: boolean,
  note: string
): void {
  if (condition) console.warn(note);
  skip(condition, note);
}

describe("the end-to-end chain's seed stage", () => {
  it('lands only in the database of the stack it names', async ({ skip }) => {
    const stage = seedStage(rootScripts());
    const bringUp = `\`pnpm ensure-stack --env-mode ${stage.stack}\``;
    skipAloud(
      skip,
      !stackFilesPresent(stage.stack),
      `nothing has generated the ${stage.stack} stack's env files in this checkout, so no stage can resolve that stack — bring it up with ${bringUp}`
    );

    const onCluster = await stacksOnCluster();
    skipAloud(
      skip,
      !onCluster.includes(stage.stack),
      `this cluster holds no ${stage.stack} database, so nothing has brought that stack up — bring it up with ${bringUp}`
    );
    const observed = onCluster.filter((stackMode) => stackMode !== stage.stack);
    skipAloud(
      skip,
      observed.length === 0,
      `this cluster holds no stack but ${stage.stack}, so there is nothing for that stage to be isolated from`
    );

    const table = mintProbeTableName();
    const writer = createTestDbExecutor(stackDatabaseUrl(stage.stack));
    const observers = observed.map(
      (stackMode) => [stackMode, createTestDbExecutor(stackDatabaseUrl(stackMode))] as const
    );

    try {
      await expect(probeRows(writer, table)).resolves.toBeNull();

      await runSeedStage(stage, table);

      await expect(probeRows(writer, table)).resolves.toBeGreaterThan(0);
      for (const [stackMode, observer] of observers) {
        // Live: the connection each stack is read on is on that stack's own
        // database, so its silence is evidence about it.
        await expect(currentDatabase(observer)).resolves.toBe(stackDatabaseName(stackMode));
        await expect(probeRows(observer, table)).resolves.toBeNull();
      }
    } finally {
      // Every stack, not only the one that should have been written. The run
      // this fails on is the run where the probe landed somewhere it should not
      // have, and leaving it there makes the next run dirtier. On a run that
      // passes, the drop an observer is asked for is a table it does not have,
      // so the observers stay read-only wherever the property holds.
      for (const executor of [writer, ...observers.map(([, observer]) => observer)]) {
        await executor.exec(`DROP TABLE IF EXISTS ${table}`);
        await executor.close();
      }
    }
    // Room for what a spawned stage costs and a unit test does not: two
    // TypeScript-loader starts, the env files, and a Postgres connect of its
    // own, on a cluster whatever else is running shares.
  }, 60_000);
});

describe('the seed stage a chain declares', () => {
  const stageBody = `tsx ${ENV_WRAPPER} --env-mode e2e tsx ${SEED_MODULE}`;

  it('refuses a chain no stage of which runs the seed module', () => {
    expect(() =>
      seedStage({ [CHAIN]: `tsx ${ENV_WRAPPER} --env-mode e2e tsx scripts/other.ts` })
    ).toThrow(`Expected exactly one stage of \`pnpm ${CHAIN}\` to run ${SEED_MODULE}, found 0`);
  });

  it('refuses a chain reaching the seed module through more than one stage', () => {
    expect(() =>
      seedStage({
        [CHAIN]: 'pnpm seed:first && pnpm seed:second',
        'seed:first': stageBody,
        'seed:second': `${stageBody} --only-models`,
      })
    ).toThrow(`Expected exactly one stage of \`pnpm ${CHAIN}\` to run ${SEED_MODULE}, found 2`);
  });

  it('refuses a stage that does not run through the env wrapper', () => {
    expect(() => seedStage({ [CHAIN]: `tsx ${SEED_MODULE}` })).toThrow(
      `The seed stage of \`pnpm ${CHAIN}\` does not run through ${ENV_WRAPPER}`
    );
  });

  it('refuses a stage that names no mode', () => {
    expect(() => seedStage({ [CHAIN]: `tsx ${ENV_WRAPPER} tsx ${SEED_MODULE}` })).toThrow(
      `The seed stage of \`pnpm ${CHAIN}\` names no mode`
    );
  });
});

describe('a skip this run can be read as having taken', () => {
  it('says the reason on a channel the run output carries', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      skipAloud(vi.fn(), true, 'the stack is absent, bring it up');
      expect(warn).toHaveBeenCalledWith('the stack is absent, bring it up');
    } finally {
      warn.mockRestore();
    }
  });

  it('says nothing where the case goes on to run', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      skipAloud(vi.fn(), false, 'the stack is absent, bring it up');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('leaves the skipping itself to the case', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const skip = vi.fn();
    try {
      skipAloud(skip, true, 'the stack is absent, bring it up');
      expect(skip).toHaveBeenCalledWith(true, 'the stack is absent, bring it up');
    } finally {
      warn.mockRestore();
    }
  });
});
