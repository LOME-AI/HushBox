import { describe, it, expect } from 'vitest';

import { MOBILE_BREAKPOINT, isMobileWidth } from './mobile.js';

describe('MOBILE_BREAKPOINT', () => {
  it('is 768 (Tailwind md: breakpoint)', () => {
    expect(MOBILE_BREAKPOINT).toBe(768);
  });
});

describe('isMobileWidth', () => {
  it('returns true for width below breakpoint', () => {
    expect(isMobileWidth(767)).toBe(true);
    expect(isMobileWidth(320)).toBe(true);
    expect(isMobileWidth(0)).toBe(true);
  });

  it('returns false for width at breakpoint', () => {
    expect(isMobileWidth(768)).toBe(false);
  });

  it('returns false for width above breakpoint', () => {
    expect(isMobileWidth(769)).toBe(false);
    expect(isMobileWidth(1920)).toBe(false);
  });
});
