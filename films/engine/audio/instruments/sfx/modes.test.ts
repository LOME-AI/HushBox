import { describe, expect, it } from 'vitest';

import { SAMPLE_RATE } from '../../../time/grid.js';
import { goertzelPower } from '../../dsp/dsp-test-support.js';

import { modalRing } from './modes.js';

import type { Mode } from './modes.js';

/** A tenth of a second: whole cycles of every multiple of 10 Hz. */
const WINDOW = SAMPLE_RATE / 10;

describe('modalRing', () => {
  it('rings at each mode’s ratio to the fundamental', () => {
    const modes: Mode[] = [
      { ratio: 1, level: 1, decayShare: 1 },
      { ratio: 2.5, level: 1, decayShare: 1 },
    ];
    const ring = modalRing({ hertz: 400, samples: WINDOW, t60: 10, modes });
    const window = { from: 0, length: WINDOW };
    const between = goertzelPower(ring, 700, window);
    expect(goertzelPower(ring, 400, window)).toBeGreaterThan(between * 1000);
    expect(goertzelPower(ring, 1000, window)).toBeGreaterThan(between * 1000);
  });

  it('scales each mode by its level', () => {
    const quiet = modalRing({
      hertz: 400,
      samples: WINDOW,
      t60: 10,
      modes: [{ ratio: 1, level: 0.5, decayShare: 1 }],
    });
    const loud = modalRing({
      hertz: 400,
      samples: WINDOW,
      t60: 10,
      modes: [{ ratio: 1, level: 1, decayShare: 1 }],
    });
    expect([...quiet]).toEqual([...loud].map((sample) => Math.fround(sample * 0.5)));
  });

  it('lets a mode with a smaller decay share die sooner', () => {
    const modes: Mode[] = [
      { ratio: 1, level: 1, decayShare: 1 },
      { ratio: 3, level: 1, decayShare: 0.1 },
    ];
    const ring = modalRing({ hertz: 400, samples: SAMPLE_RATE, t60: 1, modes });
    const late = { from: SAMPLE_RATE / 2, length: WINDOW };
    expect(goertzelPower(ring, 400, late)).toBeGreaterThan(goertzelPower(ring, 1200, late) * 1000);
  });

  it('leaves out a mode that would ring at 20 kHz or above', () => {
    const fundamental: Mode = { ratio: 1, level: 1, decayShare: 1 };
    const withHigh = modalRing({
      hertz: 10_000,
      samples: WINDOW,
      t60: 1,
      modes: [fundamental, { ratio: 2, level: 1, decayShare: 1 }],
    });
    const without = modalRing({ hertz: 10_000, samples: WINDOW, t60: 1, modes: [fundamental] });
    expect([...withHigh]).toEqual([...without]);
  });

  it('starts silent, as a struck resonator does', () => {
    const ring = modalRing({
      hertz: 400,
      samples: 8,
      t60: 1,
      modes: [{ ratio: 1, level: 1, decayShare: 1 }],
    });
    expect(ring[0]).toBe(0);
  });
});
