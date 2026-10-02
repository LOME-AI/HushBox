import { describe, it, expect } from 'vitest';
import { contextFillBand, isOverContextCapacity } from './capacity-band.ts';
import { CAPACITY_RED_THRESHOLD, CAPACITY_YELLOW_THRESHOLD } from './constants.ts';

describe('contextFillBand', () => {
  it('answers room to spare below the first threshold', () => {
    expect(contextFillBand(0)).toBe('room_to_spare');
  });

  it('enters filling up at the yellow threshold', () => {
    expect(contextFillBand(CAPACITY_YELLOW_THRESHOLD * 100)).toBe('filling_up');
  });

  it('stays in filling up in the fraction below the red threshold', () => {
    expect(contextFillBand(CAPACITY_RED_THRESHOLD * 100 - 0.4)).toBe('filling_up');
  });

  it('enters nearly full at the red threshold', () => {
    expect(contextFillBand(CAPACITY_RED_THRESHOLD * 100)).toBe('nearly_full');
  });

  it('stays nearly full past a full window', () => {
    expect(contextFillBand(150)).toBe('nearly_full');
  });
});

describe('isOverContextCapacity', () => {
  it('leaves a prompt that exactly fills the window inside capacity', () => {
    expect(isOverContextCapacity(100)).toBe(false);
  });

  it('is over capacity past a full window', () => {
    expect(isOverContextCapacity(150)).toBe(true);
  });

  // The fill a caller re-deriving the verdict off the rounded percent the meter
  // displays would answer differently: it reads "100% filled" and is over.
  it('is over capacity in the fraction just past a full window', () => {
    expect(isOverContextCapacity(100.4)).toBe(true);
  });

  it('leaves a fill below a full window inside capacity', () => {
    expect(isOverContextCapacity(99.6)).toBe(false);
  });
});
