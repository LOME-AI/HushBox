import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  FIXTURE_BOOT_BUDGET_MS,
  SIGNAL_REACTION_BUDGET_MS,
  untilObserved,
} from '../bounded-wait.setup.js';
import {
  MACHINE_READINGS,
  MEMORY_BUDGET_ENV,
  attributeReading,
  memoryBudgetKb,
  parseMemAvailableKb,
  parseProcStatPids,
  parseSmapsRollupPssKb,
  parseSmapsRollupSwapPssKb,
  partitionTreeByRoots,
  readProcStatRecords,
  sampleAttributedTreePssKb,
} from './memory.js';

/** A process that exited between the listing and the read is ordinary churn. */
function readOrSkip(pathname: string): string | undefined {
  try {
    return readFileSync(pathname, 'utf8');
  } catch {
    return undefined;
  }
}

/** The per-process sum the sampler replaced: every shared page once per sharer. */
function treeRssSumKb(rootPid: number): number {
  const entries = readdirSync('/proc')
    .filter((name) => /^\d+$/.test(name))
    .map((name) => readOrSkip(`/proc/${name}/stat`))
    .map((stat) => (stat === undefined ? undefined : parseProcStatPids(stat)))
    .filter((entry) => entry !== undefined);
  let total = 0;
  for (const pid of partitionTreeByRoots(entries, rootPid, []).keys()) {
    const rollup = readOrSkip(`/proc/${String(pid)}/smaps_rollup`) ?? '';
    total += Number.parseInt(/^Rss:\s+(\d+)\s+kB/m.exec(rollup)?.[1] ?? '0', 10);
  }
  return total;
}

const SHARERS = 3;

/**
 * The bar the proportional sum must sit under, relative to the per-process sum
 * over the same tree. It is not a reading of this host. In the tree below every
 * process maps one copy of the same runtime image, so the per-process sum
 * charges those file-backed pages once per process while a proportional sum
 * charges them once in total; with the private part held at the runtime's own
 * floor by a program that allocates nothing, the ratio a correct sampler can
 * reach is bounded by (n·private + shared) / (n·(private + shared)), which is
 * well under a half for a Node process and falls further as sharers are added.
 * A per-process sum scores exactly 1, whatever the tree is doing.
 */
const SHARING_MARGIN = 0.75;

/**
 * How long each program this fixture runs gives itself before ending, whatever
 * became of the process that started it. One spelling rather than one per
 * program: the
 * bound {@link startSharingTree}'s docblock states holds only if every member
 * of the tree keeps the same one, and a second spelling could drift off it
 * without a reader of either noticing.
 *
 * Long enough that a loaded host cannot have the tree end itself while the
 * assertion that needs it is still running.
 */
const SELF_EXIT_MS = 60_000;

/**
 * What the case that waits for a marked tree to arrive and then for it to be
 * gone may spend: the budget for a start of ours twice over, once for the tree
 * it counts and once for the tree it then abandons, plus the budget for a
 * signal reaching what the second start left running.
 *
 * At the runner's default the first of those waits outlives the case, and what
 * surfaces is a generic timeout — a case was slow — rather than the assertion
 * naming which tree never arrived or never went.
 */
const MARKED_TREE_CASE_TIMEOUT_MS = FIXTURE_BOOT_BUDGET_MS * 2 + SIGNAL_REACTION_BUDGET_MS;

/** Idles, announcing itself once it is fully up; reaps itself if abandoned. */
const LEAF_PROGRAM = String.raw`process.stdout.write("up\n"); setTimeout(() => { process.exit(0); }, ${String(SELF_EXIT_MS)});`;

/** Announces itself only once every child has, so no wait is timing-based. */
const ROOT_PROGRAM = String.raw`const { spawn } = require('node:child_process');
let up = 0;
for (let i = 0; i < ${String(SHARERS)}; i += 1) {
  const child = spawn(process.execPath, ['-e', ${JSON.stringify(LEAF_PROGRAM)}], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  child.stdout.on('data', () => {
    up += 1;
    if (up === ${String(SHARERS)}) process.stdout.write('ready\n');
  });
}
setTimeout(() => { process.exit(0); }, ${String(SELF_EXIT_MS)});`;

interface SharingTree {
  readonly pid: number;
  readonly kill: () => void;
}

/**
 * A root process and its children, all running the same runtime over a program
 * with no heap of its own — the shape in which the overcount a proportional sum
 * removes is the whole of the difference between the two accountings.
 *
 * THE TREE IS DELIBERATELY OUTSIDE THE CLAIM REGISTRY, and this is the record
 * of why, so the next reader neither re-derives it nor adds the claim.
 *
 * What leaving it unclaimed costs is bounded and checkable rather than argued.
 * The tree holds no port, socket, container or file, and every program it runs
 * ends itself after {@link SELF_EXIT_MS} whatever became of the process that
 * started it — so a worker killed with the tree up leaks the root and its
 * {@link SHARERS} children, idle, for at most that long. A caller passing its
 * own root program owes that bound: the same runtime, nothing held, and a
 * self-exit no later than {@link SELF_EXIT_MS}. The death of the process
 * running this fixture is the only way out that leaves the tree standing — a
 * readiness wait that rejects ends the group before it raises.
 * Each member also carries the enclosing run's identity in the
 * environment it inherited at spawn, which is exactly the kernel fact
 * `attributeLiveGroup` in `scripts/lib/spawn/long-lived.ts` puts to a process
 * group. What the tree lacks is a record entry, not an owner, and not
 * enumerability either: once the run has ended, the world audit reads that same
 * identity off every live process and reports every group the run's record does
 * not name (`StrayGroupReading` in `scripts/lib/claims/world-audit.ts`).
 *
 * What claiming it costs is more than that buys, on two counts that are
 * properties of the claim primitives rather than of this file. Recording is
 * refused outright by `appendEntry` in `scripts/lib/claims/registry.ts` where
 * the process holds no run claim, so this fixture would carry its own copy of
 * the production "record only if this process owns a run" guard or fail every
 * bare and out-of-tree run of this file; and nothing here may drop the entry
 * afterwards, `retireRecordedGroup` in that same module being documented for
 * the records of runs whose lock has already answered that they are gone,
 * which the run around this one has not. Routing the spawn through
 * `spawnLongLived` instead gives up the pipe this readiness handshake rides
 * on, that helper's streams being inherited or discarded and never piped; the
 * handshake would move to a port or a file, which is a machine-wide resource
 * held for the length of a unit test in place of processes that end
 * themselves.
 */
async function startSharingTree(rootProgram: string = ROOT_PROGRAM): Promise<SharingTree> {
  // Its own process group: the grandchildren are not this process's children,
  // so only a group-addressed signal reaches the whole tree.
  const root = spawn(process.execPath, ['-e', rootProgram], {
    stdio: ['ignore', 'pipe', 'inherit'],
    detached: true,
  });
  const { pid, stdout } = root;
  if (pid === undefined) throw new Error('the tree never started');
  try {
    await new Promise<void>((resolve, reject) => {
      let seen = '';
      stdout.on('data', (chunk: Buffer) => {
        seen += chunk.toString('utf8');
        if (seen.includes('ready')) resolve();
      });
      root.once('error', reject);
      root.once('exit', () => {
        reject(new Error('the tree exited before it was up'));
      });
    });
  } catch (error) {
    // The group outlives the root it is named for: children started before the
    // root died are still in it, so raising without this leaves them running.
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // The group is already empty — the root never started one, or nothing in
      // it outlived the failure.
    }
    throw error;
  }
  return {
    pid,
    kill: () => {
      process.kill(-pid, 'SIGKILL');
    },
  };
}

/**
 * A root that starts the same sharers and then leaves without announcing them.
 * Its children exist before it exits, so the readiness wait rejects on a group
 * that is still populated. The marker rides each child's argument vector,
 * which is what identifies them once the root that named the group is gone.
 */
function abandoningRootProgram(marker: string): string {
  const leaf = `${LEAF_PROGRAM} // ${marker}`;
  return String.raw`const { spawn } = require('node:child_process');
for (let i = 0; i < ${String(SHARERS)}; i += 1) {
  spawn(process.execPath, ['-e', ${JSON.stringify(leaf)}], { stdio: 'ignore' });
}
process.exit(0);`;
}

/** Every live process the kernel names as a direct child of this one. */
function liveChildrenOf(parentPid: number): number[] {
  return readdirSync('/proc')
    .filter((name) => /^\d+$/.test(name))
    .map((name) => readOrSkip(`/proc/${name}/stat`))
    .map((stat) => (stat === undefined ? undefined : parseProcStatPids(stat)))
    .filter((entry) => entry !== undefined)
    .filter((entry) => entry.ppid === parentPid)
    .map((entry) => entry.pid);
}

/** Live processes running a program that carries this marker. */
function markedPids(marker: string): number[] {
  return readdirSync('/proc')
    .filter((name) => /^\d+$/.test(name))
    .filter((name) => readOrSkip(`/proc/${name}/cmdline`)?.includes(marker) === true)
    .map((name) => Number.parseInt(name, 10));
}

/**
 * Neither a spawn nor a signal completes on the caller's next tick, so the
 * list is polled to a bound and whatever it holds at the bound is returned —
 * an assertion reading the wrong list fails, where an unbounded wait hangs.
 *
 * The bound is the caller's, because the two things waited for here are not one
 * subject: a tree arriving is processes of ours starting, and a tree going is
 * what a signal asks of processes already running, which the shared budgets
 * price separately and for reasons each of them states.
 */
async function pollMarkedPids(
  marker: string,
  settled: (pids: number[]) => boolean,
  budgetMs: number
): Promise<number[]> {
  // Read before the poll as well as inside it, so what comes back is always a
  // listing something read, never the empty one an unspent budget would leave.
  let seen = markedPids(marker);
  await untilObserved(() => {
    seen = markedPids(marker);
    return settled(seen);
  }, budgetMs);
  return seen;
}

describe('parseProcStatPids', () => {
  it('reads pid and ppid around a parenthesised comm', () => {
    expect(parseProcStatPids('123 (eslint) S 45 123 45 0 -1')).toEqual({ pid: 123, ppid: 45 });
  });

  it('survives a comm containing spaces and parentheses', () => {
    expect(parseProcStatPids('7 (tsx (evil) name) R 1 7 1')).toEqual({ pid: 7, ppid: 1 });
  });

  it('returns undefined for malformed content', () => {
    expect(parseProcStatPids('garbage')).toBeUndefined();
    expect(parseProcStatPids('12 (x R nope')).toBeUndefined();
    // Parenthesised comm closed, but the ppid field never arrives.
    expect(parseProcStatPids('12 (eslint) S')).toBeUndefined();
  });

  // A `/proc` file the sampler could not read reaches its parser as empty
  // content rather than as an absent value, so that no reader of `/proc` needs
  // a branch on whether the process outlived the listing that named it.
  it('reads nothing out of the empty content an unreadable file yields', () => {
    expect(parseProcStatPids('')).toBeUndefined();
  });
});

/** A tree whose shape is stated once, so the cases below argue about one thing. */
const NESTED_ENTRIES = [
  { pid: 1, ppid: 0 },
  { pid: 10, ppid: 1 },
  { pid: 20, ppid: 10 },
  { pid: 21, ppid: 10 },
  { pid: 30, ppid: 20 },
  { pid: 31, ppid: 30 },
  { pid: 40, ppid: 2 },
];

describe('partitionTreeByRoots', () => {
  it('charges every process in the tree to the remainder where no root is named', () => {
    const owners = partitionTreeByRoots(NESTED_ENTRIES, 10, []);
    expect([...owners.keys()].toSorted((a, b) => a - b)).toEqual([10, 20, 21, 30, 31]);
    expect([...owners.values()].every((owner) => owner === undefined)).toBe(true);
  });

  it('charges a named root and everything beneath it to that root', () => {
    const owners = partitionTreeByRoots(NESTED_ENTRIES, 10, [20]);
    expect(owners.get(20)).toBe(20);
    expect(owners.get(30)).toBe(20);
    expect(owners.get(31)).toBe(20);
  });

  it('leaves a process under no named root charged to the remainder', () => {
    const owners = partitionTreeByRoots(NESTED_ENTRIES, 10, [20]);
    expect(owners.get(10)).toBeUndefined();
    expect(owners.get(21)).toBeUndefined();
  });

  it('charges a process beneath two named roots to the nearer one', () => {
    const owners = partitionTreeByRoots(NESTED_ENTRIES, 10, [20, 30]);
    expect(owners.get(31)).toBe(30);
  });

  it('charges the tree root to itself where the caller names it', () => {
    expect(partitionTreeByRoots(NESTED_ENTRIES, 10, [10]).get(21)).toBe(10);
  });

  it('visits a child named twice only once', () => {
    const owners = partitionTreeByRoots(
      [
        { pid: 10, ppid: 1 },
        { pid: 20, ppid: 10 },
        { pid: 20, ppid: 10 },
      ],
      10,
      []
    );
    expect([...owners.keys()].toSorted((a, b) => a - b)).toEqual([10, 20]);
  });
});

describe('attributeReading', () => {
  it('sums the readings charged to one root into the total for that root', () => {
    const owners = partitionTreeByRoots(NESTED_ENTRIES, 10, [20]);
    const attributed = attributeReading(owners, [
      { pid: 20, pssKb: 200 },
      { pid: 30, pssKb: 30 },
      { pid: 31, pssKb: 1 },
    ]);
    expect(attributed.rootsKb.get(20)).toBe(231);
  });

  it('sums the readings charged to no root into the remainder', () => {
    const owners = partitionTreeByRoots(NESTED_ENTRIES, 10, [20]);
    const attributed = attributeReading(owners, [
      { pid: 10, pssKb: 7 },
      { pid: 21, pssKb: 5 },
      { pid: 30, pssKb: 30 },
    ]);
    expect(attributed.remainderKb).toBe(12);
  });

  it('leaves out a root whose every reading could not be taken', () => {
    const owners = partitionTreeByRoots(NESTED_ENTRIES, 10, [20]);
    const attributed = attributeReading(owners, [
      { pid: 10, pssKb: 7 },
      { pid: 20, pssKb: undefined },
      { pid: 30, pssKb: undefined },
      { pid: 31, pssKb: undefined },
    ]);
    expect(attributed.rootsKb.has(20)).toBe(false);
  });

  it('reports no remainder where nothing charged to it could be read', () => {
    const owners = partitionTreeByRoots(NESTED_ENTRIES, 10, [20]);
    const attributed = attributeReading(owners, [
      { pid: 10, pssKb: undefined },
      { pid: 21, pssKb: undefined },
      { pid: 20, pssKb: 200 },
    ]);
    expect(attributed.remainderKb).toBeUndefined();
  });

  it("sums the whole reading's proportional swap into one figure for the tree", () => {
    const owners = partitionTreeByRoots(NESTED_ENTRIES, 10, [20]);
    const attributed = attributeReading(owners, [
      { pid: 10, pssKb: 7, swapPssKb: 4 },
      { pid: 20, pssKb: 200, swapPssKb: 16 },
      { pid: 30, pssKb: 30, swapPssKb: 2 },
    ]);
    expect(attributed.swapPssKb).toBe(22);
  });

  it('leaves the swap figure absent where no process in the tree stated one', () => {
    const owners = partitionTreeByRoots(NESTED_ENTRIES, 10, [20]);
    expect(attributeReading(owners, [{ pid: 20, pssKb: 200 }]).swapPssKb).toBeUndefined();
  });

  it('reads a tree that had nothing swapped out as measured at zero', () => {
    const owners = partitionTreeByRoots(NESTED_ENTRIES, 10, [20]);
    const attributed = attributeReading(owners, [
      { pid: 10, pssKb: 7, swapPssKb: 0 },
      { pid: 20, pssKb: 200, swapPssKb: 0 },
    ]);
    expect(attributed.swapPssKb).toBe(0);
  });

  it('counts the swap of a process whose memory reading could not be taken', () => {
    const owners = partitionTreeByRoots(NESTED_ENTRIES, 10, [20]);
    expect(attributeReading(owners, [{ pid: 20, pssKb: undefined, swapPssKb: 9 }]).swapPssKb).toBe(
      9
    );
  });

  /**
   * One reading, partitioned two ways. Comparing two readings taken at
   * different moments would prove nothing here: a tree gains and loses
   * processes between any two samples, so the sums would agree or disagree for
   * reasons that are the host's rather than this module's.
   */
  it('splits one reading into parts summing to that same reading left whole', () => {
    const reading = [
      { pid: 10, pssKb: 7 },
      { pid: 20, pssKb: 200 },
      { pid: 21, pssKb: 5 },
      { pid: 30, pssKb: 30 },
      { pid: 31, pssKb: undefined },
    ];
    const whole = attributeReading(partitionTreeByRoots(NESTED_ENTRIES, 10, []), reading);
    const split = attributeReading(partitionTreeByRoots(NESTED_ENTRIES, 10, [20, 21]), reading);
    const parts = [...split.rootsKb.values()].reduce(
      (running, subtree) => running + subtree,
      split.remainderKb ?? 0
    );
    expect(parts).toBe(whole.remainderKb);
  });
});

describe('parseSmapsRollupSwapPssKb', () => {
  it('reads the proportional swapped-out figure a rollup states', () => {
    expect(parseSmapsRollupSwapPssKb('Pss:\t    7072 kB\nSwapPss:\t     512 kB\n')).toBe(512);
  });

  it('reads nothing from a rollup stating only the per-process swap figure', () => {
    expect(parseSmapsRollupSwapPssKb('Pss:\t    7072 kB\nSwap:\t     512 kB\n')).toBeUndefined();
  });

  it('reads nothing from an empty read', () => {
    expect(parseSmapsRollupSwapPssKb('')).toBeUndefined();
  });
});

describe('parseMemAvailableKb', () => {
  it('extracts the MemAvailable line', () => {
    const meminfo = 'MemTotal: 32000000 kB\nMemFree:  1000000 kB\nMemAvailable: 24000000 kB\n';
    expect(parseMemAvailableKb(meminfo)).toBe(24_000_000);
  });

  it('returns undefined when the line is absent', () => {
    expect(parseMemAvailableKb('MemTotal: 1 kB\n')).toBeUndefined();
  });

  it('reads nothing out of the empty content an unreadable file yields', () => {
    expect(parseMemAvailableKb('')).toBeUndefined();
  });
});

/**
 * A machine whose real memory is nearly spent while its swap sits untouched.
 * The two figures are far enough apart that a budget which folded swap in
 * could not land on the same number as one that did not.
 */
const MEMINFO_WITH_FREE_SWAP = [
  'MemTotal:       32000000 kB',
  'MemFree:          400000 kB',
  'MemAvailable:    2000000 kB',
  'SwapTotal:      16000000 kB',
  'SwapFree:       16000000 kB',
  '',
].join('\n');

describe('memoryBudgetKb', () => {
  it('reports a positive budget on every platform', () => {
    // os.freemem() already tracks the right notion on Linux and Windows, so
    // the budget is no longer a Linux-only figure the way tree sampling is.
    expect(memoryBudgetKb(0.8)).toBeGreaterThan(0);
  });

  it('scales with the fraction it is asked for', () => {
    const whole = memoryBudgetKb(1) ?? 0;
    const half = memoryBudgetKb(0.5) ?? 0;
    expect(half).toBeLessThan(whole);
  });

  it('takes the share an orchestrator handed it instead of reading the machine', () => {
    vi.stubEnv(MEMORY_BUDGET_ENV, '4194304');
    expect(memoryBudgetKb(0.8)).toBe(4_194_304);
  });

  it('ignores a share that is not a positive number', () => {
    vi.stubEnv(MEMORY_BUDGET_ENV, 'not-a-number');
    expect(memoryBudgetKb(0.8)).toBeGreaterThan(0);
    vi.stubEnv(MEMORY_BUDGET_ENV, '-5');
    expect(memoryBudgetKb(0.8)).toBeGreaterThan(0);
  });

  /**
   * The four cases below hand the function its readings rather than letting it
   * read the host, which is the only way the arm this machine never takes gets
   * exercised at all: nothing here runs on macOS or Windows.
   *
   * What they pin is that the fraction is taken over memory the machine can
   * hand out now, and never over a figure that counts free swap — a budget
   * taken over one plans a run into paging, which is the outcome the peak
   * ledger exists to keep a run clear of.
   */
  it('takes the memory available without swapping where the kernel reports both', () => {
    expect(
      memoryBudgetKb(0.8, {
        platform: 'linux',
        meminfo: () => MEMINFO_WITH_FREE_SWAP,
        freeBytes: () => 0,
      })
    ).toBe(1_600_000);
  });

  it('takes the free physical reading on a platform with no kernel figure to read', () => {
    expect(
      memoryBudgetKb(0.5, {
        platform: 'win32',
        meminfo: () => MEMINFO_WITH_FREE_SWAP,
        freeBytes: () => 8_000_000 * 1024,
      })
    ).toBe(4_000_000);
  });

  it('falls back to the free physical reading where the kernel figure is absent', () => {
    expect(
      memoryBudgetKb(1, {
        platform: 'linux',
        meminfo: () => 'MemTotal:       32000000 kB\nSwapFree:       16000000 kB\n',
        freeBytes: () => 1_000_000 * 1024,
      })
    ).toBe(1_000_000);
  });

  it('reports no budget where the platform reports no memory at all', () => {
    expect(
      memoryBudgetKb(0.8, { platform: 'win32', meminfo: () => '', freeBytes: () => 0 })
    ).toBeUndefined();
  });

  /**
   * The readings a caller who names none gets. Both are figures for memory the
   * machine holds in silicon — the kernel's estimate of what it can hand out
   * without paging anything out, and the runtime's free-physical count — and
   * neither is reachable through the injected cases above, which is why the
   * default is asserted rather than left to the reader of the signature.
   */
  it('reads this machine through figures that count no swap', () => {
    expect(MACHINE_READINGS.freeBytes()).toBeGreaterThan(0);
    if (process.platform === 'linux') {
      expect(parseMemAvailableKb(MACHINE_READINGS.meminfo())).toBeGreaterThan(0);
    }
  });
});

describe('parseSmapsRollupPssKb', () => {
  it('reads the proportional set size out of a rollup', () => {
    const rollup = [
      '146ea6400000-7ffc14c05000 ---p 00000000 00:00 0    [rollup]',
      'Rss:               45748 kB',
      'Pss:                9055 kB',
      'Pss_Dirty:          6104 kB',
      'Shared_Clean:      36692 kB',
    ].join('\n');
    expect(parseSmapsRollupPssKb(rollup)).toBe(9055);
  });

  it('reads Pss rather than the Pss_Anon and Pss_File shares beneath it', () => {
    const rollup = ['Pss_Anon:           116 kB', 'Pss:                181 kB'].join('\n');
    expect(parseSmapsRollupPssKb(rollup)).toBe(181);
  });

  it('returns undefined where no Pss line is present', () => {
    expect(parseSmapsRollupPssKb('')).toBeUndefined();
    expect(parseSmapsRollupPssKb('Rss:  45748 kB\n')).toBeUndefined();
  });
});

describe('live sampling (best effort)', () => {
  it('charges a shared page once over a tree built to share one', async () => {
    if (process.platform !== 'linux') return;
    const tree = await startSharingTree();
    try {
      const { remainderKb: sampled } = await sampleAttributedTreePssKb(tree.pid, []);
      // Positive before the comparison: an absent reading satisfies any upper
      // bound, so a sampler that measured nothing would otherwise pass here.
      expect(sampled).toBeGreaterThan(0);
      expect(sampled).toBeLessThan(treeRssSumKb(tree.pid) * SHARING_MARGIN);
    } finally {
      tree.kill();
    }
  });

  it(
    'ends the group it started when the wait for readiness rejects',
    async () => {
      if (process.platform !== 'linux') return;
      // The same root program, driven directly. What the assertion at the end of
      // this case is worth rests on this one: an empty group satisfies "nothing
      // carrying the marker survives" just as well as a group that was ended.
      const populated = randomUUID();
      const probe = spawn(process.execPath, ['-e', abandoningRootProgram(populated)], {
        stdio: 'ignore',
        detached: true,
      });
      const { pid } = probe;
      if (pid === undefined) throw new Error('the probe never started');
      try {
        expect(
          await pollMarkedPids(populated, (pids) => pids.length === SHARERS, FIXTURE_BOOT_BUDGET_MS)
        ).toHaveLength(SHARERS);
      } finally {
        process.kill(-pid, 'SIGKILL');
      }

      const marker = randomUUID();
      await expect(startSharingTree(abandoningRootProgram(marker))).rejects.toThrow(
        'the tree exited before it was up'
      );
      expect(
        await pollMarkedPids(marker, (pids) => pids.length === 0, SIGNAL_REACTION_BUDGET_MS)
      ).toEqual([]);
    },
    MARKED_TREE_CASE_TIMEOUT_MS
  );

  it('reports the whole tree as the remainder for an empty root set', async () => {
    const attributed = await sampleAttributedTreePssKb(process.pid, []);
    expect([...attributed.rootsKb.keys()]).toEqual([]);
    if (process.platform === 'linux') {
      expect(attributed.remainderKb).toBeGreaterThan(0);
    } else {
      expect(attributed.remainderKb).toBeUndefined();
    }
  });

  it('splits a live tree between the roots it is given and what is left', async () => {
    if (process.platform !== 'linux') return;
    const tree = await startSharingTree();
    try {
      const children = liveChildrenOf(tree.pid);
      expect(children).toHaveLength(SHARERS);
      const attributed = await sampleAttributedTreePssKb(tree.pid, children);
      for (const child of children) {
        expect(attributed.rootsKb.get(child)).toBeGreaterThan(0);
      }
      // The root is under none of its own children, so it is the remainder.
      expect(attributed.remainderKb).toBeGreaterThan(0);
    } finally {
      tree.kill();
    }
  });

  it('reports nothing rather than zero for a tree with nothing left to read', async () => {
    // Above the kernel's default pid ceiling, so no process can carry it.
    const { remainderKb } = await sampleAttributedTreePssKb(2 ** 30, []);
    expect(remainderKb).toBeUndefined();
  });

  it('leaves the event loop free while its reads are outstanding', async () => {
    let ticked = false;
    setImmediate(() => {
      ticked = true;
    });
    const pending = sampleAttributedTreePssKb(process.pid, []);
    expect(ticked).toBe(false);
    await pending;
    expect(ticked).toBe(true);
  });
});

describe('readProcStatRecords', () => {
  it('reads this process out of the table it lists', () => {
    if (process.platform !== 'linux') return;
    const pids = (readProcStatRecords() ?? [])
      .map((record) => parseProcStatPids(record))
      .filter((entry) => entry !== undefined)
      .map((entry) => entry.pid);
    expect(pids).toContain(process.pid);
  });

  it('hands back each record as the kernel states it, for the caller to parse', () => {
    if (process.platform !== 'linux') return;
    const own = (readProcStatRecords() ?? []).find(
      (record) => parseProcStatPids(record)?.pid === process.pid
    );
    expect(own).toMatch(/^\d+ \(/);
  });
});
