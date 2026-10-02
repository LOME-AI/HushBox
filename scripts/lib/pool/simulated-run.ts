import { deriveConcurrency, placeInLanes, scheduleOrder } from './schedule.js';
import { readLedger, writeLedger } from './ledger.js';
import type { PoolTaskEstimate, RunObservation } from './schedule.js';

/**
 * A world the concurrency derivation can be executed against instead of
 * measured against: units whose true wall and true memory charge are declared
 * rather than observed, a clock made of arithmetic, and a memory model that
 * holds a unit's charge for exactly as long as that unit runs.
 *
 * It exists so that what the derivation buys can be decided rather than
 * watched. A claim about the count a workload should open is otherwise settled
 * by running the real suite on one machine and reading the wall — which costs
 * minutes, answers for that machine's load at that moment, and cannot be
 * re-asked about a workload nobody has.
 *
 * Nothing here spawns a process or waits, so a property taken over it is a
 * property of the rule rather than of the host. The trade that buys: every
 * figure is as true as the declaration behind it, so a world declared gentler
 * than a real one proves something about a suite nobody runs. The declarations
 * belong to the caller for exactly that reason.
 *
 * **Release order is the real one.** {@link scheduleOrder} is what
 * `scripts/turbo-pool.ts` releases packages in, and `scripts/lib/vitest/lpt-sequencer.ts`
 * orders test files longest-first the same way, so a simulation queuing units
 * in any other order would answer about a scheduler nobody runs.
 *
 * **And so is the placement.** The lanes units land in come from
 * {@link placeInLanes}, the same primitive the work bound's makespan is
 * computed over. Two implementations of one placement rule would let the
 * derivation predict a schedule this simulator says the pool does not run, and
 * the drift would show up as agreement right until it stopped.
 */

/** A unit of work as the simulated world knows it: what it will actually cost. */
export interface FakeUnit {
  /** Unique within a world: the release order names units, so a repeat drops one. */
  readonly name: string;
  readonly wallMs: number;
  /** Held for the whole of the unit's run, and released the moment it ends. */
  readonly peakRssKb: number;
}

/** What one simulated execution reveals about itself. */
export interface SimulatedRun {
  /** The most units that were ever running together. */
  readonly maxConcurrent: number;
  /** The most memory the whole run ever held at once, the fixed cost included. */
  readonly peakRssKb: number;
  /**
   * Units running at the instant that set {@link SimulatedRun.peakRssKb},
   * which is the width that peak was truly held at and the one a ladder files
   * it under. Below the lanes the run opened whenever the worst moment did not
   * fill them — the count a run declares is what it was allowed, not what it
   * held. Zero for a run with no units, which holds its fixed cost and nothing
   * else.
   */
  readonly lanesAtPeak: number;
  readonly makespanMs: number;
}

/** One unit's occupancy of a lane: when it held it, and what it held while it did. */
interface Occupancy {
  readonly startMs: number;
  readonly endMs: number;
  readonly peakRssKb: number;
}

/** What the run holds at one instant, and how many units it is holding it for. */
interface Instant {
  readonly heldRssKb: number;
  readonly running: number;
}

/** A unit as the derivation reads one, standing on its own declared cost. */
export function estimatesOf(units: readonly FakeUnit[]): PoolTaskEstimate[] {
  return units.map((candidate) => ({
    name: candidate.name,
    wallsMs: [candidate.wallMs],
  }));
}

/**
 * The run's state at one instant.
 *
 * Half-open on purpose: a unit that ends exactly as another starts has already
 * released its charge, which is the same boundary the lane it vacates is
 * reassigned on.
 */
function heldAt(occupancies: readonly Occupancy[], atMs: number, fixedRssKb: number): Instant {
  let heldRssKb = fixedRssKb;
  let running = 0;
  for (const occupancy of occupancies) {
    if (occupancy.startMs > atMs || occupancy.endMs <= atMs) continue;
    heldRssKb += occupancy.peakRssKb;
    running += 1;
  }
  return { heldRssKb, running };
}

/**
 * Where each unit ran, once the list scheduler has placed them all: this
 * world's units in release order, each carrying the interval
 * {@link placeInLanes} put it in and the charge it holds for that interval.
 */
function occupanciesOf(units: readonly FakeUnit[], concurrency: number): Occupancy[] {
  const byName = new Map(units.map((candidate) => [candidate.name, candidate]));
  const released: FakeUnit[] = [];
  for (const name of scheduleOrder(estimatesOf(units))) {
    const unit = byName.get(name);
    /* v8 ignore next -- every name comes from the set the order was taken over */
    if (unit === undefined) continue;
    released.push(unit);
  }
  return placeInLanes(released, (unit) => unit.wallMs, concurrency).map((placement) => ({
    startMs: placement.startMs,
    endMs: placement.endMs,
    peakRssKb: placement.unit.peakRssKb,
  }));
}

/**
 * Run `units` through `concurrency` lanes and report what it cost.
 *
 * The peak is read at every start instant and nowhere else, which is exact
 * rather than a sample: what the run holds only ever rises when a unit starts.
 */
export function simulateRun(
  units: readonly FakeUnit[],
  concurrency: number,
  fixedRssKb: number
): SimulatedRun {
  if (concurrency < 1) {
    throw new Error(`a simulated run needs at least one lane, not ${String(concurrency)}`);
  }
  const occupancies = occupanciesOf(units, concurrency);
  let peakRssKb = fixedRssKb;
  let lanesAtPeak = 0;
  let maxConcurrent = 0;
  let makespanMs = 0;
  for (const occupancy of occupancies) {
    const instant = heldAt(occupancies, occupancy.startMs, fixedRssKb);
    // Strict, so the earliest instant reaching the peak is the one filed. The
    // instants are read in release order, longest unit first, so that is the
    // widest of any that tie — and filing a peak at the widest instant that
    // held it is the only tie-break that never prices a width below one the
    // run reached.
    if (instant.heldRssKb > peakRssKb) {
      peakRssKb = instant.heldRssKb;
      lanesAtPeak = instant.running;
    }
    maxConcurrent = Math.max(maxConcurrent, instant.running);
    makespanMs = Math.max(makespanMs, occupancy.endMs);
  }
  return { maxConcurrent, peakRssKb, lanesAtPeak, makespanMs };
}

/** The machine and the workload a simulated run happens on. */
export interface SimulatedWorld {
  readonly units: readonly FakeUnit[];
  /** What the run holds outside its units, for the whole of it. */
  readonly fixedRssKb: number;
  /** The machine ceiling the derivation is given. */
  readonly maxConcurrency: number;
  /** What the run's peak must fit into. */
  readonly memoryBudgetKb: number;
}

/** What one cycle through a world decided, and what carrying it out cost. */
export interface SimulatedCycle {
  readonly concurrency: number;
  readonly state: 'cold-start' | 'derived';
  readonly memoryCapped: boolean;
  readonly memoryGuarded: boolean;
  readonly run: SimulatedRun;
}

/** Derive over what the caller says is on record, then carry the answer out. */
function cycle(
  world: SimulatedWorld,
  tasks: readonly PoolTaskEstimate[],
  observations: readonly RunObservation[]
): SimulatedCycle {
  const derived = deriveConcurrency({
    tasks,
    observations,
    maxConcurrency: world.maxConcurrency,
    memoryBudgetKb: world.memoryBudgetKb,
  });
  return {
    concurrency: derived.concurrency,
    state: derived.state,
    memoryCapped: derived.memoryCapped,
    memoryGuarded: derived.memoryGuarded,
    run: simulateRun(world.units, derived.concurrency, world.fixedRssKb),
  };
}

/**
 * One run's own measurements, in the shape a store takes them in.
 *
 * `lanesAtPeak` is the run's own — the units that were running at the instant
 * that set its peak, which the occupancy trace knows and the declared count
 * does not. A run allowed eight lanes whose worst moment held four filed at
 * eight would pin a rung high at a width it never reached, and every count
 * above four would then be priced by memory nothing ever held there.
 */
function measured(world: SimulatedWorld, concurrency: number, run: SimulatedRun): RunObservation {
  const walls = world.units.map((candidate) => candidate.wallMs);
  return {
    concurrency,
    taskCount: world.units.length,
    sumWallMs: walls.reduce((total, wall) => total + wall, 0),
    longestWallMs: Math.max(...walls),
    makespanMs: run.makespanMs,
    fixedRssKb: world.fixedRssKb,
    peakRssKb: run.peakRssKb,
    lanesAtPeak: run.lanesAtPeak,
  };
}

/**
 * What this world has held at every width it could be opened at, one row per
 * width, each carrying that run's real peak and the lanes live when it was set.
 *
 * This is what "fully measured" means once the derivation reads whole-run peaks
 * instead of per-unit ones. A single row would say what one width held and
 * nothing about the rest, and the ladder prices every other count off that one
 * width — below it on the line down to its own baseline, above it flat — so a
 * world with one row on it would answer about the narrowness of its own record
 * rather than about the rule. Widths above the ceiling are left off because no
 * derivation here can return one.
 */
function everyWidthHeld(world: SimulatedWorld): RunObservation[] {
  const widest = Math.max(1, Math.min(world.maxConcurrency, world.units.length));
  return Array.from({ length: widest }, (_, index) => {
    const lanes = index + 1;
    return measured(world, lanes, simulateRun(world.units, lanes, world.fixedRssKb));
  });
}

/**
 * A cycle over a world that has already been measured exactly — every unit's
 * wall, and what the whole run held at every width it could open — with no
 * store between the measurement and the derivation.
 *
 * The observations carry the two figures the units cannot: what the run holds
 * outside them, and what it really held at once. Neither is declared; both come
 * out of executing this world.
 */
export function runFullyMeasured(world: SimulatedWorld): SimulatedCycle {
  return cycle(world, estimatesOf(world.units), everyWidthHeld(world));
}

/** The units the derivation sees: this world's names, carrying whatever the store holds. */
function unitsFromStore(world: SimulatedWorld, store: string): PoolTaskEstimate[] {
  const { tasks } = readLedger(store);
  return world.units.map((candidate) => {
    const recorded = tasks[candidate.name];
    return recorded === undefined
      ? { name: candidate.name }
      : { name: candidate.name, wallsMs: recorded.wallsMs };
  });
}

/**
 * One whole run of a world: read what the store holds, derive a count from it,
 * execute at that count, and record what the execution measured.
 *
 * The real store is written and read rather than a stand-in for it, because
 * what a unit stands on after a run — and whether it still stands on anything
 * several runs later — is decided by the fold and the retention in
 * `scripts/lib/pool/ledger.ts`, not by the derivation that consumes them. The
 * same holds for a width: whether a rung this run set is still on the ladder
 * later is retention's answer, and a stand-in store would not give it.
 */
export function runInWorld(world: SimulatedWorld, store: string): SimulatedCycle {
  const taken = cycle(world, unitsFromStore(world, store), readLedger(store).runs);
  // A world's unit set varies from cycle to cycle, and a unit this cycle did not
  // run has not left the tree — it is exactly the rarely-run unit the carriers
  // exist to keep. Nothing simulated ever ceases to exist, so no cycle here
  // reports a departure.
  writeLedger(
    store,
    {
      tasks: Object.fromEntries(
        world.units.map((candidate) => [candidate.name, { wallsMs: [candidate.wallMs] }])
      ),
      runs: [measured(world, taken.concurrency, taken.run)],
    },
    () => true
  );
  return taken;
}
