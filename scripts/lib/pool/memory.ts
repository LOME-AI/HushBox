import { readFileSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';

// Explicit-URL runtime import: wherever this module is loaded by Node's own
// loader rather than through a transform that rewrites specifiers, a `.js`
// specifier resolves literally and finds no such file next to
// `../proc-stat.ts` — the constraint `packages/config/vitest.config.ts` states
// in full.
const { PARENT_FIELD, parseProcStatRecord } = (await import(
  new URL('../proc-stat.ts', import.meta.url).href
)) as typeof import('../proc-stat.js');

/**
 * Memory readings for the turbo pool's ledger.
 *
 * Two different things, with two different reaches. The *budget* — how much
 * memory a run may plan against — is available everywhere, because
 * `os.freemem()` already reports the right notion on Linux (libuv reads
 * MemAvailable) and on Windows (`ullAvailPhys`); only macOS understates it, and
 * only Linux is read directly here for exactness.
 *
 * The *peak* a run reached is the **proportional set size** summed over the
 * run's process tree, not the resident set size summed over it. A resident-set
 * sum counts every shared page once per process that maps it, and a runner
 * whose workers share one loaded module graph maps a great deal of the same
 * memory in every worker: measured on the reference machine, the resident-set
 * sum peaked between 1.37× and 1.54× the proportional sum, while private pages
 * alone accounted for all but 0.7% of the proportional figure. The overcount is
 * the sharing, and it inflated every decision that read the peak.
 *
 * Two alternatives lose. A control group's own `memory.peak` would be exact,
 * but no run here owns a control group: the one reachable from inside the
 * container spans everything running in it, and giving each run its own needs
 * delegated write access no developer machine can be assumed to have. A
 * whole-system delta was measured and rejected: over five-minute windows the
 * quietest swing on the reference machine was 4.2GB, which exceeds several
 * commands' entire footprint.
 *
 * Only Linux answers, through `/proc/<pid>/smaps_rollup`. macOS and Windows
 * report nothing rather than a resident-set sum, because that sum is a
 * different quantity and one ledger holding both would mean neither: the
 * derivation then falls back to choosing concurrency from wall time alone,
 * which is where the optimisation lives anyway — the peak only ever vetoes. A
 * reading may degrade; it must never make the pool platform-dependent.
 */

/** Set by an orchestrator to hand a child its share of one budget. */
export const MEMORY_BUDGET_ENV = 'HB_MEMORY_BUDGET_KB';

interface ProcPids {
  readonly pid: number;
  readonly ppid: number;
}

/** Parse `/proc/<pid>/stat`: pid and ppid around the parenthesised comm. */
export function parseProcStatPids(content: string): ProcPids | undefined {
  const record = parseProcStatRecord(content);
  if (record === undefined) return undefined;
  const pid = Number.parseInt(record.pid, 10);
  const ppid = Number.parseInt(record.fields[PARENT_FIELD] ?? '', 10);
  if (!Number.isInteger(pid) || !Number.isInteger(ppid)) return undefined;
  return { pid, ppid };
}

/** Parse `/proc/<pid>/smaps_rollup`: the proportional set size, in kilobytes. */
export function parseSmapsRollupPssKb(content: string): number | undefined {
  const match = /^Pss:\s+(\d+)\s+kB/m.exec(content);
  if (!match) return undefined;
  /* v8 ignore next -- the regex matched, so its group is present */
  return Number.parseInt(match[1] ?? '', 10);
}

/**
 * Parse `/proc/<pid>/smaps_rollup`: the swapped-out proportional size, in
 * kilobytes.
 *
 * The proportional field rather than the rollup's `Swap:` beside it, for the
 * reason the memory reading takes `Pss:`: a page swapped out of a mapping
 * several processes share is charged whole to each of them in `Swap:` and in
 * equal parts in `SwapPss:`, and a figure recorded beside a proportional peak
 * has to be measured the same way or the two describe different trees.
 */
export function parseSmapsRollupSwapPssKb(content: string): number | undefined {
  const match = /^SwapPss:\s+(\d+)\s+kB/m.exec(content);
  if (!match) return undefined;
  /* v8 ignore next -- the regex matched, so its group is present */
  return Number.parseInt(match[1] ?? '', 10);
}

/** Every parent's children, as the entries name them. */
function childrenByParent(entries: readonly ProcPids[]): Map<number, number[]> {
  const children = new Map<number, number[]>();
  for (const entry of entries) {
    const siblings = children.get(entry.ppid) ?? [];
    siblings.push(entry.pid);
    children.set(entry.ppid, siblings);
  }
  return children;
}

/**
 * Where each process of one tree is charged: its pid against the nearest
 * caller-named root at or above it, or undefined where no named root stands
 * between it and the tree root.
 *
 * Nearest-ancestor charging is what makes the result a partition rather than a
 * set of overlapping subtrees — every process in the tree appears once, under
 * exactly one owner, whatever nesting the caller's roots happen to have. The
 * sum identity every consumer of an attributed reading rests on is that
 * property and nothing else.
 *
 * Which processes are worth naming is the caller's question. This module
 * measures; it holds no notion of what a root is for.
 */
export function partitionTreeByRoots(
  entries: readonly ProcPids[],
  treeRootPid: number,
  rootPids: readonly number[]
): Map<number, number | undefined> {
  const children = childrenByParent(entries);
  const named = new Set(rootPids);
  const owners = new Map<number, number | undefined>([
    [treeRootPid, named.has(treeRootPid) ? treeRootPid : undefined],
  ]);
  const queue = [treeRootPid];
  // Array iteration observes pushes, so this walks the growing frontier.
  for (const parent of queue) {
    const inherited = owners.get(parent);
    for (const child of children.get(parent) ?? []) {
      if (owners.has(child)) continue;
      owners.set(child, named.has(child) ? child : inherited);
      queue.push(child);
    }
  }
  return owners;
}

/** One process's proportional set size; absent where its rollup could not be read. */
interface ProcPssKb {
  readonly pid: number;
  readonly pssKb: number | undefined;
  /**
   * The process's swapped-out proportional size, absent where its rollup stated
   * none. Optional because a caller reading a tree only for what it holds in
   * memory has nothing to say here, and saying nothing is different from having
   * read a figure of zero.
   */
  readonly swapPssKb?: number | undefined;
}

/** One reading of a tree, split across the roots it was partitioned by. */
export interface AttributedTreePssKb {
  /**
   * Each named root's subtree total, keyed by the pid the caller named. A root
   * nothing could be read under is absent rather than zero, for the reason
   * {@link attributeReading} states.
   */
  readonly rootsKb: ReadonlyMap<number, number>;
  /** The tree less every named root's subtree; absent where nothing was read. */
  readonly remainderKb: number | undefined;
  /**
   * What the whole reading had swapped out, roots and remainder together.
   * Undivided on purpose: a page the kernel wrote out belongs to the tree
   * rather than to any one part of it, and charging it to a root would need a
   * second partition of a quantity that moves between processes as they map
   * and unmap what they share.
   *
   * Absent where no process in the reading stated a figure, which is every
   * kernel built without swap accounting. Zero is a measurement and says the
   * tree held nothing in swap.
   */
  readonly swapPssKb?: number | undefined;
}

/**
 * Split one reading of a tree by the owners {@link partitionTreeByRoots} gave
 * it. Readings are of that partition's processes: a pid the partition does not
 * name is charged to the remainder, the same as a pid it names for nobody.
 *
 * A process whose rollup could not be read contributes nothing rather than
 * zero, and a total nothing contributed to is absent rather than zero — zero
 * reads as a subtree that used no memory at all, which is a thing no live
 * process is.
 */
export function attributeReading(
  owners: ReadonlyMap<number, number | undefined>,
  readings: readonly ProcPssKb[]
): AttributedTreePssKb {
  const rootsKb = new Map<number, number>();
  let remainderKb: number | undefined;
  let swapPssKb: number | undefined;
  for (const { pid, pssKb, swapPssKb: processSwapKb } of readings) {
    // Folded ahead of the memory reading rather than beside it, because the two
    // figures answer independently: a process that stated one and not the other
    // contributes the one it stated.
    if (processSwapKb !== undefined) swapPssKb = (swapPssKb ?? 0) + processSwapKb;
    if (pssKb === undefined) continue;
    const owner = owners.get(pid);
    if (owner === undefined) {
      remainderKb = (remainderKb ?? 0) + pssKb;
      continue;
    }
    rootsKb.set(owner, (rootsKb.get(owner) ?? 0) + pssKb);
  }
  return { rootsKb, remainderKb, swapPssKb };
}

/**
 * Content of a `/proc` file, empty where the read failed. Empty is what an
 * absent file and an unreadable one both mean to every parser here — nothing
 * to attribute — and saying it in the value rather than in a branch is what
 * keeps the reading out of the control flow: a branch taken only when some
 * process happens to exit between the listing and the read is a branch whose
 * coverage reports the host's churn instead of this module's behaviour.
 */
function readProcFile(pathname: string): string {
  try {
    return readFileSync(pathname, 'utf8');
  } catch {
    /* v8 ignore next -- the process exited between readdir and read; normal churn */
    return '';
  }
}

/**
 * Every live process's `stat`, as `/proc` lists the table right now; absent
 * where the table cannot be listed at all.
 *
 * Raw, and exported, because the tree partition here and the worker
 * enumeration that names its roots are two readings of one table and have to
 * agree about what a process is: which entries count as processes, and that a
 * process exiting between the listing and the read is an empty record rather
 * than a throw. Each caller parses the field it wants out of the same records.
 */
export function readProcStatRecords(): string[] | undefined {
  let pidDirectories: string[];
  try {
    pidDirectories = readdirSync('/proc').filter((name) => /^\d+$/.test(name));
  } catch {
    /* v8 ignore next -- /proc is unreadable only where this branch is itself unreachable */
    return undefined;
  }
  return pidDirectories.map((dir) => readProcFile(`/proc/${dir}/stat`));
}

/** {@link readProcFile}, off the event loop; empty carries the same meaning. */
async function readProcFileAsync(pathname: string): Promise<string> {
  try {
    return await readFile(pathname, 'utf8');
  } catch {
    /* v8 ignore next -- the process exited between readdir and read; normal churn */
    return '';
  }
}

/** What a platform with no proportional accounting has to say about a tree. */
const NOTHING_ATTRIBUTED: AttributedTreePssKb = { rootsKb: new Map(), remainderKb: undefined };

async function linuxAttributedTreePssKb(
  treeRootPid: number,
  rootPids: readonly number[]
): Promise<AttributedTreePssKb> {
  const records = readProcStatRecords();
  /* v8 ignore next -- unreachable wherever /proc is readable, which is everywhere this runs */
  if (records === undefined) return NOTHING_ATTRIBUTED;
  const entries = records
    .map((record) => parseProcStatPids(record))
    .filter((entry) => entry !== undefined);
  // The partition is also the membership, so naming roots costs one walk of the
  // tree, exactly as taking an unattributed total did.
  const owners = partitionTreeByRoots(entries, treeRootPid, rootPids);
  // Every rollup is issued at once, because each one costs the kernel a walk of
  // that process's whole VMA list and those walks are the whole sample:
  // measured over a couple of hundred processes, reading them one after another
  // cost about three times what issuing them together cost. Issuing them in
  // fixed-width waves instead was measured slower than issuing them together,
  // at every width tried, since every wave waits on its slowest member.
  // Enumeration stays sequential — it is around a millisecond against tens for
  // the rollups.
  const readings = await Promise.all(
    [...owners.keys()].map(async (pid) => {
      // One rollup, both figures: the read is what a sample costs, so the
      // swapped-out total rides the walk the memory total already pays for.
      const rollup = await readProcFileAsync(`/proc/${String(pid)}/smaps_rollup`);
      return {
        pid,
        pssKb: parseSmapsRollupPssKb(rollup),
        swapPssKb: parseSmapsRollupSwapPssKb(rollup),
      };
    })
  );
  return attributeReading(owners, readings);
}

/* v8 ignore start -- platform dispatch: only one arm can run on any one machine */
/**
 * One reading of a pid's live tree, split across the roots the caller names:
 * each root's whole subtree and everything the named roots do not cover. The
 * parts sum to the tree's total because they partition one reading, never
 * because two readings were compared.
 *
 * Empty on a platform that cannot attribute shared pages proportionally.
 */
export async function sampleAttributedTreePssKb(
  treeRootPid: number,
  rootPids: readonly number[]
): Promise<AttributedTreePssKb> {
  if (process.platform === 'linux') return linuxAttributedTreePssKb(treeRootPid, rootPids);
  return NOTHING_ATTRIBUTED;
}
/* v8 ignore stop */

/** Extract MemAvailable (kB) from /proc/meminfo content. */
export function parseMemAvailableKb(meminfo: string): number | undefined {
  const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(meminfo);
  if (!match) return undefined;
  /* v8 ignore next -- the regex matched, so its group is present */
  return Number.parseInt(match[1] ?? '', 10);
}

/**
 * What a machine says about its own free memory. The platform travels with the
 * readings so that both arms below can be exercised wherever this is tested:
 * the arm a given machine does not take is the one a later edit can change
 * unobserved.
 */
interface MemoryReadings {
  readonly platform: NodeJS.Platform;
  /** `/proc/meminfo`'s content; read only on the platform that has one. */
  readonly meminfo: () => string;
  /** Free physical memory in bytes, as the runtime reports it. */
  readonly freeBytes: () => number;
}

/** This machine's own readings, which is what every caller but a test wants. */
export const MACHINE_READINGS: MemoryReadings = {
  platform: process.platform,
  meminfo: () => readProcFile('/proc/meminfo'),
  freeBytes: () => os.freemem(),
};

/**
 * Memory the machine can hand out now without paging anything out to make room
 * — Linux's `MemAvailable`, else the runtime's free-physical figure. Never a
 * reading that counts free swap: a budget taken over one plans a run into
 * paging, which is the outcome the peak ledger exists to keep a run clear of.
 */
function availableMemoryKb(readings: MemoryReadings): number | undefined {
  if (readings.platform === 'linux') {
    const available = parseMemAvailableKb(readings.meminfo());
    if (available !== undefined) return available;
  }
  const free = Math.floor(readings.freeBytes() / 1024);
  return free > 0 ? free : undefined;
}

/**
 * The share of a machine's free memory every planner in this repository plans
 * against, and the reason it is one value rather than a number each of them
 * spells: the gates run over one machine, so two planners taking different
 * fractions of the same free memory are two answers to one question, and the
 * one that took the larger fraction is the one that overcommits the host.
 *
 * Below one because the figure it is taken over is what the machine can hand
 * out at the moment it is read, and a run plans against it for its whole span:
 * the remainder is what absorbs everything that arrives while the run holds its
 * peak.
 */
export const PLANNING_MEMORY_FRACTION = 0.8;

/**
 * Memory this run may plan against: the share an orchestrator handed down when
 * there is one, else a fraction of what the machine currently has free. The
 * share takes precedence because concurrently-running gates would otherwise
 * each claim the same free memory and collectively plan for several times it.
 */
export function memoryBudgetKb(
  fraction: number,
  readings: MemoryReadings = MACHINE_READINGS
): number | undefined {
  const handed = Number.parseInt(process.env[MEMORY_BUDGET_ENV] ?? '', 10);
  if (Number.isInteger(handed) && handed > 0) return handed;
  const available = availableMemoryKb(readings);
  if (available === undefined) return undefined;
  return Math.floor(available * fraction);
}
