/**
 * Concurrency derivation for the turbo task pool.
 *
 * The pool picks the fewest lanes at which the set reaches its shortest run —
 * the count {@link workBoundFromWalls} schedules for — then lowers that count
 * while the peak it projects overruns the memory budget, so what it opens sits
 * at that point or below it, never above. The point is a property of *the set
 * of tasks about to run*, so it is computed from those tasks' own recorded
 * walls rather than from whole-run history: a run over one cache-missed package
 * and a run over all eighteen are answering different questions, and pooling
 * their answers gives a number that is right for neither. Where the set carries
 * no recorded wall at all there is no such point to pick, and the ceiling — the
 * machine's, capped at one lane per task — stands in as the count the
 * projection lowers. Every figure compared is a wall, so a machine busy with
 * other work stretches them together and the answer holds — which is what lets
 * it settle on a box that is never idle, the box it runs on.
 *
 * That stretching cancels only where it is uniform, and walls from different
 * runs sit in one map regardless: a package linted alone records a faster wall
 * than one linted beside five others, so the map mixes contended and
 * uncontended figures and a schedule built over the mixture is built over walls
 * that were not all measured under the same load. Deliberately not corrected
 * for: normalising would need a model of how wall scales with lane count, and
 * the measurements do not supply one — summed task-work came to 975s at six
 * lanes and 999s at five, which is not even monotonic. A model invented over
 * that noise would be worse than the mixing.
 *
 * Lanes beyond the point where the run stops getting shorter cost memory and
 * buy nothing: measured over 18 lint packages, wall time was flat from 4 lanes
 * to 10 (269s to 287s, inside run-to-run spread) while peak memory rose sharply
 * across the same range.
 *
 * The peak it projects is a ladder over what runs on this machine have really
 * held, indexed by the lanes that were live when each peak was set. A width's
 * rung is the worst whole-tree peak any retained row recorded at that width,
 * baseline included and nothing subtracted, and the rungs are read as a rising
 * staircase: each width stands at the worst figure it or any narrower width
 * recorded, so a narrow run that held more than a wide one goes on pricing
 * every wider count. A count between two rungs is priced on the straight line
 * joining them, and a count below the narrowest rung on the line running from
 * that rung down to its own run's baseline at no lanes at all. Non-decreasing
 * in N by construction, which is what makes the lane-lowering descent a
 * well-defined search.
 *
 * A figure taken off one of those lines is one no run held, and that is what
 * leaving no count unpriced costs. Holding the lower rung flat instead priced
 * a count between two widths as though widening to it were free, and below the
 * narrowest rung it priced nothing at all — so those counts were admitted with
 * no bound on them, which is where the overruns came from. A line is never
 * under the staircase it replaces, so it is never the looser bound, and on a
 * curve that rises with lanes it is a lower bound throughout.
 *
 * Nothing is composed and nothing is scaled. Summing the lanes' dearest units
 * priced a coincidence — those high-water marks do not occur at one instant —
 * and the ratio that corrected the sum was that same error measured against
 * the whole-run peaks the sum was trying to predict.
 *
 * Above the widest width on record the ladder continues flat. There is no rung
 * to read there, so the figure stands at the worst any width on record has
 * held: a wider count is admitted where that figure fits and refused where it
 * already overruns, and nothing is extrapolated. Extending the widest rung by
 * its own cost per lane was rejected — it is a per-lane line drawn through a
 * single point, on a curve measured nowhere past that point, and where the
 * widest rung is narrow it absorbs: the extension prices every wider count
 * out, a one-lane run only refiles the one-lane rung, and so a store whose
 * widest rung sits at one width can never record a wider one unless the budget
 * itself grows. Continuing flat is what lets the record widen at all: where it
 * admits a count, the run opens it and files a rung at the width that was live
 * when the peak was held, which is sometimes narrower than the width it
 * opened. So the record widens, but irregularly, and a run whose peak lands
 * before its lanes fill widens it by nothing.
 *
 * The projection reads no shape, and the only baseline it reads is the one on
 * the row that set its narrowest rung, where the line below that rung lands.
 * That is what lets one ladder serve a heavy path and a light one: baselines
 * vary within a shape, so a baseline term carried into every figure would hand
 * a heavy run a light run's overhead, while a whole recorded peak read across
 * shapes only ever over-reads, the direction a bound may err in.
 *
 * Where no row carries all three of a peak, a baseline and a lane count there
 * is no ladder, the count is left unbounded, and the derivation says so — a run
 * on a machine that has measured nothing is unguarded, and what it records is
 * what bounds the next one. Nothing stands in for a missing row, because a
 * figure standing in for a measurement is a constant that decays as the suite
 * grows, as the toolchain changes, and on every machine nobody measured.
 */

export interface PoolTaskEstimate {
  readonly name: string;
  /** Retained walls from the ledger, oldest first; undefined for a never-measured package. */
  readonly wallsMs?: readonly number[] | undefined;
}

/** What one completed pool run reveals about its own shape. */
export interface RunObservation {
  readonly concurrency: number;
  /**
   * Tasks the run covered. Carried for the report and compared with nothing:
   * the ladder files a peak by the lanes that were live when it was set, so a
   * peak recorded over a narrow set stands against a wider one at the same
   * width — reading high, which is the direction a bound may err in.
   */
  readonly taskCount: number;
  /** Summed wall of every task in the run. */
  readonly sumWallMs: number;
  /** The critical path: the single longest task's wall. */
  readonly longestWallMs: number;
  /** Wall of the run as a whole. */
  readonly makespanMs: number;
  /** The tree's peak proportional set size; undefined where it cannot be sampled. */
  readonly peakRssKb?: number | undefined;
  /** The run's peak outside its workers; undefined where the run measured no split. */
  readonly fixedRssKb?: number | undefined;
  /**
   * Test files the run collected, as the reporter counted them. This is the
   * population the worker-layout guard is judged against, and what tells a
   * three-file batch from a nine-hundred-file one — the batch-size difference
   * the measurements put at the widest non-transfer gap. It is **not** the
   * population {@link RunObservation.perFileWallMs} averages, which excludes a
   * file that could not be weighed, so the two must never be multiplied
   * together; {@link RunObservation.sumFileWallMs} is the total. Undefined
   * where the run collected none.
   */
  readonly fileCount?: number | undefined;
  /**
   * The mean wall of the test files the run covered — its work per file, and so
   * the one thing on the row that separates two runs over the same number of
   * packages into a heavy workload and a light one. A proxy for work and not
   * for memory: nothing here claims a memory bound follows from it. Undefined
   * where no file could be weighed.
   */
  readonly perFileWallMs?: number | undefined;
  /**
   * The run's whole test work: the summed wall of every file it could weigh,
   * recorded rather than reconstructed so that nothing on this row has to be
   * multiplied by anything. A proxy for work and not for memory, like the
   * weight beside it. Undefined where no file could be weighed.
   */
  readonly sumFileWallMs?: number | undefined;
  /**
   * Lanes live at the sample that set {@link RunObservation.peakRssKb} — the
   * width the ladder files this row at, and the one figure that decides which
   * counts the row goes on pricing. Filing a heavy row too narrow pins a low
   * rung high and costs lanes at every wider count, which is why it is the
   * recorded live count rather than the count the run declared: a run that
   * declared eight lanes and had four units to fill them held four lanes'
   * worth. Undefined where the recorder did not count them, and such a row
   * prices nothing.
   */
  readonly lanesAtPeak?: number | undefined;
  /**
   * What kind of invocation recorded this row — a batch, a package-rooted run,
   * a watch. Carried for retention and reporting, which key on it; the ladder
   * below the widest recorded width reads no shape, because a row's whole peak
   * answers for a whole run whatever shape it had. Undefined for a row recorded
   * before the stamp existed.
   */
  readonly shape?: string | undefined;
}

type ConcurrencyState = 'cold-start' | 'derived';

/**
 * Which of the limits below a count actually came out of: the machine
 * ceiling, the work bound the recorded walls describe, the memory descent, or
 * `unmeasured` where the set carries no wall and nothing projected against it.
 *
 * Reported rather than left for a reader to infer, because the three limits
 * are computed here and only two of them survive into the answer: a count and
 * a state word together cannot say which one stood, and a reader who assumes
 * the work bound stood reads a claim the numbers may not support.
 */
export type ConcurrencyBound = 'work' | 'ceiling' | 'memory' | 'unmeasured';

/** The fields a count's basis is read from, whichever derivation produced it. */
interface DerivationBasis {
  readonly bound: ConcurrencyBound;
}

/**
 * What every reader says about a count, keyed off the limit the count actually
 * came out of and nothing else.
 *
 * A word for what the record holds cannot answer for what set the count: a set
 * can carry walls whose work bound lands far above the machine ceiling, and
 * calling the ceiling's count wall-derived claims a basis the number does not
 * rest on. So the word names the binding limit, and what the record holds is
 * reported beside it as its own figures.
 *
 * One table for the word and the clause, so that a reader meeting `ceiling` in
 * the state column and in a note has met one claim twice rather than two
 * claims that agree today.
 */
const BOUND_VOCABULARY: Record<
  ConcurrencyBound,
  { readonly word: string; readonly because: string }
> = {
  work: {
    word: 'work-bound',
    because:
      'scheduling the recorded walls reaches its shortest run in fewer lanes than the machine has',
  },
  ceiling: {
    word: 'ceiling',
    because: 'nothing on record asks for fewer lanes than the machine has',
  },
  memory: {
    word: 'memory-bound',
    because: 'the projected peak takes lanes off what the work asks for',
  },
  unmeasured: {
    word: 'cold-start',
    because: 'no wall is on record, so the machine ceiling stands in',
  },
};

/** The one word a count's state is reported in. */
export function derivationBasis(basis: DerivationBasis): string {
  return BOUND_VOCABULARY[basis.bound].word;
}

/** The same word, with the clause a reader needs to act on it. */
export function describeDerivationBound(basis: DerivationBasis): string {
  const { word, because } = BOUND_VOCABULARY[basis.bound];
  return `${word}, ${because}`;
}

interface DerivedConcurrency {
  readonly concurrency: number;
  readonly state: ConcurrencyState;
  /** The limit the count came out of. */
  readonly bound: ConcurrencyBound;
  /** True when the projected peak, not the work shape, set the value. */
  readonly memoryCapped: boolean;
  /**
   * True when the count was actually checked against a projection. False is the
   * ruled unguarded run — no budget was named, or the set carries no rows to
   * project from — and it is the difference between a count memory admitted and
   * a count nothing examined.
   */
  readonly memoryGuarded: boolean;
  /**
   * What {@link projectedPeakKb} priced the admitted count at — the figure the
   * budget was compared against, and the only figure a reader can name for it.
   * Undefined exactly where nothing examined the count.
   *
   * Carried out of the descent rather than re-derived by whoever reports it: a
   * second reading of the ladder is a second implementation of the pricing
   * rule, and the two disagree the next time that rule changes. Nothing on
   * record need hold this figure — a count between two rungs is priced on the
   * line joining them — so a reader may not describe it as a peak some run
   * reached.
   */
  readonly projectedPeakKb: number | undefined;
}

/**
 * The share of the run's open lane-time that actually held work. Below 1 means
 * lanes sat idle, which is the signal that the run asked for more than its work
 * could fill.
 */
export function laneUtilization(observation: RunObservation): number {
  const laneMs = observation.makespanMs * observation.concurrency;
  if (laneMs <= 0) return 0;
  return observation.sumWallMs / laneMs;
}

/**
 * The one wall a task stands on: the median of the walls retained for it, so
 * that no single pathological reading — a killed child, a swap storm, a machine
 * busy with something else — decides on its own what the next run opens. A
 * median converges on a repeated real cost rather than filtering it, so a task
 * that is genuinely slow every run reads as slow.
 *
 * Two walls median to their mean, which is the definition rather than a guard:
 * half an outlier's excess still reaches the answer. Three is where a real
 * measurement sits between the extremes and the guard begins.
 *
 * Undefined for a task nobody has timed, which is the answer every caller here
 * already knows how to stand in for.
 */
function medianWallMs(task: PoolTaskEstimate): number | undefined {
  const walls = task.wallsMs ?? [];
  const sorted = walls.toSorted((a, b) => a - b);
  const low = sorted[(sorted.length - 1) >> 1];
  const high = sorted[sorted.length >> 1];
  if (low === undefined || high === undefined) return undefined;
  return (low + high) / 2;
}

/** Release order: never-measured first, then walls descending, names ascending. */
export function scheduleOrder(tasks: readonly PoolTaskEstimate[]): string[] {
  return [...tasks]
    .toSorted((a, b) => {
      const wallA = medianWallMs(a) ?? Number.POSITIVE_INFINITY;
      const wallB = medianWallMs(b) ?? Number.POSITIVE_INFINITY;
      if (wallA !== wallB) return wallB - wallA;
      return a.name.localeCompare(b.name);
    })
    .map((task) => task.name);
}

/**
 * The load of one lane of a heap of them, or infinity where the index names no
 * lane — so a child past the end of the heap never wins a comparison against
 * one inside it, and the sift below needs no bounds test of its own.
 */
function laneLoadMs(loads: readonly number[], index: number): number {
  return loads[index] ?? Number.POSITIVE_INFINITY;
}

/**
 * Put a lane back into the heap at its new load, the root having just been
 * taken. The heap is the lane loads, lightest at the root, which is the lane
 * longest-processing-time hands the next unit to.
 */
function settleLane(loads: number[], loadMs: number): void {
  let index = 0;
  for (;;) {
    const left = 2 * index + 1;
    const right = left + 1;
    const lighter = laneLoadMs(loads, right) < laneLoadMs(loads, left) ? right : left;
    if (laneLoadMs(loads, lighter) >= loadMs) break;
    loads[index] = laneLoadMs(loads, lighter);
    index = lighter;
  }
  loads[index] = loadMs;
}

/** One unit and the interval it occupied a lane for, in wall time from the start. */
export interface LanePlacement<Unit> {
  readonly unit: Unit;
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * Where a set of units lands on a given number of lanes, scheduled the way the
 * pool actually releases: units longest first, each into the lane that frees
 * soonest. One placement per unit, in the order they were released in, so a
 * caller that needs more about a unit than its wall reads it off the placement
 * rather than pairing the two back up by position.
 *
 * The caller hands them over already in release order — {@link scheduleOrder}'s,
 * which is what `scripts/turbo-pool.ts` releases packages in and what
 * `scripts/lib/vitest/lpt-sequencer.ts` orders test files by. For lint and
 * typecheck that order is the mechanism. For the consolidated vitest run it is
 * close but not exact: that run's file sequencer orders by longest processing
 * time too, but off vitest's own results cache rather than these walls, and it
 * puts previously-failed files first. The failed-first rule is deliberately not
 * modelled — it is a property of the last run's outcome, not of the work about
 * to run.
 *
 * Which lane a unit lands in is not reported, because nothing needs it and
 * reporting it would pin a tie-break the heap does not owe anyone: where two
 * lanes free at the same instant the intervals are the same either way and only
 * the identity of the lane differs. What a caller does with the placements — a
 * makespan, the memory held at an instant, the units running at one — follows
 * from the intervals alone.
 */
export function placeInLanes<Unit>(
  unitsLongestFirst: readonly Unit[],
  wallMsOf: (unit: Unit) => number,
  lanes: number
): LanePlacement<Unit>[] {
  const loads = Array.from({ length: lanes }, () => 0);
  return unitsLongestFirst.map((unit) => {
    const startMs = laneLoadMs(loads, 0);
    const endMs = startMs + wallMsOf(unit);
    settleLane(loads, endMs);
    return { unit, startMs, endMs };
  });
}

/** How long a set of walls takes on a given number of lanes. */
function scheduledMakespanMs(wallsMsDescending: readonly number[], lanes: number): number {
  let makespanMs = 0;
  for (const { endMs } of placeInLanes(wallsMsDescending, (wallMs) => wallMs, lanes)) {
    if (endMs > makespanMs) makespanMs = endMs;
  }
  return makespanMs;
}

/**
 * The wall every task in a set stands on: the one {@link medianWallMs} derives
 * from its own history, or — for a task nobody has timed — the largest wall any
 * task in that set stands on. Charged that, an unmeasured task fills the lane
 * the floor is set by and so is given one of its own rather than buried behind
 * others. Undefined where none of them has ever been measured, which is the set
 * nothing here can schedule.
 */
function chargedWallsMs(tasks: readonly PoolTaskEstimate[]): number[] | undefined {
  const medians = tasks.map((task) => medianWallMs(task));
  const known: number[] = [];
  for (const median of medians) {
    if (median !== undefined) known.push(median);
  }
  if (known.length === 0) return undefined;
  const assumed = Math.max(...known);
  return medians.map((median) => median ?? assumed);
}

/**
 * The fewest lanes at which a set of tasks reaches its shortest run, each task
 * standing on the wall {@link chargedWallsMs} charges it.
 *
 * The lane counts are compared by what each would actually take
 * ({@link scheduledMakespanMs}), and the smallest reaching the shortest is
 * taken. A rule comparing summed wall against longest wall — the least count at
 * which a perfect packing *could* finish inside the longest unit's wall —
 * refuses lanes that genuinely finish sooner, because a count at which such a
 * packing could exist is not a count at which one does: eight units of 10 to
 * 13.5 seconds sum to 94 against a longest of 13.5, so that rule answers 7,
 * where 7 lanes for 8 units force a pairing of 20.5 seconds against 13.5 at
 * eight lanes. Near-equal walls are the ordinary shape of a package's test
 * files, so that is not a corner.
 *
 * Two facts keep the comparison to a handful of candidates rather than one per
 * lane count. The shortest run any count reaches is the longest single wall:
 * no schedule finishes before the lane holding that unit does, and a lane per
 * unit reaches exactly it — so the minimum is known before any candidate is
 * scheduled, and the search is for the first count to reach it rather than for
 * the best of a table. And no count below `summed ÷ longest` can reach it,
 * since some lane must then hold more than the longest wall — so the old rule's
 * answer survives as the first candidate worth scheduling, and every candidate
 * below it is skipped rather than computed.
 *
 * Scale-invariant, which is what lets it settle on a machine that is never
 * idle: stretching every wall by the same factor stretches every candidate's
 * makespan and the floor by that factor, leaving the count unmoved. Walls
 * measured under different amounts of contention sit in one map all the same,
 * uncorrected, for the reason this module's header gives.
 */
export function workBoundFromWalls(tasks: readonly PoolTaskEstimate[]): number | undefined {
  const walls = chargedWallsMs(tasks);
  if (walls === undefined) return undefined;
  let sum = 0;
  let longest = 0;
  for (const wall of walls) {
    sum += wall;
    if (wall > longest) longest = wall;
  }
  if (longest <= 0) return 1;
  const descending = walls.toSorted((a, b) => b - a);
  const first = Math.max(1, Math.ceil(sum / longest));
  for (let lanes = first; lanes < descending.length; lanes += 1) {
    // Never below the floor, so this is equality; written as a comparison
    // because these walls are medians, and a median of two is a half.
    if (scheduledMakespanMs(descending, lanes) <= longest) return lanes;
  }
  // A lane per unit reaches the floor by construction, so the last candidate
  // is answered rather than scheduled.
  return descending.length;
}

interface DeriveConcurrencyOptions {
  /** The tasks this run will execute, carrying whatever walls are on record. */
  readonly tasks: readonly PoolTaskEstimate[];
  /** Completed runs, oldest first; consulted only for the memory projection. */
  readonly observations: readonly RunObservation[];
  /** The machine ceiling — real cores where detectable. */
  readonly maxConcurrency: number;
  /** Memory the run's peak must fit into; omit to skip the projection. */
  readonly memoryBudgetKb?: number | undefined;
}

/**
 * A task set nothing has named, at the size a run would open lanes for:
 * never-measured entries, so a caller with no list of its own reaches its answer
 * from the same shape of input a first real run hands the derivation, and
 * invents no wall. Deriving over an empty set answers a different question and
 * returns a single lane, which would read as "this will run serially".
 */
export function unknownTaskSet(size: number): PoolTaskEstimate[] {
  return Array.from({ length: Math.max(1, size) }, (_, index) => ({
    name: `unknown-${String(index + 1)}`,
  }));
}

/**
 * One width of the ladder: the worst whole-tree peak any retained row recorded
 * with that many lanes live.
 */
export interface LadderRung {
  /** Lanes live when the peak was recorded. */
  readonly lanes: number;
  /** The worst total peak recorded at this width, baseline included. */
  readonly peakRssKb: number;
  /**
   * What the run holding {@link LadderRung.peakRssKb} held outside its own
   * lanes. Read only for the narrowest rung, where it is where the line below
   * that rung lands at zero lanes.
   */
  readonly fixedRssKb: number;
  /** Retained rows filed at this width, whether or not they set the rung. */
  readonly rows: number;
}

/** One more row filed at a width the ladder may already hold: the worse peak stands. */
function worstRung(standing: LadderRung | undefined, arriving: LadderRung): LadderRung {
  if (standing === undefined) return arriving;
  const worse = arriving.peakRssKb > standing.peakRssKb ? arriving : standing;
  return {
    lanes: arriving.lanes,
    peakRssKb: worse.peakRssKb,
    fixedRssKb: worse.fixedRssKb,
    rows: standing.rows + 1,
  };
}

/**
 * What every width on record has held, narrowest first.
 *
 * A row prices nothing unless it carries all three of a peak, a baseline and
 * the lanes that were live when the peak was set. The width is the
 * load-bearing one — a peak with no width is evidence about no width, and
 * filing it at a guessed one would move every count above the guess. No row is
 * rejected for anything else — thin, short, small and single-unit runs are all
 * evidence at the width they ran.
 */
export function memoryLadder(observations: readonly RunObservation[]): LadderRung[] {
  const byWidth = new Map<number, LadderRung>();
  for (const observation of observations) {
    const { peakRssKb, fixedRssKb, lanesAtPeak } = observation;
    if (peakRssKb === undefined || fixedRssKb === undefined) continue;
    if (lanesAtPeak === undefined || lanesAtPeak < 1) continue;
    const alone: LadderRung = { lanes: lanesAtPeak, peakRssKb, fixedRssKb, rows: 1 };
    byWidth.set(lanesAtPeak, worstRung(byWidth.get(lanesAtPeak), alone));
  }
  return [...byWidth.values()].toSorted((a, b) => a.lanes - b.lanes);
}

/**
 * What a lane count is projected to hold, over a ladder known to carry a rung.
 *
 * The rungs are read as a rising staircase — each width standing at the worst
 * figure it or any narrower width recorded, so a narrow run that held more
 * goes on pricing every wider count — and a count between two of them is
 * priced on the straight line joining them. Below the narrowest rung that line
 * runs down to the baseline of the run that set it, which is what a run holds
 * with no lane of its own. Above the widest rung there is no second point to
 * draw through, so the figure stands flat.
 *
 * A figure taken off a line is one no run held, which is the price of leaving
 * no count unpriced: holding the lower rung flat priced a count between two
 * widths as though widening to it cost nothing, and it is the counts nothing
 * priced at all — everything below the narrowest rung — that were admitted
 * unguarded. The line is never under the staircase it replaces, so it is never
 * the looser bound, and on a curve that rises with lanes it is a lower bound
 * throughout.
 *
 * A recorder samples a run's baseline and its tree peak independently, so a
 * row can carry a baseline above its own peak; the line below the narrowest
 * rung would then fall as lanes rise, and the descent that walks a count down
 * is a correct search only while the projection does not.
 */
function pricedPeakKb(
  ladder: readonly LadderRung[],
  narrowest: LadderRung,
  concurrency: number
): number {
  let lanes = 0;
  let heldKb = Math.min(narrowest.fixedRssKb, narrowest.peakRssKb);
  for (const rung of ladder) {
    const rungKb = Math.max(heldKb, rung.peakRssKb);
    if (rung.lanes >= concurrency) {
      const climbedKb = ((rungKb - heldKb) * (concurrency - lanes)) / (rung.lanes - lanes);
      return Math.round(heldKb + climbedKb);
    }
    lanes = rung.lanes;
    heldKb = rungKb;
  }
  return heldKb;
}

/**
 * What a lane count is projected to hold, as {@link pricedPeakKb} prices it.
 *
 * Undefined only for a ladder with no rung on it at all, which is a machine
 * that has recorded nothing the projection can read — every count a ladder
 * carrying one rung can be asked about is priced.
 */
export function projectedPeakKb(
  ladder: readonly LadderRung[],
  concurrency: number
): number | undefined {
  const narrowest = ladder[0];
  return narrowest === undefined ? undefined : pricedPeakKb(ladder, narrowest, concurrency);
}

interface BindingBoundInput {
  /** The work bound the set's walls describe; undefined where none carries one. */
  readonly fromWork: number | undefined;
  readonly ceiling: number;
  readonly memoryCapped: boolean;
  readonly memoryGuarded: boolean;
}

/**
 * Which limit the count came out of, decided where the three are compared
 * rather than reconstructed afterwards from the answer.
 *
 * A work bound equal to the ceiling is named for the walls: the ceiling is
 * named only where it lowered what the walls asked for, so the word tracks
 * which limit constrained the count rather than which one it happens to equal.
 */
function bindingBound(input: BindingBoundInput): ConcurrencyBound {
  if (input.memoryCapped) return 'memory';
  if (input.fromWork === undefined) return input.memoryGuarded ? 'ceiling' : 'unmeasured';
  return input.fromWork > input.ceiling ? 'ceiling' : 'work';
}

interface MemoryAdmission {
  /** The count the projection admitted, at or below the one it was handed. */
  readonly concurrency: number;
  readonly memoryCapped: boolean;
  readonly memoryGuarded: boolean;
  /** {@link DerivedConcurrency.projectedPeakKb}. */
  readonly projectedPeakKb: number | undefined;
}

interface MemoryAdmissionInput {
  /** The count the work shape asked for, which the projection may only lower. */
  readonly target: number;
  readonly ladder: readonly LadderRung[];
  readonly memoryBudgetKb: number | undefined;
}

/**
 * The lanes the projection admits: lanes come off the count the work asked for
 * while the highest rung at that count or below overruns the budget, and the
 * descent stops at one lane.
 *
 * Every count a ladder carrying a rung can be asked about is priced, so the
 * descent runs to a single lane rather than stopping at a width no row stands
 * at. A run the projection cannot examine at all — no budget named, or no row
 * carrying a rung — keeps the count it was handed and reports that nothing
 * examined it, which is a different thing from a count a projection admitted.
 */
function admitToMemory(input: MemoryAdmissionInput): MemoryAdmission {
  const { target, ladder, memoryBudgetKb } = input;
  const narrowest = ladder[0];
  if (memoryBudgetKb === undefined || narrowest === undefined) {
    return {
      concurrency: target,
      memoryCapped: false,
      memoryGuarded: false,
      projectedPeakKb: undefined,
    };
  }
  let concurrency = target;
  let memoryCapped = false;
  // The figure the descent stopped on travels out with the count, so that what
  // a reader names the count as checked against is the figure that was checked.
  let projectedPeakKb = pricedPeakKb(ladder, narrowest, concurrency);
  while (concurrency > 1 && projectedPeakKb > memoryBudgetKb) {
    concurrency -= 1;
    projectedPeakKb = pricedPeakKb(ladder, narrowest, concurrency);
    memoryCapped = true;
  }
  return { concurrency, memoryCapped, memoryGuarded: true, projectedPeakKb };
}

export function deriveConcurrency(options: DeriveConcurrencyOptions): DerivedConcurrency {
  const { tasks, observations, maxConcurrency, memoryBudgetKb } = options;
  if (tasks.length === 0) {
    return {
      concurrency: 1,
      state: 'cold-start',
      bound: 'unmeasured',
      memoryCapped: false,
      memoryGuarded: false,
      projectedPeakKb: undefined,
    };
  }

  const ceiling = Math.max(1, Math.min(Math.max(1, maxConcurrency), tasks.length));
  // A machine with nothing timed opens the ceiling rather than guessing a work
  // shape, and a set with no peaks on record is not lowered from there at all:
  // that run is the unguarded one, and it reports itself as such.
  const fromWork = workBoundFromWalls(tasks);
  const state: ConcurrencyState = fromWork === undefined ? 'cold-start' : 'derived';

  const target = fromWork === undefined ? ceiling : Math.max(1, Math.min(fromWork, ceiling));
  const { concurrency, memoryCapped, memoryGuarded, projectedPeakKb } = admitToMemory({
    target,
    ladder: memoryLadder(observations),
    memoryBudgetKb,
  });

  return {
    concurrency,
    state,
    bound: bindingBound({ fromWork, ceiling, memoryCapped, memoryGuarded }),
    memoryCapped,
    memoryGuarded,
    projectedPeakKb,
  };
}
