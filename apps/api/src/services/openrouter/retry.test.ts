import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { retryWithBackoff, isProviderError } from './retry.js';

describe('retryWithBackoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns result on first success', async () => {
    const function_ = vi.fn().mockResolvedValue('ok');

    const result = await retryWithBackoff(function_);

    expect(result).toBe('ok');
    expect(function_).toHaveBeenCalledTimes(1);
  });

  it('retries and succeeds on subsequent attempt', async () => {
    const function_ = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce('recovered');

    const promise = retryWithBackoff(function_);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result).toBe('recovered');
    expect(function_).toHaveBeenCalledTimes(2);
  });

  it('throws after max attempts exhausted', async () => {
    const function_ = vi.fn().mockRejectedValue(new Error('persistent'));

    const promise = retryWithBackoff(function_, { maxAttempts: 2 });
    // Attach rejection handler before advancing timers to prevent unhandled rejection
    const assertion = expect(promise).rejects.toThrow('persistent');

    await vi.advanceTimersByTimeAsync(1000);
    await assertion;

    expect(function_).toHaveBeenCalledTimes(2);
  });

  it('uses exponential backoff capped at maxDelayMs', async () => {
    const function_ = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockRejectedValueOnce(new Error('fail 3'))
      .mockResolvedValueOnce('ok');

    const promise = retryWithBackoff(function_, {
      maxAttempts: 4,
      initialDelayMs: 1000,
      maxDelayMs: 4000,
    });

    // First retry: 1000ms
    await vi.advanceTimersByTimeAsync(999);
    expect(function_).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(function_).toHaveBeenCalledTimes(2);

    // Second retry: 2000ms
    await vi.advanceTimersByTimeAsync(1999);
    expect(function_).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(function_).toHaveBeenCalledTimes(3);

    // Third retry: capped at 4000ms (not 4000ms from 1000*2^2)
    await vi.advanceTimersByTimeAsync(3999);
    expect(function_).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);

    const result = await promise;
    expect(result).toBe('ok');
    expect(function_).toHaveBeenCalledTimes(4);
  });

  it('skips retry when shouldRetry returns false', async () => {
    const function_ = vi.fn().mockRejectedValue(new Error('non-retryable'));

    await expect(
      retryWithBackoff(function_, {
        maxAttempts: 3,
        shouldRetry: () => false,
      })
    ).rejects.toThrow('non-retryable');

    expect(function_).toHaveBeenCalledTimes(1);
  });

  it('retries all errors by default', async () => {
    const function_ = vi
      .fn()
      .mockRejectedValueOnce(new Error('any error'))
      .mockResolvedValueOnce('ok');

    const promise = retryWithBackoff(function_);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result).toBe('ok');
    expect(function_).toHaveBeenCalledTimes(2);
  });
});

describe('isProviderError', () => {
  it('returns true for OpenRouter error messages', () => {
    expect(isProviderError(new Error('OpenRouter error: Provider returned error'))).toBe(true);
    expect(isProviderError(new Error('OpenRouter error: rate limited'))).toBe(true);
  });

  it('returns false for non-OpenRouter errors', () => {
    expect(isProviderError(new Error('Network timeout'))).toBe(false);
    expect(isProviderError(new Error('Model not found'))).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isProviderError('string error')).toBe(false);
    expect(isProviderError(null)).toBe(false);
    expect(isProviderError(void 0)).toBe(false);
  });
});
