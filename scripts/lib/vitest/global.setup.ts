import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RUN_TOKEN_VARIABLE } from '@hushbox/db/test-db';
import { currentRunId } from '../claims/ownership.js';
import { migrationsFingerprint } from '../cli/fingerprint.js';
import { markCacheDirUsed } from './cache-sweep.js';
import { cancelCoverageReports, coverageDirectoryRefusal } from './coverage-directory-guard.js';
import { resolveRunnerCacheNames, runnerCacheClaimRefusal } from './vitest-cache.js';
import {
  WORKERD_SLOT,
  buildTemplateDatabase,
  prepareRun,
  provisionSlotDatabase,
  runBuildCommand,
  teardownRun,
} from '../test-run/test-db-provision.js';
import type { TestProject } from 'vitest/node';

/**
 * Vitest global setup: the per-worker test databases, the retention stamp on
 * the vite cache directories this run bundles into (`stampCacheDirectories`
 * below), and the refusal of a coverage run aimed at a directory its own claim
 * does not key.
 * Runs once per vitest process, before any worker starts, and is the only place
 * the run identity is minted — worker slots are numbered per process, so two
 * concurrent runs would otherwise provision the same slot and destroy each other.
 *
 * Real-IO wiring only; every decision lives in the tested helpers it composes.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function buildTemplate(databaseName: string): Promise<void> {
  return buildTemplateDatabase(REPO_ROOT, databaseName, runBuildCommand);
}

/**
 * The second gate every invocation passes, and it is here for the reason the
 * coverage one below is: this file is what the shared config names, so a runner
 * reaches it whatever started it — including one a third-party tool constructs
 * in its own process, which no spawn site in this repository can see.
 *
 * It cannot prevent the directory, only refuse the run that made it: the
 * optimizer commits bundles into that directory while the runner builds its
 * project servers, which is before any code here runs. That is also why the
 * claim itself is taken by the process that starts a runner rather than here —
 * `cache-sweep.ts`'s `withRunnerCacheClaim` carries the whole argument.
 */
function refuseUnclaimedCacheDirectory(): void {
  const refusal = runnerCacheClaimRefusal(process.env, currentRunId());
  if (refusal !== undefined) throw new Error(refusal);
}

/**
 * Stamps the retention time on the generation and the invocation directory this
 * run resolves its `cacheDir` to.
 *
 * Claiming them, sweeping what nothing holds, and removing them again all
 * happen in the process that starts this runner — the first before this one
 * exists and the last after it is gone. None of it can happen here: a runner
 * killed mid-flight reaches no teardown, so a drop written here is exactly the
 * case that never runs, and the directory it would have removed is the one that
 * outlives every record naming it.
 */
async function stampCacheDirectories(): Promise<void> {
  // The names the claim holder minted for this run; this runner's own directory
  // inside them is derived where the runner resolves its `cacheDir`.
  const { generationName, runSegment } = await resolveRunnerCacheNames(
    process.env,
    process.pid,
    REPO_ROOT
  );
  // Vitest resolves the relative `cacheDir` against the project root, which is
  // the directory the package's test script runs from. The two levels the prune
  // reads are stamped: the generation is what the retention gate reads, and the
  // invocation directory is what it reads for a run holding no claim to be
  // recognised by. This runner's own directory inside them is never asked about
  // on its own account, so nothing reads a stamp on it.
  const now = Date.now();
  const generation = path.join(process.cwd(), 'node_modules', generationName);
  await markCacheDirUsed(generation, now);
  await markCacheDirUsed(path.join(generation, runSegment), now);
}

/**
 * The one gate every coverage invocation passes, whatever started it. The
 * runners key a coverage directory to the run holding the claim, but they are
 * bypassable: `vitest run --coverage` in a package directory reaches vitest
 * through the shared config while inheriting that package's default directory,
 * which every concurrent run of it also writes. Global setup is not bypassable
 * — the shared config names it — so the refusal lives here.
 */
function refuseSharedCoverageDirectory(project: TestProject): void {
  const { coverage } = project.vitest.config;
  const refusal = coverageDirectoryRefusal({
    enabled: coverage.enabled,
    reportsDirectory: coverage.reportsDirectory,
    runId: currentRunId(),
  });
  if (refusal === undefined) return;
  // The resolved coverage configuration is the provider's own options object,
  // so dropping the reports here is what the provider reads at shutdown.
  cancelCoverageReports(coverage);
  throw new Error(refusal);
}

async function provisionRun(): Promise<void> {
  refuseUnclaimedCacheDirectory();
  await stampCacheDirectories();
  await prepareRun(process.env, await migrationsFingerprint(REPO_ROOT), buildTemplate);
}

export async function setup(project: TestProject): Promise<void> {
  refuseSharedCoverageDirectory(project);
  await provisionRun();
}

export async function teardown(): Promise<void> {
  // A run whose setup failed never minted a token and has nothing to drop;
  // throwing here would replace the real failure with a second one.
  if (process.env[RUN_TOKEN_VARIABLE] === undefined) return;
  await teardownRun(process.env);
}

/**
 * The workerd projects load standalone configs that read `DATABASE_URL` at
 * config load and never load the vitest setup file, so their database has to be
 * provisioned here, before the config object is built.
 */
export async function prepareWorkersPhase(): Promise<string> {
  await provisionRun();
  await provisionSlotDatabase(process.env, WORKERD_SLOT);
  const url = process.env['DATABASE_URL'];
  if (url === undefined) throw new Error('vitest-global.setup: DATABASE_URL is required');
  return url;
}
