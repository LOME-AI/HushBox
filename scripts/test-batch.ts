import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';

import { isMainModule } from './lib/cli/is-main.js';
import { runMain } from './lib/cli/run-main.js';
import { asElectedCacheWriter } from './lib/turbo/cache-writer.js';
import { REPORT_ENV } from './lib/vitest/coverage-offset-reporter.js';
import {
  BATCH_PORT_ENV,
  parseRegistration,
  serializeLine,
  type BatchRegistration,
} from './lib/test-run/test-batch-protocol.js';
import { computeVerdicts } from './lib/test-run/test-batch-verdicts.js';
import { discoverTestPackages } from './lib/test-run/test-packages.js';
import { parseTaskRuns } from './lib/pool/turbo-dry-run.js';
import { machineFingerprint } from './lib/pool/machine.js';
import { ledgerPath, readLedger } from './lib/pool/ledger.js';
import { PLANNING_MEMORY_FRACTION, memoryBudgetKb } from './lib/pool/memory.js';
import {
  VITEST_LEDGER_TASK,
  deriveVitestWorkers,
  formatVitestRunReport,
  measureTestFiles,
  observeRunConstraints,
  readMachineMemoryEvents,
  recordVitestRun,
  trackRunSplit,
  vitestFileUnits,
} from './lib/vitest/workers.js';
import { PSS_SAMPLE_INTERVAL_MS } from './turbo-pool.js';
import { withRunnerCacheClaim } from './lib/vitest/cache-sweep.js';
import { loadPackageCoverageGlobs } from './lib/vitest/coverage-globs.js';
import {
  coverageDirectory,
  coverageDirectoryFs,
  dropSeparators,
  reclaimCoverageDirectories,
  requireCoverageRunId,
  runCoverageDirectory,
  type CoverageDirectoryFs,
  type CoverageReclaim,
} from './run-package-tests.js';
import { readOwnership, recordOwnedResource } from './lib/claims/ownership.js';
import { claimReportFile, dropReportFile } from './lib/test-run/report-file.js';
import { perFileWallMs, sumFileWallMs, type VitestJsonReport } from './lib/test-run/test-report.js';
import type { Ownership } from './lib/claims/ownership.js';
import type { OffsetScanResult } from './lib/vitest/coverage-offset-detector.js';
import type { TrackedRunSplit, VitestRunRecord, VitestRunShape } from './lib/vitest/workers.js';

/**
 * The full-suite test entry: turbo decides per package (its input hashing and
 * cache are untouched), one consolidated vitest invocation executes whatever
 * missed, so a single global worker pool schedules every stale package's
 * files.
 *
 * Flow: a `--dry-run=json` asks turbo which `#test` tasks are cache misses;
 * the real `turbo test` then runs with every package's test script pointed at
 * this process (via `HB_TEST_BATCH_PORT`), so cache-missed tasks register and
 * wait instead of spawning their own vitest. Once every expected package has
 * registered, one `vitest run` covers all of them — directory filters for the
 * files, their own glob union for coverage — and each task exits with its
 * package's verdict, which turbo caches under that task's own input hash.
 *
 * The tasks stay alive while the batch executes, which is what makes the
 * caching sound: turbo hashed each task's inputs before execution began, so
 * an edit landing mid-run cannot produce a cache entry whose hash postdates
 * the sources that were actually tested. (A run-then-stamp design has exactly
 * that hole.)
 */

interface RegisteredClient {
  readonly registration: BatchRegistration;
  readonly socket: net.Socket;
}

interface Registry {
  readonly server: net.Server;
  readonly clients: Map<string, RegisteredClient>;
  onRegistration?: () => void;
  /** Once set, a late expected registrant is answered immediately. */
  verdicts?: ReadonlyMap<string, { ok: boolean; reasons: readonly string[] }>;
}

/**
 * The registration listener. An expected registrant is held for its verdict —
 * however late it arrives, since the batch covers the whole missed set from
 * the start. An unexpected or duplicate registrant is told to run itself
 * scoped; correctness is unaffected, the batch simply does not cover it.
 */
export function createRegistry(missed: ReadonlyMap<string, string>): Registry {
  const registry: Registry = {
    clients: new Map<string, RegisteredClient>(),
    server: net.createServer((socket) => {
      let buffer = '';
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const newline = buffer.indexOf('\n');
        if (newline === -1) {
          return;
        }
        const registration = parseRegistration(buffer.slice(0, newline));
        if (!registration) {
          socket.end();
          return;
        }
        if (!missed.has(registration.package) || registry.clients.has(registration.package)) {
          socket.write(serializeLine({ verdict: 'solo' }));
          socket.end();
          return;
        }
        const client = { registration, socket };
        registry.clients.set(registration.package, client);
        if (registry.verdicts) {
          sendVerdicts(new Map([[registration.package, client]]), registry.verdicts);
          return;
        }
        registry.onRegistration?.();
      });
      socket.on('error', () => {
        // A vanished client fails its own task; nothing to do here.
      });
    }),
  };
  return registry;
}

export function sendVerdicts(
  clients: ReadonlyMap<string, RegisteredClient>,
  verdicts: ReadonlyMap<string, { ok: boolean; reasons: readonly string[] }>
): void {
  for (const [packageName, client] of clients.entries()) {
    const verdict = verdicts.get(packageName) ?? { ok: false, reasons: ['no verdict computed'] };
    client.socket.write(
      serializeLine(
        verdict.ok ? { verdict: 'ok' } : { verdict: 'fail', reasons: [...verdict.reasons] }
      )
    );
    client.socket.end();
  }
}

interface BatchCoveragePaths {
  /** Where this batch's vitest writes its coverage report. */
  readonly reportsDirectory: string;
  /** The coverage map the empty-scope guard judges the batch on. */
  readonly coverageFile: string;
}

/**
 * This batch's coverage paths, keyed to the run's claim through
 * {@link runCoverageDirectory} for the reason that function's docblock gives:
 * overlapping runs sharing one reports directory delete each other's `.tmp`.
 *
 * The guard's file is derived here from the same value the run is handed, so a
 * guard cannot end up reading a directory the run never wrote to — silently
 * judging another run's map, or none.
 */
export function batchCoveragePaths(repoRoot: string, runId: string): BatchCoveragePaths {
  const reportsDirectory = runCoverageDirectory(repoRoot, runId);
  return {
    reportsDirectory,
    coverageFile: path.join(reportsDirectory, 'coverage-final.json'),
  };
}

/** What one consolidated run declares to the runner it spawns. */
interface BatchVitestArgsInputs {
  readonly repoRoot: string;
  /** The count the derivation produced, declared at launch and held for the run. */
  readonly workers: number;
  /** The directories the batch covers, in the order it registered them. */
  readonly directories: readonly string[];
  /** Every covered package's coverage scope, flattened. */
  readonly coverageInclude: readonly string[];
  readonly reportsDirectory: string;
  readonly reportFile: string;
}

/**
 * The command line this batch runs vitest under.
 *
 * It declares the worker count and nothing about the pool or about file
 * parallelism, and that silence is load-bearing: the shared configuration
 * declares one fork per test file, and a command-line override of either is
 * what would bypass that declaration. The count this line carries was derived
 * over test files as units, one to a lane, so a run that asked for another
 * shape would be running a schedule its own count does not describe.
 */
export function batchVitestArgs(inputs: BatchVitestArgsInputs): string[] {
  const { repoRoot, workers, directories, coverageInclude, reportsDirectory, reportFile } = inputs;
  return [
    'run',
    `--maxWorkers=${String(workers)}`,
    ...directories,
    '--coverage',
    `--coverage.reportsDirectory=${reportsDirectory}`,
    `--config=${path.join(repoRoot, 'vitest.projects.config.ts')}`,
    ...coverageInclude.map((glob) => `--coverage.include=${glob}`),
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${reportFile}`,
  ];
}

/**
 * What this batch tells its runner, and through it every fork the runner makes:
 * where the coverage-offset scan reports.
 *
 * It travels as an inherited environment variable, so it reaches any process a
 * test file starts — including a runner one starts.
 */
export function batchRunnerEnv(offsetFile: string): NodeJS.ProcessEnv {
  return { [REPORT_ENV]: offsetFile };
}

/**
 * The shape every row this launcher records is stamped with.
 *
 * One store holds every vitest invocation, so the stamp is what tells a
 * consolidated batch's rows from a package-rooted run's once they are there —
 * which is what lets retention age each shape's widths on its own runs, and so
 * what lets the two histories share a store at all.
 */
const BATCH_RUN_SHAPE: VitestRunShape = 'batch';

/** What one finished batch states about itself, before its row is assembled. */
interface BatchRunInputs {
  readonly wallMs: number;
  readonly tracked: TrackedRunSplit;
  /**
   * The process whose direct children were charged as workers; undefined where
   * the runner never started, which the recorder refuses rather than files.
   */
  readonly runnerPid: number | undefined;
  /** The count the batch was launched at and held for its whole span. */
  readonly declaredWorkers: number;
  readonly packageCount: number;
  /** The runner's own report, or nothing where the batch died before writing one. */
  readonly report: VitestJsonReport | undefined;
}

/**
 * The row one finished batch becomes.
 *
 * It states the workload it measured — the packages the batch covered and the
 * files they amounted to — and files itself at the lanes that were live when
 * the tree peaked rather than at the count the batch declared: the declared
 * count is what the run asked for, and the ladder prices a width by what was
 * actually holding memory at it. A partial batch's reading is as valid as a
 * full one's, which is why the counts travel with the row instead of the row
 * being thrown away.
 */
export function batchRunRecord(inputs: BatchRunInputs): VitestRunRecord {
  const { wallMs, tracked, runnerPid, declaredWorkers, packageCount, report } = inputs;
  return {
    wallMs,
    peakRssKb: tracked.peakRssKb,
    split: tracked.split,
    runnerPid,
    declaredWorkers,
    fileCount: report?.testResults?.length ?? 0,
    peakRunnerChildren: tracked.peakRunnerChildren,
    lanesAtPeak: tracked.lanesAtPeak,
    shape: BATCH_RUN_SHAPE,
    packageCount,
    perFileWallMs: perFileWallMs(report),
    sumFileWallMs: sumFileWallMs(report),
  };
}

/**
 * Collect the coverage directories batches that died left behind.
 *
 * The per-package runner sweeps its own package's coverage directory on the
 * same call, but the repo root is not a package and runs no per-package test
 * script, so without this call nothing ever collects a killed batch's
 * directory.
 */
export function reclaimBatchCoverage(
  repoRoot: string,
  ownership: Ownership,
  fs: CoverageDirectoryFs
): CoverageReclaim {
  return reclaimCoverageDirectories(coverageDirectory(repoRoot), ownership, fs);
}

/**
 * Run the batch and drop the coverage directory it wrote, whichever way the
 * batch ends. A batch killed part-way leaves truncated JSON its own parses
 * cannot read, so the throw is a reachable path and not only the success one.
 */
export async function withBatchCoverageDirectory<T>(
  reportsDirectory: string,
  fs: CoverageDirectoryFs,
  runBatch: () => Promise<T>
): Promise<T> {
  try {
    return await runBatch();
  } finally {
    fs.remove(reportsDirectory);
  }
}

/** This batch's json report, and the offset findings written beside it. */
interface BatchReportFiles {
  readonly reportFile: string;
  readonly offsetFile: string;
}

/**
 * Name this batch's report through the shared module, run the batch, and drop
 * both files whichever way it ends — the shape {@link withBatchCoverageDirectory}
 * uses for the directory beside them, and for the same reason: a batch killed
 * part-way otherwise leaves a pair behind.
 *
 * The name is the whole of the claim for these two. The run holding it is what a
 * later batch reads off a leftover to decide whether the run that wrote it is
 * still alive, so the sibling is derived from the claimed name rather than named
 * on its own account.
 */
export async function withBatchReportFiles<T>(
  claim: () => Promise<string>,
  drop: (file: string) => void,
  runBatch: (files: BatchReportFiles) => Promise<T>
): Promise<T> {
  const reportFile = await claim();
  const files: BatchReportFiles = { reportFile, offsetFile: `${reportFile}.offsets.json` };
  try {
    return await runBatch(files);
  } finally {
    drop(files.reportFile);
    drop(files.offsetFile);
  }
}

/* v8 ignore start -- process orchestration exercised by the repo's own test runs */
async function runTurboReplay(repoRoot: string, turboArgs: readonly string[]): Promise<number> {
  const replay = await execa('turbo', ['test', ...turboArgs], {
    cwd: repoRoot,
    preferLocal: true,
    reject: false,
    stdio: 'inherit',
  });
  return typeof replay.exitCode === 'number' ? replay.exitCode : 1;
}

/**
 * Each missed package's coverage scope, repo-root-relative.
 *
 * Called before turbo is spawned rather than alongside it: resolving a scope
 * rejects the package whose scope is missing or measures nothing, and ahead of
 * the spawn that rejection is the whole output, while behind it every package
 * that has already registered reports an unreachable coordinator too and buries
 * the one line naming the cause. Loaded one at a time: concurrent
 * `loadConfigFromFile` calls hang or silently kill the process (reproduced on
 * vite 8 — the consolidated config carries the same constraint), and a hung
 * coordinator strands every registered client.
 */
async function resolveCoverageScopes(
  repoRoot: string,
  missed: ReadonlyMap<string, string>
): Promise<Map<string, readonly string[]>> {
  const roster = new Map(discoverTestPackages(repoRoot).map((entry) => [entry.name, entry]));
  const scopes = new Map<string, readonly string[]>();
  for (const packageName of missed.keys()) {
    const entry = roster.get(packageName);
    if (!entry) {
      throw new Error(`missed package ${packageName} is not in the workspace roster`);
    }
    const { include } = await loadPackageCoverageGlobs(repoRoot, entry.dir, entry.configFile);
    scopes.set(packageName, include);
  }
  return scopes;
}

/**
 * One consolidated vitest run over the registered packages' directories and
 * coverage scopes, judged per package.
 */
interface BatchEntry {
  readonly package: string;
  readonly dir: string;
  readonly coverageInclude: readonly string[];
}

async function executeBatch(
  repoRoot: string,
  registered: readonly BatchEntry[]
): Promise<Map<string, { ok: boolean; reasons: readonly string[] }>> {
  // Named rather than left to vitest's default: the empty-scope guard reads
  // the map back out of this same derivation, and a guard that has to guess
  // where the run wrote is a guard that silently stops running when the shared
  // config changes.
  const coveragePaths = batchCoveragePaths(repoRoot, requireCoverageRunId());
  // Claim before create, then sweep off one reading of the registry — the same
  // order and the same three verdicts every other reclaimer here follows.
  await recordOwnedResource('directory', coveragePaths.reportsDirectory);
  const { unowned } = reclaimBatchCoverage(repoRoot, await readOwnership(), coverageDirectoryFs);
  if (unowned.length > 0) {
    console.warn(
      `[test-batch] coverage directories no run claim accounts for, left standing: ${unowned.join(', ')}`
    );
  }
  return withBatchCoverageDirectory(coveragePaths.reportsDirectory, coverageDirectoryFs, () =>
    withBatchReportFiles(
      () => claimReportFile(),
      dropReportFile,
      (reportFiles) => runBatchVitest(repoRoot, registered, coveragePaths, reportFiles)
    )
  );
}

async function runBatchVitest(
  repoRoot: string,
  registered: readonly BatchEntry[],
  { reportsDirectory, coverageFile }: BatchCoveragePaths,
  { reportFile, offsetFile }: BatchReportFiles
): Promise<Map<string, { ok: boolean; reasons: readonly string[] }>> {
  // The count comes out once, here, and is held for the run: the same figure
  // reaches the runner on its command line and the ledger as the count this run
  // declared. The units are the batch's own test files, so the bound is taken
  // over the set about to run rather than over every file on record.
  const ledgerFile = ledgerPath(repoRoot, machineFingerprint(), VITEST_LEDGER_TASK);
  const ledger = readLedger(ledgerFile);
  const derivedWorkers = deriveVitestWorkers({
    maxParallelism: os.availableParallelism(),
    files: vitestFileUnits(
      repoRoot,
      ledger.tasks,
      registered.map((registration) => registration.dir)
    ),
    observations: ledger.runs,
    memoryBudgetKb: memoryBudgetKb(PLANNING_MEMORY_FRACTION),
  });
  const vitestArgs = batchVitestArgs({
    repoRoot,
    workers: derivedWorkers.workers,
    directories: registered.map((registration) => registration.dir),
    coverageInclude: registered.flatMap((registration) => registration.coverageInclude),
    reportsDirectory,
    reportFile,
  });
  // The runner's dependency optimizer writes into its cache directory while it
  // builds its project servers, before any of our code runs inside it — so the
  // claim on that directory is taken around the start rather than beside it.
  const runnerEnv: NodeJS.ProcessEnv = batchRunnerEnv(offsetFile);
  return withRunnerCacheClaim(
    {
      repoRoot,
      projectRoot: repoRoot,
      processId: process.pid,
      env: runnerEnv,
      now: Date.now(),
    },
    async () => {
      // stdout streams through; stderr is teed because the per-file coverage
      // threshold errors are printed there and verdict attribution parses them.
      let errorOutput = '';
      const vitestChild = execa('vitest', vitestArgs, {
        cwd: repoRoot,
        preferLocal: true,
        reject: false,
        stdio: ['inherit', 'inherit', 'pipe'],
        env: runnerEnv,
      });
      vitestChild.stderr.on('data', (chunk: Buffer) => {
        process.stderr.write(chunk);
        errorOutput += chunk.toString('utf8');
      });
      const startedAt = performance.now();
      // Read at the run's two ends, because these counters are the machine's
      // whole uptime: only the difference across the span says anything, and
      // only at machine scope.
      const eventsAtStart = readMachineMemoryEvents();
      // The tree measured is this process's, not the vitest child's:
      // `run-package-tests.ts` launches each package's `test:workers` suite
      // alongside the batch rather than inside it, so those workerd processes
      // are siblings of the vitest child, and everything turbo spawns descends
      // from here. The workers charged inside that tree are the vitest child's
      // own children, which leaves those sibling suites and turbo itself in the
      // fixed cost, where they belong.
      // Read once and carried, never defaulted: the runner is spawned with
      // rejection disabled, so a binary that fails to spawn arrives here with
      // no process id, and standing a number in for it charges some other
      // process's children as this run's workers.
      const runnerPid = vitestChild.pid;
      const tracker = trackRunSplit({
        treeRootPid: process.pid,
        runnerPid,
        intervalMs: PSS_SAMPLE_INTERVAL_MS,
      });
      const vitestResult = await vitestChild;
      const tracked = tracker.stop();
      const constraints = observeRunConstraints(eventsAtStart, readMachineMemoryEvents());

      const report = existsSync(reportFile)
        ? (JSON.parse(readFileSync(reportFile, 'utf8')) as VitestJsonReport)
        : undefined;
      const files = measureTestFiles(repoRoot, report);
      const disposition = recordVitestRun(
        repoRoot,
        machineFingerprint(),
        batchRunRecord({
          wallMs: performance.now() - startedAt,
          tracked,
          runnerPid,
          declaredWorkers: derivedWorkers.workers,
          packageCount: registered.length,
          report,
        }),
        files
      );
      // The run states what it used and what it observed, whichever way the row
      // went: a refusal is the one outcome nothing else in the output carries,
      // and it goes to the stream a refusal belongs on.
      const runReport = formatVitestRunReport({
        derivation: derivedWorkers,
        split: tracked.split,
        constraints,
        disposition,
      });
      if (disposition.kind === 'refused') console.warn(runReport);
      else console.log(runReport);
      const offsetDivergences = existsSync(offsetFile)
        ? (JSON.parse(readFileSync(offsetFile, 'utf8')) as OffsetScanResult)
        : undefined;
      if (offsetDivergences === undefined) {
        console.warn(
          '[test-batch] coverage-offset scan did not run — coverage numbers were not checked for offset misattribution.'
        );
      }
      const coverageMap = existsSync(coverageFile)
        ? (JSON.parse(readFileSync(coverageFile, 'utf8')) as Record<string, unknown>)
        : undefined;
      const verdicts = computeVerdicts({
        repoRoot,
        packages: registered.map((registration) => ({
          package: registration.package,
          dir: registration.dir,
          coverageInclude: registration.coverageInclude,
        })),
        vitestExitCode: typeof vitestResult.exitCode === 'number' ? vitestResult.exitCode : 1,
        report,
        errorOutput,
        offsetDivergences,
        coverageMap,
        coverageReportsDirectory: reportsDirectory,
      });
      return verdicts;
    }
  );
}

async function main(): Promise<number> {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.dirname(scriptDir);
  // `pnpm test -- --force` re-inserts a bare separator ahead of the forwarded
  // flags; turbo reads everything after `--` as per-task passthrough, so an
  // unstripped separator turns intended turbo flags into script arguments —
  // `--force` then never bypasses the cache, it silently perturbs every task
  // hash instead.
  const turboArgs = dropSeparators(process.argv.slice(2));

  const dryRun = await execa('turbo', ['test', '--dry-run=json', ...turboArgs], {
    cwd: repoRoot,
    preferLocal: true,
    reject: false,
  });
  if (dryRun.exitCode !== 0) {
    console.error(dryRun.stderr);
    return typeof dryRun.exitCode === 'number' ? dryRun.exitCode : 1;
  }
  const missed = parseTaskRuns(dryRun.stdout, repoRoot, 'test');

  if (missed.size === 0) {
    // Everything replays from cache; no batch to coordinate.
    return runTurboReplay(repoRoot, turboArgs);
  }
  console.log(
    `[test-batch] ${String(missed.size)} package(s) missed cache: ${[...missed.keys()].join(', ')}`
  );

  const globs = await resolveCoverageScopes(repoRoot, missed);

  const registry = createRegistry(missed);
  const server = registry.server;
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('test-batch server has no port');
  }
  const clients = registry.clients;

  // `--continue=always` unconditionally: batched tasks are waiters whose exit
  // codes ARE the verdicts, so an early failing verdict must not cancel
  // sibling tasks mid-exit — a cancelled task records no cache entry even
  // though its tests passed.
  const continueArgs = turboArgs.includes('--continue=always') ? [] : ['--continue=always'];
  const turboChild = execa('turbo', ['test', ...turboArgs, ...continueArgs, '--concurrency=50'], {
    cwd: repoRoot,
    preferLocal: true,
    reject: false,
    stdio: 'inherit',
    env: { [BATCH_PORT_ENV]: String(address.port) },
  });

  // The batch covers the whole missed set (known from the dry-run), so it
  // launches at the FIRST registration rather than a full rendezvous — turbo
  // hashes the entire task graph during run planning, so one task having
  // started proves every task's inputs are already hashed, which is the
  // property the caching soundness rests on. The remaining registrations,
  // the workers-pool suites, and turbo's own startup all overlap the batch's
  // quiet startup phase instead of preceding it. If turbo exits before any
  // client registers (it failed to start tasks at all), there is no batch.
  const firstRegistration = new Promise<'registered'>((resolve) => {
    registry.onRegistration = () => {
      resolve('registered');
    };
    if (clients.size > 0) {
      resolve('registered');
    }
  });
  const opening = await Promise.race([
    firstRegistration,
    turboChild.then(() => 'turbo-exited' as const),
  ]);

  if (opening === 'registered') {
    const verdicts = await executeBatch(
      repoRoot,
      [...missed.entries()].map(([packageName, dir]) => ({
        package: packageName,
        dir,
        coverageInclude: globs.get(packageName) ?? [],
      }))
    );
    registry.verdicts = verdicts;
    sendVerdicts(clients, verdicts);
  }

  const turboResult = await turboChild;
  server.close();
  return typeof turboResult.exitCode === 'number' ? turboResult.exitCode : 1;
}

if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    return asElectedCacheWriter({ rootDir: path.dirname(scriptDir), command: 'test-batch' }, main);
  });
}
/* v8 ignore stop */
