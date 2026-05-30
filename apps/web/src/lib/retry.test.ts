import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiError } from './api.js';
import {
  isRetryableError,
  shouldRetry,
  shouldRetryMutation,
  computeRetryDelay,
  parseRetryAfterMs,
  MAX_RETRIES,
} from './retry.js';

describe('isRetryableError', () => {
  it('retries transient ApiError statuses (408, 429, 5xx)', () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(isRetryableError(new ApiError('X', status))).toBe(true);
    }
  });

  it('does not retry 4xx client errors', () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(isRetryableError(new ApiError('X', status))).toBe(false);
    }
  });

  it('retries network/transport failures (TypeError from fetch)', () => {
    expect(isRetryableError(new TypeError('Failed to fetch'))).toBe(true);
  });

  it('does not retry intentional cancellation (AbortError)', () => {
    expect(isRetryableError(new DOMException('aborted', 'AbortError'))).toBe(false);
  });

  it('does not retry unknown / non-transient errors', () => {
    expect(isRetryableError(new Error('boom'))).toBe(false);
    expect(isRetryableError('nope')).toBe(false);
    expect(isRetryableError(null)).toBe(false);
  });
});

describe('shouldRetry', () => {
  it('retries a transient error up to MAX_RETRIES (0-based failureCount)', () => {
    const error = new ApiError('X', 503);
    expect(shouldRetry(0, error)).toBe(true);
    expect(shouldRetry(MAX_RETRIES - 1, error)).toBe(true);
    expect(shouldRetry(MAX_RETRIES, error)).toBe(false);
  });

  it('never retries a non-transient error, even at failureCount 0', () => {
    expect(shouldRetry(0, new ApiError('X', 400))).toBe(false);
  });
});

describe('shouldRetryMutation', () => {
  it('retries network/no-response failures up to MAX_RETRIES', () => {
    const error = new TypeError('Failed to fetch');
    expect(shouldRetryMutation(0, error)).toBe(true);
    expect(shouldRetryMutation(MAX_RETRIES - 1, error)).toBe(true);
    expect(shouldRetryMutation(MAX_RETRIES, error)).toBe(false);
  });

  it('does NOT retry server responses (4xx or 5xx) — the write may have applied', () => {
    expect(shouldRetryMutation(0, new ApiError('INTERNAL', 500))).toBe(false);
    expect(shouldRetryMutation(0, new ApiError('RATE', 429))).toBe(false);
    expect(shouldRetryMutation(0, new ApiError('BAD', 400))).toBe(false);
  });

  it('does not retry intentional cancellation (AbortError)', () => {
    expect(shouldRetryMutation(0, new DOMException('aborted', 'AbortError'))).toBe(false);
  });
});

describe('computeRetryDelay', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses exponential backoff with full jitter (0-based failureCount)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(computeRetryDelay(0, new TypeError('x'))).toBe(250); // 0.5 * min(500*2^0, 10000)
    expect(computeRetryDelay(1, new TypeError('x'))).toBe(500); // 0.5 * min(500*2^1, 10000)
  });

  it('caps the backoff ceiling at 10s', () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    expect(computeRetryDelay(10, new TypeError('x'))).toBe(10_000);
  });

  it('returns a value within [0, ceiling]', () => {
    const delay = computeRetryDelay(0, new TypeError('x'));
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThanOrEqual(500);
  });

  it('honors Retry-After (capped at 30s), overriding backoff and jitter', () => {
    expect(computeRetryDelay(0, new ApiError('RATE', 429, undefined, 2000))).toBe(2000);
    expect(computeRetryDelay(0, new ApiError('RATE', 503, undefined, 60_000))).toBe(30_000);
  });
});

describe('parseRetryAfterMs', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('parses delta-seconds into milliseconds', () => {
    expect(parseRetryAfterMs('5')).toBe(5000);
    expect(parseRetryAfterMs('0')).toBe(0);
  });

  it('returns null for missing / empty / unparseable values', () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs('')).toBeNull();
    expect(parseRetryAfterMs('not-a-date')).toBeNull();
  });

  it('parses an HTTP-date into a non-negative delay', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    expect(parseRetryAfterMs('Thu, 01 Jan 2026 00:00:10 GMT')).toBe(10_000);
  });

  it('clamps a past HTTP-date to 0', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    expect(parseRetryAfterMs('Thu, 01 Jan 2026 00:00:00 GMT')).toBe(0);
  });
});
