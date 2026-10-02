import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUN_CLAIM_ENV } from './lib/claims/registry.js';
import { LIFELINE_ENV } from './lib/spawn/long-lived.js';
import { FIXTURE_BOOT_BUDGET_MS, untilFileWritten } from './lib/bounded-wait.setup.js';
import {
  DECLARATION_END,
  GROUP_SEPARATOR,
  execCheck,
  parseChecks,
  runChecks,
  summarize,
  watchInterrupts,
  type CheckSpec,
  type InterruptWatchHost,
} from './run-checks.js';
import {
  FORWARDED_SIGNALS,
  type LongLivedChild,
  type LongLivedOptions,
  type TreeSignal,
} from './lib/spawn/long-lived.js';

describe('the syntax a manifest spells', () => {
  it('separates groups on the sequence a manifest writes between them', () => {
    expect(GROUP_SEPARATOR).toBe('::');
  });

  it('closes a declaration on the sequence a manifest writes at the end', () => {
    expect(DECLARATION_END).toBe('::end');
  });
});

describe('parseChecks', () => {
  it('parses a single group into one check spec', () => {
    expect(parseChecks(['::', 'src', 'tsc', '--noEmit'])).toEqual([
      { label: 'src', program: 'tsc', args: ['--noEmit'] },
    ]);
  });

  it('parses multiple groups into separate check specs', () => {
    expect(
      parseChecks([
        '::',
        'src',
        'tsc',
        '--noEmit',
        '::',
        'tests',
        'tsc',
        '-p',
        'tsconfig.tests.json',
      ])
    ).toEqual([
      { label: 'src', program: 'tsc', args: ['--noEmit'] },
      { label: 'tests', program: 'tsc', args: ['-p', 'tsconfig.tests.json'] },
    ]);
  });

  it('parses a command with no arguments', () => {
    expect(parseChecks(['::', 'astro', 'astro', 'check'])).toEqual([
      { label: 'astro', program: 'astro', args: ['check'] },
    ]);
  });

  it('rejects an invocation with no groups at all', () => {
    expect(() => parseChecks([])).toThrow(/at least one/);
  });

  it('rejects a first token that is not the group separator', () => {
    expect(() => parseChecks(['src', 'tsc', '--noEmit'])).toThrow(/::/);
  });

  it('rejects a group missing its label', () => {
    expect(() => parseChecks(['::'])).toThrow(/label/);
  });

  it('rejects a group missing its command', () => {
    expect(() => parseChecks(['::', 'src'])).toThrow(/command/);
  });

  it('consumes a trailing declaration terminator rather than reading it as an argument', () => {
    expect(parseChecks(['::', 'src', 'tsc', '--noEmit', '::end'])).toEqual([
      { label: 'src', program: 'tsc', args: ['--noEmit'] },
    ]);
  });

  it('rejects an argument appended after the declaration terminator', () => {
    expect(() =>
      parseChecks(['::', 'skills', 'pnpm', 'typecheck:skills', '::end', '--force'])
    ).toThrow(/--force/);
  });

  it('names every lane command when it rejects an appended argument', () => {
    const parse = (): CheckSpec[] =>
      parseChecks([
        '::',
        'pool',
        'tsx',
        'scripts/turbo-pool.ts',
        'typecheck',
        '::',
        'skills',
        'pnpm',
        'typecheck:skills',
        '::end',
        '--force',
      ]);
    expect(parse).toThrow(/pnpm exec tsx scripts\/turbo-pool\.ts typecheck/);
    expect(parse).toThrow(/pnpm exec pnpm typecheck:skills/);
  });

  it('gives a trailing argument to the last group when the declaration is unterminated', () => {
    expect(parseChecks(['::', 'packages', 'tsx', 'scripts/test-batch.ts', '--force'])).toEqual([
      { label: 'packages', program: 'tsx', args: ['scripts/test-batch.ts', '--force'] },
    ]);
  });
});

describe('runChecks', () => {
  const checks: CheckSpec[] = [
    { label: 'first', program: 'tsc', args: ['--noEmit'] },
    { label: 'second', program: 'tsc', args: ['-p', 'tsconfig.tests.json'] },
  ];

  it('runs every check and reports each outcome in order', async () => {
    const run = vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(0);
    const outcomes = await runChecks(checks, { run });
    expect(outcomes).toEqual([
      { label: 'first', exitCode: 0 },
      { label: 'second', exitCode: 0 },
    ]);
  });

  it('still runs the second check when the first fails', async () => {
    const run = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const outcomes = await runChecks(checks, { run });
    expect(run).toHaveBeenCalledTimes(2);
    expect(outcomes).toEqual([
      { label: 'first', exitCode: 1 },
      { label: 'second', exitCode: 0 },
    ]);
  });

  it('still reports the first check when the second fails', async () => {
    const run = vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    const outcomes = await runChecks(checks, { run });
    expect(outcomes).toEqual([
      { label: 'first', exitCode: 0 },
      { label: 'second', exitCode: 1 },
    ]);
  });

  it('still runs the second check when the first runner throws', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('spawn failed')).mockResolvedValueOnce(0);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const outcomes = await runChecks(checks, { run });
    errorSpy.mockRestore();
    expect(run).toHaveBeenCalledTimes(2);
    expect(outcomes).toEqual([
      { label: 'first', exitCode: 1 },
      { label: 'second', exitCode: 0 },
    ]);
  });

  it('still runs the second check when the first runner throws a non-Error value', async () => {
    const run = vi.fn().mockRejectedValueOnce('spawn failed').mockResolvedValueOnce(0);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const outcomes = await runChecks(checks, { run });
    errorSpy.mockRestore();
    expect(outcomes).toEqual([
      { label: 'first', exitCode: 1 },
      { label: 'second', exitCode: 0 },
    ]);
  });

  it('stops at the check an interrupt reached instead of running the next one', async () => {
    let interrupted = false;
    // The signal that ends a lane reaches this process too, which is what tells
    // the run apart from a lane that merely failed.
    const run = vi.fn(() => {
      interrupted = true;
      return Promise.resolve(1);
    });

    const outcomes = await runChecks(checks, { run }, () => interrupted);

    expect(run).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual([{ label: 'first', exitCode: 1 }]);
  });

  it('still runs the second check when the first failed and nothing was interrupted', async () => {
    const run = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    const outcomes = await runChecks(checks, { run }, () => false);

    expect(run).toHaveBeenCalledTimes(2);
    expect(outcomes).toEqual([
      { label: 'first', exitCode: 1 },
      { label: 'second', exitCode: 0 },
    ]);
  });

  it('runs no check at all when the interrupt arrived before the first', async () => {
    const run = vi.fn().mockResolvedValue(0);

    const outcomes = await runChecks(checks, { run }, () => true);

    expect(run).not.toHaveBeenCalled();
    expect(outcomes).toEqual([]);
  });
});

/** A signal host a case drives, standing in for the process the runner binds. */
function recordingHost(): InterruptWatchHost & {
  fire: (signal: TreeSignal) => void;
  listening: (signal: TreeSignal) => number;
} {
  const handlers = new Map<TreeSignal, Set<() => void>>();
  const setFor = (signal: TreeSignal): Set<() => void> => {
    const existing = handlers.get(signal);
    if (existing !== undefined) return existing;
    const created = new Set<() => void>();
    handlers.set(signal, created);
    return created;
  };
  return {
    on: (signal, handler) => {
      setFor(signal).add(handler);
    },
    off: (signal, handler) => {
      setFor(signal).delete(handler);
    },
    fire: (signal) => {
      for (const handler of setFor(signal)) handler();
    },
    listening: (signal) => setFor(signal).size,
  };
}

describe('watchInterrupts', () => {
  it('reports nothing while no signal has arrived', () => {
    expect(watchInterrupts(recordingHost()).interrupted()).toBe(false);
  });

  it('reports a terminating signal that reached this process', () => {
    const host = recordingHost();
    const watch = watchInterrupts(host);

    host.fire('SIGINT');

    expect(watch.interrupted()).toBe(true);
  });

  it('watches every signal the spawner forwards to a lane', () => {
    const host = recordingHost();
    watchInterrupts(host);

    expect(FORWARDED_SIGNALS.filter((signal) => host.listening(signal) !== 1)).toEqual([]);
  });

  it('stops watching once one has arrived, so a repeat reaches the action it suppressed', () => {
    const host = recordingHost();
    watchInterrupts(host);

    host.fire('SIGINT');

    expect(FORWARDED_SIGNALS.filter((signal) => host.listening(signal) !== 0)).toEqual([]);
  });

  it('stops watching when released', () => {
    const host = recordingHost();
    const watch = watchInterrupts(host);

    watch.release();

    expect(FORWARDED_SIGNALS.filter((signal) => host.listening(signal) !== 0)).toEqual([]);
  });

  it('watches this process when no host is named', () => {
    const before = FORWARDED_SIGNALS.map((signal) => process.listenerCount(signal));
    const watch = watchInterrupts();
    const during = FORWARDED_SIGNALS.map((signal) => process.listenerCount(signal));
    watch.release();

    expect(during).toEqual(before.map((count) => count + 1));
    expect(FORWARDED_SIGNALS.map((signal) => process.listenerCount(signal))).toEqual(before);
  });
});

describe('summarize', () => {
  it('reports success with no message when every check passed', () => {
    expect(
      summarize([
        { label: 'first', exitCode: 0 },
        { label: 'second', exitCode: 0 },
      ])
    ).toEqual({ exitCode: 0, message: '' });
  });

  it('names the single failing check', () => {
    const result = summarize([
      { label: 'first', exitCode: 1 },
      { label: 'second', exitCode: 0 },
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('first');
    expect(result.message).not.toContain('second');
  });

  it('names every failing check when more than one fails', () => {
    const result = summarize([
      { label: 'first', exitCode: 1 },
      { label: 'second', exitCode: 2 },
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('first');
    expect(result.message).toContain('second');
  });

  it('fails a run that was stopped even where every check that ran passed', () => {
    const result = summarize([{ label: 'first', exitCode: 0 }], true);

    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/stopped/i);
  });

  it('names the failing check as well as the stop when a stopped run had one', () => {
    const result = summarize([{ label: 'first', exitCode: 1 }], true);

    expect(result.message).toContain('first');
    expect(result.message).toMatch(/stopped/i);
  });
});

function child(exitCode: number): LongLivedChild {
  return {
    pid: 4242,
    pgid: 4242,
    exit: Promise.resolve(exitCode),
    kill: () => Promise.resolve(exitCode),
  };
}

/** A stand-in for the long-lived spawner, typed as the call site sees it. */
function spawning(
  started: LongLivedChild
): (file: string, args: readonly string[], options: LongLivedOptions) => Promise<LongLivedChild> {
  return () => Promise.resolve(started);
}

describe('execCheck', () => {
  it('starts the lane through the spawner that puts a lifeline in its hands', async () => {
    const spawn = vi.fn(spawning(child(0)));

    await execCheck({ label: 'src', program: 'tsc', args: ['--noEmit'] }, spawn);

    expect(spawn).toHaveBeenCalledWith(
      'tsc',
      ['--noEmit'],
      expect.objectContaining({ stdio: 'inherit' })
    );
  });

  it('hands back what the lane exited with', async () => {
    await expect(
      execCheck({ label: 'src', program: 'tsc', args: [] }, vi.fn(spawning(child(2))))
    ).resolves.toBe(2);
  });

  it('kills a lane the interrupt reached while that lane was still starting', async () => {
    const kill = vi.fn(() => Promise.resolve(143));
    const started: LongLivedChild = { pid: 4242, pgid: 4242, exit: Promise.resolve(0), kill };
    let interrupted = false;
    // A signal arriving here reaches this process's watch and nothing else:
    // the lane's own forwarder is armed only once the spawner has returned.
    const spawn: (
      file: string,
      args: readonly string[],
      options: LongLivedOptions
    ) => Promise<LongLivedChild> = () => {
      interrupted = true;
      return Promise.resolve(started);
    };

    const exitCode = await execCheck(
      { label: 'src', program: 'tsc', args: [] },
      vi.fn(spawn),
      () => interrupted
    );

    expect(kill).toHaveBeenCalled();
    expect(exitCode).toBe(143);
  });

  it('waits out a lane whose start nothing interrupted', async () => {
    const kill = vi.fn(() => Promise.resolve(143));
    const started: LongLivedChild = { pid: 4242, pgid: 4242, exit: Promise.resolve(0), kill };

    const exitCode = await execCheck(
      { label: 'src', program: 'tsc', args: [] },
      vi.fn(spawning(started)),
      () => false
    );

    expect(kill).not.toHaveBeenCalled();
    expect(exitCode).toBe(0);
  });
});

/**
 * The runner driven the way a manifest entry drives it, which is the only place
 * the decision above is joined to the signals a real operator sends. A case
 * over `runChecks` alone would still pass with the watch unwired, and the
 * commands this matters on — the one that restarts the stack, the one that runs
 * every package's tests — are exactly the ones where a lane starting after a
 * Ctrl+C is worst.
 */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** A lane that stays up until something ends it, announcing its own id first. */
const HOLDING_LANE = `import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], String(process.pid));
setInterval(() => {}, 1000);
`;

/** A lane that fails, which is what the runner is built to carry on past. */
const FAILING_LANE = `import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], String(process.pid));
process.exit(3);
`;

/** The lane after it, which says by existing that the run went on. */
const MARKING_LANE = `import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], 'ran');
`;

/**
 * Sends one signal at the moment a lane is starting, which is otherwise a gap
 * too narrow to aim at from a clock. The runner records its lifeline socket
 * against its run claim on the way into the first spawn and arms that lane's
 * forwarder on the way out, so a claim directory that has just stopped being
 * empty is a spinning watcher's cue that the runner is inside it.
 */
const SPAWN_SNIPER = `const { readdirSync } = require('node:fs');
const dir = process.argv[1];
const runner = Number(process.argv[2]);
const deadline = Date.now() + 30000;
for (;;) {
  let entries = 0;
  try { entries = readdirSync(dir).length; } catch {}
  if (entries > 0) break;
  if (Date.now() > deadline) process.exit(2);
}
try { process.kill(runner, 'SIGINT'); } catch {}
`;

/** When a driven run's one signal is sent, relative to the first lane. */
type Aim = 'none' | 'once it is running' | 'while it is starting';

/**
 * Whether the driven command is given a run claim. A command holding none is
 * ordinary — `pnpm` scripts that register a run are a subset — and the runner's
 * lifeline socket is one of the few resources a claim-free process may still
 * record nothing for, so a lane here is what says that spawning still works
 * where recording does not.
 */
type Claim = 'held' | 'none';

/** How long a driven case waits on a kernel fact, polled rather than slept out. */
const DRIVEN_TIMEOUT_MS = 60_000;

let scratchDir = '';
let started: number[] = [];

interface DrivenRun {
  /** What the whole command answered. */
  readonly exitCode: number | null;
  /** Whether the lane after the interrupted or failing one ran at all. */
  readonly nextLaneRan: boolean;
}

/**
 * Runs the real runner over two lanes and reports what happened to the second.
 * Everything it starts is watched being born, and everything it writes lives
 * under a directory the case removes.
 */
async function driveTwoLanes(
  firstLane: string,
  aim: Aim,
  claim: Claim = 'held'
): Promise<DrivenRun> {
  const laneDir = await fs.mkdtemp(path.join(scratchDir, 'lanes-'));
  const first = path.join(laneDir, 'first.mjs');
  const second = path.join(laneDir, 'second.mjs');
  await fs.writeFile(first, firstLane);
  await fs.writeFile(second, MARKING_LANE);
  const claimDir = path.join(laneDir, 'run');
  await fs.mkdir(claimDir);
  const firstMark = path.join(laneDir, 'first-mark');
  const secondMark = path.join(laneDir, 'second-mark');

  // The lifeline address is removed rather than emptied: the value inherited
  // here names the run hosting these tests, and leaving it would make the
  // runner a watcher of that one rather than the head of its own.
  const inherited = Object.entries(process.env).filter(([name]) => name !== LIFELINE_ENV);
  const runner = spawn(
    // This process's own interpreter rather than a name resolved off the path,
    // which is what the manifest's launcher word resolves to for a developer.
    process.execPath,
    [
      '--import',
      'tsx',
      'scripts/run-checks.ts',
      GROUP_SEPARATOR,
      'one',
      process.execPath,
      first,
      firstMark,
      GROUP_SEPARATOR,
      'two',
      process.execPath,
      second,
      secondMark,
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...Object.fromEntries(inherited),
        [RUN_CLAIM_ENV]: claim === 'held' ? claimDir : '',
        TMPDIR: laneDir,
      },
      stdio: ['ignore', 'ignore', 'ignore'],
      // Its own group, so a signal can address the runner alone — which is what
      // an operator's Ctrl+C reaches now that a lane sits in a group of its own.
      detached: true,
    }
  );
  if (runner.pid !== undefined) started.push(runner.pid);

  const exited = new Promise<number | null>((resolve) => {
    runner.once('exit', (code) => {
      resolve(code);
    });
  });

  if (aim === 'once it is running') {
    started.push(Number(await untilFileWritten(firstMark, FIXTURE_BOOT_BUDGET_MS)));
    if (runner.pid !== undefined) process.kill(runner.pid, 'SIGINT');
  }
  if (aim === 'while it is starting') {
    const sniper = spawn(process.execPath, ['-e', SPAWN_SNIPER, claimDir, String(runner.pid)], {
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
    });
    if (sniper.pid !== undefined) started.push(sniper.pid);
  }

  return { exitCode: await exited, nextLaneRan: existsSync(secondMark) };
}

describe('the runner driven the way a manifest entry drives it', () => {
  beforeEach(async () => {
    scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-run-checks-'));
    started = [];
  });

  afterEach(async () => {
    // Runs whether the case passed or failed. Every id was watched being born
    // here, and the gentlest signal that ends a lane is the one it takes.
    for (const pid of started) {
      if (!Number.isInteger(pid) || pid <= 1) continue;
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Already gone is the outcome this wanted.
      }
    }
    await fs.rm(scratchDir, { recursive: true, force: true });
  });

  it(
    'stops where an interrupt reached it rather than running the lane after',
    async () => {
      const run = await driveTwoLanes(HOLDING_LANE, 'once it is running');

      expect(run.nextLaneRan).toBe(false);
      expect(run.exitCode).toBe(1);
    },
    DRIVEN_TIMEOUT_MS
  );

  it(
    'ends a lane an interrupt reached while that lane was still starting',
    async () => {
      // Nothing else ends this lane: it holds no forwarder yet, and it is
      // written to stay up. A run that answers at all is one that killed it.
      const run = await driveTwoLanes(HOLDING_LANE, 'while it is starting');

      expect(run.nextLaneRan).toBe(false);
      expect(run.exitCode).toBe(1);
    },
    DRIVEN_TIMEOUT_MS
  );

  it(
    'runs the lane after one that merely failed',
    async () => {
      const run = await driveTwoLanes(FAILING_LANE, 'none');

      expect(run.nextLaneRan).toBe(true);
      expect(run.exitCode).toBe(1);
    },
    DRIVEN_TIMEOUT_MS
  );

  it(
    'runs its lanes for a command holding no run claim',
    async () => {
      const run = await driveTwoLanes(MARKING_LANE, 'none', 'none');

      expect(run.nextLaneRan).toBe(true);
      expect(run.exitCode).toBe(0);
    },
    DRIVEN_TIMEOUT_MS
  );
});
