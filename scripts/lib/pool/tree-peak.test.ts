import { describe, expect, it } from 'vitest';

import { foldTreePeak } from './tree-peak.js';

import type { AttributedTreePssKb } from './memory.js';

/** One attributed reading, in the shape the sampler hands back. */
function reading(rootsKb: Record<number, number>, remainderKb?: number): AttributedTreePssKb {
  return {
    rootsKb: new Map(Object.entries(rootsKb).map(([pid, kb]) => [Number(pid), kb])),
    remainderKb,
  };
}

describe('foldTreePeak', () => {
  it('adds one reading up over the lanes it was taken across', () => {
    const fold = foldTreePeak();
    expect(fold.fold(reading({ 7: 900, 8: 500 }, 100), [7, 8])).toBe(1500);
  });

  it('charges nothing for a lane the reading says nothing about', () => {
    const fold = foldTreePeak();
    expect(fold.fold(reading({ 7: 900 }, 100), [7, 8])).toBe(1000);
  });

  it('charges nothing for a subtree no lane was named for', () => {
    const fold = foldTreePeak();
    expect(fold.fold(reading({ 7: 900 }, 100), [])).toBe(100);
  });

  it('answers with nothing at all where the reading read nothing', () => {
    const fold = foldTreePeak();
    expect(fold.fold(reading({}), [7])).toBeUndefined();
  });

  it('keeps the largest reading taken outside every lane as the fixed cost', () => {
    const fold = foldTreePeak();
    fold.fold(reading({}, 100), []);
    fold.fold(reading({}, 700), []);
    fold.fold(reading({}, 300), []);
    expect(fold.stop().fixedKb).toBe(700);
  });

  it('keeps no fixed cost from a reading that stated none', () => {
    const fold = foldTreePeak();
    fold.fold(reading({ 7: 900 }), [7]);
    expect(fold.stop().fixedKb).toBeUndefined();
  });

  it('keeps the largest total and the lanes that were live at it', () => {
    const fold = foldTreePeak();
    fold.fold(reading({ 7: 100, 8: 100 }), [7, 8]);
    fold.fold(reading({ 7: 900 }), [7]);
    fold.fold(reading({ 7: 50, 8: 50, 9: 50 }), [7, 8, 9]);
    expect(fold.stop()).toEqual({ peakKb: 900, lanesAtPeak: 1, fixedKb: undefined });
  });

  it('keeps the first of two readings that tied, which is the one it already had', () => {
    const fold = foldTreePeak();
    fold.fold(reading({ 7: 900 }), [7]);
    fold.fold(reading({ 7: 450, 8: 450 }), [7, 8]);
    expect(fold.stop().lanesAtPeak).toBe(1);
  });

  it('names no peak and no lanes before it has folded anything', () => {
    expect(foldTreePeak().stop()).toEqual({
      peakKb: undefined,
      lanesAtPeak: undefined,
      fixedKb: undefined,
    });
  });

  it('folds nothing once it has been stopped', () => {
    const fold = foldTreePeak();
    fold.fold(reading({ 7: 100 }, 10), [7]);
    fold.stop();
    fold.fold(reading({ 7: 900, 8: 900 }, 500), [7, 8]);
    expect(fold.stop()).toEqual({ peakKb: 110, lanesAtPeak: 1, fixedKb: 10 });
  });

  it('still answers a stopped reading with its own total, for the loop driving it', () => {
    const fold = foldTreePeak();
    fold.stop();
    expect(fold.fold(reading({ 7: 900 }, 100), [7])).toBe(1000);
  });

  it('reports what it had reached at the moment it was stopped', () => {
    const fold = foldTreePeak();
    fold.fold(reading({ 7: 100 }, 10), [7]);
    expect(fold.stop()).toEqual({ peakKb: 110, lanesAtPeak: 1, fixedKb: 10 });
  });
});
