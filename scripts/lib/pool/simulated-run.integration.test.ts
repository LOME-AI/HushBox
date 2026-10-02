import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MAX_RETAINED_WALLS, readLedger } from './ledger.js';
import { workBoundFromWalls } from './schedule.js';
import {
  estimatesOf,
  runFullyMeasured,
  runInWorld,
  simulateRun,
  type FakeUnit,
  type SimulatedCycle,
  type SimulatedWorld,
} from './simulated-run.js';

/**
 * What the concurrency derivation actually buys, decided against a world that
 * executes rather than against a machine that has to be watched.
 *
 * The derivation is the real one; only the world is fake. Each case declares
 * what its units truly cost, runs the count the derivation returns, and reads
 * back three figures — the most units ever running together, the most memory
 * ever held, and the wall. A claim about any of them is then arithmetic, so it
 * holds for workloads nobody has and machines nobody owns.
 */

const SECOND = 1000;
/** Kibibytes in a gibibyte, which is the unit every charge here is declared in. */
const GB = 1024 * 1024;
/** What a run holds outside its units, the same for every world here. */
const FIXED_RSS_KB = 2 * GB;

function unit(name: string, wallSeconds: number, peakGb: number): FakeUnit {
  return { name, wallMs: wallSeconds * SECOND, peakRssKb: Math.round(peakGb * GB) };
}

/** A name that sorts in declaration order, so a release order is readable. */
function unitName(index: number): string {
  return `unit-${String(index + 1).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// The grid.
//
// A universal cannot be established from examples, so the two properties that
// are universals run over a cross-product of every input the rule reads: how
// many units there are, how their walls are spread (which is what decides the
// fewest lanes at which the set reaches its longest single wall), how their
// charges are spread *relative to those walls* — release order is by wall, so
// that relation is what decides whether a width's dearest instant fills its
// lanes, and a peak filed narrower than the run that set it prices wider counts
// off a narrower rung — the machine ceiling, and the budget. The ceilings span
// below, at and above every unit count in the grid; the budget ladder runs from
// one that admits a single lane to one that admits every unit at once.
// ---------------------------------------------------------------------------

interface WallProfile {
  readonly name: string;
  readonly wallMs: (index: number, count: number) => number;
}

interface PeakProfile {
  readonly name: string;
  readonly peakRssKb: (index: number, walls: readonly number[]) => number;
}

const WALL_PROFILES: readonly WallProfile[] = [
  { name: 'even walls', wallMs: () => 10 * SECOND },
  { name: 'one long unit', wallMs: (index) => (index === 0 ? 100 * SECOND : 10 * SECOND) },
  { name: 'one short unit', wallMs: (index) => (index === 0 ? 1 * SECOND : 12 * SECOND) },
  { name: 'a ramp of walls', wallMs: (index) => (index + 1) * 5 * SECOND },
  { name: 'two tiers of walls', wallMs: (index, count) => (index * 2 < count ? 20 : 4) * SECOND },
  { name: 'nearly even walls', wallMs: (index) => 10 * SECOND + index * 500 },
];

/** A wall, in whole seconds, as the charge profiles below read it. */
function wallSecondsAt(walls: readonly number[], index: number): number {
  return (walls[index] ?? 0) / SECOND;
}

/**
 * The profile whose dearest units are its longest. Release is longest first, so
 * every width's dearest instant is its opening one with all its lanes full:
 * each width's rung is that width's own true peak, and the rungs rise with
 * width, so the highest rung at or below a count is the truth at that count
 * exactly.
 *
 * That exactness is what the maximality assertion narrows itself to this
 * profile for, and it is the admission test for any profile let in beside it.
 * Where it fails the ladder prices a count off a rung narrower than the count,
 * and a memory-capped count can then sit below what the truth admits — cases
 * elsewhere in this grid do.
 */
const CHARGES_WITH_THE_WALLS = 'charges with the walls';

const PEAK_PROFILES: readonly PeakProfile[] = [
  { name: 'even charges', peakRssKb: () => GB },
  { name: 'one dear unit', peakRssKb: (index) => (index === 0 ? 6 * GB : GB) },
  { name: 'two dear units', peakRssKb: (index) => (index < 2 ? 6 * GB : GB) },
  {
    name: CHARGES_WITH_THE_WALLS,
    peakRssKb: (index, walls) => Math.round((wallSecondsAt(walls, index) * GB) / 5),
  },
  {
    // The dearest units are the shortest, so release order puts them last and a
    // run's dearest instant falls in the tail with its lanes already emptying.
    // The ladder files that peak below the width that ran it, and every wider
    // count is priced off the narrower rung — the over-read this profile is
    // carried for.
    name: 'charges against the walls',
    peakRssKb: (index, walls) =>
      Math.round(((Math.max(...walls) / SECOND - wallSecondsAt(walls, index)) * GB) / 5 + GB / 2),
  },
];

const UNIT_COUNTS: readonly number[] = [2, 3, 5, 8, 13];
const CEILINGS: readonly number[] = [1, 2, 4, 8, 16];
/** The share of everything past the dearest single unit that the budget admits. */
const BUDGET_FRACTIONS: readonly number[] = [0, 0.1, 0.25, 0.5, 1, 2];

interface Workload {
  readonly label: string;
  readonly peakProfile: string;
  readonly units: readonly FakeUnit[];
  readonly maxConcurrency: number;
}

function buildUnits(count: number, walls: WallProfile, peaks: PeakProfile): FakeUnit[] {
  const wallsMs = Array.from({ length: count }, (_, index) => walls.wallMs(index, count));
  return wallsMs.map((wallMs, index) => ({
    name: unitName(index),
    wallMs,
    peakRssKb: peaks.peakRssKb(index, wallsMs),
  }));
}

function buildWorkloads(): Workload[] {
  const built: Workload[] = [];
  for (const count of UNIT_COUNTS) {
    for (const walls of WALL_PROFILES) {
      for (const peaks of PEAK_PROFILES) {
        for (const maxConcurrency of CEILINGS) {
          built.push({
            label: `${String(count)} units, ${walls.name}, ${peaks.name}, ${String(maxConcurrency)} lanes`,
            peakProfile: peaks.name,
            units: buildUnits(count, walls, peaks),
            maxConcurrency,
          });
        }
      }
    }
  }
  return built;
}

const WORKLOADS = buildWorkloads();

/**
 * A workload under a budget placed on its own scale: the fixed cost plus the
 * dearest single unit, plus a share of everything else. At a share of zero only
 * one lane can ever fit; at two, every unit fits at once. Sizing the budget
 * against the workload rather than naming figures is what keeps the ladder
 * meaningful for a two-unit world and a thirteen-unit one alike.
 */
function budgeted(workload: Workload, fraction: number): SimulatedWorld {
  const charges = workload.units.map((candidate) => candidate.peakRssKb);
  const dearest = Math.max(...charges);
  const rest = charges.reduce((total, charge) => total + charge, 0) - dearest;
  return {
    units: workload.units,
    fixedRssKb: FIXED_RSS_KB,
    maxConcurrency: workload.maxConcurrency,
    memoryBudgetKb: Math.round(FIXED_RSS_KB + dearest + fraction * rest),
  };
}

/**
 * A workload under a budget no projection over it can reach at any count it
 * could open: the fixed cost, plus the dearest unit once for every lane.
 *
 * Sized against the record rather than against the truth, because that is what
 * the projection reads. A ladder never answers above its worst rung — between
 * two rungs it reads a line whose upper end is one of them, below the narrowest
 * it reads down towards a baseline, and past the widest it holds flat — so the
 * largest answer it can give over this world is the worst whole-run peak the
 * world can produce, which is the fixed cost plus every unit charged at once.
 * Replacing each of those units with the dearest is what this budget does, so a
 * world budgeted this way is one no record can claim is tight.
 */
function beyondAnyProjection(workload: Workload): SimulatedWorld {
  const dearest = Math.max(...workload.units.map((candidate) => candidate.peakRssKb));
  return {
    units: workload.units,
    fixedRssKb: FIXED_RSS_KB,
    maxConcurrency: workload.maxConcurrency,
    memoryBudgetKb: FIXED_RSS_KB + workload.units.length * dearest,
  };
}

interface GridCase {
  readonly label: string;
  readonly peakProfile: string;
  readonly world: SimulatedWorld;
}

function buildGrid(): GridCase[] {
  const cases: GridCase[] = [];
  for (const workload of WORKLOADS) {
    for (const fraction of BUDGET_FRACTIONS) {
      cases.push({
        label: `${workload.label}, budget share ${String(fraction)}`,
        peakProfile: workload.peakProfile,
        world: budgeted(workload, fraction),
      });
    }
  }
  return cases;
}

const GRID = buildGrid();

/** Every unit gets a lane, up to the machine's. */
function ceilingOf(world: SimulatedWorld): number {
  return Math.min(world.maxConcurrency, world.units.length);
}

/** The work bound over a world every unit of which carries a wall. */
function workBoundOf(world: SimulatedWorld): number {
  const bound = workBoundFromWalls(estimatesOf(world.units));
  if (bound === undefined) throw new Error('a fully measured world has a work bound');
  return bound;
}

/** Which of the three bounds decided this case's count. */
function bindingBound(world: SimulatedWorld, taken: SimulatedCycle): string {
  if (taken.memoryCapped) return 'memory';
  return workBoundOf(world) < ceilingOf(world) ? 'work' : 'ceiling';
}

describe('the simulated world', () => {
  it('runs every unit at once when it has a lane for each', () => {
    const units = [unit('a', 10, 1), unit('b', 4, 1), unit('c', 4, 1)];
    expect(simulateRun(units, 3, 0)).toStrictEqual({
      maxConcurrent: 3,
      peakRssKb: 3 * GB,
      lanesAtPeak: 3,
      makespanMs: 10 * SECOND,
    });
  });

  it('releases the longest unit first into the lane that frees soonest', () => {
    // Longest first: 10 and 6 start together; the 5 follows the 6 at t=6, and
    // the 4 follows the 10 at t=10. Any other order ends later than 14.
    const units = [unit('a', 5, 1), unit('b', 10, 1), unit('c', 6, 1), unit('d', 4, 1)];
    expect(simulateRun(units, 2, 0).makespanMs).toBe(14 * SECOND);
  });

  it('stops charging for a unit the moment it ends', () => {
    // One lane, so the second unit starts exactly as the first ends and the run
    // holds the dearer of them rather than both: 2 + 8, never 2 + 8 + 6.
    const units = [unit('dear', 10, 8), unit('other', 10, 6)];
    expect(simulateRun(units, 1, 2 * GB)).toStrictEqual({
      maxConcurrent: 1,
      peakRssKb: 10 * GB,
      lanesAtPeak: 1,
      makespanMs: 20 * SECOND,
    });
  });

  it('reports the lanes that were live when the peak was set, not the lanes it opened', () => {
    // Two lanes, and the dearest moment holds one of them: the two ten-second
    // units start together for 2GB, and the nine-gigabyte unit follows at t=10,
    // by which time both have released. A row filed at the two lanes the run
    // opened would price a width that never held this.
    const units = [unit('a', 10, 1), unit('b', 10, 1), unit('dear', 2, 9)];
    expect(simulateRun(units, 2, 0)).toStrictEqual({
      maxConcurrent: 2,
      peakRssKb: 9 * GB,
      lanesAtPeak: 1,
      makespanMs: 12 * SECOND,
    });
  });

  it('refuses to run with no lane to run in', () => {
    expect(() => simulateRun([unit('a', 1, 1)], 0, 0)).toThrow(/at least one lane/);
  });
});

describe('the derived count, carried out', () => {
  it('never holds more memory than the budget it was given, over the whole grid', () => {
    const overBudget: string[] = [];
    const bindings = new Set<string>();
    for (const gridCase of GRID) {
      const taken = runFullyMeasured(gridCase.world);
      bindings.add(bindingBound(gridCase.world, taken));
      if (taken.run.peakRssKb > gridCase.world.memoryBudgetKb) overBudget.push(gridCase.label);
    }
    expect(overBudget).toStrictEqual([]);
    // Without this the universal above could hold because no case ever reached
    // the memory term, or the work bound, at all.
    expect([...bindings].toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
      'ceiling',
      'memory',
      'work',
    ]);
  });

  it('opens the lesser of the machine ceiling and the work bound where memory is abundant', () => {
    const wrong: string[] = [];
    let belowCeiling = 0;
    for (const workload of WORKLOADS) {
      const world = beyondAnyProjection(workload);
      const taken = runFullyMeasured(world);
      const lesser = Math.min(ceilingOf(world), workBoundOf(world));
      if (taken.concurrency !== lesser || taken.memoryCapped) wrong.push(workload.label);
      if (taken.concurrency < ceilingOf(world)) belowCeiling += 1;
    }
    expect(wrong).toStrictEqual([]);
    // Abundance does not imply the ceiling: somewhere in the grid the work
    // shape, not the machine, is what stops the count rising.
    expect(belowCeiling).toBeGreaterThan(0);
  });

  it('opens the largest count the budget admits where memory is tight', () => {
    const wrong: string[] = [];
    let examined = 0;
    for (const gridCase of GRID.filter((entry) => entry.peakProfile === CHARGES_WITH_THE_WALLS)) {
      const taken = runFullyMeasured(gridCase.world);
      if (!taken.memoryCapped) continue;
      examined += 1;
      const oneMore = simulateRun(
        gridCase.world.units,
        taken.concurrency + 1,
        gridCase.world.fixedRssKb
      );
      const fits = taken.run.peakRssKb <= gridCase.world.memoryBudgetKb;
      if (!fits || oneMore.peakRssKb <= gridCase.world.memoryBudgetKb) wrong.push(gridCase.label);
    }
    expect(wrong).toStrictEqual([]);
    expect(examined).toBeGreaterThan(0);
  });

  it('never opens fewer lanes, nor runs for longer, when the budget rises', () => {
    const regressions: string[] = [];
    let rises = 0;
    for (const workload of WORKLOADS) {
      const walk = walkBudgetLadder(workload);
      regressions.push(...walk.regressions);
      rises += walk.rises;
    }
    expect(regressions).toStrictEqual([]);
    // A ladder no count ever climbs would satisfy the universal vacuously.
    expect(rises).toBeGreaterThan(0);
  });

  it('keeps two units far dearer than the rest inside the budget', () => {
    // The worked shape a per-unit average gets wrong: eighteen units, two of
    // them six times dearer than the other sixteen.
    const units = Array.from({ length: 18 }, (_, index) =>
      unit(unitName(index), 10, index < 2 ? 6 : 1)
    );
    const world: SimulatedWorld = {
      units,
      fixedRssKb: FIXED_RSS_KB,
      maxConcurrency: 18,
      memoryBudgetKb: 16 * GB,
    };
    const taken = runFullyMeasured(world);
    expect(taken.run.peakRssKb).toBeLessThanOrEqual(world.memoryBudgetKb);
    expect(taken.run.maxConcurrent).toBe(taken.concurrency);

    // An averaged per-unit charge is not a cheaper form of the same rule. It
    // admits more lanes than this, and the memory those lanes truly hold is
    // over the budget — which is why a count is priced by the worst whole-run
    // peak recorded at a width it covers, never by a figure per unit.
    const averaged = Math.floor(
      (world.memoryBudgetKb - FIXED_RSS_KB) / ((2 * 6 * GB + 16 * GB) / units.length)
    );
    expect(averaged).toBeGreaterThan(taken.concurrency);
    expect(simulateRun(units, averaged, FIXED_RSS_KB).peakRssKb).toBeGreaterThan(
      world.memoryBudgetKb
    );

    // Tighten the budget below what the two dear units cost together and they
    // stop meeting at all.
    const tighter = runFullyMeasured({ ...world, memoryBudgetKb: 13 * GB });
    expect(tighter.run.peakRssKb).toBeLessThanOrEqual(13 * GB);
    expect(tighter.run.maxConcurrent).toBe(1);
  });
});

/** A world with memory to spare, so nothing but its own record moves its count. */
function roomyWorld(units: readonly FakeUnit[]): SimulatedWorld {
  return { units, fixedRssKb: FIXED_RSS_KB, maxConcurrency: 8, memoryBudgetKb: 40 * GB };
}

/** A world whose count moves once its units have been measured, then settles. */
function settlingWorld(): SimulatedWorld {
  return {
    units: Array.from({ length: 8 }, (_, index) => unit(unitName(index), 10, 3)),
    fixedRssKb: FIXED_RSS_KB,
    maxConcurrency: 8,
    memoryBudgetKb: 10 * GB,
  };
}

interface LadderWalk {
  readonly regressions: readonly string[];
  readonly rises: number;
}

/** What each step up one workload's budget ladder did to its count and its wall. */
function walkBudgetLadder(workload: Workload): LadderWalk {
  const regressions: string[] = [];
  let rises = 0;
  let before: SimulatedCycle | undefined;
  for (const fraction of BUDGET_FRACTIONS) {
    const after = runFullyMeasured(budgeted(workload, fraction));
    regressions.push(...stepRegressions(workload.label, fraction, before, after));
    if (before !== undefined && after.concurrency > before.concurrency) rises += 1;
    before = after;
  }
  return { regressions, rises };
}

/** What one step up a budget ladder did that a step up a budget ladder may not do. */
function stepRegressions(
  label: string,
  fraction: number,
  before: SimulatedCycle | undefined,
  after: SimulatedCycle
): string[] {
  if (before === undefined) return [];
  const faults: string[] = [];
  const at = `${label}, budget share ${String(fraction)}`;
  if (after.concurrency < before.concurrency) faults.push(`${at}: fewer lanes`);
  if (after.run.makespanMs > before.run.makespanMs) faults.push(`${at}: longer run`);
  return faults;
}

describe('what a run leaves for the next one', () => {
  let store: string;

  beforeEach(() => {
    store = path.join(mkdtempSync(path.join(os.tmpdir(), 'hb-pool-simulated-')), 'vitest');
  });

  afterEach(() => {
    rmSync(path.dirname(store), { recursive: true, force: true });
  });

  it('records every unit that ran, after one run from a cold store', () => {
    const world = settlingWorld();
    const first = runInWorld(world, store);
    expect(first.state).toBe('cold-start');

    const { tasks } = readLedger(store);
    const misrecorded = world.units
      .filter((candidate) => tasks[candidate.name]?.wallsMs.at(-1) !== candidate.wallMs)
      .map((candidate) => candidate.name);
    expect(misrecorded).toStrictEqual([]);
  });

  it('settles on the count its budget holds after one run over it', () => {
    const world = settlingWorld();
    const walk = [runInWorld(world, store)];
    for (let run = 0; run < 9; run += 1) walk.push(runInWorld(world, store));

    expect(walk[0]?.state).toBe('cold-start');
    expect(walk[1]?.state).toBe('derived');
    // The cold run is bounded by nothing, so it opens wide and files the one
    // rung it stood on. Every narrower count is then priced on the line from
    // that rung down to the run's own baseline, so the second run lands where
    // the budget holds instead of shedding a lane a run until it gets there.
    // Holding the rung flat below itself cost this world six over-budget runs
    // to reach the same count.
    expect(walk.map((taken) => taken.concurrency)).toStrictEqual([8, 2, 2, 2, 2, 2, 2, 2, 2, 2]);

    const settled = walk.at(-1);
    expect(settled?.run.makespanMs).toBe(walk.at(-2)?.run.makespanMs);
    // Where it settles is the widest count this world has held inside the
    // budget: one lane more is over it, which is why the descent stopped here
    // rather than at whatever count it happened to reach.
    expect(settled?.run.peakRssKb).toBeLessThanOrEqual(world.memoryBudgetKb);
    expect(simulateRun(world.units, 3, world.fixedRssKb).peakRssKb).toBeGreaterThan(
      world.memoryBudgetKb
    );
  });

  it('records a unit the same whatever else ran beside it', () => {
    const shared = unit('shared-unit', 12, 4);
    const alongside = (count: number): FakeUnit[] =>
      Array.from({ length: count }, (_, index) => unit(unitName(index), 6, 1));
    const crowded = path.join(path.dirname(store), 'crowded');

    runInWorld(roomyWorld([shared, ...alongside(2)]), store);
    runInWorld(roomyWorld([shared, ...alongside(11)]), crowded);

    // A wall that were a whole-run makespan divided by the units in the run
    // could not survive the run growing from three units to twelve.
    expect(readLedger(store).tasks[shared.name]).toStrictEqual({ wallsMs: [shared.wallMs] });
    expect(readLedger(crowded).tasks[shared.name]).toStrictEqual(
      readLedger(store).tasks[shared.name]
    );
  });

  it('keeps a wall for a unit the newest runs no longer name', () => {
    const rare = unit('rare-unit', 20, 5);
    const regulars = Array.from({ length: 4 }, (_, index) => unit(unitName(index), 8, 1));
    runInWorld(roomyWorld([rare, ...regulars]), store);
    for (let run = 0; run < MAX_RETAINED_WALLS + 2; run += 1) {
      runInWorld(roomyWorld(regulars), store);
    }

    // Every run that named it has long since left the newest-runs window, and
    // its wall is still there to be scheduled against.
    expect(readLedger(store).runs.length).toBeLessThanOrEqual(MAX_RETAINED_WALLS);
    expect(readLedger(store).tasks[rare.name]?.wallsMs).toStrictEqual([rare.wallMs]);

    const returning = runInWorld(roomyWorld([rare, ...regulars]), store);
    expect(returning.memoryGuarded).toBe(true);
  });
});
