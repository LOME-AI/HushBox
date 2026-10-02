import { describe, expect, it } from 'vitest';

import { SAMPLE_RATE } from '../../../time/grid.js';
import { risingCrossings } from '../instrument-test-support.js';

import {
  crestSine,
  decorrelated,
  normalized,
  placedAt,
  scaled,
  scattered,
  underEnvelope,
} from './layer.js';

describe('scaled', () => {
  it('multiplies every sample by the level', () => {
    expect([...scaled(new Float32Array([1, -0.5, 0.25]), 0.5)]).toEqual([0.5, -0.25, 0.125]);
  });
});

describe('placedAt', () => {
  it('starts the signal at the given sample of a silent signal', () => {
    expect([...placedAt(new Float32Array([1, 2]), 1, 4)]).toEqual([0, 1, 2, 0]);
  });

  it('drops whatever falls past the end', () => {
    expect([...placedAt(new Float32Array([1, 2, 3]), 2, 4)]).toEqual([0, 0, 1, 2]);
  });

  it('keeps nothing of a signal placed at or past the end', () => {
    expect([...placedAt(new Float32Array([1, 2]), 4, 4)]).toEqual([0, 0, 0, 0]);
  });
});

describe('normalized', () => {
  it('scales the loudest magnitude to 1', () => {
    expect([...normalized(new Float32Array([0.25, -0.5, 0.125]))]).toEqual([0.5, -1, 0.25]);
  });

  it('leaves a silent signal silent', () => {
    expect([...normalized(new Float32Array(3))]).toEqual([0, 0, 0]);
  });
});

describe('crestSine', () => {
  it.each([100, 3000, 6000])('starts a %d Hz sine within 45° of its crest', (hertz) => {
    const tone = crestSine({ frequency: hertz, samples: 16 });
    expect(tone[0]).toBeGreaterThanOrEqual(Math.SQRT1_2);
  });

  it('holds a steady frequency', () => {
    const tone = crestSine({ frequency: 100, samples: SAMPLE_RATE });
    expect(risingCrossings(tone)).toBe(100);
  });

  it('follows a frequency given per sample, starting at the crest of its first value', () => {
    const frequency = new Float32Array(SAMPLE_RATE)
      .fill(200, 0, SAMPLE_RATE / 2)
      .fill(400, SAMPLE_RATE / 2);
    const tone = crestSine({ frequency, samples: SAMPLE_RATE });
    expect(tone[0]).toBeGreaterThanOrEqual(Math.SQRT1_2);
    expect(risingCrossings(tone)).toBe(300);
  });
});

describe('decorrelated', () => {
  it('renders each channel by its own call', () => {
    let calls = 0;
    const buffer = decorrelated(() => new Float32Array([++calls]));
    expect([...buffer.left, ...buffer.right]).toEqual([1, 2]);
  });
});

describe('scattered', () => {
  it('mixes each grain in at its sample and its place in the field', () => {
    const buffer = scattered(
      [
        { at: 1, signal: new Float32Array([1]), pan: -1 },
        { at: 2, signal: new Float32Array([1]), pan: 1 },
      ],
      4
    );
    expect([...buffer.left, ...buffer.right]).toEqual([0, 1, 0, 0, 0, 0, 1, 0]);
  });

  it('drops whatever of a grain falls past the end', () => {
    const buffer = scattered([{ at: 3, signal: new Float32Array([1, 1, 1]), pan: -1 }], 4);
    expect([...buffer.left]).toEqual([0, 0, 0, 1]);
  });
});

describe('underEnvelope', () => {
  it('multiplies both channels by the envelope', () => {
    const buffer = underEnvelope(
      { left: new Float32Array([1, 2]), right: new Float32Array([3, 4]) },
      new Float32Array([0.5, 0.25])
    );
    expect([...buffer.left, ...buffer.right]).toEqual([0.5, 0.5, 1.5, 1]);
  });
});
