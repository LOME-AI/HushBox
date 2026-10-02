import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { firstOnset, renderWith } from '../instrument-test-support.js';

import { carriageBell } from './carriage-bell.js';
import { crack } from './crack.js';
import { downlifter } from './downlifter.js';
import { glassShatter } from './glass-shatter.js';
import { heartbeat } from './heartbeat.js';
import { impact } from './impact.js';
import { matchStrike } from './match-strike.js';
import { pop } from './pop.js';
import { reverseSwell } from './reverse-swell.js';
import { riser } from './riser.js';
import { measuredAnchor } from './sfx-test-support.js';
import { snap } from './snap.js';
import { tick } from './tick.js';
import { typewriter } from './typewriter.js';
import { whoosh } from './whoosh.js';

import type { Instrument } from '../instrument.js';

/**
 * Each case renders a whole sound, some through a 4×-oversampled saturator or
 * dozens of layered rings, thousands of times the work of a typical property
 * case: at the shared pinned count the heavier sounds here run past the
 * runner's per-test timeout, so each property runs 25 cases.
 */
const RUNS = { numRuns: 25 };

const between = (min: number, max: number): fc.Arbitrary<number> =>
  fc.double({ min, max, noNaN: true });
/**
 * Lengths stop at 1 s, or 4 beats, to bound each render. A longer sound only
 * slows how its layers fall over the few samples its first and last samples
 * are formed from; the strike that makes those samples heard is the same. The
 * whoosh renders cheaply and runs to its longest.
 */
const upToOneSecond = (min: number): fc.Arbitrary<number> => between(min, 1);
const beats = fc.constantFrom(1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 1.5, 2, 3, 4);

const PERCUSSIVE: readonly (readonly [string, Instrument, fc.Arbitrary<unknown>])[] = [
  ['tick', tick, fc.record({ toneHz: between(1000, 6000), decay: between(0.003, 0.1) })],
  [
    'pop',
    pop,
    fc.record({ fromHz: between(100, 1000), octaves: between(0, 4), decay: between(0.01, 0.3) }),
  ],
  [
    'impact',
    impact,
    fc.record({
      decay: upToOneSecond(0.3),
      subHz: between(20, 60),
      drive: between(0.5, 8),
      metal: between(0, 1),
    }),
  ],
  [
    'heartbeat',
    heartbeat,
    fc.record({ toneHz: between(30, 120), gap: between(0.08, 0.5), decay: between(0.08, 0.6) }),
  ],
  ['matchStrike', matchStrike, fc.record({ seconds: upToOneSecond(0.3) })],
  ['typewriter', typewriter, fc.record({ toneHz: between(800, 4000), decay: between(0.02, 0.3) })],
  ['snap', snap, fc.record({ toneHz: between(800, 4000), decay: between(0.02, 0.3) })],
  [
    'glassShatter',
    glassShatter,
    fc.record({ decay: upToOneSecond(0.3), shards: fc.integer({ min: 8, max: 200 }) }),
  ],
  ['crack', crack, fc.record({ toneHz: between(500, 5000), decay: between(0.03, 0.8) })],
  [
    'carriageBell',
    carriageBell,
    fc.record({ toneHz: between(1000, 6000), decay: upToOneSecond(0.2) }),
  ],
  ['downlifter', downlifter, fc.record({ beats, octaves: between(1, 3) })],
];

const END_ANCHORED: readonly (readonly [string, Instrument, fc.Arbitrary<unknown>])[] = [
  ['riser', riser, fc.record({ beats, octaves: between(1, 3) })],
  ['reverseSwell', reverseSwell, fc.record({ beats })],
];

describe.each(PERCUSSIVE)('%s', (_name, instrument, parameters) => {
  it('is heard from its first sample for every seed and parameter set: fc.string() keys over fc.record parameters', () => {
    fc.assert(
      fc.property(fc.string(), parameters, (key, raw) => {
        expect(firstOnset(renderWith(instrument, raw, { key }).buffer)).toBe(0);
      }),
      RUNS
    );
  });
});

describe.each(END_ANCHORED)('%s', (_name, instrument, parameters) => {
  it('is heard on its last sample for every seed and parameter set: fc.string() keys over fc.record parameters', () => {
    fc.assert(
      fc.property(fc.string(), parameters, (key, raw) => {
        const { buffer } = renderWith(instrument, raw, { key });
        expect(measuredAnchor(buffer, 'end')).toBe(buffer.left.length);
      }),
      RUNS
    );
  });
});

describe('whoosh', () => {
  it('lands its cue on the same sample for every seed, never on its noise: fc.string() key pairs over fc.record parameters', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string(),
        fc.record({ seconds: between(0.1, 4), semitones: between(0, 12) }),
        (key, otherKey, raw) => {
          expect(renderWith(whoosh, raw, { key: otherKey }).anchorOffset).toBe(
            renderWith(whoosh, raw, { key }).anchorOffset
          );
        }
      ),
      RUNS
    );
  });
});
