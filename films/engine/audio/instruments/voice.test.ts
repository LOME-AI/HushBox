import { describe, expect, it } from 'vitest';

import { SAMPLES_PER_FRAME, SAMPLE_RATE } from '../../time/grid.js';
import { createStereo, saw, sine } from '../dsp/index.js';

import {
  add,
  anchoredAtStart,
  beatsToSamples,
  freeRunning,
  gate,
  impulse,
  midiToHz,
  mono,
  multiply,
  secondsToSamples,
  swing,
} from './voice.js';

/** A frequency whose cycle is exactly 100 samples. */
const HUNDRED_SAMPLE_CYCLE = SAMPLE_RATE / 100;

describe('midiToHz', () => {
  it('tunes note 69 to 440 Hz', () => {
    expect(midiToHz(69)).toBe(440);
  });

  it('doubles the frequency an octave up', () => {
    expect(midiToHz(81)).toBe(880);
  });

  it('halves the frequency an octave down', () => {
    expect(midiToHz(57)).toBe(220);
  });

  it('puts middle C on its equal-tempered frequency', () => {
    expect(midiToHz(60)).toBeCloseTo(261.625_565_300_598_6, 10);
  });
});

describe('beatsToSamples', () => {
  it('resolves a length in beats to the exact samples of its frames', () => {
    expect(beatsToSamples(1.5, 24)).toBe(1.5 * 24 * SAMPLES_PER_FRAME);
  });

  it('refuses a length that falls between samples', () => {
    expect(() => beatsToSamples(1 / 7, 24)).toThrow(/whole number of samples/);
  });

  it('refuses a length of NaN beats', () => {
    expect(() => beatsToSamples(Number.NaN, 24)).toThrow(/whole number of samples/);
  });

  it('refuses a tempo that leaves the note no samples', () => {
    expect(() => beatsToSamples(1, 0)).toThrow(/at least one/);
  });
});

describe('secondsToSamples', () => {
  it('counts the samples in a length in seconds', () => {
    expect(secondsToSamples(0.5)).toBe(SAMPLE_RATE / 2);
  });

  it('rounds to the nearest sample', () => {
    expect(secondsToSamples(0.123_457)).toBe(Math.round(0.123_457 * SAMPLE_RATE));
  });
});

describe('multiply', () => {
  it('multiplies two signals sample by sample', () => {
    expect([...multiply(new Float32Array([1, 2, 3]), new Float32Array([2, 3, 4]))]).toEqual([
      2, 6, 12,
    ]);
  });

  it('refuses a second signal one sample shorter than the first', () => {
    expect(() => multiply(new Float32Array(3), new Float32Array(2))).toThrow(
      /signals of 3 and 2 samples cannot be combined/
    );
  });

  it('refuses a second signal one sample longer than the first', () => {
    expect(() => multiply(new Float32Array(2), new Float32Array(3))).toThrow(
      /signals of 2 and 3 samples cannot be combined/
    );
  });
});

describe('add', () => {
  it('sums two signals sample by sample', () => {
    expect([...add(new Float32Array([1, 2]), new Float32Array([3, 4]))]).toEqual([4, 6]);
  });

  it('refuses a second signal one sample shorter than the first', () => {
    expect(() => add(new Float32Array(2), new Float32Array(1))).toThrow(
      /signals of 2 and 1 samples cannot be combined/
    );
  });

  it('refuses a second signal one sample longer than the first', () => {
    expect(() => add(new Float32Array(1), new Float32Array(2))).toThrow(
      /signals of 1 and 2 samples cannot be combined/
    );
  });
});

describe('impulse', () => {
  it('holds its height on the first sample and silence after', () => {
    expect([...impulse(4, 2)]).toEqual([2, 0, 0, 0]);
  });
});

describe('freeRunning', () => {
  it('returns the samples asked for', () => {
    const tone = freeRunning(
      sine,
      { frequency: HUNDRED_SAMPLE_CYCLE, samples: 10, leadHz: HUNDRED_SAMPLE_CYCLE },
      () => 0
    );
    expect(tone).toHaveLength(10);
  });

  it('starts at the phase its drawn value names', () => {
    const tone = freeRunning(
      sine,
      { frequency: HUNDRED_SAMPLE_CYCLE, samples: 1, leadHz: HUNDRED_SAMPLE_CYCLE },
      () => 0.25
    );
    expect(tone[0]).toBeCloseTo(1, 6);
  });

  it('starts at phase 0 when its drawn value is 0', () => {
    const tone = freeRunning(
      saw,
      { frequency: HUNDRED_SAMPLE_CYCLE, samples: 4, leadHz: HUNDRED_SAMPLE_CYCLE },
      () => 0
    );
    expect([...tone]).toEqual([...saw({ frequency: HUNDRED_SAMPLE_CYCLE, samples: 4 })]);
  });

  it('runs its lead at the lead frequency before following a per-sample control', () => {
    const frequency = new Float32Array(2).fill(HUNDRED_SAMPLE_CYCLE / 2);
    const tone = freeRunning(
      sine,
      { frequency, samples: 2, leadHz: HUNDRED_SAMPLE_CYCLE },
      () => 0.25
    );
    // A quarter cycle in at the lead frequency, then half a hundredth of a cycle per sample.
    expect(tone[0]).toBeCloseTo(1, 6);
    expect(tone[1]).toBeCloseTo(Math.sin(2 * Math.PI * 0.255), 6);
  });
});

describe('mono', () => {
  it('puts the same signal in both channels', () => {
    const buffer = mono(new Float32Array([0.5, -0.5]));
    expect([...buffer.left]).toEqual([0.5, -0.5]);
    expect([...buffer.right]).toEqual([0.5, -0.5]);
  });

  it('gives each channel its own storage', () => {
    const buffer = mono(new Float32Array([0.5]));
    buffer.left[0] = 0;
    expect(buffer.right[0]).toBe(0.5);
  });
});

describe('anchoredAtStart', () => {
  it('scales the loudest sample of either channel to full scale', () => {
    const rendered = anchoredAtStart({
      left: new Float32Array([0.25, -0.125]),
      right: new Float32Array([-0.5, 0]),
    });
    expect([...rendered.buffer.left]).toEqual([0.5, -0.25]);
    expect([...rendered.buffer.right]).toEqual([-1, 0]);
  });

  it('anchors the cue on the first sample', () => {
    expect(anchoredAtStart(mono(new Float32Array([0.5]))).anchorOffset).toBe(0);
  });

  it('leaves a silent buffer silent', () => {
    const rendered = anchoredAtStart(createStereo(3));
    expect([...rendered.buffer.left, ...rendered.buffer.right]).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe('gate', () => {
  it('rises over the attack, holds, and releases over the last samples of the note', () => {
    expect([...gate({ samples: 10, attack: 2, release: 4 })]).toEqual([
      0, 0.5, 1, 1, 1, 1, 1, 0.75, 0.5, 0.25,
    ]);
  });

  it('leaves an attack and release that exactly fill the note unscaled', () => {
    expect([...gate({ samples: 8, attack: 4, release: 4 })]).toEqual([
      0, 0.25, 0.5, 0.75, 1, 0.75, 0.5, 0.25,
    ]);
  });

  it('scales an attack and release one sample too long to fit, peaking where the attack ends', () => {
    expect([...gate({ samples: 8, attack: 5, release: 4 })]).toEqual([
      0, 0.25, 0.5, 0.75, 1, 0.75, 0.5, 0.25,
    ]);
  });

  it('scales an attack and release that overrun the note by one factor, with no hold', () => {
    expect([...gate({ samples: 8, attack: 6, release: 10 })]).toEqual([
      ...Float32Array.from([0, 1 / 3, 2 / 3, 1, 0.8, 0.6, 0.4, 0.2]),
    ]);
  });

  it('fits a release longer than the note inside the note', () => {
    expect([...gate({ samples: 4, attack: 0, release: 10 })]).toEqual([1, 0.75, 0.5, 0.25]);
  });
});

describe('swing', () => {
  const ramp = new Float32Array([1, 2, 3, 4, 5, 6]);

  it('passes the input unchanged under no excursion', () => {
    expect([...swing(ramp, new Float32Array(6))]).toEqual([...ramp]);
  });

  it('reads the input late under a positive excursion', () => {
    expect([...swing(ramp, new Float32Array(6).fill(2))]).toEqual([0, 0, 1, 2, 3, 4]);
  });

  it('reads the input early under a negative excursion', () => {
    expect([...swing(ramp, new Float32Array(6).fill(-2))]).toEqual([3, 4, 5, 6, 0, 0]);
  });

  it('reads between samples under a fractional excursion', () => {
    expect([...swing(ramp, new Float32Array(6).fill(0.5))]).toEqual([0.5, 1.5, 2.5, 3.5, 4.5, 5.5]);
  });

  it('refuses an excursion of a different length from the input', () => {
    expect(() => swing(ramp, new Float32Array(5))).toThrow(/5 values for 6 samples/);
  });
});
