import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MAX_RETAINED_WALLS, ledgerPath, readLedger, writeLedger } from './lib/pool/ledger.js';
import {
  createPoolPeakRecorder,
  parsePoolArgs,
  poolMain,
  runPool,
  toPoolChild,
  type PoolChild,
  type PoolDeps,
  type PoolEntry,
  type PoolExecOptions,
  type PoolExecResult,
} from './turbo-pool.js';
import type { AttributedTreePssKb } from './lib/pool/memory.js';

const FINGERPRINT = 'testmachine1';

/**
 * The liveness a seeded run states. A seed stands for a run recorded earlier,
 * taken while the workspace still declared every package that run named — which
 * is what puts the row in the store for the run under test to act on. A seed
 * that reported a departure would remove the row before the assertion could
 * reach it, and the one test here that watches a removed package drop watches
 * the pool's own write do it.
 */
function whenEachStillStood(): boolean {
  return true;
}

describe('parsePoolArgs', () => {
  it('takes the task from the first positional and forwards unknown flags to the tool', () => {
    expect(parsePoolArgs(['lint', '--force', '--', '--fix'])).toEqual({
      task: 'lint',
      force: true,
      record: true,
      forwarded: ['--fix'],
    });
  });

  it('recognizes --force wherever it appears, including after a pnpm-inserted separator', () => {
    expect(parsePoolArgs(['lint', '--', '--force'])).toEqual({
      task: 'lint',
      force: true,
      record: true,
      forwarded: [],
    });
  });

  it('accepts and drops --continue: the pool always continues', () => {
    expect(parsePoolArgs(['lint', '--continue'])).toEqual({
      task: 'lint',
      force: false,
      record: true,
      forwarded: [],
    });
  });

  it('takes --no-record without forwarding it to the tool', () => {
    // `lint:fix` reads the learned concurrency but must not teach the ledger:
    // rewriting files is not the run whose shape the ledger describes.
    expect(parsePoolArgs(['lint', '--no-record', '--', '--fix'])).toEqual({
      task: 'lint',
      force: false,
      record: false,
      forwarded: ['--fix'],
    });
  });

  it('throws without a task name', () => {
    expect(() => parsePoolArgs([])).toThrow(/task name is required/i);
  });

  it('lets a forwarded flag take the value that follows it', () => {
    // `lint:summary` is `turbo-pool lint -- --format summary`; the value was
    // read as a second task name and the script could never have run.
    expect(parsePoolArgs(['lint', '--', '--format', 'summary'])).toEqual({
      task: 'lint',
      force: false,
      record: true,
      forwarded: ['--format', 'summary'],
    });
  });

  it('still takes the task from a bare first token, flag or not', () => {
    expect(parsePoolArgs(['--fix', 'lint']).task).toBe('lint');
  });

  it('rejects a second positional rather than guessing', () => {
    expect(() => parsePoolArgs(['lint', 'typecheck'])).toThrow(/second positional/i);
  });
});

describe('runPool', () => {
  it('starts tasks in the given order, never exceeding the concurrency', async () => {
    const started: string[] = [];
    let inFlight = 0;
    let peak = 0;
    const entries: PoolEntry[] = ['a', 'b', 'c', 'd'].map((name) => ({ package: name, dir: name }));
    const results = await runPool(
      entries,
      2,
      async (entry) => {
        started.push(entry.package);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return { exitCode: 0 };
      },
      () => 0
    );
    expect(started).toEqual(['a', 'b', 'c', 'd']);
    expect(peak).toBeLessThanOrEqual(2);
    expect(results).toHaveLength(4);
  });

  it('keeps running the remaining tasks after a failure', async () => {
    const entries: PoolEntry[] = ['a', 'b'].map((name) => ({ package: name, dir: name }));
    const results = await runPool(
      entries,
      1,
      (entry) => Promise.resolve({ exitCode: entry.package === 'a' ? 1 : 0 }),
      () => 0
    );
    expect(
      results.toSorted((x, y) => x.package.localeCompare(y.package)).map((r) => r.exitCode)
    ).toEqual([1, 0]);
  });
});

/** One attributed reading, in the shape the sampler hands back. */
function reading(rootsKb: Record<number, number>, remainderKb?: number): AttributedTreePssKb {
  return {
    rootsKb: new Map(Object.entries(rootsKb).map(([pid, kb]) => [Number(pid), kb])),
    remainderKb,
  };
}

/** A sampler on a platform that has no reading to give. */
function nothingAttributed(): AttributedTreePssKb {
  return reading({});
}

/** A reading that charges every live root alike, beside what is outside them. */
function evenReading(
  rootPids: readonly number[],
  perRootKb: number,
  remainderKb?: number
): AttributedTreePssKb {
  return { rootsKb: new Map(rootPids.map((pid) => [pid, perRootKb])), remainderKb };
}

describe('createPoolPeakRecorder', () => {
  it('keeps the largest reading taken outside every task as the fixed cost', async () => {
    const samples = [reading({}, 100), reading({}, 700), reading({}, 300)];
    let index = 0;
    const recorder = createPoolPeakRecorder(() => Promise.resolve(samples[index++] ?? reading({})));
    await recorder.sample(42);
    await recorder.sample(42);
    await recorder.sample(42);
    expect(recorder.stop().fixedKb).toBe(700);
  });

  it('returns one sample as its own parts added up, for the tracker to peak on', async () => {
    const recorder = createPoolPeakRecorder(() =>
      Promise.resolve(reading({ 7: 900, 8: 500 }, 100))
    );
    recorder.enter(7);
    recorder.enter(8);
    expect(await recorder.sample(42)).toBe(1500);
  });

  it('returns nothing at all where the sample could read nothing', async () => {
    const recorder = createPoolPeakRecorder(() => Promise.resolve(nothingAttributed()));
    recorder.enter(7);
    expect(await recorder.sample(42)).toBeUndefined();
    expect(recorder.stop().fixedKb).toBeUndefined();
  });

  it('names the lanes that were live at the sample whose total was largest', async () => {
    // Six lanes hold the first reading, four the second, three the third, and
    // only the second is dear — so the width of this run is four, which is
    // neither the most lanes any sample saw nor the lanes the last one saw.
    const perLaneKb = [100, 1_000_000, 200];
    let index = 0;
    const recorder = createPoolPeakRecorder((_treeRootPid, rootPids) =>
      Promise.resolve(evenReading(rootPids, perLaneKb[index++] ?? 0))
    );
    for (const pid of [1, 2, 3, 4, 5, 6]) recorder.enter(pid);
    await recorder.sample(42);
    recorder.leave(5);
    recorder.leave(6);
    await recorder.sample(42);
    recorder.leave(4);
    await recorder.sample(42);
    expect(recorder.stop().lanesAtPeak).toBe(4);
  });

  it('answers with a peak and the lanes live at it out of one reading', async () => {
    // One answer rather than a peak from here and a width from there: the pair
    // means "this much was held with this many lanes open", and two figures
    // read a moment apart can describe two different samples.
    const perLaneKb = [100, 1_000_000];
    let index = 0;
    const recorder = createPoolPeakRecorder((_treeRootPid, rootPids) =>
      Promise.resolve(evenReading(rootPids, perLaneKb[index++] ?? 0, 5000))
    );
    for (const pid of [1, 2, 3, 4]) recorder.enter(pid);
    await recorder.sample(42);
    recorder.leave(4);
    await recorder.sample(42);
    expect(recorder.stop()).toEqual({ peakKb: 3_005_000, lanesAtPeak: 3, fixedKb: 5000 });
  });

  it('names as roots exactly the pids entered and not yet left', async () => {
    const asked: number[][] = [];
    const recorder = createPoolPeakRecorder((_treeRootPid, rootPids) => {
      asked.push([...rootPids]);
      return Promise.resolve(reading({}, 100));
    });
    await recorder.sample(42);
    recorder.enter(7);
    await recorder.sample(42);
    recorder.leave(7);
    recorder.enter(8);
    await recorder.sample(42);
    expect(asked).toEqual([[], [7], [8]]);
  });

  it('adds nothing for a lane that has left, however the sample answers', async () => {
    const recorder = createPoolPeakRecorder(() => Promise.resolve(reading({ 7: 900 })));
    recorder.enter(7);
    recorder.leave(7);
    expect(await recorder.sample(42)).toBeUndefined();
  });
});

interface ExecCall {
  file: string;
  args: readonly string[];
  options: PoolExecOptions;
}

function fakeChild(result: Partial<PoolExecResult>, pid?: number): PoolChild {
  const child = Promise.resolve({ exitCode: 0, stdout: '', stderr: '', ...result });
  return Object.assign(child, { pid }) as PoolChild;
}

/**
 * A child that finishes only once the fake clock is advanced past it, so the
 * pool's sampler ticks while the task is live — which is the only state in
 * which a task's own subtree can be read.
 */
function slowChild(exitCode: number, pid: number, ms: number): PoolChild {
  const child = new Promise<PoolExecResult>((resolve) => {
    setTimeout(() => {
      resolve({ exitCode });
    }, ms);
  });
  return Object.assign(child, { pid }) as PoolChild;
}

/** The pid each package's spawn reports; the pool charges a subtree to it. */
const PIDS: Readonly<Record<string, number>> = { '@x/a': 101, '@x/b': 102, '@x/c': 103 };

function pidFor(package_: string): number {
  return PIDS[package_] ?? 199;
}

function dryRunJson(
  entries: readonly { pkg: string; dir: string; hit?: boolean }[],
  task = 'lint'
): string {
  return JSON.stringify({
    tasks: entries.map((entry) => ({
      taskId: `${entry.pkg}#${task}`,
      package: entry.pkg,
      directory: entry.dir,
      cache: { status: entry.hit === true ? 'HIT' : 'MISS' },
    })),
  });
}

/**
 * The newest run file a store holds, exactly as it was written. What a run
 * wrote and what a read hands back are different questions: the read carries
 * across the keys it knows and drops every other silently, so a claim about
 * what reaches disk is only settled here.
 */
function runFileBody(store: string): unknown {
  const newest = readdirSync(store)
    .filter((name) => name.endsWith('.json'))
    .toSorted((a, b) => a.localeCompare(b))
    .at(-1);
  if (newest === undefined) throw new Error('the run under test wrote no run file');
  return JSON.parse(readFileSync(path.join(store, newest), 'utf8'));
}

/** The line the pool prints before it opens lanes, out of everything it logged. */
function launchLine(lines: readonly string[]): string | undefined {
  return lines.find((line) => line.includes('concurrency '));
}

describe('poolMain', () => {
  const temporaryRoots: string[] = [];
  function makeRepoRoot(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'turbo-pool-'));
    temporaryRoots.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const dir of temporaryRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** Tasks finish at once unless `taskMs` gives the sampler a tick to run in. */
  function makeExec(
    dryRun: string,
    calls: ExecCall[],
    taskExit: (package_: string) => number,
    taskMs = 0
  ): PoolDeps['exec'] {
    return (file, args, options) => {
      calls.push({ file, args, options });
      if (args.includes('--dry-run=json')) return fakeChild({ stdout: dryRun });
      const filter = args.find((argument) => argument.startsWith('--filter='));
      const package_ = filter ? filter.slice('--filter='.length) : '';
      const exitCode = taskExit(package_);
      return taskMs === 0
        ? fakeChild({ exitCode }, pidFor(package_))
        : slowChild(exitCode, pidFor(package_), taskMs);
    };
  }

  function makeDeps(
    repoRoot: string,
    dryRun: string,
    calls: ExecCall[],
    taskExit: (package_: string) => number
  ): PoolDeps {
    let clock = 0;
    return {
      argv: ['lint'],
      repoRoot,
      fingerprint: FINGERPRINT,
      exec: makeExec(dryRun, calls, taskExit),
      maxConcurrency: 8,
      memoryBudgetKb: undefined,
      sampleAttributedPss: () => Promise.resolve(reading({}, 1234)),
      selfPid: 99,
      now: () => (clock += 1000),
      log: () => {},
    };
  }

  /** Drive a pool whose tasks outlive a sampling tick, on the fake clock. */
  async function runOnFakeClock(deps: PoolDeps): Promise<number> {
    vi.useFakeTimers();
    try {
      const pending = poolMain(deps);
      await vi.advanceTimersByTimeAsync(5000);
      return await pending;
    } finally {
      vi.useRealTimers();
    }
  }

  it('replays plainly when nothing missed', async () => {
    const repoRoot = makeRepoRoot();
    const calls: ExecCall[] = [];
    const deps = makeDeps(
      repoRoot,
      dryRunJson([{ pkg: '@x/a', dir: 'a', hit: true }]),
      calls,
      () => 0
    );
    const exit = await poolMain(deps);
    expect(exit).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args).toEqual(['lint', '--', '--max-warnings=0']);
  });

  it('spawns one filtered turbo per missed package and records walls in the ledger', async () => {
    const repoRoot = makeRepoRoot();
    const calls: ExecCall[] = [];
    const dryRun = dryRunJson([
      { pkg: '@x/a', dir: 'a' },
      { pkg: '@x/b', dir: 'b', hit: true },
      { pkg: '@x/c', dir: 'c' },
    ]);
    const deps = makeDeps(repoRoot, dryRun, calls, () => 0);
    const exit = await poolMain(deps);
    expect(exit).toBe(0);
    const filtered = calls.filter((call) => call.args.some((a) => a.startsWith('--filter=')));
    expect(filtered.map((call) => call.args)).toEqual([
      ['lint', '--filter=@x/a', '--', '--max-warnings=0'],
      ['lint', '--filter=@x/c', '--', '--max-warnings=0'],
    ]);
    const ledger = readLedger(ledgerPath(repoRoot, FINGERPRINT, 'lint'));
    expect(Object.keys(ledger.tasks).toSorted((a, b) => a.localeCompare(b))).toEqual([
      '@x/a',
      '@x/c',
    ]);
  });

  it('rewrites only the walls of the packages it actually ran', async () => {
    // The daily shape: one package misses cache and the rest replay. Their
    // recorded walls must survive, because the next full run reads them.
    const repoRoot = makeRepoRoot();
    const store = ledgerPath(repoRoot, FINGERPRINT, 'lint');
    writeLedger(
      store,
      {
        tasks: { '@x/a': { wallsMs: [11] }, '@x/untouched': { wallsMs: [222] } },
        runs: [],
      },
      whenEachStillStood
    );
    const calls: ExecCall[] = [];
    await poolMain(makeDeps(repoRoot, dryRunJson([{ pkg: '@x/a', dir: 'a' }]), calls, () => 0));
    const ledger = readLedger(store);
    expect(ledger.tasks['@x/untouched']?.wallsMs).toEqual([222]);
    expect(ledger.tasks['@x/a']?.wallsMs).not.toEqual([11]);
  });

  it("appends a run's wall to the history a package already holds", async () => {
    // The history is what a median can be taken over, so a run adds to it
    // rather than replacing it with the one reading it just took.
    const repoRoot = makeRepoRoot();
    const store = ledgerPath(repoRoot, FINGERPRINT, 'lint');
    writeLedger(store, { tasks: { '@x/a': { wallsMs: [11, 12] } }, runs: [] }, whenEachStillStood);
    const calls: ExecCall[] = [];
    await poolMain(makeDeps(repoRoot, dryRunJson([{ pkg: '@x/a', dir: 'a' }]), calls, () => 0));
    const walls = readLedger(store).tasks['@x/a']?.wallsMs;
    expect(walls).toHaveLength(3);
    expect(walls?.slice(0, 2)).toEqual([11, 12]);
  });

  it("keeps a package's wall history inside the retained window", async () => {
    const repoRoot = makeRepoRoot();
    const store = ledgerPath(repoRoot, FINGERPRINT, 'lint');
    const full = Array.from({ length: MAX_RETAINED_WALLS }, (_, index) => 1000 + index);
    writeLedger(store, { tasks: { '@x/a': { wallsMs: full } }, runs: [] }, whenEachStillStood);
    const calls: ExecCall[] = [];
    await poolMain(makeDeps(repoRoot, dryRunJson([{ pkg: '@x/a', dir: 'a' }]), calls, () => 0));
    const walls = readLedger(store).tasks['@x/a']?.wallsMs;
    expect(walls).toHaveLength(MAX_RETAINED_WALLS);
    expect(walls?.[0]).toBe(1001);
  });

  it('stops carrying a package the workspace no longer declares', async () => {
    // A carrier is kept so a package that rarely misses the build cache is not
    // forgotten; kept for a package that has been removed, it is a run file
    // nothing would ever reclaim.
    const repoRoot = makeRepoRoot();
    const store = ledgerPath(repoRoot, FINGERPRINT, 'lint');
    writeLedger(store, { tasks: { '@x/gone': { wallsMs: [900] } }, runs: [] }, whenEachStillStood);
    for (let index = 0; index < MAX_RETAINED_WALLS; index += 1) {
      writeLedger(store, { tasks: { '@x/a': { wallsMs: [index] } }, runs: [] }, whenEachStillStood);
    }
    const calls: ExecCall[] = [];
    await poolMain(makeDeps(repoRoot, dryRunJson([{ pkg: '@x/a', dir: 'a' }]), calls, () => 0));
    expect(readLedger(store).tasks['@x/gone']).toBeUndefined();
    expect(readLedger(store).tasks['@x/a']).toBeDefined();
  });

  it('records one whole-run observation carrying the shape the derivation reads', async () => {
    const repoRoot = makeRepoRoot();
    const calls: ExecCall[] = [];
    const dryRun = dryRunJson([
      { pkg: '@x/a', dir: 'a' },
      { pkg: '@x/c', dir: 'c' },
    ]);
    await poolMain(makeDeps(repoRoot, dryRun, calls, () => 0));
    const { runs } = readLedger(ledgerPath(repoRoot, FINGERPRINT, 'lint'));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ concurrency: 2, peakRssKb: 1234 });
    expect(runs[0]?.sumWallMs).toBeGreaterThan(0);
    expect(runs[0]?.longestWallMs).toBeGreaterThan(0);
    expect(runs[0]?.makespanMs).toBeGreaterThan(0);
  });

  it('samples the pool itself once rather than every task separately', async () => {
    const repoRoot = makeRepoRoot();
    const calls: ExecCall[] = [];
    const sampled: number[] = [];
    const deps: PoolDeps = {
      ...makeDeps(
        repoRoot,
        dryRunJson([
          { pkg: '@x/a', dir: 'a' },
          { pkg: '@x/c', dir: 'c' },
        ]),
        calls,
        () => 0
      ),
      sampleAttributedPss: (treeRootPid) => {
        sampled.push(treeRootPid);
        return Promise.resolve(reading({}, 4321));
      },
    };
    await poolMain(deps);
    expect(new Set(sampled)).toEqual(new Set([99]));
  });

  it('writes nothing to the ledger under --no-record but still uses what it holds', async () => {
    const repoRoot = makeRepoRoot();
    const store = ledgerPath(repoRoot, FINGERPRINT, 'lint');
    writeLedger(
      store,
      {
        tasks: { '@x/a': { wallsMs: [5] }, '@x/c': { wallsMs: [999] } },
        runs: [
          { concurrency: 4, taskCount: 4, sumWallMs: 1000, longestWallMs: 500, makespanMs: 600 },
        ],
      },
      whenEachStillStood
    );
    const calls: ExecCall[] = [];
    const dryRun = dryRunJson([
      { pkg: '@x/a', dir: 'a' },
      { pkg: '@x/c', dir: 'c' },
    ]);
    const deps: PoolDeps = {
      ...makeDeps(repoRoot, dryRun, calls, () => 0),
      argv: ['lint', '--no-record'],
    };
    await poolMain(deps);
    const after = readLedger(store);
    expect(after.runs).toHaveLength(1);
    expect(after.tasks['@x/a']?.wallsMs).toEqual([5]);
    // Order still follows the ledger it declined to update: longest first.
    const filtered = calls.filter((call) => call.args.some((a) => a.startsWith('--filter=')));
    expect(filtered.map((call) => call.args[1])).toEqual(['--filter=@x/c', '--filter=@x/a']);
  });

  it('releases in ledger longest-first order and returns 1 when any package fails', async () => {
    const repoRoot = makeRepoRoot();
    writeLedger(
      ledgerPath(repoRoot, FINGERPRINT, 'lint'),
      {
        tasks: { '@x/a': { wallsMs: [10] }, '@x/c': { wallsMs: [999] } },
        runs: [],
      },
      whenEachStillStood
    );
    const calls: ExecCall[] = [];
    const dryRun = dryRunJson([
      { pkg: '@x/a', dir: 'a' },
      { pkg: '@x/c', dir: 'c' },
    ]);
    const deps = makeDeps(repoRoot, dryRun, calls, (package_) => (package_ === '@x/a' ? 1 : 0));
    const exit = await poolMain(deps);
    expect(exit).toBe(1);
    const filtered = calls.filter((call) => call.args.some((a) => a.startsWith('--filter=')));
    expect(filtered.map((call) => call.args[1])).toEqual(['--filter=@x/c', '--filter=@x/a']);
  });

  it('under --force runs every package and forwards --force plus tool args to each spawn', async () => {
    const repoRoot = makeRepoRoot();
    const calls: ExecCall[] = [];
    const dryRun = dryRunJson([
      { pkg: '@x/a', dir: 'a', hit: true },
      { pkg: '@x/b', dir: 'b' },
    ]);
    const deps = {
      ...makeDeps(repoRoot, dryRun, calls, () => 0),
      argv: ['lint', '--force', '--', '--fix'],
    };
    const exit = await poolMain(deps);
    expect(exit).toBe(0);
    const filtered = calls.filter((call) => call.args.some((a) => a.startsWith('--filter=')));
    expect(filtered.map((call) => call.args)).toEqual([
      ['lint', '--filter=@x/a', '--force', '--', '--max-warnings=0', '--fix'],
      ['lint', '--filter=@x/b', '--force', '--', '--max-warnings=0', '--fix'],
    ]);
  });

  it('spawns lint with the flag that makes a warning fail, ahead of forwarded args', async () => {
    const repoRoot = makeRepoRoot();
    const calls: ExecCall[] = [];
    const deps = {
      ...makeDeps(repoRoot, dryRunJson([{ pkg: '@x/a', dir: 'a' }]), calls, () => 0),
      argv: ['lint', '--', '--format', 'summary'],
    };
    expect(await poolMain(deps)).toBe(0);
    const filtered = calls.filter((call) => call.args.some((a) => a.startsWith('--filter=')));
    expect(filtered.map((call) => call.args)).toEqual([
      ['lint', '--filter=@x/a', '--', '--max-warnings=0', '--format', 'summary'],
    ]);
  });

  it('adds no tool arguments of its own to a task other than lint', async () => {
    const repoRoot = makeRepoRoot();
    const calls: ExecCall[] = [];
    const deps = {
      ...makeDeps(repoRoot, dryRunJson([{ pkg: '@x/a', dir: 'a' }], 'typecheck'), calls, () => 0),
      argv: ['typecheck'],
    };
    expect(await poolMain(deps)).toBe(0);
    const filtered = calls.filter((call) => call.args.some((a) => a.startsWith('--filter=')));
    expect(filtered.map((call) => call.args)).toEqual([['typecheck', '--filter=@x/a']]);
  });

  it('omits the peak from the observation when sampling yields nothing', async () => {
    const repoRoot = makeRepoRoot();
    const calls: ExecCall[] = [];
    const deps = {
      ...makeDeps(repoRoot, dryRunJson([{ pkg: '@x/a', dir: 'a' }]), calls, () => 0),
      sampleAttributedPss: () => Promise.resolve(nothingAttributed()),
    };
    await poolMain(deps);
    const { runs } = readLedger(ledgerPath(repoRoot, FINGERPRINT, 'lint'));
    expect(runs[0]?.peakRssKb).toBeUndefined();
  });

  it('treats a spawn that reports no exit code as a failure', async () => {
    const repoRoot = makeRepoRoot();
    const calls: ExecCall[] = [];
    const deps: PoolDeps = {
      ...makeDeps(repoRoot, dryRunJson([{ pkg: '@x/a', dir: 'a' }]), calls, () => 0),
      exec: (file, args, options) => {
        calls.push({ file, args, options });
        if (args.includes('--dry-run=json')) {
          return fakeChild({ stdout: dryRunJson([{ pkg: '@x/a', dir: 'a' }]) });
        }
        return Object.assign(Promise.resolve({}), { pid: 7 }) as PoolChild;
      },
    };
    expect(await poolMain(deps)).toBe(1);
  });

  it('says so in its log line when the memory projection lowered the lane count', async () => {
    const repoRoot = makeRepoRoot();
    const store = ledgerPath(repoRoot, FINGERPRINT, 'lint');
    writeLedger(
      store,
      {
        tasks: {
          '@x/a': { wallsMs: [100] },
          '@x/b': { wallsMs: [100] },
        },
        runs: [
          {
            concurrency: 2,
            taskCount: 2,
            sumWallMs: 200,
            longestWallMs: 100,
            makespanMs: 100,
            peakRssKb: 8_000_000,
            fixedRssKb: 1_000_000,
          },
        ],
      },
      whenEachStillStood
    );
    const lines: string[] = [];
    const calls: ExecCall[] = [];
    const deps: PoolDeps = {
      ...makeDeps(
        repoRoot,
        dryRunJson([
          { pkg: '@x/a', dir: 'a' },
          { pkg: '@x/b', dir: 'b' },
        ]),
        calls,
        () => 0
      ),
      memoryBudgetKb: 6_000_000,
      log: (line) => lines.push(line),
    };
    await poolMain(deps);
    expect(launchLine(lines)).toContain('concurrency 1 (memory-bound');
  });

  it('names the machine ceiling on its launch line where almost nothing carries a wall', async () => {
    // The set the whole vocabulary exists for: twenty packages of which one
    // carries a wall. The work bound imputes that wall to the other nineteen
    // and lands at twenty, far above the lanes the machine has, so the ceiling
    // is the only limit that touched the count.
    const repoRoot = makeRepoRoot();
    const names = Array.from({ length: 20 }, (_, index) => `@x/p${String(index + 1)}`);
    writeLedger(
      ledgerPath(repoRoot, FINGERPRINT, 'lint'),
      {
        tasks: { '@x/p1': { wallsMs: [100] } },
        runs: [],
      },
      whenEachStillStood
    );
    const lines: string[] = [];
    const calls: ExecCall[] = [];
    const deps: PoolDeps = {
      ...makeDeps(
        repoRoot,
        dryRunJson(names.map((name) => ({ pkg: name, dir: name.slice('@x/'.length) }))),
        calls,
        () => 0
      ),
      log: (line) => lines.push(line),
    };
    await poolMain(deps);
    expect(launchLine(lines)).toContain('concurrency 8 (ceiling');
    expect(launchLine(lines)).not.toMatch(/derived/);
  });

  it('names the recorded walls on its launch line where they ask for fewer lanes than the machine has', async () => {
    const repoRoot = makeRepoRoot();
    writeLedger(
      ledgerPath(repoRoot, FINGERPRINT, 'lint'),
      {
        tasks: {
          '@x/a': { wallsMs: [300] },
          '@x/b': { wallsMs: [100] },
          '@x/c': { wallsMs: [100] },
        },
        runs: [],
      },
      whenEachStillStood
    );
    const lines: string[] = [];
    const calls: ExecCall[] = [];
    const deps: PoolDeps = {
      ...makeDeps(
        repoRoot,
        dryRunJson([
          { pkg: '@x/a', dir: 'a' },
          { pkg: '@x/b', dir: 'b' },
          { pkg: '@x/c', dir: 'c' },
        ]),
        calls,
        () => 0
      ),
      log: (line) => lines.push(line),
    };
    await poolMain(deps);
    expect(launchLine(lines)).toContain('concurrency 2 (work-bound');
  });

  it('files the run at the lanes that were live when its peak was read', async () => {
    // Six packages open together and finish one after another, so the lanes
    // live fall six, five, four, three as the run goes on, and only a sample
    // taken with four of them live reads anything dear. Four is therefore the
    // width this run is filed at — not the six lanes it declared, not the six
    // its first sample saw, and nothing a later reader could recompute from
    // the row's own counts.
    const repoRoot = makeRepoRoot();
    const packages = [1, 2, 3, 4, 5, 6].map((index) => `@y/${String(index)}`);
    const dryRun = dryRunJson(
      packages.map((name) => ({ pkg: name, dir: name.slice('@y/'.length) }))
    );
    const calls: ExecCall[] = [];
    const deps: PoolDeps = {
      ...makeDeps(repoRoot, dryRun, calls, () => 0),
      exec: (file, args, options) => {
        calls.push({ file, args, options });
        if (args.includes('--dry-run=json')) return fakeChild({ stdout: dryRun });
        const filter = args.find((argument) => argument.startsWith('--filter=')) ?? '';
        const place = Number(filter.slice(`--filter=@y/`.length));
        return slowChild(0, 200 + place, 600 * place);
      },
      sampleAttributedPss: (_treeRootPid, rootPids) =>
        Promise.resolve(evenReading(rootPids, rootPids.length === 4 ? 2_000_000 : 100_000, 50_000)),
    };
    await runOnFakeClock(deps);
    const { runs } = readLedger(ledgerPath(repoRoot, FINGERPRINT, 'lint'));
    expect(runs[0]?.lanesAtPeak).toBe(4);
    expect(runs[0]?.concurrency).toBe(6);
  });

  it("records what it held outside every task as the run's fixed cost", async () => {
    const repoRoot = makeRepoRoot();
    const calls: ExecCall[] = [];
    const dryRun = dryRunJson([{ pkg: '@x/a', dir: 'a' }]);
    const deps: PoolDeps = {
      ...makeDeps(repoRoot, dryRun, calls, () => 0),
      exec: makeExec(dryRun, calls, () => 0, 600),
      sampleAttributedPss: () =>
        Promise.resolve(reading({ [PIDS['@x/a'] ?? 0]: 5_000_000 }, 900_000)),
    };
    await runOnFakeClock(deps);
    const { runs } = readLedger(ledgerPath(repoRoot, FINGERPRINT, 'lint'));
    expect(runs[0]?.fixedRssKb).toBe(900_000);
    expect(runs[0]?.peakRssKb).toBe(5_900_000);
  });

  /** A pool over one package, sampled by `sampler`, whose task outlives a tick. */
  function depsSampledBy(repoRoot: string, sampler: PoolDeps['sampleAttributedPss']): PoolDeps {
    const calls: ExecCall[] = [];
    const dryRun = dryRunJson([{ pkg: '@x/a', dir: 'a' }]);
    return {
      ...makeDeps(repoRoot, dryRun, calls, () => 0),
      exec: makeExec(dryRun, calls, () => 0, 2000),
      sampleAttributedPss: sampler,
    };
  }

  it('files no width for a run whose spawns reported no pid', async () => {
    // A lane the recorder was never told the pid of is a lane it cannot count,
    // and a peak read with no lane counted is evidence about no width at all.
    const repoRoot = makeRepoRoot();
    const store = ledgerPath(repoRoot, FINGERPRINT, 'lint');
    const calls: ExecCall[] = [];
    const deps: PoolDeps = {
      ...makeDeps(repoRoot, dryRunJson([{ pkg: '@x/a', dir: 'a' }]), calls, () => 0),
      exec: (file, args, options) => {
        calls.push({ file, args, options });
        if (args.includes('--dry-run=json')) {
          return fakeChild({ stdout: dryRunJson([{ pkg: '@x/a', dir: 'a' }]) });
        }
        return fakeChild({ exitCode: 0 });
      },
      sampleAttributedPss: () => Promise.resolve(reading({ 101: 5_000_000 }, 900_000)),
    };
    expect(await poolMain(deps)).toBe(0);
    expect(runFileBody(store)).not.toHaveProperty(['runs', '0', 'lanesAtPeak']);
  });

  it('writes no sample count on the run it records', async () => {
    const repoRoot = makeRepoRoot();
    const store = ledgerPath(repoRoot, FINGERPRINT, 'lint');
    await runOnFakeClock(
      depsSampledBy(repoRoot, (_treeRootPid, rootPids) =>
        Promise.resolve(evenReading(rootPids, 5_000_000, 900_000))
      )
    );
    expect(runFileBody(store)).not.toHaveProperty(['runs', '0', 'peakSamples']);
  });

  it('writes no peak against a package it ran', async () => {
    // What this run measured of a package is its wall. What a sample read
    // inside that package's own subtree belongs to the whole tree's peak and
    // is spent there, so nothing per-package is kept for a projection to read.
    const repoRoot = makeRepoRoot();
    const store = ledgerPath(repoRoot, FINGERPRINT, 'lint');
    await runOnFakeClock(
      depsSampledBy(repoRoot, (_treeRootPid, rootPids) =>
        Promise.resolve(evenReading(rootPids, 5_000_000, 900_000))
      )
    );
    expect(runFileBody(store)).not.toHaveProperty(['tasks', '@x/a', 'peakRssKb']);
  });

  it('names the figure its lane count was checked against on the launch line', async () => {
    // Widths on record at one lane and at four, and a two-lane count sitting
    // between them: the figure it is checked against is read off the line
    // joining the two, so no rung on record holds it and none can be named.
    const repoRoot = makeRepoRoot();
    writeLedger(
      ledgerPath(repoRoot, FINGERPRINT, 'lint'),
      {
        tasks: { '@x/a': { wallsMs: [100] }, '@x/b': { wallsMs: [100] } },
        runs: [
          {
            concurrency: 1,
            taskCount: 1,
            sumWallMs: 100,
            longestWallMs: 100,
            makespanMs: 100,
            peakRssKb: 3_000_000,
            fixedRssKb: 1_000_000,
            lanesAtPeak: 1,
          },
          {
            concurrency: 4,
            taskCount: 4,
            sumWallMs: 400,
            longestWallMs: 100,
            makespanMs: 100,
            peakRssKb: 7_000_000,
            fixedRssKb: 1_000_000,
            lanesAtPeak: 4,
          },
        ],
      },
      whenEachStillStood
    );
    const lines: string[] = [];
    const calls: ExecCall[] = [];
    const deps: PoolDeps = {
      ...makeDeps(
        repoRoot,
        dryRunJson([
          { pkg: '@x/a', dir: 'a' },
          { pkg: '@x/b', dir: 'b' },
        ]),
        calls,
        () => 0
      ),
      memoryBudgetKb: 9_000_000,
      log: (line) => lines.push(line),
    };
    await poolMain(deps);
    expect(launchLine(lines)).toContain('checked against a projected 4333333 kB');
  });

  it('says on its launch line that a count below every rung was checked all the same', async () => {
    // A store that has only ever held four lanes still prices two, on the line
    // running from its narrowest rung down to that run's own baseline — so the
    // count was bounded, and the line says what bounded it.
    const repoRoot = makeRepoRoot();
    writeLedger(
      ledgerPath(repoRoot, FINGERPRINT, 'lint'),
      {
        tasks: {
          '@x/a': { wallsMs: [300] },
          '@x/b': { wallsMs: [100] },
          '@x/c': { wallsMs: [100] },
        },
        runs: [
          {
            concurrency: 4,
            taskCount: 4,
            sumWallMs: 400,
            longestWallMs: 100,
            makespanMs: 100,
            peakRssKb: 3_000_000,
            fixedRssKb: 1_000_000,
            lanesAtPeak: 4,
          },
        ],
      },
      whenEachStillStood
    );
    const lines: string[] = [];
    const calls: ExecCall[] = [];
    const deps: PoolDeps = {
      ...makeDeps(
        repoRoot,
        dryRunJson([
          { pkg: '@x/a', dir: 'a' },
          { pkg: '@x/b', dir: 'b' },
          { pkg: '@x/c', dir: 'c' },
        ]),
        calls,
        () => 0
      ),
      memoryBudgetKb: 9_000_000,
      log: (line) => lines.push(line),
    };
    await poolMain(deps);
    expect(launchLine(lines)).toContain('checked against a projected 2000000 kB');
  });

  it('says so in its log line when nothing bounded the lane count', async () => {
    const repoRoot = makeRepoRoot();
    const lines: string[] = [];
    const calls: ExecCall[] = [];
    const deps: PoolDeps = {
      ...makeDeps(repoRoot, dryRunJson([{ pkg: '@x/a', dir: 'a' }]), calls, () => 0),
      memoryBudgetKb: 1000,
      log: (line) => lines.push(line),
    };
    await poolMain(deps);
    expect(lines.some((line) => line.includes('memory-unguarded'))).toBe(true);
  });

  it('plans against the same tool arguments it will run with, so a cache hit is one those arguments produced', async () => {
    const repoRoot = makeRepoRoot();
    const calls: ExecCall[] = [];
    const deps = {
      ...makeDeps(repoRoot, dryRunJson([{ pkg: '@x/a', dir: 'a' }]), calls, () => 0),
      argv: ['lint', '--', '--fix'],
    };
    expect(await poolMain(deps)).toBe(0);
    expect(calls[0]?.args).toEqual(['lint', '--dry-run=json', '--', '--max-warnings=0', '--fix']);
  });

  it('records a wall only for the package whose command exited zero', async () => {
    const repoRoot = makeRepoRoot();
    const calls: ExecCall[] = [];
    const dryRun = dryRunJson([
      { pkg: '@x/a', dir: 'a' },
      { pkg: '@x/c', dir: 'c' },
    ]);
    const deps = makeDeps(repoRoot, dryRun, calls, (package_) => (package_ === '@x/a' ? 1 : 0));
    expect(await poolMain(deps)).toBe(1);
    const { tasks } = readLedger(ledgerPath(repoRoot, FINGERPRINT, 'lint'));
    expect(Object.keys(tasks)).toEqual(['@x/c']);
  });

  it('records nothing for a task whose spawn reported no exit code, and still names it', async () => {
    // What a signal-terminated child looks like at this seam: the runner hands
    // back a result carrying no exit code at all. Its wall is the wall of a run
    // cut short, so the recorded one stands.
    const repoRoot = makeRepoRoot();
    const store = ledgerPath(repoRoot, FINGERPRINT, 'lint');
    writeLedger(store, { tasks: { '@x/a': { wallsMs: [11] } }, runs: [] }, whenEachStillStood);
    const lines: string[] = [];
    const calls: ExecCall[] = [];
    const deps: PoolDeps = {
      ...makeDeps(repoRoot, dryRunJson([{ pkg: '@x/a', dir: 'a' }]), calls, () => 0),
      exec: (file, args, options) => {
        calls.push({ file, args, options });
        if (args.includes('--dry-run=json')) {
          return fakeChild({ stdout: dryRunJson([{ pkg: '@x/a', dir: 'a' }]) });
        }
        return Object.assign(Promise.resolve({}), { pid: 7 }) as PoolChild;
      },
      log: (line) => lines.push(line),
    };
    expect(await poolMain(deps)).toBe(1);
    expect(lines).toContain('[turbo-pool] failed: @x/a');
    expect(readLedger(store).tasks['@x/a']?.wallsMs).toEqual([11]);
  });

  it('propagates a failed dry run without spawning anything else', async () => {
    const repoRoot = makeRepoRoot();
    const calls: ExecCall[] = [];
    const deps: PoolDeps = {
      ...makeDeps(repoRoot, '{}', calls, () => 0),
      exec: (file, args, options) => {
        calls.push({ file, args, options });
        return fakeChild({ exitCode: 3, stderr: 'boom' });
      },
    };
    const exit = await poolMain(deps);
    expect(exit).toBe(3);
    expect(calls).toHaveLength(1);
  });
});

describe('toPoolChild', () => {
  it('carries the exit code the spawned process finished with', async () => {
    const result = await toPoolChild(Object.assign(Promise.resolve({ exitCode: 3 }), { pid: 11 }));

    expect(result.exitCode).toBe(3);
  });

  it('carries the pid, which the peak recorder attributes the subtree by', () => {
    const child = toPoolChild(Object.assign(Promise.resolve({ exitCode: 0 }), { pid: 11 }));

    expect(child.pid).toBe(11);
  });

  it('passes captured stdout through, which the dry-run pass parses', async () => {
    const result = await toPoolChild(
      Object.assign(Promise.resolve({ exitCode: 0, stdout: '{"tasks":[]}' }), { pid: 11 })
    );

    expect(result.stdout).toBe('{"tasks":[]}');
  });

  it('reports no exit code when the process ended without setting one', async () => {
    const result = await toPoolChild(Object.assign(Promise.resolve({}), { pid: 11 }));

    expect(result.exitCode).toBeUndefined();
  });

  it('passes captured stderr through', async () => {
    const result = await toPoolChild(
      Object.assign(Promise.resolve({ exitCode: 1, stderr: 'boom' }), { pid: 11 })
    );

    expect(result.stderr).toBe('boom');
  });

  it('carries no pid when the process never reported one', () => {
    const child = toPoolChild(Promise.resolve({ exitCode: 0 }));

    expect(child.pid).toBeUndefined();
  });

  it('reports no stdout when the stream was inherited rather than captured', async () => {
    const result = await toPoolChild(
      Object.assign(Promise.resolve({ exitCode: 0, stdout: new Uint8Array([1]) }), { pid: 11 })
    );

    expect(result.stdout).toBeUndefined();
  });
});
