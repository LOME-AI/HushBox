/**
 * Single orchestrator for "the stack is ready to be used."
 *
 * Every local consumer (pnpm dev / test / e2e / mobile:test / db:reset / db:seed)
 * calls `ensureStack` first. The orchestrator owns:
 *
 *   - heartbeat tick (FIRST, before any check that depends on stack liveness —
 *     prevents the idle daemon from tearing down between our check and our
 *     subsequent work)
 *   - env file regeneration (cheap, always runs)
 *   - `pnpm install --frozen-lockfile` when pnpm-lock.yaml changes
 *   - orphaned-compose cleanup (cheap when none exist)
 *   - container bring-up (compose up --wait, idempotent)
 *   - schema migration (skip when schema fingerprint hasn't changed)
 *   - dev-only tracking install (idempotent DDL)
 *   - seed (skip when seed fingerprint matches AND meta.dirty == false)
 *   - idle daemon spawn (skip when already alive)
 *
 * CI is a no-op: workflows already have explicit `db:up`/`db:migrate`/`db:seed`/
 * `db:down` steps with per-step caching and timing. ensureStack only ticks the
 * heartbeat and returns when isCI=true so a locally-shaped consumer still has
 * its activity recorded.
 */
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { StackMeta, SqlExecutor } from './lib/stack-meta.js';
import type { EnsureDaemonOptions } from './lib/idle-killer.js';

export interface EnsureStackOptions {
  repoRoot: string;
  slot: number;
  isCI: boolean;
  daemonScriptPath: string;
  idleTtlMs: number;
  idleDaemonPort: number;
  /** Force a docker volume wipe before bring-up. Used by `pnpm db:reset`. */
  wipe?: boolean;
}

export interface EnsureStackDeps {
  touchHeartbeat: (heartbeatPath: string) => Promise<void>;
  generateEnvFiles: (repoRoot: string) => void;
  installDeps: (repoRoot: string) => Promise<void>;
  cleanupOrphans: () => Promise<void>;
  ensureContainersHealthy: (repoRoot: string) => Promise<void>;
  runMigrations: (repoRoot: string) => Promise<void>;
  installDevTracking: (executor: SqlExecutor) => Promise<void>;
  readMeta: (executor: SqlExecutor) => Promise<StackMeta>;
  truncateTracked: (executor: SqlExecutor) => Promise<void>;
  runSeed: () => Promise<void>;
  markClean: (executor: SqlExecutor, seedHash: string) => Promise<void>;
  composeDown: (repoRoot: string, options: { volumes: boolean }) => Promise<void>;
  ensureDaemonRunning: (options: EnsureDaemonOptions) => Promise<void>;
  readDepsHash: (cacheDir: string) => Promise<string | null>;
  writeDepsHash: (cacheDir: string, hash: string) => Promise<void>;
  computeDepsFingerprint: (repoRoot: string) => Promise<string>;
  computeMigrationFingerprint: (repoRoot: string) => Promise<string>;
  computeSeedFingerprint: (repoRoot: string) => Promise<string>;
  /** SQL executor — supplied by the CLI entry point, stubbed in tests. */
  sqlExecutor: SqlExecutor;
}

export function cacheDirFor(repoRoot: string, slot: number): string {
  return path.join(repoRoot, 'scripts', '.cache', 'local', String(slot));
}

export function heartbeatPathFor(cacheDir: string): string {
  return path.join(cacheDir, 'heartbeat');
}

/** Combined seed_hash = migration fingerprint + seed fingerprint, separated. */
export function composeSeedHash(migrationFp: string, seedFp: string): string {
  return `${migrationFp}:${seedFp}`;
}

/** Extract the migration portion of a composed seed_hash; '' if malformed. */
export function storedMigrationFp(seedHash: string): string {
  return seedHash.split(':')[0] ?? '';
}

async function tryReadMeta(
  deps: EnsureStackDeps,
  executor: SqlExecutor
): Promise<StackMeta | null> {
  try {
    return await deps.readMeta(executor);
  } catch {
    // First-ever run: __stack_meta doesn't exist yet. Fall through to the
    // migrate-then-install path so the table gets created.
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
  migrationFp: string
): Promise<StackMeta> {
  // Optimistic skip: if the meta row already records this migration fingerprint
  // and is clean, the schema is in sync — we can skip the ~5s drizzle-kit
  // startup. The optimistic read tolerates "table doesn't exist" (fresh DB).
  const optimisticMeta = options.wipe ? null : await tryReadMeta(deps, deps.sqlExecutor);
  const canSkipMigration =
    optimisticMeta !== null &&
    optimisticMeta.seededAt !== null &&
    storedMigrationFp(optimisticMeta.seedHash) === migrationFp;
  if (canSkipMigration) return optimisticMeta;
  await deps.runMigrations(options.repoRoot);
  await deps.installDevTracking(deps.sqlExecutor);
  return deps.readMeta(deps.sqlExecutor);
}

async function ensureSeedFresh(
  deps: EnsureStackDeps,
  options: EnsureStackOptions,
  meta: StackMeta,
  desiredHash: string
): Promise<void> {
  const needsSeed = options.wipe === true || meta.dirty || meta.seedHash !== desiredHash;
  if (!needsSeed) return;
  if (!options.wipe) {
    // After a wipe, the volume is empty and TRUNCATE has nothing to do.
    // In the non-wipe case (dirty or fingerprint drift), wiping just the
    // tracked tables is enough.
    await deps.truncateTracked(deps.sqlExecutor);
  }
  await deps.runSeed();
  await deps.markClean(deps.sqlExecutor, desiredHash);
}

export async function ensureStack(
  options: EnsureStackOptions,
  deps: EnsureStackDeps
): Promise<void> {
  const cacheDir = cacheDirFor(options.repoRoot, options.slot);
  await mkdir(cacheDir, { recursive: true });

  // Heartbeat first — covers the race where the idle daemon polls between
  // our checks and our subsequent work. See conversation notes.
  await deps.touchHeartbeat(heartbeatPathFor(cacheDir));

  if (options.isCI) return;

  if (options.wipe) {
    await deps.composeDown(options.repoRoot, { volumes: true });
  }

  deps.generateEnvFiles(options.repoRoot);
  await ensureDepsInstalled(deps, options, cacheDir);
  await deps.cleanupOrphans();
  await deps.ensureContainersHealthy(options.repoRoot);

  const migrationFp = await deps.computeMigrationFingerprint(options.repoRoot);
  const seedFp = await deps.computeSeedFingerprint(options.repoRoot);
  const desiredHash = composeSeedHash(migrationFp, seedFp);
  const meta = await ensureSchemaReady(deps, options, migrationFp);
  await ensureSeedFresh(deps, options, meta, desiredHash);

  await deps.ensureDaemonRunning({
    port: options.idleDaemonPort,
    cacheDir,
    daemonScriptPath: options.daemonScriptPath,
    slot: options.slot,
    ttlMs: options.idleTtlMs,
  });
}
