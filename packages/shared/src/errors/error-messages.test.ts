import { describe, it, expect } from 'vitest';
import {
  customUserMessage,
  formatLockoutMessage,
  rateLimitedMessage,
  retryAfterSecondsOf,
} from './error-messages.ts';

describe('formatLockoutMessage', () => {
  it('formats sub-minute lockouts as seconds', () => {
    expect(formatLockoutMessage(1)).toBe('Too many attempts. Try again in 1 second.');
    expect(formatLockoutMessage(45)).toBe('Too many attempts. Try again in 45 seconds.');
    expect(formatLockoutMessage(59)).toBe('Too many attempts. Try again in 59 seconds.');
  });

  it('formats sub-hour lockouts as minutes, rounding up', () => {
    expect(formatLockoutMessage(60)).toBe('Too many attempts. Try again in 1 minute.');
    expect(formatLockoutMessage(61)).toBe('Too many attempts. Try again in 2 minutes.');
    expect(formatLockoutMessage(120)).toBe('Too many attempts. Try again in 2 minutes.');
    expect(formatLockoutMessage(3599)).toBe('Too many attempts. Try again in 60 minutes.');
  });

  it('formats >=1h lockouts as hours, rounding up', () => {
    expect(formatLockoutMessage(3600)).toBe('Too many attempts. Try again in 1 hour.');
    expect(formatLockoutMessage(3601)).toBe('Too many attempts. Try again in 2 hours.');
    expect(formatLockoutMessage(7200)).toBe('Too many attempts. Try again in 2 hours.');
    expect(formatLockoutMessage(24 * 60 * 60)).toBe('Too many attempts. Try again in 24 hours.');
  });

  it('falls back for non-positive inputs', () => {
    expect(formatLockoutMessage(0)).toBe('Too many attempts. Try again in a moment.');
    expect(formatLockoutMessage(-5)).toBe('Too many attempts. Try again in a moment.');
  });

  it('falls back for non-finite inputs', () => {
    expect(formatLockoutMessage(Number.NaN)).toBe('Too many attempts. Try again in a moment.');
    expect(formatLockoutMessage(Number.POSITIVE_INFINITY)).toBe(
      'Too many attempts. Try again in a moment.'
    );
  });
});

describe('customUserMessage', () => {
  it('returns the input string unchanged', () => {
    const result = customUserMessage('Custom error message for the user.');
    expect(result).toBe('Custom error message for the user.');
  });

  it('preserves markdown in custom messages', () => {
    const result = customUserMessage('Please [sign up](/signup) to continue.');
    expect(result).toBe('Please [sign up](/signup) to continue.');
  });
});

describe('rateLimitedMessage', () => {
  it('names the wait in seconds when the refusal carries one', () => {
    expect(rateLimitedMessage(3)).toBe('Too many attempts. Try again in 3 seconds.');
  });

  it('names a one-second wait in the singular', () => {
    expect(rateLimitedMessage(1)).toBe('Too many attempts. Try again in 1 second.');
  });

  it('names a wait past a minute in minutes, rounding up', () => {
    expect(rateLimitedMessage(90)).toBe('Too many attempts. Try again in 2 minutes.');
  });

  it('says "in a moment" when the refusal carries no wait', () => {
    expect(rateLimitedMessage()).toBe('Too many attempts. Try again in a moment.');
  });

  it('says "in a moment" for a wait that is not a positive number', () => {
    expect(rateLimitedMessage(0)).toBe('Too many attempts. Try again in a moment.');
    expect(rateLimitedMessage(-1)).toBe('Too many attempts. Try again in a moment.');
    expect(rateLimitedMessage(Number.NaN)).toBe('Too many attempts. Try again in a moment.');
  });
});

describe('retryAfterSecondsOf', () => {
  it('reads the wait a refusal carries in its details', () => {
    expect(retryAfterSecondsOf({ retryAfterSeconds: 3 })).toBe(3);
  });

  it('reads no wait from details that carry none', () => {
    expect(retryAfterSecondsOf({})).toBeUndefined();
  });

  it('reads no wait from absent details', () => {
    let missing: unknown;
    expect(retryAfterSecondsOf(null)).toBeUndefined();
    expect(retryAfterSecondsOf(missing)).toBeUndefined();
  });

  it('reads no wait from a value that is not a number', () => {
    expect(retryAfterSecondsOf({ retryAfterSeconds: '3' })).toBeUndefined();
  });

  it('reads no wait from a number that is not a positive finite wait', () => {
    expect(retryAfterSecondsOf({ retryAfterSeconds: 0 })).toBeUndefined();
    expect(retryAfterSecondsOf({ retryAfterSeconds: -5 })).toBeUndefined();
    expect(retryAfterSecondsOf({ retryAfterSeconds: Number.NaN })).toBeUndefined();
    expect(retryAfterSecondsOf({ retryAfterSeconds: Number.POSITIVE_INFINITY })).toBeUndefined();
  });
});
