import { describe, it, expect } from 'vitest';

import { MOBILE_BREAKPOINT, isMobileWidth } from './mobile.js';

describe('MOBILE_BREAKPOINT', () => {
  it('is 768 (Tailwind md: breakpoint)', () => {
    expect(MOBILE_BREAKPOINT).toBe(768);
  });

  it('equals Tailwind --breakpoint-md (48rem) under the @media initial 16px base', () => {
    // Couples the TS constant to the literal 48rem used in two places:
    //   - packages/ui/src/components/accessibility/styles/typography.css
    //     (@media (width < 48rem) — drops root font-size to 100% on mobile)
    //   - Tailwind's default --breakpoint-md (md: utility variants).
    // rem in @media context resolves against the CSS initial value (16px),
    // not the document root, so 48 * 16 = 768 regardless of html font-size.
    // If anyone changes --breakpoint-md in @theme, update this — the failure
    // is the signal that useIsMobile and the CSS have drifted.
    const TAILWIND_BREAKPOINT_MD_REM = 48;
    const MEDIA_QUERY_REM_BASE_PX = 16;
    expect(MOBILE_BREAKPOINT).toBe(TAILWIND_BREAKPOINT_MD_REM * MEDIA_QUERY_REM_BASE_PX);
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
