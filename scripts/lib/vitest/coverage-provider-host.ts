import { rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';

// Deep import sanctioned by the package's `"./*": "./*"` exports entry; the
// class is not re-exported from the package root.
import { V8CoverageProvider } from '@vitest/coverage-v8/dist/provider.js';

import { findOffsetDivergences } from './coverage-offset-detector.js';
import { REPORT_ENV } from './coverage-offset-reporter.js';
import { FORK_DUMP_DIRECTORY, FORK_DUMP_ROOT_ENV } from './fork-dumps.js';
import type { NamedRawCoverage, OffsetDivergence } from './coverage-offset-detector.js';
import type { MergeBatchRequest, MergeBatchResponse } from './coverage-merge-worker.ts';
import type { Vitest } from 'vitest/node';

// Resolved through coverage-v8's own module scope so the version can never
// diverge from the one coverage-v8 uses (pnpm hides transitive deps here).
const coverageV8Require = createRequire(
  createRequire(import.meta.url).resolve('@vitest/coverage-v8')
);
const { mergeProcessCovs } = coverageV8Require('@bcoe/v8-coverage') as {
  mergeProcessCovs: (covs: ProcessCov[]) => ProcessCov;
};
const vitestRequire = createRequire(createRequire(import.meta.url).resolve('vitest/package.json'));
const pm = vitestRequire('picomatch') as (
  globs: string | string[],
  options: { contains: boolean; dot: boolean; ignore: string[] }
) => (file: string) => boolean;
const { slash, cleanUrl } = vitestRequire('@vitest/utils/helpers') as {
  slash: (value: string) => string;
  cleanUrl: (value: string) => string;
};

interface ScriptCov {
  readonly url: string;
  startOffset?: number;
}

interface ProcessCov {
  readonly result: ScriptCov[];
}

/** Dumps parsed and merged per worker task; bounds each task's memory. */
const MERGE_BATCH = 32;

/** The base-class internals the batched override drives; untyped upstream. */
interface ProviderInternals {
  pendingPromises: Promise<unknown>[];
  coverageFiles: Map<string | symbol, Record<string, Record<string, string>>>;
  coverageFilesDirectory: string;
  ctx: { getProjectByName: (name: string | symbol) => unknown };
  globCache: Map<string, boolean>;
  options: { include?: string[]; exclude: string[]; allowExternal?: boolean };
  changedFiles?: string[];
}

/**
 * Whether the base class still holds the internals the batched override drives.
 * Upstream declares none of them, so a rename there surfaces as a refusal here
 * rather than as coverage state that reads undefined.
 */
function isPresentObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function holdsDumpState(value: object): boolean {
  return (
    'pendingPromises' in value &&
    Array.isArray(value.pendingPromises) &&
    'coverageFiles' in value &&
    value.coverageFiles instanceof Map &&
    'coverageFilesDirectory' in value &&
    typeof value.coverageFilesDirectory === 'string'
  );
}

function holdsScopeState(value: object): boolean {
  return (
    'globCache' in value &&
    value.globCache instanceof Map &&
    'options' in value &&
    isPresentObject(value.options) &&
    'ctx' in value &&
    isPresentObject(value.ctx)
  );
}

export function hasProviderInternals(value: object): value is ProviderInternals {
  return holdsDumpState(value) && holdsScopeState(value);
}

/** The base class's undeclared state, refused if upstream no longer holds it. */
function providerInternals(provider: object): ProviderInternals {
  if (!hasProviderInternals(provider)) {
    throw new Error('coverage provider: the base class no longer holds the expected internals');
  }
  return provider;
}

/**
 * Remove fork-written dumps upstream's directory removal cannot see — the
 * per-fork directories too, which otherwise pile up empty after the merge
 * workers consume their files.
 */
function forkDumpDirectories(
  coverageFiles: ProviderInternals['coverageFiles'],
  coverageFilesDirectory: string
): Set<string> {
  const dumpDirectories = new Set<string>();
  for (const perProject of coverageFiles.values()) {
    for (const byTestFiles of Object.values(perProject)) {
      for (const file of Object.values(byTestFiles)) {
        if (!file.startsWith(coverageFilesDirectory)) {
          dumpDirectories.add(path.dirname(file));
        }
      }
    }
  }
  return dumpDirectories;
}

function sweepForkDumps(
  coverageFiles: ProviderInternals['coverageFiles'],
  coverageFilesDirectory: string
): void {
  for (const directory of forkDumpDirectories(coverageFiles, coverageFilesDirectory)) {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Upstream's Map key for tasks reported without a project name. */
const DEFAULT_PROJECT_KEY = Symbol.for('default-project');

interface AfterSuiteRunMeta {
  readonly coverage?: unknown;
  readonly environment: string;
  readonly projectName?: string;
  readonly testFiles: readonly string[];
}

interface MergedBatch {
  readonly merged: ProcessCov;
  readonly rawLite: readonly NamedRawCoverage[];
}

interface PendingTask {
  readonly resolve: (batch: MergedBatch) => void;
  readonly reject: (error: Error) => void;
}

/**
 * A pool of threads that parse and merge batches of per-test-file V8 dumps.
 * JSON-parsing the dumps is the dominant cost of whole-repo coverage
 * finalization and is CPU-bound, so on the main thread it cannot overlap
 * with anything; each thread additionally returns one deduplicated cov per
 * batch, so the main thread receives a fraction of the raw volume.
 */
class MergeWorkerPool {
  private readonly workers: Worker[] = [];
  private readonly pending = new Map<number, PendingTask>();
  private nextId = 0;

  public constructor(size: number) {
    for (let workerIndex = 0; workerIndex < size; workerIndex += 1) {
      const worker = new Worker(new URL('coverage-merge-worker.ts', import.meta.url));
      worker.on('message', (response: MergeBatchResponse) => {
        const task = this.pending.get(response.id);
        if (!task) {
          return;
        }
        this.pending.delete(response.id);
        if (response.merged) {
          task.resolve({ merged: response.merged, rawLite: response.rawLite ?? [] });
        } else {
          task.reject(new Error(response.error ?? 'coverage merge worker failed'));
        }
      });
      worker.on('error', (error: Error) => {
        for (const [id, task] of this.pending.entries()) {
          this.pending.delete(id);
          task.reject(error);
        }
      });
      this.workers.push(worker);
    }
  }

  public run(filenames: readonly string[]): Promise<MergedBatch> {
    const id = this.nextId;
    this.nextId += 1;
    const worker = this.workers[id % this.workers.length];
    if (!worker) {
      return Promise.reject(new Error('coverage merge pool has no workers'));
    }
    return new Promise<MergedBatch>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const request: MergeBatchRequest = { id, filenames };
      worker.postMessage(request);
    });
  }

  public async destroy(): Promise<void> {
    await Promise.all(this.workers.map(async (worker) => worker.terminate()));
  }
}

function findStartOffset(covs: ProcessCov[], url: string): number {
  for (const cov of covs) {
    const original = cov.result.find((r) => r.url === url && r.startOffset);
    if (original?.startOffset) {
      return original.startOffset;
    }
  }
  return 0;
}

function poolSizeFor(totalFiles: number): number {
  const batches = Math.ceil(totalFiles / MERGE_BATCH);
  return Math.max(1, Math.min(availableParallelism() - 1, batches));
}

/**
 * The stock v8 provider with the dump-ingestion hot loop moved off the main
 * thread. Upstream reads and JSON-parses each test file's V8 dump on the
 * main thread and pairwise-merges it into the accumulated whole-repo process
 * cov — the dominant cost of a whole-repo coverage run. This override keeps
 * upstream's iteration contract (per-project/per-environment groups,
 * `onFinished` after each) but ships batches of dump files to a worker-thread
 * pool that parses and pre-merges them (startOffset repair included), handing
 * the caller one merged cov per batch.
 */
export class ThreadedV8Provider extends V8CoverageProvider {
  private includeMatcher: ((file: string) => boolean) | undefined;

  private get internals(): ProviderInternals {
    return providerInternals(this);
  }

  /**
   * Publishes where forks write their dumps, before the pool spawns any: a
   * fork inherits this process's environment, and the reports directory it
   * names is keyed to this run's claim, so dumps a killed run leaves are
   * removed with that directory by the next run's coverage reclaim.
   */
  override initialize(ctx: Vitest): void {
    super.initialize(ctx);
    process.env[FORK_DUMP_ROOT_ENV] = path.join(this.options.reportsDirectory, FORK_DUMP_DIRECTORY);
  }

  /**
   * Same decision procedure as upstream's `isIncluded`, with the glob set
   * compiled once. Upstream calls `pm.isMatch(file, globs, …)` per cache-miss
   * filename, which recompiles every include and exclude glob each call —
   * with a whole-repo include union and tens of thousands of distinct script
   * URLs that recompilation dominates conversion. The fixture pins this
   * against the stock provider's output.
   */
  override isIncluded(rawFilename: string, root?: string): boolean {
    const self = this.internals;
    const roots = root ? [root] : this.roots;
    const filename = slash(cleanUrl(rawFilename));
    const cacheHit = self.globCache.get(filename);
    if (cacheHit !== undefined) {
      return cacheHit;
    }
    if (self.options.allowExternal === false && roots.every((r) => !filename.startsWith(r))) {
      self.globCache.set(filename, false);
      return false;
    }
    this.includeMatcher ??= pm(self.options.include ?? '**', {
      contains: true,
      dot: true,
      ignore: self.options.exclude,
    });
    let included = this.includeMatcher(filename);
    if (included && self.changedFiles) {
      included = self.changedFiles.includes(filename);
    }
    self.globCache.set(filename, included);
    return included;
  }

  /**
   * Forks write their own dump files and report `{ __file }` markers (see the
   * provider entry module); registering the path directly skips upstream's
   * per-suite JSON.stringify + rewrite of the multi-megabyte dump on the main
   * thread. A result without a marker takes upstream's path untouched.
   */
  override onAfterSuiteRun(meta: AfterSuiteRunMeta): void {
    const marker = (meta.coverage as { __file?: string } | undefined)?.__file;
    if (!marker) {
      super.onAfterSuiteRun(meta as never);
      return;
    }
    const self = this.internals;
    const key = meta.projectName ?? DEFAULT_PROJECT_KEY;
    let entry = self.coverageFiles.get(key);
    if (!entry) {
      entry = {};
      self.coverageFiles.set(key, entry);
    }
    const byTestFiles = (entry[meta.environment] ??= {});
    // Default-separator join mirrors upstream's key construction; the key must
    // match what `readCoverageFiles` iterates.
    byTestFiles[meta.testFiles.join(',')] = marker;
  }

  /**
   * Fork-written dumps live outside `coverageFilesDirectory`, so upstream's
   * directory removal never sees them; sweep whatever the merge workers did
   * not already consume (a failed run cleans without reading).
   */
  override async cleanAfterRun(): Promise<void> {
    const self = this.internals;
    sweepForkDumps(self.coverageFiles, self.coverageFilesDirectory);
    await super.cleanAfterRun();
  }

  override async readCoverageFiles(
    options: Parameters<V8CoverageProvider['readCoverageFiles']>[0]
  ): Promise<void> {
    const self = this.internals;
    const total = self.pendingPromises.length;
    await Promise.all(self.pendingPromises);
    self.pendingPromises = [];
    const pool = new MergeWorkerPool(poolSizeFor(total));
    const findings: OffsetDivergence[] = [];
    const progress = { read: 0, total };
    try {
      for (const [projectName, coveragePerProject] of self.coverageFiles.entries()) {
        for (const [environment, coverageByTestfiles] of Object.entries(coveragePerProject)) {
          // The offset scan runs per (project, environment) group, matching
          // what conversion does: each group converts with its own offsets,
          // so a module loaded under different offsets by *different* groups
          // is benign — only divergence within one group corrupts numbers.
          // That is also exactly the per-package gate's original scope.
          const rawLite: NamedRawCoverage[] = [];
          await this.readGroup(options, {
            pool,
            rawLite,
            progress,
            project: self.ctx.getProjectByName(projectName),
            environment,
            filenames: Object.values(coverageByTestfiles),
          });
          findings.push(...this.scopedOffsetDivergences(rawLite));
        }
      }
      this.writeOffsetFindings(findings);
    } finally {
      await pool.destroy();
    }
  }

  private async readGroup(
    options: Parameters<V8CoverageProvider['readCoverageFiles']>[0],
    group: {
      pool: MergeWorkerPool;
      rawLite: NamedRawCoverage[];
      progress: { read: number; total: number };
      project: unknown;
      environment: string;
      filenames: readonly string[];
    }
  ): Promise<void> {
    const { onFileRead, onFinished, onDebug } = options;
    const { pool, rawLite, progress } = group;
    const batches: (readonly string[])[] = [];
    for (let start = 0; start < group.filenames.length; start += MERGE_BATCH) {
      batches.push(group.filenames.slice(start, start + MERGE_BATCH));
    }
    const results = await Promise.all(
      batches.map(async (batch) => {
        const result = await pool.run(batch);
        if (onDebug.enabled) {
          progress.read += batch.length;
          onDebug(`Reading coverage results ${String(progress.read)}/${String(progress.total)}`);
        }
        return result;
      })
    );
    const batchCovs = results.map((result) => result.merged);
    rawLite.push(...results.flatMap((result) => result.rawLite));
    if (batchCovs.length > 0) {
      // One k-way merge per group, handed over as a single result: upstream's
      // caller pairwise-merges every onFileRead argument into its accumulated
      // cov, so per-batch calls would rescan the whole accumulated map once
      // per batch.
      const groupCov = mergeProcessCovs(batchCovs);
      for (const entry of groupCov.result) {
        entry.startOffset ||= findStartOffset(batchCovs, entry.url);
      }
      onFileRead(groupCov as never);
    }
    await onFinished(group.project as never, group.environment);
  }

  /**
   * The coverage-offset gate's scan, fed from the dumps this provider already
   * parsed. The reporter that used to scan vitest's raw `.tmp` directory
   * in-run cannot see fork-written dumps, so the findings file the wrapper
   * reads is produced here instead, under the same env contract.
   */
  /**
   * One group's divergences, kept only for files inside this run's coverage
   * scope: a module outside the include set has no coverage numbers an offset
   * mismatch could corrupt.
   */
  private scopedOffsetDivergences(rawLite: readonly NamedRawCoverage[]): OffsetDivergence[] {
    if (!process.env[REPORT_ENV]) {
      return [];
    }
    return findOffsetDivergences(rawLite).filter((divergence) => {
      try {
        return (
          divergence.url.startsWith('file://') && this.isIncluded(fileURLToPath(divergence.url))
        );
      } catch {
        return false;
      }
    });
  }

  private writeOffsetFindings(findings: readonly OffsetDivergence[]): void {
    const reportFile = process.env[REPORT_ENV];
    if (!reportFile) {
      return;
    }
    writeFileSync(reportFile, JSON.stringify(findings));
  }
}
