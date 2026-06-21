import { describe, it, expect, vi } from 'vitest';
import { isRetryableStatus, backoffCeilingMs, retryOnTransientStatus } from './retry.js';

describe('isRetryableStatus', () => {
  it('treats request-timeout, rate-limit, and any 5xx as transient', () => {
    for (const status of [408, 429, 500, 502, 503, 504, 599]) {
      expect(isRetryableStatus(status)).toBe(true);
    }
  });

  it('treats 2xx/3xx and 4xx other than 408/429 as terminal', () => {
    for (const status of [200, 201, 204, 304, 400, 401, 403, 404, 409, 422]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });
});

describe('backoffCeilingMs', () => {
  it('doubles the ceiling per attempt', () => {
    expect(backoffCeilingMs(1)).toBe(backoffCeilingMs(0) * 2);
    expect(backoffCeilingMs(2)).toBe(backoffCeilingMs(0) * 4);
  });

  it('caps the ceiling at 10s', () => {
    expect(backoffCeilingMs(20)).toBe(10_000);
  });
});

describe('retryOnTransientStatus', () => {
  const withStatus = (status: number): { status: number } => ({ status });
  const getStatus = (result: { status: number }): number => result.status;
  const resolved = (): Promise<void> => Promise.resolve();

  it('returns the first response when it is already terminal', async () => {
    const send = vi.fn((): Promise<{ status: number }> => Promise.resolve(withStatus(200)));
    const sleep = vi.fn(resolved);
    const result = await retryOnTransientStatus(send, getStatus, {
      timeoutMs: 1000,
      sleep,
      now: () => 0,
    });
    expect(result.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries while the status is transient then returns the first terminal response', async () => {
    const statuses = [503, 503, 200];
    let index = 0;
    const send = vi.fn(
      (): Promise<{ status: number }> => Promise.resolve(withStatus(statuses[index++]!))
    );
    const result = await retryOnTransientStatus(send, getStatus, {
      timeoutMs: 60_000,
      sleep: resolved,
      now: () => 0,
    });
    expect(result.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('sleeps the backoff schedule between attempts', async () => {
    const statuses = [503, 503, 200];
    let index = 0;
    const send = (): Promise<{ status: number }> => Promise.resolve(withStatus(statuses[index++]!));
    const delays: number[] = [];
    const sleep = (ms: number): Promise<void> => {
      delays.push(ms);
      return Promise.resolve();
    };
    await retryOnTransientStatus(send, getStatus, { timeoutMs: 60_000, sleep, now: () => 0 });
    expect(delays).toEqual([backoffCeilingMs(0), backoffCeilingMs(1)]);
  });

  it('stops at the time budget and returns the last transient response', async () => {
    let clock = 0;
    const send = vi.fn((): Promise<{ status: number }> => Promise.resolve(withStatus(503)));
    const sleep = (): Promise<void> => {
      clock += 1000;
      return Promise.resolve();
    };
    const result = await retryOnTransientStatus(send, getStatus, {
      timeoutMs: 2500,
      sleep,
      now: () => clock,
    });
    expect(result.status).toBe(503);
    expect(send).toHaveBeenCalledTimes(4);
  });
});
