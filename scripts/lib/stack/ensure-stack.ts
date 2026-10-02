/**
 * Single orchestrator for "the stack is ready to be used."
 *
 * Every local consumer (pnpm dev / test / e2e / mobile:test / db:reset)
 * calls `ensureStack` first. The orchestrator owns:
 *
 *   - recording this slot's compose project against the run, before anything
 *     can end one or bring one into existence
 *   - env file regeneration (cheap, always runs)
 *   - `pnpm install` when pnpm-lock.yaml changes
 *   - orphaned-compose cleanup (cheap when none exist)
 *   - container bring-up (compose up --wait, idempotent)
 *   - repair of the cluster's client authentication method, so the driver's
 *     pipelined connect is answered the way it expects
 *   - for the end-to-end stack alone, recreation of its data plane from empty
 *   - creation of the stack's own database when the cluster lacks it
 *   - schema migration (skip when schema fingerprint hasn't changed)
 *   - dev-only tracking install (idempotent DDL)
 *   - vitest clone-source template build (skip when it matches the migrations)
 *   - idle daemon spawn (skip when already alive)
 *   - the read-only world audit (LAST, so it classifies the stack the caller is
 *     about to use)
 *
 * This orchestrator owns no seed phase — seeding runs as a separate
 * `pnpm db:seed` step (see the `pnpm dev` script), a full live seed that
 * re-mints every persona and fixture on each run using an idempotent-mint
 * model (see scripts/seed.ts).
 *
 * The orchestrator assumes it has been invoked. The CI no-op decision lives
 * one layer up in `ensure-stack-cli.ts`, because in CI we must not even
 * regenerate env files — the workflow has already written CI-mode values
 * and any regen here would clobber them.
 */
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { canonicalPath } from '../canonical-path.js';
import { claim } from '../claims/claim.js';
import { currentRunId, recordOwnedResourceIfClaimed } from '../claims/ownership.js';
import { composeProjectName } from '../cli/worktree.js';
import { otherRunsOnSlot } from './teardown-guard.js';
import type { StackMeta, SqlExecutor } from './stack-meta.js';
import type { StackMode } from './port-plan.js';
import type { EnsureDaemonOptions } from './idle-killer.js';

export interface EnsureStackOptions {
  repoRoot: string;
  slot: number;
  daemonScriptPath: string;
  idleDaemonPort: number;
  /** Force a docker volume wipe before bring-up. Used by `pnpm db:reset`. */
  wipe?: boolean;
  /**
   * The stack being prepared. Only {@link DATA_PLANE_RESET_STACK} has its data
   * plane recreated, and a caller naming none is treated as naming another.
   */
  stackMode?: StackMode;
  /** Defaults to the machine-wide claim registry; a test points it elsewhere. */
  registryDir?: string;
}

export interface EnsureStackDeps {
  generateEnvFiles: (repoRoot: string) => void;
  /**
   * The generated files the compose services themselves read at boot, rather
   * than the ones this repo's own processes read. Regenerated before bring-up,
   * so a value changed in the env registry is on disk before the container that
   * mounts it is created. Answers the services whose file it rewrote.
   */
  generateComposeFiles: (repoRoot: string) => readonly string[];
  installDeps: (repoRoot: string) => Promise<void>;
  cleanupOrphans: () => Promise<void>;
  /**
   * `recreate` names the services whose mounted files changed under them. A
   * mount is outside the configuration hash compose recreates on and the
   * service reads it once at boot, so those containers have to be replaced
   * explicitly or they keep serving the value they started with.
   */
  ensureContainersHealthy: (repoRoot: string, recreate: readonly string[]) => Promise<void>;
  /**
   * Leaves the cluster asking for the authentication the driver sends, or
   * refuses naming the repair. The method is decided at initialisation and kept
   * in the volume, so a volume older than the setting that selects it refuses
   * every connection below this line until something rewrites its rules
   * (`postgres-auth-method.ts`).
   */
  ensurePostgresAcceptsPassword: () => Promise<void>;
  /**
   * Recreates every store the stack owns from nothing — database, Redis
   * logical database, media bucket and Worker persist root. Run for
   * {@link DATA_PLANE_RESET_STACK} only, and required there: that bring-up
   * refuses without it rather than start on what an earlier run left.
   */
  resetDataPlane?: () => Promise<void>;
  /**
   * Creates the database this stack resolves, when the cluster does not have it
   * yet. Every stack but the one the cluster is initialised with starts absent,
   * and it stays absent until something makes it — reading the meta row or
   * running migrations against a database that is not there fails instead.
   * It goes through a maintenance connection rather than {@link sqlExecutor},
   * which is pointed at the very database that may not exist.
   */
  ensureDatabase: () => Promise<void>;
  runMigrations: (repoRoot: string) => Promise<void>;
  installDevTracking: (executor: SqlExecutor) => Promise<void>;
  /**
   * Dev-only: grants LOGIN to the migration-created `admin_sql_panel` role
   * (migrations create it NOLOGIN; the production password is minted
   * out-of-band, never in a migration). Idempotent, runs on every ensure so
   * a DB migrated by another path still gets it. Never a migration.
   */
  provisionAdminSqlPanelRole: (executor: SqlExecutor) => Promise<void>;
  readMeta: (executor: SqlExecutor) => Promise<StackMeta>;
  markClean: (executor: SqlExecutor, seedHash: string) => Promise<void>;
  composeDown: (repoRoot: string, options: { volumes: boolean }) => Promise<void>;
  ensureDaemonRunning: (options: EnsureDaemonOptions) => Promise<void>;
  readDepsHash: (cacheDir: string) => Promise<string | null>;
  writeDepsHash: (cacheDir: string, hash: string) => Promise<void>;
  computeDepsFingerprint: (repoRoot: string) => Promise<string>;
  computeMigrationFingerprint: (repoRoot: string) => Promise<string>;
  /**
   * Builds the migrated+seeded database the vitest workers clone, when it is
   * missing or was built from other migrations. It happens here, ahead of the
   * fan-out, because every package's vitest process would otherwise reach the
   * same `CREATE DATABASE` at once and all but one would die on it.
   */
  ensureTestTemplate: (migrationFingerprint: string) => Promise<void>;
  /**
   * Names every way the database disagrees with the schema its migration chain
   * records, and refuses when the two differ. The migration step runs this
   * comparison as its own second half, which is why {@link ensureSchemaReady}
   * reaches it only where the migration is skipped.
   */
  assertNoSchemaDrift: () => Promise<void>;
  /**
   * Narrates a step to the operator. A dependency rather than a direct
   * `console.log` because this module is a helper the `ensure-stack-cli.ts`
   * entry point imports, and printing is the entry point's job.
   */
  reportProgress: (message: string) => void;
  /**
   * The read-only world audit. It classifies every container, database,
   * bucket, listener, dist snapshot and purge aside this stack left behind, and
   * repairs none of them — auditors detect and humans repair. Its verdict never
   * fails the command it is housekeeping for, so what it finds is printed and
   * the command carries on.
   */
  auditStackWorld: (repoRoot: string) => Promise<void>;
  /** SQL executor — supplied by the CLI entry point, stubbed in tests. */
  sqlExecutor: SqlExecutor;
}

/**
 * The stack whose bring-up recreates its data plane. The development stack's
 * data is the developer's own, and a test run works on clones it makes and
 * drops; the end-to-end stack is the one whose stores outlive a run and must
 * not carry what that run left into the next.
 */
const DATA_PLANE_RESET_STACK: StackMode = 'e2e';

function cacheDirFor(repoRoot: string, slot: number): string {
  return path.join(repoRoot, 'scripts', '.cache', 'local', String(slot));
}

/** What a refusal or a progress line calls the section. */
const SECTION_NAME = 'the local stack';

/**
 * Beside the slot's other state, because that is the scope the section
 * protects: this checkout's `node_modules`, its compose project, its database
 * and its clone-source template.
 */
function sectionLockPathFor(cacheDir: string): string {
  return path.join(cacheDir, 'ensure-stack.lock');
}

/**
 * The sections this process already holds.
 *
 * Re-entrancy in the claim primitive is inherited only: a child process
 * proceeds through a claim its parent holds, but a second claim from the *same*
 * process meets its own lock, and in `wait` mode waits for a release that can
 * never come. A nested call therefore has to run inside the claim already held
 * rather than take a second one, or the failure is a silent hang.
 */
const sectionsHeldHere = new Set<string>();

/**
 * A wipe destroys the compose volumes — every database and every object on the
 * slot — so it refuses while anything else is running against it. It asks
 * {@link otherRunsOnSlot}, the one question every destructive path here asks,
 * disregarding its own run: `scripts/ensure-stack-cli.ts` registers the run
 * before it calls in here, so `pnpm db:reset` is holding a claim of its own.
 *
 * Both halves of that reading decide this, and the second is why the refusal is
 * not a count of readable claims. A record a wider checkout wrote is invalid to
 * a narrower reader, so a live run nothing can read arrives without a crash or a
 * disk fault — two checkouts of different ages on one machine are enough.
 */
async function assertSlotFreeToWipe(options: EnsureStackOptions): Promise<void> {
  const { claimed: others, unknown: unread } = await otherRunsOnSlot(
    options.slot,
    currentRunId(),
    options.registryDir
  );
  if (others.length === 0 && unread.length === 0) return;

  const named = [
    ...others.map((found) => `\`${found.command}\` (pid ${String(found.pid)})`),
    ...unread.map((found) => `the run in ${found.runId}, whose record could not be read`),
  ].join(', ');
  const count = others.length + unread.length;
  throw new Error(
    `ensure-stack: refusing to wipe slot ${String(options.slot)} while ${named} ` +
      `${count === 1 ? 'is' : 'are'} still running against it — a wipe ` +
      'destroys the volumes underneath them. Re-run once they have finished.' +
      (unread.length === 0
        ? ''
        : ' A run whose record cannot be read is on no slot this can rule out, so ' +
          'remove its directory by hand once you have established that no run is using it.')
  );
}

/**
 * Extract the migration portion of a stored seed_hash; '' if malformed.
 * Pre-redesign local DBs store a composed "<migrationFp>:<seedFp>" value
 * (the old stack-meta seed-hash tracking wrote it); current code stores the
 * bare migration fingerprint. Splitting on ':' reads both.
 */
function storedMigrationFp(seedHash: string): string {
  /* v8 ignore next -- split always yields at least one element, so index 0 is always present */
  return seedHash.split(':')[0] ?? '';
}

async function tryReadMeta(
  deps: EnsureStackDeps,
  executor: SqlExecutor
): Promise<StackMeta | null> {
  try {
    return await deps.readMeta(executor);
  } catch (error) {
    // Two reasons this can throw:
    //   1. First-ever run — __stack_meta doesn't exist yet. Expected.
    //   2. Real DB error (connection refused, permission denied, etc.).
    // In both cases we fall through to migrate, which is the right recovery
    // for case 1 and surfaces the real failure mode for case 2. Log so the
    // original error isn't lost when migrate fails next.
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`ensure-stack: optimistic readMeta failed (${message}); will run migrations.`);
    return null;
  }
}

async function ensureDepsInstalled(
  deps: EnsureStackDeps,
  options: EnsureStackOptions,
  cacheDir: string
): Promise<void> {
  const currentDepsFp = await deps.computeDepsFingerprint(options.repoRoot);
  const cachedDepsFp = await deps.readDepsHash(cacheDir);
  if (currentDepsFp !== cachedDepsFp) {
    await deps.installDeps(options.repoRoot);
    await deps.writeDepsHash(cacheDir, currentDepsFp);
  }
}

async function ensureSchemaReady(
  deps: EnsureStackDeps,
  options: EnsureStackOptions,
  migrationFp: string,
  fromEmpty: boolean
): Promise<void> {
  // Optimistic skip: if the meta row already records this migration fingerprint
  // the schema is in sync — we can skip the ~5s drizzle-kit startup. The
  // optimistic read tolerates "table doesn't exist" (fresh DB). A database this
  // bring-up has just emptied has no meta row, so it is not asked.
  const optimisticMeta = fromEmpty ? null : await tryReadMeta(deps, deps.sqlExecutor);
  const canSkipMigration =
    optimisticMeta !== null &&
    optimisticMeta.seededAt !== null &&
    storedMigrationFp(optimisticMeta.seedHash) === migrationFp;
  if (canSkipMigration) {
    // The fingerprint is a hash of the migration files, so it says nothing
    // about the database: one whose objects were changed outside the chain
    // satisfies the skip forever, and the first thing to notice is some later
    // migration failing on an object that is not where it should be. The
    // comparison the migration's own second half runs is what names it here
    // instead.
    await deps.assertNoSchemaDrift();
    return;
  }
  await deps.runMigrations(options.repoRoot);
  await deps.installDevTracking(deps.sqlExecutor);
  await deps.markClean(deps.sqlExecutor, migrationFp);
}

async function resetDataPlane(deps: EnsureStackDeps): Promise<void> {
  if (deps.resetDataPlane === undefined) {
    throw new Error(
      `ensure-stack: the ${DATA_PLANE_RESET_STACK} bring-up recreates its data plane, and was ` +
        'handed nothing to reset it with.'
    );
  }
  await deps.resetDataPlane();
}

/**
 * Every step, run under the section's claim. The steps that mutate the stack
 * share one invariant, so per-step locks would let one caller's wipe interleave
 * with another's migration.
 */
async function runStackSteps(
  cacheDir: string,
  options: EnsureStackOptions,
  deps: EnsureStackDeps
): Promise<void> {
  // Before anything below either ends a compose project or brings one into
  // existence, so no instant exists where this slot's project is running and
  // nothing says which run is working against it. `deps.cleanupOrphans` is a
  // teardown that reads this very record, and it is two steps down.
  //
  // {@link recordOwnedResourceIfClaimed} is spelled here rather than the
  // refusing recorder, because a bring-up holding no claim is accounted for
  // without one. What the record buys is the exact `held` verdict in
  // `scripts/docker-cleanup.ts`'s `verdictFor`, never the attribution — a
  // project no claim names is still placed by its own label and its recorded
  // working directory — and the audit's class for the kind leaves such a line
  // standing without paging. A bring-up that could not record has therefore
  // created nothing unattributable, which is the harm refusing exists to
  // prevent where the claim is a resource's only name.
  await recordOwnedResourceIfClaimed('compose-project', composeProjectName(options.slot));

  if (options.wipe) {
    await assertSlotFreeToWipe(options);
    await deps.composeDown(options.repoRoot, { volumes: true });
  }

  deps.generateEnvFiles(options.repoRoot);
  const recreate = deps.generateComposeFiles(options.repoRoot);
  await ensureDepsInstalled(deps, options, cacheDir);
  await deps.cleanupOrphans();
  await deps.ensureContainersHealthy(options.repoRoot, recreate);
  // Before the first connection rather than beside the other database steps:
  // `ensureDatabase` is where this bring-up first opens one, and a cluster
  // asking for the wrong authentication method refuses it.
  await deps.ensurePostgresAcceptsPassword();
  // After the authentication repair, which the drop's maintenance connection
  // needs, and before the database is ensured, so creation and migration
  // rebuild what the reset removed.
  const resetsDataPlane = options.stackMode === DATA_PLANE_RESET_STACK;
  if (resetsDataPlane) await resetDataPlane(deps);
  await deps.ensureDatabase();

  const migrationFp = await deps.computeMigrationFingerprint(options.repoRoot);
  await ensureSchemaReady(deps, options, migrationFp, options.wipe === true || resetsDataPlane);
  await deps.provisionAdminSqlPanelRole(deps.sqlExecutor);
  // The template build reuses the output-capturing runner the vitest global
  // setup needs, so a rebuild is a silent migrate+seed in a command whose every
  // other step streams. This line is the only thing standing between the user
  // and an unexplained multi-minute pause.
  deps.reportProgress(
    'ensure-stack: checking the vitest clone-source template (rebuild is quiet)...'
  );
  await deps.ensureTestTemplate(migrationFp);

  await deps.ensureDaemonRunning({
    port: options.idleDaemonPort,
    cacheDir,
    daemonScriptPath: options.daemonScriptPath,
    slot: options.slot,
  });

  // Last, so it reports the stack the caller is about to use rather than the
  // one it found: a resource this run just claimed reads as owned-live here,
  // and anything still unowned is what nothing will reclaim.
  await deps.auditStackWorld(options.repoRoot);
}

export async function ensureStack(
  options: EnsureStackOptions,
  deps: EnsureStackDeps
): Promise<void> {
  const cacheDir = cacheDirFor(options.repoRoot, options.slot);
  await mkdir(cacheDir, { recursive: true });
  const lockPath = canonicalPath(sectionLockPathFor(cacheDir));

  if (sectionsHeldHere.has(lockPath)) return runStackSteps(cacheDir, options, deps);

  // `wait`, not `refuse`: a second caller wants the stack ready, and the run
  // ahead of it is making it ready. Queueing gets it what it asked for, where
  // refusing would make `pnpm test` fail because `pnpm dev` was starting.
  return claim(
    { name: SECTION_NAME, lockPath },
    {
      onHeld: 'wait',
      holder: `ensure-stack on slot ${String(options.slot)} (pid ${String(process.pid)})`,
      log: deps.reportProgress,
    },
    async () => {
      sectionsHeldHere.add(lockPath);
      try {
        await runStackSteps(cacheDir, options, deps);
      } finally {
        sectionsHeldHere.delete(lockPath);
      }
    }
  );
}
