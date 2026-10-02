import { describe, expect, it } from 'vitest';

import {
  derivationBasis,
  describeDerivationBound,
  deriveConcurrency,
  laneUtilization,
  scheduleOrder,
  workBoundFromWalls,
  type PoolTaskEstimate,
  type RunObservation,
} from './schedule.js';

/** A task carrying one retained wall, which is what most of these cases need. */
function task(name: string, wallMs?: number): PoolTaskEstimate {
  return { name, wallsMs: wallMs === undefined ? undefined : [wallMs] };
}

/** A task carrying a wall history, oldest first. */
function taskWalls(name: string, wallsMs: readonly number[]): PoolTaskEstimate {
  return { name, wallsMs };
}

interface ObservedSeconds {
  readonly concurrency: number;
  readonly sumWall: number;
  readonly longestWall: number;
  readonly makespan: number;
}

/** Seconds are the unit these numbers were measured in; the module takes ms. */
function observed(input: ObservedSeconds): RunObservation {
  return {
    concurrency: input.concurrency,
    taskCount: 18,
    sumWallMs: input.sumWall * 1000,
    longestWallMs: input.longestWall * 1000,
    makespanMs: input.makespan * 1000,
  };
}

/** Positional shorthand for the many call sites that read as a row of numbers. */
function obs(
  concurrency: number,
  sumWall: number,
  longestWall: number,
  makespan: number
): RunObservation {
  return observed({ concurrency, sumWall, longestWall, makespan });
}

interface HeldRun {
  /** Lanes live at the sample that set this run's peak. */
  readonly lanes: number;
  /** What the whole tree held at that sample, baseline included. */
  readonly peakRssKb: number;
  /** What the run held outside its own lanes. */
  readonly fixedRssKb: number;
}

/**
 * A completed run carrying every figure the ladder reads. A case that wants a
 * row the ladder rejects builds the literal itself, so what is absent is
 * visible at the case rather than in a default here.
 */
function held(input: HeldRun): RunObservation {
  return {
    concurrency: input.lanes,
    taskCount: 4,
    sumWallMs: 400_000,
    longestWallMs: 100_000,
    makespanMs: 100_000,
    lanesAtPeak: input.lanes,
    peakRssKb: input.peakRssKb,
    fixedRssKb: input.fixedRssKb,
  };
}

describe('laneUtilization', () => {
  it('is the share of the lane-seconds the run actually filled', () => {
    // Four lanes open for 100s is 400 lane-seconds; 200s of work fills half.
    expect(laneUtilization(obs(4, 200, 100, 100))).toBeCloseTo(0.5, 5);
  });

  it('is 1 when every lane stayed busy for the whole run', () => {
    expect(laneUtilization(obs(4, 400, 100, 100))).toBeCloseTo(1, 5);
  });

  it('is unchanged when external load slows the whole run uniformly', () => {
    // The property the whole design rests on: walls and makespan scale
    // together, so the ratio survives a busy machine.
    const quiet = obs(5, 1274, 299, 300);
    const busy = obs(5, 1274 * 1.8, 299 * 1.8, 300 * 1.8);
    expect(laneUtilization(busy)).toBeCloseTo(laneUtilization(quiet), 5);
  });

  it('is 0 rather than NaN for a run that recorded no time', () => {
    expect(laneUtilization(obs(4, 0, 0, 0))).toBe(0);
  });
});

describe('scheduleOrder', () => {
  it('orders unknown-wall tasks first, then walls descending, names ascending on ties', () => {
    const order = scheduleOrder([
      task('small', 10),
      task('fresh-b'),
      task('big', 100),
      task('fresh-a'),
      task('twin-b', 50),
      task('twin-a', 50),
    ]);
    expect(order).toEqual(['fresh-a', 'fresh-b', 'big', 'twin-a', 'twin-b', 'small']);
  });

  it('orders on the median of a task’s history, not on its most recent wall', () => {
    // Release order stands on the same figure the lane count does. A task
    // whose latest run was pathological still releases where its repeated
    // cost puts it; on the most recent wall alone this pair reverses.
    const order = scheduleOrder([
      taskWalls('steady', [100, 100, 100]),
      taskWalls('spiky', [10, 10, 900]),
    ]);
    expect(order).toEqual(['steady', 'spiky']);
  });
});

describe('workBoundFromWalls', () => {
  it('is the fewest lanes at which the set fits under its longest member', () => {
    // Four equal tasks need four lanes to finish in one task's time.
    expect(
      workBoundFromWalls([100, 100, 100, 100].map((w, index) => task(`p${String(index)}`, w)))
    ).toBe(4);
    // One long task carrying three short ones needs only two.
    expect(
      workBoundFromWalls([300, 100, 100, 100].map((w, index) => task(`p${String(index)}`, w)))
    ).toBe(2);
  });

  it('is one lane for a single task, however long it is', () => {
    // The daily case: one package missed cache and the rest replayed.
    expect(workBoundFromWalls([task('only', 222_000)])).toBe(1);
  });

  it('substitutes the longest known wall for a never-measured task', () => {
    // Unknown reads as expensive, which raises the lane count rather than
    // starving a task nobody has timed yet.
    expect(workBoundFromWalls([task('known', 100_000), task('new')])).toBe(2);
  });

  it('is undefined when no task in the set has ever been measured', () => {
    expect(workBoundFromWalls([task('a'), task('b')])).toBeUndefined();
  });

  it('is undefined for an empty set', () => {
    expect(workBoundFromWalls([])).toBeUndefined();
  });

  it('is one lane when every recorded wall is zero', () => {
    expect(workBoundFromWalls([task('a', 0), task('b', 0)])).toBe(1);
  });

  it('is unmoved by a single outlier among a task’s retained walls', () => {
    // The outlier sits last on purpose: it is the realistic case — the run
    // that just happened is the pathological one — and it is the only
    // position that discriminates. A derivation reading the most recent wall
    // instead of the median answers 2 for the outlying set below.
    const steady = ['a', 'b', 'c', 'd'].map((name) => taskWalls(name, [100, 100, 100]));
    const outlying = steady.map((entry, index) =>
      index === 0 ? taskWalls(entry.name, [100, 100, 5000]) : entry
    );
    expect(workBoundFromWalls(steady)).toBe(4);
    expect(workBoundFromWalls(outlying)).toBe(4);
  });

  it('derives from a task holding a single retained wall', () => {
    // A history shorter than the median's guard still derives: what the
    // derivation needs is a wall, not a count of samples behind it.
    expect(workBoundFromWalls(['a', 'b', 'c'].map((name) => taskWalls(name, [100])))).toBe(3);
  });

  it('takes the fewest lanes that reach the shortest run, not the first that could', () => {
    // Scheduled longest-first: four lanes run 11s, because a 6s unit and a 5s
    // one have to share one; five lanes run 10s, the longest unit's own wall,
    // which no count beats; six lanes run 10s as well. The answer is the first
    // count to reach that, and a rule reading the summed walls against the
    // longest one answers four — a count whose run is a second longer.
    const set = [10_000, 6000, 6000, 6000, 5000, 5000].map((wall, index) =>
      task(`p${String(index)}`, wall)
    );
    expect(workBoundFromWalls(set)).toBe(5);
  });

  it('stops where extra lanes buy nothing, one long unit carrying short ones', () => {
    // The shape the bound exists for: the five short units all fit beside the
    // long one inside its own wall, so a second lane reaches the shortest run
    // this set has and a third would idle.
    const set = [100_000, 1000, 1000, 1000, 1000, 1000].map((wall, index) =>
      task(`p${String(index)}`, wall)
    );
    expect(workBoundFromWalls(set)).toBe(2);
  });

  it('takes two retained walls as their mean', () => {
    // Two samples are the definition and not a guard: the median of two is
    // their mean, so half an outlier's excess still reaches the answer. Here
    // the mean gives 3 lanes where the latest wall alone would give 2.
    const tasks = [
      taskWalls('a', [100, 300]),
      ...['b', 'c', 'd'].map((name) => taskWalls(name, [100, 100])),
    ];
    expect(workBoundFromWalls(tasks)).toBe(3);
  });
});

describe('deriveConcurrency', () => {
  const CEILING = 6;
  const eighteen = Array.from({ length: 18 }, (_, index) =>
    task(`p${String(index)}`, index === 0 ? 222_000 : 42_647)
  );

  it('starts at the machine ceiling when no wall is known', () => {
    const derived = deriveConcurrency({
      tasks: [task('a'), task('b'), task('c')],
      observations: [],
      maxConcurrency: CEILING,
    });
    expect(derived).toMatchObject({ concurrency: 3, state: 'cold-start' });
  });

  it('never opens more lanes than there are tasks', () => {
    const derived = deriveConcurrency({
      tasks: [task('a', 10), task('b', 10)],
      observations: [],
      maxConcurrency: CEILING,
    });
    expect(derived.concurrency).toBe(2);
  });

  it('derives the full set from its own walls', () => {
    // Measured: 18 lint packages summing 947s against a 222s longest.
    const derived = deriveConcurrency({
      tasks: eighteen,
      observations: [],
      maxConcurrency: CEILING,
    });
    expect(derived.concurrency).toBe(5);
    expect(derived.state).toBe('derived');
  });

  it('opens one lane when a single package missed cache', () => {
    const derived = deriveConcurrency({
      tasks: [task('@x/api', 222_000)],
      observations: [],
      maxConcurrency: CEILING,
    });
    expect(derived.concurrency).toBe(1);
  });

  it('is unmoved by history from runs over a different set of tasks', () => {
    // The bug this replaced: a mostly-cached run recorded sum == longest,
    // which read as one lane and then governed the next full run.
    const onePackageRun: RunObservation = {
      concurrency: 1,
      taskCount: 1,
      sumWallMs: 50_000,
      longestWallMs: 50_000,
      makespanMs: 50_000,
    };
    const derived = deriveConcurrency({
      tasks: eighteen,
      observations: [onePackageRun, onePackageRun, onePackageRun],
      maxConcurrency: CEILING,
    });
    expect(derived.concurrency).toBe(5);
  });

  it('opens a lane per unit where pairing any two of them would run longer', () => {
    // Eight near-equal units: eight lanes finish in the longest one's 13.5s,
    // while seven force a lane to run two of them — 20.5s at the best pairing,
    // half as long again to save a lane.
    const nearEqual = [10_000, 10_500, 11_000, 11_500, 12_000, 12_500, 13_000, 13_500].map(
      (wall, index) => task(`p${String(index)}`, wall)
    );
    const derived = deriveConcurrency({
      tasks: nearEqual,
      observations: [],
      maxConcurrency: 8,
    });
    expect(derived.concurrency).toBe(8);
  });

  it('never rises above the machine ceiling', () => {
    const wide = Array.from({ length: 40 }, (_, index) => task(`p${String(index)}`, 100_000));
    const derived = deriveConcurrency({ tasks: wide, observations: [], maxConcurrency: CEILING });
    expect(derived.concurrency).toBe(CEILING);
  });

  it('returns a single lane for an empty task set', () => {
    const derived = deriveConcurrency({ tasks: [], observations: [], maxConcurrency: CEILING });
    expect(derived.concurrency).toBe(1);
  });
});

describe('the bound a derived count came out of', () => {
  const CEILING = 6;

  it('names the walls where scheduling them reached the shortest run below the ceiling', () => {
    const eighteen = Array.from({ length: 18 }, (_, index) =>
      task(`p${String(index)}`, index === 0 ? 222_000 : 42_647)
    );
    const derived = deriveConcurrency({
      tasks: eighteen,
      observations: [],
      maxConcurrency: CEILING,
    });
    expect(derived).toMatchObject({ concurrency: 5, bound: 'work' });
  });

  it('names the ceiling where the walls asked for more lanes than the machine has', () => {
    const wide = Array.from({ length: 40 }, (_, index) => task(`p${String(index)}`, 100_000));
    const derived = deriveConcurrency({ tasks: wide, observations: [], maxConcurrency: CEILING });
    expect(derived).toMatchObject({ concurrency: CEILING, bound: 'ceiling' });
  });

  it('names the walls where they asked for exactly the lanes the machine has', () => {
    const derived = deriveConcurrency({
      tasks: [task('a', 100_000), task('b', 100_000)],
      observations: [],
      maxConcurrency: 2,
    });
    expect(derived).toMatchObject({ concurrency: 2, bound: 'work' });
  });

  it('names no basis at all where the set carries no wall', () => {
    const derived = deriveConcurrency({
      tasks: [task('a'), task('b'), task('c')],
      observations: [],
      maxConcurrency: CEILING,
    });
    expect(derived).toMatchObject({ concurrency: 3, bound: 'unmeasured' });
  });

  it('names the ceiling where no wall is on record but a projection admitted the count', () => {
    const derived = deriveConcurrency({
      tasks: [task('a'), task('b')],
      observations: [held({ lanes: 2, peakRssKb: 2_000_000, fixedRssKb: 1_000_000 })],
      maxConcurrency: CEILING,
      memoryBudgetKb: 100_000_000,
    });
    expect(derived).toMatchObject({ concurrency: 2, bound: 'ceiling', memoryGuarded: true });
  });

  it('names the memory descent where it took lanes off what the work asked for', () => {
    const four = Array.from({ length: 4 }, (_, index) => task(`p${String(index)}`, 100_000));
    const derived = deriveConcurrency({
      tasks: four,
      observations: [
        held({ lanes: 3, peakRssKb: 7_000_000, fixedRssKb: 1_000_000 }),
        held({ lanes: 4, peakRssKb: 9_000_000, fixedRssKb: 1_000_000 }),
      ],
      maxConcurrency: CEILING,
      memoryBudgetKb: 8_000_000,
    });
    expect(derived).toMatchObject({ concurrency: 3, bound: 'memory' });
  });

  it('names no basis for an empty task set, which nothing on record reached', () => {
    const derived = deriveConcurrency({ tasks: [], observations: [], maxConcurrency: CEILING });
    expect(derived).toMatchObject({ bound: 'unmeasured' });
  });
});

describe('derivationBasis', () => {
  it('names the walls for a count the work bound set', () => {
    expect(derivationBasis({ bound: 'work' })).toBe('work-bound');
  });

  it('names the ceiling for a count the ceiling set', () => {
    expect(derivationBasis({ bound: 'ceiling' })).toBe('ceiling');
  });

  it('names the projection for a count the memory descent set', () => {
    expect(derivationBasis({ bound: 'memory' })).toBe('memory-bound');
  });

  it('names a count no measurement reached a cold start', () => {
    expect(derivationBasis({ bound: 'unmeasured' })).toBe('cold-start');
  });

  /**
   * The claim the vocabulary exists to refuse: a count the ceiling set is not
   * a count walls shaped, whatever walls the set happens to carry elsewhere.
   */
  it('calls no count the ceiling set wall-derived', () => {
    expect(derivationBasis({ bound: 'ceiling' })).not.toMatch(/derived/);
  });
});

describe('describeDerivationBound', () => {
  it('says what scheduling the walls reached where the work bound set the count', () => {
    expect(describeDerivationBound({ bound: 'work' })).toMatch(
      /work-bound.*scheduling.*walls.*shortest run/
    );
  });

  it('says nothing on record asked for fewer lanes where the ceiling set the count', () => {
    expect(describeDerivationBound({ bound: 'ceiling' })).toMatch(/ceiling.*nothing on record/);
  });

  it('says the projection took lanes off where the descent set the count', () => {
    expect(describeDerivationBound({ bound: 'memory' })).toMatch(/memory-bound.*project/);
  });

  it('says the ceiling stood in where no wall is on record', () => {
    expect(describeDerivationBound({ bound: 'unmeasured' })).toMatch(/cold-start.*no wall/);
  });

  it('opens with the same word the state column prints, for every bound', () => {
    for (const bound of ['work', 'ceiling', 'memory', 'unmeasured'] as const) {
      expect(describeDerivationBound({ bound }).startsWith(derivationBasis({ bound }))).toBe(true);
    }
  });
});

describe('the memory descent over the ladder of what widths have held', () => {
  const CEILING = 6;

  /** Four equal tasks: the work bound asks for four lanes and the ladder lowers it. */
  const four = Array.from({ length: 4 }, (_, index) => task(`p${String(index)}`, 100_000));

  /** Six equal tasks, for the counts that sit above the widest recorded width. */
  const six = Array.from({ length: 6 }, (_, index) => task(`p${String(index)}`, 100_000));

  /** A rung at every width from one lane to four, rising 2.0GB a lane. */
  const upToFour = [
    held({ lanes: 1, peakRssKb: 3_000_000, fixedRssKb: 1_000_000 }),
    held({ lanes: 2, peakRssKb: 5_000_000, fixedRssKb: 1_000_000 }),
    held({ lanes: 3, peakRssKb: 7_000_000, fixedRssKb: 1_000_000 }),
    held({ lanes: 4, peakRssKb: 9_000_000, fixedRssKb: 1_000_000 }),
  ];

  /** The count a set derives against one budget, over the rows given. */
  function over(
    tasks: readonly PoolTaskEstimate[],
    observations: readonly RunObservation[],
    memoryBudgetKb: number
  ): { concurrency: number; memoryCapped: boolean; memoryGuarded: boolean } {
    const derived = deriveConcurrency({
      tasks,
      observations,
      maxConcurrency: CEILING,
      memoryBudgetKb,
    });
    return {
      concurrency: derived.concurrency,
      memoryCapped: derived.memoryCapped,
      memoryGuarded: derived.memoryGuarded,
    };
  }

  it('prices a recorded width at the worst total peak recorded at it, exactly', () => {
    // Nothing is subtracted and nothing is composed: the 9.0GB row is what four
    // lanes have held, so a budget of exactly that admits four and a budget one
    // kilobyte under it does not.
    const worst = [...upToFour, held({ lanes: 4, peakRssKb: 8_000_000, fixedRssKb: 1_500_000 })];
    expect(over(four, worst, 9_000_000)).toEqual({
      concurrency: 4,
      memoryCapped: false,
      memoryGuarded: true,
    });
    expect(over(four, worst, 9_000_000 - 1).concurrency).toBe(3);
  });

  /** Rungs at two lanes and at six, with every width between them unrecorded. */
  const gapped = [
    held({ lanes: 2, peakRssKb: 5_000_000, fixedRssKb: 1_000_000 }),
    held({ lanes: 6, peakRssKb: 13_000_000, fixedRssKb: 1_000_000 }),
  ];

  it('prices a width between two recorded rungs on the line between them', () => {
    // Four lanes sit halfway from the 5.0GB rung to the 13.0GB one and are
    // priced halfway up it, at 9.0GB. Holding the lower rung instead would
    // price them at 5.0GB — a figure that assumes widening from two lanes to
    // four costs nothing.
    expect(over(four, gapped, 9_000_000)).toEqual({
      concurrency: 4,
      memoryCapped: false,
      memoryGuarded: true,
    });
    expect(over(four, gapped, 9_000_000 - 1).concurrency).toBe(3);
  });

  it('prices a width that sits on a recorded rung at that rung’s own figure', () => {
    // The endpoints of the line are the rungs themselves: two lanes are priced
    // at exactly the 5.0GB that width recorded, so a budget of that admits two
    // and a budget one kilobyte under it does not.
    expect(over(four, gapped, 5_000_000).concurrency).toBe(2);
    expect(over(four, gapped, 5_000_000 - 1).concurrency).toBe(1);
  });

  it('carries a narrow row’s higher peak onto every wider count', () => {
    // Two lanes once held 10.0GB and four lanes have held only 6.0GB, so four
    // lanes are priced at 10.0GB: a budget that the four-lane row alone would
    // clear takes the count apart instead.
    const narrowHeavy = [
      held({ lanes: 2, peakRssKb: 10_000_000, fixedRssKb: 1_000_000 }),
      held({ lanes: 4, peakRssKb: 6_000_000, fixedRssKb: 1_000_000 }),
    ];
    expect(over(four, narrowHeavy, 10_000_000)).toEqual({
      concurrency: 4,
      memoryCapped: false,
      memoryGuarded: true,
    });
    expect(over(four, narrowHeavy, 6_000_000).concurrency).toBe(1);
  });

  /** One rung, at four lanes, for the two cases either side of the widest width. */
  const widestAtFour = [held({ lanes: 4, peakRssKb: 9_000_000, fixedRssKb: 1_000_000 })];

  it('holds the widest rung’s own figure above every recorded width', () => {
    // Six lanes is a width nothing has ever run. It is priced at the 9.0GB the
    // four-lane row held and at nothing more: a budget of exactly that admits
    // all six, where extending the rung by its own 2.0GB a lane would have
    // priced them at 13.0GB and taken two lanes off.
    expect(over(six, widestAtFour, 9_000_000)).toEqual({
      concurrency: 6,
      memoryCapped: false,
      memoryGuarded: true,
    });
  });

  it('refuses a count wider than every recorded width where the widest rung overruns', () => {
    // A kilobyte under what four lanes held. Five and six lanes hold at least
    // what four did, so the descent refuses both and walks down to the first
    // count no width on record prices.
    expect(over(six, widestAtFour, 9_000_000 - 1)).toEqual({
      concurrency: 3,
      memoryCapped: true,
      memoryGuarded: true,
    });
  });

  it('still prices the widest recorded width itself', () => {
    // The boundary the case above must not cross: four lanes is on record, so
    // a budget a kilobyte under what four lanes held still takes a lane off.
    expect(over(four, widestAtFour, 9_000_000)).toEqual({
      concurrency: 4,
      memoryCapped: false,
      memoryGuarded: true,
    });
    expect(over(four, widestAtFour, 9_000_000 - 1).concurrency).toBe(3);
  });

  /** The count against a budget nothing can meet, over one row and no other. */
  function guardedBy(run: RunObservation): { concurrency: number; memoryGuarded: boolean } {
    const { concurrency, memoryGuarded } = over(four, [run], 1);
    return { concurrency, memoryGuarded };
  }

  /**
   * A run at four lanes carrying every figure the ladder reads, which each case
   * below strips one figure from. Each is stated as its own literal so the
   * absence is visible where the case is read.
   */
  const complete: RunObservation = {
    concurrency: 4,
    taskCount: 4,
    sumWallMs: 400_000,
    longestWallMs: 100_000,
    makespanMs: 100_000,
    lanesAtPeak: 4,
    peakRssKb: 9_000_000,
    fixedRssKb: 1_000_000,
  };

  it('needs a peak on the row before it will bound a count', () => {
    const noPeak: RunObservation = {
      concurrency: 4,
      taskCount: 4,
      sumWallMs: 400_000,
      longestWallMs: 100_000,
      makespanMs: 100_000,
      lanesAtPeak: 4,
      fixedRssKb: 1_000_000,
    };
    expect(guardedBy(complete)).toEqual({ concurrency: 1, memoryGuarded: true });
    expect(guardedBy(noPeak)).toEqual({ concurrency: 4, memoryGuarded: false });
  });

  it('needs a fixed cost on the row before it will bound a count', () => {
    const noFixed: RunObservation = {
      concurrency: 4,
      taskCount: 4,
      sumWallMs: 400_000,
      longestWallMs: 100_000,
      makespanMs: 100_000,
      lanesAtPeak: 4,
      peakRssKb: 9_000_000,
    };
    expect(guardedBy(complete)).toEqual({ concurrency: 1, memoryGuarded: true });
    expect(guardedBy(noFixed)).toEqual({ concurrency: 4, memoryGuarded: false });
  });

  it('needs the lane count at the peak before it will bound a count', () => {
    // The row the ladder cannot file: a peak with no width is evidence about no
    // width, and filing it at a guessed one moves every count above that guess.
    const noLanes: RunObservation = {
      concurrency: 4,
      taskCount: 4,
      sumWallMs: 400_000,
      longestWallMs: 100_000,
      makespanMs: 100_000,
      peakRssKb: 9_000_000,
      fixedRssKb: 1_000_000,
    };
    expect(guardedBy(complete)).toEqual({ concurrency: 1, memoryGuarded: true });
    expect(guardedBy(noLanes)).toEqual({ concurrency: 4, memoryGuarded: false });
  });

  it('leaves the count unguarded and says so where no run qualifies at all', () => {
    expect(over(four, upToFour, 1).memoryGuarded).toBe(true);
    expect(over(four, [], 1)).toEqual({
      concurrency: 4,
      memoryCapped: false,
      memoryGuarded: false,
    });
  });

  it('leaves the count unguarded where the caller named no budget', () => {
    const derived = deriveConcurrency({
      tasks: four,
      observations: upToFour,
      maxConcurrency: CEILING,
    });
    expect(derived).toEqual({
      concurrency: 4,
      state: 'derived',
      bound: 'work',
      memoryCapped: false,
      memoryGuarded: false,
    });
  });

  it('never cuts below a single lane, however small the budget', () => {
    expect(over(four, upToFour, 1)).toEqual({
      concurrency: 1,
      memoryCapped: true,
      memoryGuarded: true,
    });
  });

  it('prices a width below the narrowest rung from that rung down to its baseline', () => {
    // A rung at four lanes and nothing narrower: 9.0GB held over a 1.0GB
    // baseline. Three lanes are priced three quarters of the way up that line,
    // at 7.0GB, rather than left unpriced and admitted.
    expect(over(four, widestAtFour, 7_000_000).concurrency).toBe(3);
    expect(over(four, widestAtFour, 7_000_000 - 1).concurrency).toBe(2);
  });

  it('carries the descent to a single lane rather than stopping below the narrowest rung', () => {
    // Every count the ladder can price is priced, so a budget nothing meets
    // walks the count all the way down instead of stopping at the first width
    // no row stands at.
    expect(over(four, widestAtFour, 1)).toEqual({
      concurrency: 1,
      memoryCapped: true,
      memoryGuarded: true,
    });
  });
});

describe('the widths a store can come to hold a rung at', () => {
  /** Three equal units, so the work shape asks for three lanes and the machine allows them. */
  const three = Array.from({ length: 3 }, (_, index) => task(`p${String(index)}`, 100_000));

  /**
   * What this world really holds at a width: 1.0GB outside the lanes, 3.0GB of
   * image the lanes share, and 1.0GB private to each of them. A row recorded
   * at one lane therefore reads 5.0GB over a 1.0GB baseline — a cost per lane
   * of 4.0GB against a real marginal cost of 1.0GB. That gap is what a
   * one-point line drawn above the widest rung reads as the cost of widening.
   */
  function trulyHeldKb(lanes: number): number {
    return 4_000_000 + lanes * 1_000_000;
  }

  /** The row a run at this width would leave behind, having held what the world holds. */
  function filedBy(lanes: number): RunObservation {
    return held({ lanes, peakRssKb: trulyHeldKb(lanes), fixedRssKb: 1_000_000 });
  }

  /**
   * The counts successive runs derive, each one filing its own row before the
   * next derives. The store starts holding the single rung a one-lane run left
   * — the state a count has to climb out of, and could not while a rung one
   * lane wide was extended by its own cost over every count above it.
   */
  function countsOverRuns(rounds: number, memoryBudgetKb: number): number[] {
    const observations: RunObservation[] = [filedBy(1)];
    const counts: number[] = [];
    for (let round = 0; round < rounds; round += 1) {
      const derived = deriveConcurrency({
        tasks: three,
        observations,
        maxConcurrency: 3,
        memoryBudgetKb,
      });
      counts.push(derived.concurrency);
      observations.push(filedBy(derived.concurrency));
    }
    return counts;
  }

  it('is not held at one lane by a store whose only rung is one lane wide', () => {
    // 8.0GB holds all three lanes with a gigabyte to spare, and the one-lane
    // rung it starts from is under that, so the count opens wide at once and
    // the row it files keeps it there.
    expect(countsOverRuns(5, 8_000_000)).toStrictEqual([3, 3, 3, 3, 3]);
  });

  it('settles at the widest count its budget holds, having learnt the width by running it', () => {
    // 6.0GB holds two lanes and not three. The first run opens three on the
    // strength of the one-lane rung and overruns; the row it files is what
    // takes the third lane off, and the second row is what settles it.
    expect(countsOverRuns(5, 6_000_000)).toStrictEqual([3, 2, 2, 2, 2]);
  });
});

describe('the bounds that are not the memory bound', () => {
  it('pins the work bound for a set the memory record says nothing about', () => {
    // Held across the projection's replacement: the walls alone decide this,
    // and the answer is the same with no row on record and with a ladder that
    // admits every count.
    const set = [10_000, 6000, 6000, 6000, 5000, 5000].map((wall, index) =>
      task(`p${String(index)}`, wall)
    );
    expect(workBoundFromWalls(set)).toBe(5);
    expect(deriveConcurrency({ tasks: set, observations: [], maxConcurrency: 8 })).toEqual({
      concurrency: 5,
      state: 'derived',
      bound: 'work',
      memoryCapped: false,
      memoryGuarded: false,
    });
    expect(
      deriveConcurrency({
        tasks: set,
        observations: [held({ lanes: 5, peakRssKb: 2_000_000, fixedRssKb: 1_000_000 })],
        maxConcurrency: 8,
        memoryBudgetKb: 100_000_000,
      }).concurrency
    ).toBe(5);
  });
});
