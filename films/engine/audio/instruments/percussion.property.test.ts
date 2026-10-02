import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { clap } from './clap.js';
import { hat } from './hat.js';
import { firstOnset, renderWith } from './instrument-test-support.js';
import { kick } from './kick.js';
import { snare } from './snare.js';
import { tom } from './tom.js';

import type { Instrument } from './instrument.js';

/**
 * Each case renders a whole hit through a 4×-oversampled saturator, thousands of
 * times the work of a typical property case: at the shared pinned count the
 * heavier instruments here run past the runner's per-test timeout, so each
 * property runs 25 cases.
 */
const RUNS = { numRuns: 25 };

const hertz = (min: number, max: number): fc.Arbitrary<number> =>
  fc.double({ min, max, noNaN: true });
/**
 * Decays stop at 1 s to bound each render. A longer decay only slows a body's
 * fall over the first 32 samples, the most the saturator's filter reads to form
 * sample 0: by under 0.6% for the snare's shell, which rings for 0.4 of the
 * decay and so changes most between 1 s and its 2 s maximum.
 */
const decay = fc.double({ min: 0.05, max: 1, noNaN: true });

const PERCUSSION: readonly (readonly [string, Instrument, fc.Arbitrary<unknown>])[] = [
  [
    'kick',
    kick,
    fc.record({
      startHz: hertz(40, 1000),
      endHz: hertz(20, 200),
      decay,
      drive: fc.double({ min: 0.5, max: 8, noNaN: true }),
    }),
  ],
  ['snare', snare, fc.record({ toneHz: hertz(100, 500), decay })],
  ['clap', clap, fc.record({ toneHz: hertz(500, 4000), decay })],
  ['hat', hat, fc.record({ variant: fc.constantFrom('closed', 'open') })],
  ['tom', tom, fc.record({ toneHz: hertz(50, 400), decay })],
];

describe.each(PERCUSSION)('%s', (_name, instrument, parameters) => {
  it('is heard from its first sample for every seed and parameter set: fc.string() keys over fc.record parameters', () => {
    fc.assert(
      fc.property(fc.string(), parameters, (key, raw) => {
        expect(firstOnset(renderWith(instrument, raw, { key }).buffer)).toBe(0);
      }),
      RUNS
    );
  });
});
