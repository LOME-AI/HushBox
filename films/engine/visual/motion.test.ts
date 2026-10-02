import { describe, expect, it } from 'vitest';

import { logZoom } from './motion.js';

describe('logZoom', () => {
  it('holds the start zoom before from', () => {
    expect(logZoom(9, 10, 20, [1.1, 1.3])).toBe(1.1);
  });

  it('is exactly the start zoom on from', () => {
    expect(logZoom(10, 10, 20, [1.1, 1.3])).toBe(1.1);
  });

  it('is exactly the end zoom on to', () => {
    expect(logZoom(20, 10, 20, [1.1, 1.3])).toBe(1.3);
  });

  it('holds the end zoom after to', () => {
    expect(logZoom(21, 10, 20, [1.1, 1.3])).toBe(1.3);
  });

  it('passes the geometric mean at the midpoint, a constant perceived speed', () => {
    expect(logZoom(15, 10, 20, [1, 4])).toBeCloseTo(2, 12);
  });

  it('grows on every frame of a push', () => {
    const zooms = Array.from({ length: 11 }, (_, step) => logZoom(10 + step, 10, 20, [1, 2]));
    expect(zooms.every((zoom, step) => step === 0 || zoom > (zooms[step - 1] ?? zoom))).toBe(true);
  });

  it('accepts the smallest positive zoom', () => {
    expect(logZoom(0, 10, 20, [Number.MIN_VALUE, 1])).toBe(Number.MIN_VALUE);
  });

  it('accepts the smallest positive end zoom', () => {
    expect(logZoom(20, 10, 20, [1, Number.MIN_VALUE])).toBe(Number.MIN_VALUE);
  });

  it('accepts a span of one frame', () => {
    expect(logZoom(11, 10, 11, [1, 2])).toBe(2);
  });

  it('refuses a start zoom of zero', () => {
    expect(() => logZoom(0, 10, 20, [0, 1])).toThrow(/zoom 0 to 1/);
  });

  it('refuses an end zoom of zero', () => {
    expect(() => logZoom(0, 10, 20, [1, 0])).toThrow(/zoom 1 to 0/);
  });

  it('refuses a span that holds no frames', () => {
    expect(() => logZoom(10, 10, 10, [1, 2])).toThrow(/holds no frames/);
  });
});
