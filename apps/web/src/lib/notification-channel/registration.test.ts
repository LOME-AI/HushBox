import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SECOND_MS, TEST_DAY_START } from '@hushbox/shared/test-time';
import { ApiError } from '@/lib/api/api';
import { sendRegistration } from './registration.js';

/** Longer than every retry delay the app-wide mutation policy can choose for three sends. */
const RETRIES_ELAPSED_MS = 20 * SECOND_MS;

function severedAfter(ms: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => {
      reject(new TypeError('Failed to fetch'));
    }, ms);
  });
}

describe('sendRegistration', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: TEST_DAY_START });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports success when the POST resolves', async () => {
    const post = vi.fn(() => Promise.resolve({ registered: true }));

    expect(await sendRegistration(post)).toBe('succeeded');
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('sends a severed connection three times in all before recording it retryable', async () => {
    const post = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));

    const outcome = sendRegistration(post);
    await vi.advanceTimersByTimeAsync(RETRIES_ELAPSED_MS);

    expect(await outcome).toBe('failed-retryable');
    expect(post).toHaveBeenCalledTimes(3);
  });

  it('re-issues a connection severed 15 s after the send', async () => {
    const post = vi
      .fn<() => Promise<unknown>>()
      .mockImplementationOnce(() => severedAfter(15 * SECOND_MS))
      .mockResolvedValueOnce({ registered: true });

    const outcome = sendRegistration(post);
    await vi.advanceTimersByTimeAsync(15 * SECOND_MS + RETRIES_ELAPSED_MS);

    expect(await outcome).toBe('succeeded');
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('stops re-issuing as soon as an attempt succeeds', async () => {
    const post = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ registered: true });

    const outcome = sendRegistration(post);
    await vi.advanceTimersByTimeAsync(RETRIES_ELAPSED_MS);

    expect(await outcome).toBe('succeeded');
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('records a token held by another account as terminal', async () => {
    const post = vi.fn(() => Promise.reject(new ApiError('CONFLICT', 409, undefined)));

    expect(await sendRegistration(post)).toBe('failed-terminal');
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('leaves a server error retryable without re-issuing it', async () => {
    const post = vi.fn(() => Promise.reject(new ApiError('INTERNAL', 503, undefined)));

    expect(await sendRegistration(post)).toBe('failed-retryable');
    expect(post).toHaveBeenCalledTimes(1);
  });
});
