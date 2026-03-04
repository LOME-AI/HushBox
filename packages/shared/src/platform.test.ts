import { describe, it, expect } from 'vitest';
import { isPaymentDisabledPlatform, VALID_PLATFORMS, type Platform } from './platform.js';

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
