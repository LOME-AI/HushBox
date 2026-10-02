import path from 'node:path';

import { execa } from 'execa';
import { sql } from 'drizzle-orm';

import { createDb, LOCAL_NEON_DEV_CONFIG } from '@hushbox/db';
import { assertNoSchemaDrift } from '@hushbox/db/schema-drift';

import {
  RUN_TOKEN_VARIABLE,
  SEED_INPUTS_DIGEST_VARIABLE,
  STALE_DATABASE_AGE_MS,
  TEST_DATABASE_VARIABLE,
  TEMPLATE_DATABASE,
  TEMPLATE_COMMENT_PREFIX,
  applyTestDatabaseName,
  carriesReadableCreationStamp,
  commentDatabaseSql,
  connectionCountSql,
  createDatabaseSql,
  createdComment,
  databaseClaim,
  dropDatabaseSql,
  dropIdleDatabaseSql,
  listStageDatabasesSql,
  listTestDatabasesSql,
  mintStageDatabaseName,
  preRegistryDatabaseNames,
  publishTemplateSql,
  renameDatabaseSql,
  runDatabasePrefix,
  runTokenFor,
  scratchBucketPrefix,
  slotDatabaseName,
  templateComment,
  templateFingerprintSql,
  withDatabaseName,
  type DatabaseRow,
} from '@hushbox/db/test-db';
import { claim } from '../claims/claim.js';
import {
  currentRunId,
  reapPass,
  recordOwnedResource,
  unownedFinding,
} from '../claims/ownership.js';
import { claimsDir } from '../claims/registry.js';
import { composeFingerprint } from '../cli/fingerprint.js';
import { stackSlotFrom } from '../stack/stack-slot.js';
import { stateOfRunNamedResource } from './run-named-resource.js';
import { reclaimScratchBuckets, requireScratchBucketStore } from './scratch-bucket-reclaim.js';
import { seedInputsFingerprint } from './seed-fingerprint.js';
import type { ClaimResource } from '../claims/claim.js';
import type { Ownership, OwnershipState } from '../claims/ownership.js';
import type { SqlExecutor } from '../stack/stack-meta.js';

/**
 * Driver-facing half of the per-worker test databases: it creates, sweeps and
 * drops them. The naming and SQL it issues live in `test-db.ts`.
 *
 * `CREATE DATABASE` cannot run inside a transaction and cannot run from the
 * database being cloned, so every statement here goes through a connection to
 * the cluster's `postgres` maintenance database on the same server.
 */

/**
 * Both SQLSTATEs a losing concurrent `CREATE DATABASE` can report.
 * `duplicate_database` (42P04) is the staggered case — the winner already
 * committed its `pg_database` row. Two creates in the same instant instead
 * collide on the unique index and surface `unique_violation` (23505), which is
 * why matching only 42P04 let a genuinely simultaneous loser propagate.
 */
const DUPLICATE_DATABASE_CODES = new Set(['42P04', '23505']);

/** The maintenance database every DDL connection targets. */
const MAINTENANCE_DATABASE = 'postgres';

/** The checkout this module sits in, which is the one its callers build the template from. */
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

/**
 * The workerd projects run serially with parallelism off and never load the
 * vitest setup file, so one database per run is enough for all of them; slot 0
 * is unreachable to `VITEST_POOL_ID`, which starts at 1.
 */
export const WORKERD_SLOT = '0';

interface ClosableSqlExecutor extends SqlExecutor {
  close(): Promise<void>;
}

export function createTestDbExecutor(connectionString: string): ClosableSqlExecutor {
  const db = createDb(connectionString, { neonDev: LOCAL_NEON_DEV_CONFIG });
  return {
    exec: async (statement: string): Promise<void> => {
      await db.execute(sql.raw(statement));
    },
    query: async <T>(statement: string): Promise<T[]> => {
      const { rows }: { rows: readonly unknown[] } = await db.execute(sql.raw(statement));
      return [...rows] as T[];
    },
    close: async (): Promise<void> => {
      await db.$client.end();
    },
  };
}

/** Opens a maintenance connection derived from any Postgres URL on the target server. */
export async function withMaintenanceExecutor<T>(
  connectionString: string,
  use: (executor: ClosableSqlExecutor) => Promise<T>
): Promise<T> {
  const executor = createTestDbExecutor(withDatabaseName(connectionString, MAINTENANCE_DATABASE));
  try {
    return await use(executor);
  } finally {
    await executor.close();
  }
}

export async function connectionCount(
  executor: SqlExecutor,
  databaseName: string
): Promise<number> {
  const rows = await executor.query<{ count: number }>(connectionCountSql(databaseName));
  return rows[0]?.count ?? 0;
}

async function listTestDatabases(executor: SqlExecutor): Promise<DatabaseRow[]> {
  return executor.query<DatabaseRow>(listTestDatabasesSql());
}

async function dropAll(executor: SqlExecutor, names: readonly string[]): Promise<string[]> {
  for (const name of names) {
    await executor.exec(dropDatabaseSql(name));
  }
  return [...names];
}

interface ReclaimReport {
  /** Databases whose owning run is gone, and which this pass dropped. */
  readonly dropped: string[];
  /** Databases no claim accounts for. Reported and left standing. */
  readonly unowned: string[];
}

interface ReclaimOptions {
  /** Defaults to the machine-wide registry; a test points it elsewhere. */
  readonly registryDir?: string;
  /** Only the pre-registry debris path reads this. */
  readonly maxAgeMs?: number;
}

/**
 * A database is attributed by its own name ({@link databaseClaim}) — the same
 * attribution a scratch bucket gets, and for the same reason: the name is
 * readable from the instant the resource exists.
 *
 * The name carries two things and both are read: the claim id its run recorded,
 * and the run id that outlives that record. {@link stateOfRunNamedResource} is
 * where the two are ordered.
 */
export function stateOfDatabase(datname: string, ownership: Ownership): OwnershipState {
  const { id, runId } = databaseClaim(datname);
  return stateOfRunNamedResource(ownership, 'database', id, runId);
}

/**
 * The names the age path may drop, which is none of them while a live run's
 * record went unread.
 *
 * A database names its run in its own name, and the record that would say
 * whether that name belongs to one of those runs is the record that could not
 * be read — so nothing here separates a live run's per-worker database from
 * debris, and the drop this feeds carries FORCE, which ends that run's own
 * connections. The reading is therefore established before the clock is
 * consulted rather than after.
 *
 * `owned-expired` is untouched by this and stays droppable: its owner was read
 * and is positively dead, which is a different question from this one.
 */
function preRegistryDrops(
  rows: readonly DatabaseRow[],
  ownership: Ownership,
  now: Date,
  maxAgeMs: number
): ReadonlySet<string> {
  if (ownership.unreadLiveRuns.length > 0) return new Set();
  return new Set(preRegistryDatabaseNames(rows, now, maxAgeMs));
}

/**
 * The names dropped for carrying no stamp anything can read, which is a
 * question about the comment and never about the clock: the reading is
 * {@link carriesReadableCreationStamp}, in the module that writes the stamp, so
 * there is one answer to what a readable stamp is.
 *
 * Nothing that reaches this is a database being created right now. A run
 * records the prefix its worker databases are named under before it creates
 * one, so a row in the window between its `CREATE` and its `COMMENT` — the
 * window where a stamp is genuinely absent rather than lost — is owned by a
 * live run and never offered here. What is left is a database whose name no
 * record accounts for and whose comment says nothing either: debris no other
 * path can ever select, since the age path is barred from reading an absent
 * stamp as an old one.
 *
 * Guarded by the unread-record reading for the same reason the age path is: a
 * record nobody could read may be the record that names this database, and the
 * drop below carries FORCE.
 */
function unstampedDrops(rows: readonly DatabaseRow[], ownership: Ownership): ReadonlySet<string> {
  if (ownership.unreadLiveRuns.length > 0) return new Set();
  return new Set(
    rows.filter((row) => !carriesReadableCreationStamp(row.comment)).map((row) => row.datname)
  );
}

function classify(
  rows: readonly DatabaseRow[],
  ownership: Ownership,
  debris: ReadonlySet<string>
): { drop: string[]; unowned: string[] } {
  const drop: string[] = [];
  const unowned: string[] = [];

  for (const row of rows) {
    const state = stateOfDatabase(row.datname, ownership);
    // Ownership decides first and the migration only ever sees what is left:
    // the age of a database a live run holds is not a question worth asking.
    if (state === 'owned-expired') drop.push(row.datname);
    else if (state === 'unowned') {
      if (debris.has(row.datname)) drop.push(row.datname);
      else unowned.push(row.datname);
    }
  }

  return { drop, unowned };
}

/** One line per database left standing, saying what the pass actually established about it. */
function reportUnowned(names: readonly string[], ownership: Ownership): void {
  const finding = unownedFinding(ownership);
  for (const name of names) {
    console.warn(
      `test-db: ${name} is ${finding}. Classify everything with ` + `\`pnpm dev:clean --dry-run\`.`
    );
  }
}

/**
 * Reclaims the databases of runs that were killed before their teardown could
 * run — the case teardown by construction cannot cover.
 *
 * The predicate is the owning run's claim, never the database's age: age cannot
 * tell a live sibling's database from a dead one's, and a suite that outran the
 * threshold used to have its own database dropped underneath it. The owner is
 * read from the database's name, which exists from the instant the database
 * does. A database whose owner no claim accounts for is dropped where its
 * comment carries no readable stamp ({@link unstampedDrops}) and reported
 * otherwise; only the pre-registry debris path still reads a clock, it is a
 * one-time migration (see `STALE_DATABASE_AGE_MS`), and both of those paths are
 * asked nothing at all while a live run's record went unread.
 */
export async function reclaimTestDatabases(
  executor: SqlExecutor,
  now: Date,
  options: ReclaimOptions = {}
): Promise<ReclaimReport> {
  const maxAgeMs = options.maxAgeMs ?? STALE_DATABASE_AGE_MS;
  // The scan's own rows, kept for the reap that the guard admits: re-reading
  // them would be a third reading of a world the guard just proved settled.
  let scanned: DatabaseRow[] = [];

  const report = await reapPass({
    what: 'test databases',
    registryDir: options.registryDir,
    scan: async () => {
      scanned = await listTestDatabases(executor);
      return scanned.map((row) => row.datname);
    },
    reap: async (present, ownership) => {
      const rows = scanned.filter((row) => present.includes(row.datname));
      const debris = new Set([
        ...unstampedDrops(rows, ownership),
        ...preRegistryDrops(rows, ownership, now, maxAgeMs),
      ]);
      const { drop, unowned } = classify(rows, ownership, debris);
      reportUnowned(unowned, ownership);
      return { dropped: await dropAll(executor, drop), unowned };
    },
  });

  // A skipped pass reclaimed nothing, which is the empty report: the skip
  // itself is already printed where it was decided.
  return report ?? { dropped: [], unowned: [] };
}

/**
 * Reclaims the staging databases a template build was killed before it could
 * publish or retire. Nothing else can see them — they sit outside the swept
 * `hb_t_` prefix on purpose — so without this they accumulate forever.
 *
 * The predicate is the build's own claim, never the database's age. A staging
 * name is recorded against its run before anything creates a database under it
 * (see {@link ensureTemplateDatabase}), so the three states mean here exactly
 * what they mean everywhere else: a build still holding its lock is untouched,
 * a build that died is reclaimed, and a database no claim accounts for is
 * reported and left standing — which is also what a live run whose record could
 * not be read leaves behind it, since nothing that reading returned can tell
 * that run's staging database from debris.
 *
 * Age decided this once and could not. A staging database is dropped with
 * FORCE, so a build outliving the window lost the database it was filling and
 * had its own connections terminated with it.
 */
export async function sweepStageDatabases(
  executor: SqlExecutor,
  options: ReclaimOptions = {}
): Promise<ReclaimReport> {
  const report = await reapPass({
    what: 'staged template databases',
    registryDir: options.registryDir,
    scan: async () => {
      const rows = await executor.query<{ datname: string }>(listStageDatabasesSql());
      return rows.map((row) => row.datname);
    },
    reap: async (present, ownership) => {
      const drop: string[] = [];
      const unowned: string[] = [];
      for (const name of present) {
        const state = stateOfDatabase(name, ownership);
        if (state === 'owned-expired') drop.push(name);
        else if (state === 'unowned') unowned.push(name);
      }
      reportUnowned(unowned, ownership);
      return { dropped: await dropAll(executor, drop), unowned };
    },
  });

  // A skipped pass reclaimed nothing, which is the empty report: the skip
  // itself is already printed where it was decided.
  return report ?? { dropped: [], unowned: [] };
}

export async function dropRunDatabases(executor: SqlExecutor, runToken: string): Promise<string[]> {
  const prefix = runDatabasePrefix(runToken);
  const rows = await listTestDatabases(executor);
  return dropAll(
    executor,
    rows.map((row) => row.datname).filter((name) => name.startsWith(prefix))
  );
}

/**
 * Walks the cause chain: the query layer wraps driver errors in its own
 * `Failed query: …` Error, so the Postgres code is never on the thrown object.
 */
function isDuplicateDatabase(error: unknown): boolean {
  let current: unknown = error;
  while (typeof current === 'object' && current !== null) {
    const { code } = current as { code?: unknown };
    if (typeof code === 'string' && DUPLICATE_DATABASE_CODES.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Clones the template for one worker slot. Creation is attempted rather than
 * checked for first: a concurrent creator loses the race harmlessly, and the
 * existing database keeps its original creation stamp so the sweep still reads
 * its true age.
 */
export async function ensureSlotDatabase(
  executor: SqlExecutor,
  databaseName: string,
  now: Date
): Promise<void> {
  try {
    await executor.exec(createDatabaseSql(databaseName, TEMPLATE_DATABASE));
  } catch (error: unknown) {
    if (isDuplicateDatabase(error)) return;
    throw error;
  }
  await executor.exec(commentDatabaseSql(databaseName, createdComment(now)));
}

/**
 * Creates a database when the cluster does not have it, and answers whether it
 * had to.
 *
 * Empty, not a clone: this is a stack's own database, which migrations and the
 * seed then fill, rather than a per-worker copy of the test template.
 * Attempted rather than checked for first — `CREATE DATABASE` has no
 * `IF NOT EXISTS`, and a lost race leaves exactly the database the caller
 * wanted.
 */
export async function ensureDatabaseExists(
  executor: SqlExecutor,
  databaseName: string
): Promise<boolean> {
  try {
    await executor.exec(createDatabaseSql(databaseName));
  } catch (error: unknown) {
    if (isDuplicateDatabase(error)) return false;
    throw error;
  }
  return true;
}

interface TemplateState {
  /** A row under the live name exists, whatever its comment says. */
  readonly present: boolean;
  /** The fingerprint it was stamped with, or undefined when it carries no stamp. */
  readonly fingerprint: string | undefined;
}

async function templateState(executor: SqlExecutor): Promise<TemplateState> {
  const rows = await executor.query<{ comment: string | null }>(templateFingerprintSql());
  if (rows.length === 0) return { present: false, fingerprint: undefined };
  const comment = rows[0]?.comment;
  return {
    present: true,
    fingerprint: comment?.startsWith(TEMPLATE_COMMENT_PREFIX)
      ? comment.slice(TEMPLATE_COMMENT_PREFIX.length)
      : undefined,
  };
}

/**
 * Mints a staging name carrying this run's id and records it against the run,
 * both before anything creates a database under it, and refuses to name one for
 * a process that holds no run.
 *
 * Claim before create, in the one order that is safe: a claim naming a database
 * that was never created is harmless, while a database nothing claims is one
 * {@link sweepStageDatabases} can only report and never reclaim — a line asking
 * a human to remove it by hand, which stands until one does. Refusing is what
 * keeps that line from ever being written: a process holding no run has no id
 * to name a staging database with, so it does not stage. The failure is the
 * caller's to fix by registering a run, which is what every entry point that
 * reaches here already does.
 *
 * The name and the record answer for the two halves of a run's life. The record
 * is what {@link sweepStageDatabases} reads first and is the only thing that
 * can speak for a name minted before names carried a run; the run id in the
 * name is what still answers once a run that ended the way it meant to has
 * taken that record with it.
 */
async function claimStageDatabaseName(): Promise<string> {
  const runId = currentRunId();
  if (runId === null) {
    throw new Error(
      'test-db: this process holds no run claim, so a staging database it created could be ' +
        'attributed to nothing and reclaimed by nothing. Register a run before building the ' +
        'template.'
    );
  }
  const name = mintStageDatabaseName(runTokenFor(runId));
  // The run this read is the claim `recordOwnedResource` requires, so the
  // refusal above is the only way this records nothing.
  await recordOwnedResource('database', name);
  return name;
}

interface TemplateOptions {
  /** Defaults to the machine-wide claim registry; a test points it elsewhere. */
  readonly registryDir?: string;
  /**
   * Compares the live template against the schema the migration chain records
   * and refuses when the two differ. Only the skip consults it: a build ends in
   * `pnpm db:migrate`, which runs the same comparison as its own second half
   * against the database it just filled.
   *
   * Required rather than optional because a caller that forgot it would skip
   * the build on the stamp alone, which is the reading this exists to stop
   * being the whole of it.
   */
  readonly verifyTemplate: () => Promise<void>;
  /**
   * The seed-input digest the template is checked against. Defaults to
   * {@link seedInputsFingerprint} over the checkout this module sits in;
   * {@link prepareRun} always passes the digest it prepares the run against.
   */
  readonly seedInputsDigest?: string;
}

/**
 * What the template is stamped with and compared against: one digest over the
 * migrations and over the seed's inputs ({@link seedInputsFingerprint}),
 * because the template is built by migrating and then seeding, and a change to
 * either can make a different database.
 */
export function templateFingerprint(
  migrationFingerprint: string,
  seedInputsDigest: string
): string {
  return composeFingerprint([migrationFingerprint, seedInputsDigest]);
}

/**
 * Every way the database at `connectionString` disagrees with the schema the
 * migration chain records, as a refusal naming each object it found.
 *
 * A connection of its own: the comparison reads the catalog of the database it
 * is connected to, and every caller here holds a maintenance connection to
 * another one.
 */
export async function assertSchemaMatchesMigrations(connectionString: string): Promise<void> {
  const db = createDb(connectionString, { neonDev: LOCAL_NEON_DEV_CONFIG });
  try {
    await assertNoSchemaDrift(db);
  } finally {
    await db.$client.end();
  }
}

/**
 * The comparison that answers for the clone source every worker database is
 * copied from, run against a throwaway clone of it rather than against the
 * source.
 *
 * Never a session on the source: `CREATE DATABASE … TEMPLATE src` waits for
 * every other session on `src` to end and refuses once that wait runs out —
 * measured at about five seconds — so a comparison connected to the clone
 * source stalls every slot clone raised beside it and fails the ones whose wait
 * expires. {@link ensureSlotDatabase} tolerates a name already taken and
 * nothing else, so that refusal reaches its caller. A clone answers the same
 * question because it carries its source's schema, drift included — the same
 * property that makes this drift worth catching, since every worker inherits
 * it.
 *
 * The clone is named and claimed the way a template build's staging databases
 * are, so one left behind by a killed process is attributable and the stage
 * sweep reclaims it.
 */
export function templateVerifier(
  executor: SqlExecutor,
  connectionString: string,
  compare: (connectionString: string) => Promise<void>
): () => Promise<void> {
  return async () => {
    const clone = await claimStageDatabaseName();
    await executor.exec(createDatabaseSql(clone, TEMPLATE_DATABASE));
    try {
      await compare(withDatabaseName(connectionString, clone));
    } finally {
      // No FORCE: the comparison closed its own connection, so a session still
      // holding this clone is a defect to surface rather than one to terminate.
      await executor.exec(dropIdleDatabaseSql(clone));
    }
  };
}

/**
 * The claim one template build is made under.
 *
 * Keyed on the stack slot because that is what a template belongs to: one
 * cluster per slot and one template per cluster, so two checkouts hold
 * different slots and different templates, and a shared key would make each
 * wait for a build that cannot affect it. Machine-scoped for the same reason
 * the run registry is — the cluster is a machine-wide resource, so a key
 * scoped to one checkout would not exclude the checkout next to it.
 */
function templateClaim(registryDir: string): ClaimResource {
  const slot = stackSlotFrom(process.env);
  return {
    name: `the vitest clone-source template on stack slot ${String(slot)}`,
    lockPath: path.join(registryDir, `test-template-${String(slot)}.lock`),
  };
}

/**
 * Builds the clone source when it is missing or was built from different
 * migrations or seed inputs ({@link templateFingerprint}) — under a staging
 * name, never under the live one, which no statement here creates or drops.
 *
 * That is what leaves the live name in one of exactly two states, absent or
 * carrying a complete stamped template. The build is stamped before it is
 * published and published by rename, so a checker cloning mid-rebuild gets the
 * outgoing template rather than a database whose migrations have run and whose
 * seed has not — the window nothing downstream can detect, because slot
 * provisioning clones the name and never reads the stamp.
 *
 * One builder at a time, and the state is read again inside the claim, which
 * is what makes the wait pay for itself: whoever queued behind the build finds
 * the fingerprint it wanted and skips, so N runs on a cold template pay for one
 * migrate-and-seed instead of N. Two builders publishing at once is the harder
 * half — both read the live name free, both rename onto it, and the cluster
 * refuses the second with a duplicate name it had no answer for. There is one
 * mechanism here and no second line of defence: the loser does not survive the
 * rename, it never reaches it.
 *
 * The wait is bounded by one build and never by a run's tests, so runs still
 * execute concurrently; a template already carrying the wanted fingerprint is
 * answered before the claim is asked for, so a warm template makes nobody wait
 * at all.
 */
export async function ensureTemplateDatabase(
  executor: SqlExecutor,
  migrationFingerprint: string,
  build: (databaseName: string) => Promise<void>,
  options: TemplateOptions
): Promise<boolean> {
  const fingerprint = templateFingerprint(
    migrationFingerprint,
    options.seedInputsDigest ?? seedInputsFingerprint(REPO_ROOT)
  );
  const current = await templateState(executor);
  if (current.fingerprint === fingerprint) {
    // The stamp records what the template was built from and nothing about what
    // it holds now, so a template altered outside the chain satisfies this skip
    // forever and every worker clones the alteration.
    await options.verifyTemplate();
    return false;
  }

  // `wait`, not `refuse`: every caller wants a current template, and the run
  // ahead of it is making one. Refusing would fail a `pnpm test` because a
  // sibling `pnpm test` got to the build first.
  return claim(
    templateClaim(options.registryDir ?? claimsDir()),
    {
      onHeld: 'wait',
      holder: `test template build (pid ${String(process.pid)})`,
    },
    () => buildAndPublishTemplate(executor, fingerprint, build)
  );
}

/**
 * The build itself, run by whichever caller holds the claim above.
 *
 * A build killed part-way leaves the live name exactly as it found it and one
 * staging database, recorded against the dying run before it was created — so
 * the next run's {@link sweepStageDatabases} reclaims it rather than a person.
 */
async function buildAndPublishTemplate(
  executor: SqlExecutor,
  fingerprint: string,
  build: (databaseName: string) => Promise<void>
): Promise<boolean> {
  const current = await templateState(executor);
  if (current.fingerprint === fingerprint) return false;

  const staged = await claimStageDatabaseName();
  await executor.exec(createDatabaseSql(staged));
  await build(staged);
  await executor.exec(commentDatabaseSql(staged, templateComment(fingerprint)));

  const live = await templateState(executor);
  if (live.fingerprint === fingerprint) {
    // This fingerprint was published while this one was building, by something
    // that took no claim — a migration run by hand is the only such publisher.
    await executor.exec(dropIdleDatabaseSql(staged));
    return false;
  }
  if (!live.present) {
    // Nothing to retire, so one rename publishes. No other claimed builder can
    // publish between the read above and this rename: the claim this runs
    // inside is held across both.
    await executor.exec(renameDatabaseSql(staged, TEMPLATE_DATABASE));
    return true;
  }
  const retired = await claimStageDatabaseName();
  await executor.exec(publishTemplateSql(staged, retired));
  await executor.exec(dropIdleDatabaseSql(retired));
  return true;
}

interface CommandOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

type CommandRunner = (
  command: string,
  args: readonly string[],
  options: CommandOptions
) => Promise<void>;

/**
 * Output is captured rather than inherited: this runs from a vitest global
 * setup, where an inherited stream is interleaved with the reporter's and a
 * failing child's diagnostics are lost. Attaching them to the error is what
 * makes a failed template build readable.
 */
export const runBuildCommand: CommandRunner = async (command, args, options) => {
  const result = await execa(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    all: true,
    reject: false,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `test-db: \`${command} ${args.join(' ')}\` failed (exit ${String(result.exitCode)})\n${result.all}`
    );
  }
};

/**
 * The template is built by the same two commands a developer runs. `HB_TEST_DB`
 * is the only way to retarget them: `with-env.ts` loads the env files with
 * `override: true`, so a pre-set `DATABASE_URL` would be silently clobbered.
 */
export async function buildTemplateDatabase(
  repoRoot: string,
  databaseName: string,
  run: CommandRunner
): Promise<void> {
  const options: CommandOptions = {
    cwd: repoRoot,
    env: { ...process.env, [TEST_DATABASE_VARIABLE]: databaseName },
  };
  await run('pnpm', ['run', 'db:migrate'], options);
  await run('pnpm', ['run', 'db:seed'], options);
}

function requireDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const url = env['DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new Error(
      'test-db: DATABASE_URL is required to provision test databases — run vitest through ' +
        '`tsx scripts/with-env.ts`, which is what loads the env files (a bare `npx vitest` does not)'
    );
  }
  return url;
}

/**
 * The token every database and scratch bucket of this run is named under, which
 * is the run's own id, and the refusal that keeps an unattributable name from
 * ever being created.
 *
 * A process holding no run claim has no id to name anything after, so every
 * database and every scratch bucket its workers went on to create would be one
 * no reclaimer may touch — a line asking a human to remove it by hand, repeated
 * by every later pass until one does. Refusing is cheaper than that line, and
 * the failure is the caller's to fix by registering a run, which is what every
 * entry point that reaches here already does.
 */
function requireClaimedRunToken(): string {
  const runId = currentRunId();
  if (runId === null) {
    throw new Error(
      'test-db: this process holds no run claim, so the databases and scratch buckets it is ' +
        'about to name could be attributed to nothing and reclaimed by nothing. Register a run ' +
        'before preparing one.'
    );
  }
  return runTokenFor(runId);
}

/**
 * Once per vitest process, before any worker starts: mint the run identity,
 * collect debris, and make sure the clone source is current. The token and the
 * seed-input digest the template was checked against are exported into the
 * environment so forked workers inherit them.
 *
 * `seedInputsDigest` defaults to {@link seedInputsFingerprint} over this
 * checkout. A caller preparing again inside a run can pass the digest the run
 * exported, so that a source edit made since is not read as a stale template.
 */
export async function prepareRun(
  env: NodeJS.ProcessEnv,
  migrationFingerprint: string,
  build: (databaseName: string) => Promise<void>,
  seedInputsDigest?: string
): Promise<string> {
  const existing = env[RUN_TOKEN_VARIABLE];
  if (existing !== undefined && existing !== '') return existing;
  // Both preconditions first: a caller missing one of them must not pay for a
  // template build and a migration run before the fail-fast fires.
  const databaseUrl = requireDatabaseUrl(env);
  const bucketStore = requireScratchBucketStore(env);
  const runToken = requireClaimedRunToken();
  // Claim before create, and before any worker exists to create one: a claim
  // naming resources that were never made is harmless, the reverse is an orphan.
  // The claim itself is established above, so neither call can fail to find one;
  // what the records add is the owner a report line names while the run lives.
  await recordOwnedResource('database', runDatabasePrefix(runToken));
  await recordOwnedResource('bucket', scratchBucketPrefix(runToken));
  const digest = seedInputsDigest ?? seedInputsFingerprint(REPO_ROOT);

  await withMaintenanceExecutor(databaseUrl, async (executor) => {
    await reclaimTestDatabases(executor, new Date());
    await sweepStageDatabases(executor);
    await ensureTemplateDatabase(executor, migrationFingerprint, build, {
      verifyTemplate: templateVerifier(executor, databaseUrl, assertSchemaMatchesMigrations),
      seedInputsDigest: digest,
    });
  });
  await reclaimScratchBuckets(bucketStore);

  env[RUN_TOKEN_VARIABLE] = runToken;
  env[SEED_INPUTS_DIGEST_VARIABLE] = digest;
  return runToken;
}

function requireRunToken(env: NodeJS.ProcessEnv): string {
  const runToken = env[RUN_TOKEN_VARIABLE];
  if (runToken === undefined || runToken === '') {
    throw new Error(
      `test-db: ${RUN_TOKEN_VARIABLE} is unset — the vitest global setup did not run`
    );
  }
  return runToken;
}

/**
 * Lazily gives one worker slot its own database and retargets the environment
 * at it. Lazy because the worker count is not a constant: it varies with the
 * package, the coverage cap and the invocation.
 */
export async function provisionSlotDatabase(env: NodeJS.ProcessEnv, slot: string): Promise<string> {
  const databaseName = slotDatabaseName(requireRunToken(env), slot);
  const url = requireDatabaseUrl(env);
  if (url.endsWith(`/${databaseName}`)) return databaseName;

  await withMaintenanceExecutor(url, (executor) =>
    ensureSlotDatabase(executor, databaseName, new Date())
  );
  applyTestDatabaseName(env, databaseName);
  return databaseName;
}

export async function teardownRun(env: NodeJS.ProcessEnv): Promise<string[]> {
  const runToken = requireRunToken(env);
  return withMaintenanceExecutor(requireDatabaseUrl(env), (executor) =>
    dropRunDatabases(executor, runToken)
  );
}
