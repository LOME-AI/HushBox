import { describe, it, expect } from 'vitest';

import { mixSrgb } from './mix-srgb';

describe('mixSrgb', () => {
  it('returns the top colour when the fraction is 1', () => {
    expect(mixSrgb('#1d4364', '#ffffff', 1)).toBe('#1d4364');
  });

  it('returns the bottom colour when the fraction is 0', () => {
    expect(mixSrgb('#1d4364', '#ffffff', 0)).toBe('#ffffff');
  });

  it('interpolates each channel independently on the gamma-encoded channels', () => {
    expect(mixSrgb('#ff0000', '#0000ff', 0.25)).toBe('#4000bf');
  });

  it('rounds a half-way channel to the nearer 8-bit value', () => {
    expect(mixSrgb('#000000', '#ffffff', 0.5)).toBe('#808080');
  });

  it('accepts every notation the shared colour parser accepts', () => {
    expect(mixSrgb('hsl(0 0% 0%)', '#ffffff', 0.5)).toBe('#808080');
  });
});
