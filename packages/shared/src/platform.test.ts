import { describe, it, expect } from 'vitest';
import {
  isPaymentDisabledPlatform,
  VALID_PLATFORMS,
  MOBILE_PLATFORMS,
  type Platform,
  type MobilePlatform,
} from './platform.js';

describe('isPaymentDisabledPlatform', () => {
  it('returns true for ios', () => {
    expect(isPaymentDisabledPlatform('ios')).toBe(true);
  });

  it('returns true for android', () => {
    expect(isPaymentDisabledPlatform('android')).toBe(true);
  });

  it('returns false for web', () => {
    expect(isPaymentDisabledPlatform('web')).toBe(false);
  });

  it('returns false for android-direct', () => {
    expect(isPaymentDisabledPlatform('android-direct')).toBe(false);
  });
});

describe('VALID_PLATFORMS', () => {
  it('contains all expected platform values', () => {
    expect(VALID_PLATFORMS).toEqual(['web', 'ios', 'android', 'android-direct']);
  });

  it('is readonly', () => {
    const platforms: readonly string[] = VALID_PLATFORMS;
    expect(platforms).toHaveLength(4);
  });
});

describe('Platform type', () => {
  it('accepts all valid platform values', () => {
    const platforms: Platform[] = [...VALID_PLATFORMS];
    expect(platforms).toHaveLength(4);
  });
});

describe('MOBILE_PLATFORMS', () => {
  it('contains all VALID_PLATFORMS except web', () => {
    expect(MOBILE_PLATFORMS).toEqual(VALID_PLATFORMS.filter((p) => p !== 'web'));
  });

  it('does not include web', () => {
    expect(MOBILE_PLATFORMS).not.toContain('web');
  });
});

describe('MobilePlatform type', () => {
  it('accepts all mobile platform values', () => {
    const platforms: MobilePlatform[] = [...MOBILE_PLATFORMS];
    expect(platforms).toHaveLength(MOBILE_PLATFORMS.length);
  });
});
