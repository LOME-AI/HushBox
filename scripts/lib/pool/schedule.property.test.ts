/**
 * The ladder's laws, each stated over generated row sets rather than a chosen
 * few because the shapes that would break them are the awkward ones: a narrow
 * row above a wide one, a baseline above its own peak, a width nothing has
 * recorded between two that have.
 *
 * **What it projects for N lanes never falls as N rises.** The descent that
 * lowers a lane count walks N downwards and stops at the first count whose
 * projection fits the budget. That is only a correct search if the projection
 * is monotone — on a projection that dipped and rose again the descent would
 * stop above a count it should have kept walking past, and the run would open
 * lanes the record says it cannot hold.
 *
 * **It prices every count once one row prices anything.** The descent reads an
 * unpriced count as "nothing on record refuses this", so a count left
 * unanswered would be admitted on the strength of rows it overruns.
 *
 * **It never reads below the rungs themselves.** A figure taken off the line
 * between two rungs is not one any run held, so what keeps it a bound is that
 * it is never under the worst rung standing at the count or below it — the
 * figure the rule it replaced would have given.
 */

import { describe, expect, it } from 'vitest';

import { memoryLadder, projectedPeakKb, type RunObservation } from './schedule.js';

type Rng = () => number;

/** Deterministic seeded generator (mulberry32), so a failure reproduces exactly. */
function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d_2b_79_f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Uniform integer in [min, max] inclusive. */
function intBetween(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/**
 * One recorded run. A quarter of the rows drop a figure the ladder needs, so
 * the generated sets include the mixtures a real store holds, and a fifth
 * carry a baseline above their own peak — a row the recorders can write, and
 * one the ladder must still file at the width it ran.
 */
function generateRow(rng: Rng): RunObservation {
  const lanes = intBetween(rng, 1, 12);
  const peakRssKb = intBetween(rng, 1, 40_000_000);
  const fixedRssKb =
    rng() < 0.2 ? peakRssKb + intBetween(rng, 1, 5_000_000) : intBetween(rng, 0, peakRssKb);
  const missing = intBetween(rng, 0, 7);
  return {
    concurrency: lanes,
    taskCount: intBetween(rng, 1, 20),
    sumWallMs: 400_000,
    longestWallMs: 100_000,
    makespanMs: 100_000,
    ...(missing === 0 ? {} : { peakRssKb }),
    ...(missing === 1 ? {} : { fixedRssKb }),
    ...(missing === 2 ? {} : { lanesAtPeak: lanes }),
  };
}

function generateRows(rng: Rng): RunObservation[] {
  return Array.from({ length: intBetween(rng, 0, 8) }, () => generateRow(rng));
}

/** Sets to sweep. Enough that every row count and every missing-figure mixture appears. */
const SETS = 500;

/** Lane counts to sweep past the widest a generated row can carry. */
const WIDEST_LANES = 20;

/** The first counterexample a sweep found, printed whole so the failing set is readable. */
interface Counterexample {
  readonly rows: readonly RunObservation[];
  readonly lanes: number;
  readonly projected: number | undefined;
  readonly previous: number | undefined;
}

function firstFall(rng: Rng): Counterexample | undefined {
  for (let set = 0; set < SETS; set += 1) {
    const rows = generateRows(rng);
    const ladder = memoryLadder(rows);
    let previous: number | undefined;
    for (let lanes = 1; lanes <= WIDEST_LANES; lanes += 1) {
      const projected = projectedPeakKb(ladder, lanes);
      if (projected === undefined) continue;
      if (previous !== undefined && projected < previous) {
        return { rows, lanes, projected, previous };
      }
      previous = projected;
    }
  }
  return undefined;
}

/** The first count a ladder with a rung on it left unanswered. */
function firstUnpriced(rng: Rng): Counterexample | undefined {
  for (let set = 0; set < SETS; set += 1) {
    const rows = generateRows(rng);
    const ladder = memoryLadder(rows);
    if (ladder.length === 0) continue;
    for (let lanes = 1; lanes <= WIDEST_LANES; lanes += 1) {
      const projected = projectedPeakKb(ladder, lanes);
      if (projected === undefined) return { rows, lanes, projected, previous: undefined };
    }
  }
  return undefined;
}

/** The first count priced below the worst rung standing at it or below it. */
function firstBelowTheRungs(rng: Rng): Counterexample | undefined {
  for (let set = 0; set < SETS; set += 1) {
    const rows = generateRows(rng);
    const ladder = memoryLadder(rows);
    for (let lanes = 1; lanes <= WIDEST_LANES; lanes += 1) {
      const projected = projectedPeakKb(ladder, lanes);
      const standing = ladder.filter((rung) => rung.lanes <= lanes).map((rung) => rung.peakRssKb);
      if (standing.length === 0) continue;
      const worst = Math.max(...standing);
      if (projected === undefined || projected < worst) {
        return { rows, lanes, projected, previous: worst };
      }
    }
  }
  return undefined;
}

describe('the projection over any set of recorded runs', () => {
  it('never falls as the lane count rises', () => {
    expect(firstFall(mulberry32(0x5c_ed_1e))).toBeUndefined();
  });

  it('prices every count once one row prices anything', () => {
    // The descent reads an unpriced count as "nothing on record refuses this",
    // so a count a ladder left unanswered would be admitted on the strength of
    // rows it overruns.
    expect(firstUnpriced(mulberry32(0x5c_ed_1f))).toBeUndefined();
  });

  it('never prices a count below the worst rung standing at it or below it', () => {
    // What the line between two rungs buys: it is never a looser bound than
    // holding the lower rung flat was, at any count, on any row set.
    expect(firstBelowTheRungs(mulberry32(0x5c_ed_20))).toBeUndefined();
  });
});
