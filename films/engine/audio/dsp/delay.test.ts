import { describe, expect, it } from 'vitest';

import { createDelayLine, feedbackDelay } from './delay.js';
import { nextAfter } from './dsp-test-support.js';

function impulse(length: number): Float32Array {
  const signal = new Float32Array(length);
  signal[0] = 1;
  return signal;
}

describe('createDelayLine', () => {
  it('taps the newest sample at a delay of 0', () => {
    const line = createDelayLine(4);
    line.write(0.25);
    line.write(0.5);
    expect(line.tap(0)).toBe(0.5);
  });

  it('taps a whole number of samples back', () => {
    const line = createDelayLine(4);
    for (const sample of [1, 2, 3, 4]) {
      line.write(sample);
    }
    expect([line.tap(1), line.tap(3)]).toEqual([3, 1]);
  });

  it('interpolates linearly between samples at a fractional delay', () => {
    const line = createDelayLine(4);
    line.write(1);
    line.write(3);
    expect(line.tap(0.25)).toBe(2.5);
  });

  it('holds silence where nothing has been written yet', () => {
    const line = createDelayLine(4);
    line.write(1);
    expect(line.tap(3)).toBe(0);
  });

  it('overwrites its oldest sample once full', () => {
    const line = createDelayLine(2);
    for (const sample of [1, 2, 3]) {
      line.write(sample);
    }
    expect([line.tap(0), line.tap(1)]).toEqual([3, 2]);
  });

  it('accepts a capacity of one sample', () => {
    expect(() => createDelayLine(1)).not.toThrow();
  });

  it('refuses a capacity of zero samples', () => {
    expect(() => createDelayLine(0)).toThrow('capacity must hold at least one sample, got 0');
  });

  it('accepts a tap at delay 0', () => {
    expect(() => createDelayLine(4).tap(0)).not.toThrow();
  });

  it('refuses a tap just below delay 0', () => {
    expect(() => createDelayLine(4).tap(-Number.MIN_VALUE)).toThrow(/delay must be in \[0, 3\]/);
  });

  it('accepts a tap at its oldest sample', () => {
    expect(() => createDelayLine(4).tap(3)).not.toThrow();
  });

  it('refuses a tap just past its oldest sample', () => {
    expect(() => createDelayLine(4).tap(nextAfter(3, 1))).toThrow(RangeError);
  });
});

describe('feedbackDelay', () => {
  it('delays by a whole number of samples', () => {
    expect([...feedbackDelay(impulse(6), { time: 3, feedback: 0 })]).toEqual([0, 0, 0, 1, 0, 0]);
  });

  it('feeds each echo back scaled by the feedback', () => {
    expect([...feedbackDelay(impulse(7), { time: 2, feedback: 0.5 })]).toEqual([
      0, 0, 1, 0, 0.5, 0, 0.25,
    ]);
  });

  it('splits an impulse across two samples at a fractional time', () => {
    expect([...feedbackDelay(impulse(5), { time: 2.5, feedback: 0 })]).toEqual([0, 0, 0.5, 0.5, 0]);
  });

  it('renders a per-sample time that holds one value exactly as that constant', () => {
    const input = impulse(16);
    const perSample = feedbackDelay(input, { time: new Float32Array(16).fill(3.5), feedback: 0.4 });
    expect(perSample).toEqual(feedbackDelay(input, { time: 3.5, feedback: 0.4 }));
  });

  it('names the sample whose per-sample time is out of range', () => {
    const time = new Float32Array([2, 2, 0.5]);
    expect(() => feedbackDelay(impulse(3), { time, feedback: 0 })).toThrow(
      'time[2] must be in [1, 3], got 0.5'
    );
  });

  it('accepts a time of one sample', () => {
    expect(() => feedbackDelay(impulse(4), { time: 1, feedback: 0 })).not.toThrow();
  });

  it('refuses a time just under one sample', () => {
    expect(() => feedbackDelay(impulse(4), { time: nextAfter(1, -1), feedback: 0 })).toThrow(
      /time must be in \[1, 4\]/
    );
  });

  it('accepts a time as long as the input', () => {
    expect(() => feedbackDelay(impulse(4), { time: 4, feedback: 0 })).not.toThrow();
  });

  it('refuses a time just longer than the input', () => {
    expect(() => feedbackDelay(impulse(4), { time: nextAfter(4, 1), feedback: 0 })).toThrow(
      RangeError
    );
  });

  it('accepts the feedback just above −1', () => {
    expect(() => feedbackDelay(impulse(4), { time: 1, feedback: nextAfter(-1, 1) })).not.toThrow();
  });

  it('refuses a feedback of −1, which would never decay', () => {
    expect(() => feedbackDelay(impulse(4), { time: 1, feedback: -1 })).toThrow(
      /feedback must be in \(-1, 1\)/
    );
  });

  it('accepts the feedback just below 1', () => {
    expect(() => feedbackDelay(impulse(4), { time: 1, feedback: nextAfter(1, -1) })).not.toThrow();
  });

  it('refuses a feedback of 1', () => {
    expect(() => feedbackDelay(impulse(4), { time: 1, feedback: 1 })).toThrow(RangeError);
  });

  it('accepts an empty input', () => {
    expect(
      feedbackDelay(new Float32Array(0), { time: new Float32Array(0), feedback: 0 })
    ).toHaveLength(0);
  });
});
