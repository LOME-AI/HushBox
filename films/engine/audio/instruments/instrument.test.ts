import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createStereo } from '../dsp/index.js';

import { defineInstrument } from './instrument.js';

import type { Instrument, Rendered } from './instrument.js';

const SILENCE: Rendered = { buffer: createStereo(1), anchorOffset: 0 };
const params = z.object({ level: z.number() });

/** A definition that reports what it was handed. */
const echo: Instrument<z.output<typeof params>> = defineInstrument({
  params,
  percussive: false,
  render({ level }, { framesPerBeat }) {
    return { buffer: createStereo(level + framesPerBeat), anchorOffset: 0 };
  },
});

const silent: Instrument<z.output<typeof params>> = defineInstrument({
  params,
  percussive: false,
  render: () => SILENCE,
});

describe('defineInstrument', () => {
  it('keeps the definition’s schema', () => {
    expect(echo.params).toBe(params);
  });

  it.each([true, false])('keeps the definition’s percussive declaration, %s', (percussive) => {
    expect(defineInstrument({ params, percussive, render: () => SILENCE }).percussive).toBe(
      percussive
    );
  });

  it('hands the parameters and context to the definition', () => {
    const rendered = echo.render({ level: 2 }, { rand: () => 0, framesPerBeat: 3 });
    expect(rendered.buffer.left).toHaveLength(5);
  });

  it('accepts a tempo of one frame per beat', () => {
    expect(silent.render({ level: 0 }, { rand: () => 0, framesPerBeat: 1 })).toBe(SILENCE);
  });

  it.each([0, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses a tempo of %d frames per beat, naming it',
    (framesPerBeat) => {
      expect(() => silent.render({ level: 0 }, { rand: () => 0, framesPerBeat })).toThrow(
        /framesPerBeat must be a whole number of frames, at least one/
      );
    }
  );
});
