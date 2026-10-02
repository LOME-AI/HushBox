import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createStereo } from '../dsp/index.js';

import { INSTRUMENTS } from './index.js';
import { defineInstrument } from './instrument.js';
import { TEST_FRAMES_PER_BEAT, firstOnset, renderWith } from './instrument-test-support.js';

import type { Instrument } from './instrument.js';

/**
 * Every corner of every percussive entry is a property of its own, and each
 * case renders a whole sound, the heaviest a glass shatter of two hundred
 * shards: at the shared pinned count the file would run for minutes. Each
 * corner runs five seeds instead. What puts these sounds on their anchor is the
 * strike on sample 0, which no seed moves; the drums' and the sounds' own
 * property tests run more seeds over the interiors of their parameters.
 */
const RUNS = { numRuns: 5 };

/**
 * The parameters that set a note's length. A longer note lengthens the tail
 * after the strike and moves sample 0 only through the peak it is normalized
 * by, a few decibels at most against a strike tens of decibels above the
 * threshold, so a corner takes each of these at its shortest legal value. A
 * length named otherwise is taken at both extremes, which costs time, not
 * correctness.
 */
const NOTE_LENGTHS: ReadonlySet<string> = new Set(['decay', 'seconds', 'beats']);

/**
 * The values a corner takes for one parameter: a note length's shortest legal
 * value, a number's two bounds, or every value of an enum.
 */
function extremes(key: string, field: unknown): readonly unknown[] {
  const inner = field instanceof z.ZodDefault ? field.unwrap() : field;
  if (inner instanceof z.ZodEnum) {
    return inner.options;
  }
  if (inner instanceof z.ZodNumber) {
    const { minValue, maxValue } = inner;
    if (Number.isFinite(minValue) && Number.isFinite(maxValue)) {
      return NOTE_LENGTHS.has(key) ? [minValue] : [minValue, maxValue];
    }
  }
  throw new TypeError(`parameter ${key} has no finite legal extremes to take a corner from`);
}

/** Every combination of each parameter's corner values. */
function corners(schema: unknown): Record<string, unknown>[] {
  if (!(schema instanceof z.ZodObject)) {
    throw new TypeError('corners are taken from an object schema of parameters');
  }
  let sets: Record<string, unknown>[] = [{}];
  for (const [key, field] of Object.entries(schema.shape)) {
    const values = extremes(key, field);
    sets = sets.flatMap((set) => values.map((value) => ({ ...set, [key]: value })));
  }
  return sets;
}

/** The onset contract at one parameter set, over seeds: the first sample above −60 dBFS falls on the anchor. */
function onsetOnAnchor(
  instrument: Instrument,
  raw: Record<string, unknown>
): fc.IPropertyWithHooks<[string]> {
  return fc.property(fc.string(), (key) => {
    const { buffer, anchorOffset } = renderWith(instrument, raw, {
      key,
      framesPerBeat: TEST_FRAMES_PER_BEAT,
    });
    expect(firstOnset(buffer)).toBe(anchorOffset);
  });
}

const controlParams = z.object({ level: z.number().min(0.5).max(1).default(1) });

/** A control declared percussive that is silent on its anchor and heard one sample after it. */
const lateStart: Instrument<z.output<typeof controlParams>> = defineInstrument({
  params: controlParams,
  percussive: true,
  render({ level }) {
    const buffer = createStereo(2);
    buffer.left[1] = level;
    buffer.right[1] = level;
    return { buffer, anchorOffset: 0 };
  },
});

describe('the onset contract', () => {
  it('takes a note length at its shortest and every other parameter at each extreme', () => {
    const schema = z.object({
      decay: z.number().min(0.05).max(4).default(1),
      level: z.number().min(0.5).max(1).default(1),
      variant: z.enum(['closed', 'open']),
    });
    expect(corners(schema)).toEqual([
      { decay: 0.05, level: 0.5, variant: 'closed' },
      { decay: 0.05, level: 0.5, variant: 'open' },
      { decay: 0.05, level: 1, variant: 'closed' },
      { decay: 0.05, level: 1, variant: 'open' },
    ]);
  });

  it.each(corners(lateStart.params))(
    'fails a control that starts one sample after its anchor, at %j: fc.string() keys',
    (raw) => {
      expect(fc.check(onsetOnAnchor(lateStart, raw), RUNS).failed).toBe(true);
    }
  );
});

const PERCUSSIVE = Object.entries(INSTRUMENTS).filter(([, instrument]) => instrument.percussive);

describe.each(PERCUSSIVE)('%s, declared percussive', (_name, instrument) => {
  it.each(corners(instrument.params))(
    'is first heard on its anchor at %j for every seed: fc.string() keys',
    (raw) => {
      fc.assert(onsetOnAnchor(instrument, raw), RUNS);
    }
  );
});
