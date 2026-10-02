import { describe, expect, it } from 'vitest';

import { pattern } from './pattern.js';

import type { Grid } from '../../time/grid.js';

const FOUR_FOUR: Grid = { framesPerBeat: 24, beatsPerBar: 4 };
const FOUR_ON_THE_FLOOR = 'x...x...x...x...';

function beatsOf(events: ReturnType<typeof pattern>): number[] {
  return events.map(({ at }) => ('beat' in at ? at.beat : Number.NaN));
}

describe('pattern', () => {
  it('puts a hit on every beat of a bar for four on the floor', () => {
    expect(beatsOf(pattern({ grid: FOUR_FOUR, bars: [0, 1], steps: FOUR_ON_THE_FLOOR }))).toEqual([
      0, 1, 2, 3,
    ]);
  });

  it('repeats the steps in every bar from the first bar up to, not including, the last', () => {
    expect(beatsOf(pattern({ grid: FOUR_FOUR, bars: [2, 4], steps: FOUR_ON_THE_FLOOR }))).toEqual([
      8, 9, 10, 11, 12, 13, 14, 15,
    ]);
  });

  it('divides the bar into sixteen equal steps', () => {
    expect(beatsOf(pattern({ grid: FOUR_FOUR, bars: [0, 1], steps: '.x.............x' }))).toEqual([
      0.25, 3.75,
    ]);
  });

  it('sizes each step by the grid’s bar, however many beats it holds', () => {
    const threeFour: Grid = { framesPerBeat: 24, beatsPerBar: 3 };
    expect(beatsOf(pattern({ grid: threeFour, bars: [1, 2], steps: 'x.......x.......' }))).toEqual([
      3, 4.5,
    ]);
  });

  it('gives every hit the same parameters', () => {
    const params = { variant: 'open' };
    const events = pattern({ grid: FOUR_FOUR, bars: [0, 1], steps: 'x.......x.......', params });
    expect(events.map((event) => event.params)).toEqual([params, params]);
  });

  it('leaves the parameters out when none are given', () => {
    const [event] = pattern({ grid: FOUR_FOUR, bars: [0, 1], steps: FOUR_ON_THE_FLOOR });
    expect(event).toEqual({ at: { beat: 0 } });
  });

  it('expands a bar of rests to no events', () => {
    expect(pattern({ grid: FOUR_FOUR, bars: [0, 8], steps: '................' })).toEqual([]);
  });

  it.each(['x...x...x...x..', 'x...x...x...x....'])(
    'refuses steps that are not sixteen long: %s',
    (steps) => {
      expect(() => pattern({ grid: FOUR_FOUR, bars: [0, 1], steps })).toThrow(
        `pattern ${JSON.stringify(steps)}: holds ${String(steps.length)} steps, not 16`
      );
    }
  );

  it.each([
    ['X', 'x...X...x...x...', 4],
    ['-', 'x...x...x..-x...', 11],
  ])('refuses a step that is neither x nor .: %s', (character, steps, position) => {
    expect(() => pattern({ grid: FOUR_FOUR, bars: [0, 1], steps })).toThrow(
      `step ${String(position)} is "${character}"`
    );
  });

  it('accepts bar 0 as the first bar', () => {
    expect(pattern({ grid: FOUR_FOUR, bars: [0, 1], steps: FOUR_ON_THE_FLOOR })).toHaveLength(4);
  });

  it('accepts a range of one bar', () => {
    expect(pattern({ grid: FOUR_FOUR, bars: [5, 6], steps: FOUR_ON_THE_FLOOR })).toHaveLength(4);
  });

  it.each([
    [[-1, 1]],
    [[0.5, 1]],
    [[Number.NaN, 1]],
    [[0, Number.NaN]],
    [[0, 1.5]],
    [[Number.POSITIVE_INFINITY, 1]],
  ] as const)('refuses bars %j that are not whole bars from 0', (bars) => {
    expect(() => pattern({ grid: FOUR_FOUR, bars, steps: FOUR_ON_THE_FLOOR })).toThrow(
      /bars must be whole bar numbers, 0 or more/
    );
  });

  it('refuses a range whose last bar does not come after its first', () => {
    expect(() => pattern({ grid: FOUR_FOUR, bars: [3, 3], steps: FOUR_ON_THE_FLOOR })).toThrow(
      /bars \[3, 3\) hold no bar/
    );
  });

  it.each([0, 1.5, Number.NaN])('refuses a grid of %s beats per bar', (beatsPerBar) => {
    expect(() =>
      pattern({ grid: { framesPerBeat: 24, beatsPerBar }, bars: [0, 1], steps: FOUR_ON_THE_FLOOR })
    ).toThrow(/beatsPerBar must be a whole number of beats, at least one/);
  });
  it('starts bar 0 on the start beat', () => {
    expect(
      beatsOf(pattern({ grid: FOUR_FOUR, bars: [0, 2], steps: 'x.......x.......', startBeat: 10 }))
    ).toEqual([10, 12, 14, 16]);
  });

  it('accepts a start beat of 0, the film’s first beat', () => {
    expect(
      beatsOf(pattern({ grid: FOUR_FOUR, bars: [0, 1], steps: FOUR_ON_THE_FLOOR, startBeat: 0 }))
    ).toEqual([0, 1, 2, 3]);
  });

  it.each([-Number.MIN_VALUE, -0.25, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses a start beat of %s',
    (startBeat) => {
      expect(() =>
        pattern({ grid: FOUR_FOUR, bars: [0, 1], steps: FOUR_ON_THE_FLOOR, startBeat })
      ).toThrow(/startBeat must be a finite beat, 0 or more/);
    }
  );

  it('plays the list from the first bar, cycling', () => {
    const events = pattern({
      grid: FOUR_FOUR,
      bars: [1, 4],
      steps: [{ steps: 'x...............' }, { steps: '........x.......' }],
    });
    expect(beatsOf(events)).toEqual([4, 10, 12]);
  });

  it('accepts a list of one bar', () => {
    const events = pattern({
      grid: FOUR_FOUR,
      bars: [0, 2],
      steps: [{ steps: FOUR_ON_THE_FLOOR }],
    });
    expect(events).toHaveLength(8);
  });

  it('refuses an empty list', () => {
    expect(() => pattern({ grid: FOUR_FOUR, bars: [0, 1], steps: [] })).toThrow(
      /holds no bar of steps/
    );
  });

  it.each(['x...x...x...x..', 'x...x...x...x....'])(
    'refuses a listed bar whose steps are not sixteen long: %s',
    (steps) => {
      expect(() =>
        pattern({
          grid: FOUR_FOUR,
          bars: [0, 1],
          steps: [{ steps: FOUR_ON_THE_FLOOR }, { steps }],
        })
      ).toThrow(`pattern ${JSON.stringify(steps)}: holds ${String(steps.length)} steps, not 16`);
    }
  );

  it('refuses a listed bar with a step that is neither x nor .', () => {
    expect(() =>
      pattern({ grid: FOUR_FOUR, bars: [0, 1], steps: [{ steps: 'x...x...x..-x...' }] })
    ).toThrow('step 11 is "-"');
  });

  it('gives each hit its own parameters, in step order', () => {
    const events = pattern({
      grid: FOUR_FOUR,
      bars: [0, 1],
      steps: [{ steps: 'x.......x.......', params: [{ note: 1 }, { note: 2 }] }],
    });
    expect(events).toEqual([
      { at: { beat: 0 }, params: { note: 1 } },
      { at: { beat: 2 }, params: { note: 2 } },
    ]);
  });

  it('gives the shared parameters to a listed bar that names none', () => {
    const params = { variant: 'open' };
    const events = pattern({
      grid: FOUR_FOUR,
      bars: [0, 1],
      steps: [{ steps: 'x...............' }],
      params,
    });
    expect(events).toEqual([{ at: { beat: 0 }, params }]);
  });

  it.each([[[{ note: 1 }]], [[{ note: 1 }, { note: 2 }, { note: 3 }]]])(
    'refuses parameters that do not match the bar’s hits one for one: %j',
    (params) => {
      expect(() =>
        pattern({ grid: FOUR_FOUR, bars: [0, 1], steps: [{ steps: 'x.......x.......', params }] })
      ).toThrow(`names ${String(params.length)} parameter sets for 2 hits`);
    }
  );

  it('refuses per-hit parameters beside shared ones', () => {
    expect(() =>
      pattern({
        grid: FOUR_FOUR,
        bars: [0, 1],
        steps: [{ steps: 'x...............', params: [{ note: 1 }] }],
        params: { note: 2 },
      })
    ).toThrow(/gives parameters both per hit and for every hit/);
  });
});
