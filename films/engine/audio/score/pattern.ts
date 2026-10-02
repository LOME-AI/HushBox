import type { Grid } from '../../time/grid.js';
import type { ScoreEvent } from './schema.js';

/** Steps in a bar: sixteenths in four-four. */
const STEPS_PER_BAR = 16;
const HIT = 'x';
const REST = '.';

/** One bar of a pattern: sixteen steps and, optionally, one parameter set per hit in step order. */
interface PatternBar {
  steps: string;
  params?: readonly unknown[];
}

export interface PatternOptions {
  /** The film's grid: a bar is its `beatsPerBar` beats. */
  grid: Grid;
  /** The first bar and the bar the pattern stops before, counted from bar 0. */
  bars: readonly [number, number];
  /**
   * Sixteen steps per bar: `x` a hit, `.` a rest. A list of bars cycles, its
   * first entry played on the first bar.
   */
  steps: string | readonly PatternBar[];
  /** The parameters every hit carries, where its bar names none of its own. */
  params?: unknown;
  /** The beat bar 0 starts on; the film's first beat when omitted. */
  startBeat?: number;
}

function refusal(steps: string, detail: string): RangeError {
  return new RangeError(`pattern ${JSON.stringify(steps)}: ${detail}`);
}

function checkSteps(steps: string): void {
  if (steps.length !== STEPS_PER_BAR) {
    throw refusal(steps, `holds ${String(steps.length)} steps, not ${String(STEPS_PER_BAR)}`);
  }
  for (let position = 0; position < steps.length; position++) {
    const character = steps.charAt(position);
    if (character !== HIT && character !== REST) {
      throw refusal(
        steps,
        `step ${String(position)} is ${JSON.stringify(character)}, neither "${HIT}" (a hit) nor "${REST}" (a rest)`
      );
    }
  }
}

function checkBars(steps: string, [first, stop]: readonly [number, number]): void {
  if (!(Number.isSafeInteger(first) && first >= 0 && Number.isSafeInteger(stop) && stop >= 0)) {
    throw refusal(
      steps,
      `bars must be whole bar numbers, 0 or more, got [${String(first)}, ${String(stop)})`
    );
  }
  if (stop <= first) {
    throw refusal(steps, `bars [${String(first)}, ${String(stop)}) hold no bar`);
  }
}

/** The steps of a checked pattern that hold a hit. */
function hitSteps(steps: string): number[] {
  const hits: number[] = [];
  for (let step = 0; step < STEPS_PER_BAR; step++) {
    if (steps.charAt(step) === HIT) {
      hits.push(step);
    }
  }
  return hits;
}

function checkStartBeat(steps: string, startBeat: number): void {
  if (!(Number.isFinite(startBeat) && startBeat >= 0)) {
    throw refusal(steps, `startBeat must be a finite beat, 0 or more, got ${String(startBeat)}`);
  }
}

/** A bar of the pattern, checked: its steps, the steps it hits, and its own per-hit parameters or null. */
interface CheckedBar {
  steps: string;
  hits: number[];
  params: readonly unknown[] | null;
}

/** Every bar of the pattern, checked, as its steps and the parameters each hit carries. */
function checkedBars(options: PatternOptions): CheckedBar[] {
  const list = typeof options.steps === 'string' ? [{ steps: options.steps }] : options.steps;
  if (list.length === 0) {
    throw new RangeError('pattern: holds no bar of steps');
  }
  return list.map(({ steps, params }) => {
    checkSteps(steps);
    const hits = hitSteps(steps);
    if (params === undefined) {
      return { steps, hits, params: null };
    }
    if (options.params !== undefined) {
      throw refusal(steps, 'gives parameters both per hit and for every hit');
    }
    if (params.length !== hits.length) {
      throw refusal(
        steps,
        `names ${String(params.length)} parameter sets for ${String(hits.length)} hits`
      );
    }
    return { steps, hits, params };
  });
}

/** Every hit of the checked bars across the range, each listed bar on its own turn of the cycle. */
function hitsOf(
  list: readonly CheckedBar[],
  {
    bars,
    beatsPerBar,
    startBeat,
    params: shared,
  }: { bars: readonly [number, number]; beatsPerBar: number; startBeat: number; params?: unknown }
): { beat: number; params: unknown }[] {
  const found: { beat: number; params: unknown }[] = [];
  for (const [position, { hits, params }] of list.entries()) {
    for (let bar = bars[0] + position; bar < bars[1]; bar += list.length) {
      for (const [index, step] of hits.entries()) {
        found.push({
          beat: startBeat + bar * beatsPerBar + (step * beatsPerBar) / STEPS_PER_BAR,
          params: params === null ? shared : params[index],
        });
      }
    }
  }
  return found;
}

/**
 * Events for a step pattern repeated over a range of bars: a hit on each `x`,
 * at the beat its step falls on. Each step is a sixteenth of the grid's bar, so
 * in four-four a step is a sixteenth note. Bars count from `startBeat`, so a
 * pattern can start on any beat, mid-bar included; a list of bars cycles from
 * the first bar.
 */
export function pattern(options: PatternOptions): ScoreEvent[] {
  const list = checkedBars(options);
  const label = list.map(({ steps }) => steps).join(' ');
  const { beatsPerBar } = options.grid;
  if (!(Number.isSafeInteger(beatsPerBar) && beatsPerBar >= 1)) {
    throw refusal(
      label,
      `beatsPerBar must be a whole number of beats, at least one, got ${String(beatsPerBar)}`
    );
  }
  checkBars(label, options.bars);
  const startBeat = options.startBeat ?? 0;
  checkStartBeat(label, startBeat);
  return hitsOf(list, { ...options, beatsPerBar, startBeat })
    .toSorted((a, b) => a.beat - b.beat)
    .map(({ beat, params }) =>
      params === undefined ? { at: { beat } } : { at: { beat }, params }
    );
}
