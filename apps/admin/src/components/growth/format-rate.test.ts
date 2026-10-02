import { describe, expect, it } from 'vitest';
import { NO_RATE } from './absent-figure.js';
import { formatRate } from './format-rate.js';

describe('formatRate', () => {
  it('states an absent rate in the words every growth cell states one in', () => {
    expect(formatRate(null)).toBe(NO_RATE);
  });

  it('prints a rate of nought as a figure rather than as an absence', () => {
    expect(formatRate(0)).toBe('0.0%');
  });

  it('prints a whole rate as one hundred per cent', () => {
    expect(formatRate(1)).toBe('100.0%');
  });

  it('rounds a rate to one decimal of a per cent', () => {
    expect(formatRate(0.123_45)).toBe('12.3%');
  });

  it('prints a rate above the whole rather than capping it', () => {
    expect(formatRate(1.5)).toBe('150.0%');
  });
});
