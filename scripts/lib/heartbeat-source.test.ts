import { describe, it, expect, vi } from 'vitest';
import {
  createHeartbeatTicker,
  isApiRequestLogLine,
  HEARTBEAT_TICK_BUCKET_MS,
} from './heartbeat-source.js';

describe('isApiRequestLogLine', () => {
  it('matches the [req] prefix emitted by apps/api request-log middleware', () => {
    expect(isApiRequestLogLine('[req] 2026-05-29T01:00:00Z GET /api/health 200 5ms v=none')).toBe(
      true
    );
  });

  it('does not match unrelated lines', () => {
    expect(isApiRequestLogLine('[wrangler:info] Ready on http://localhost:8787')).toBe(false);
    expect(isApiRequestLogLine('')).toBe(false);
    expect(isApiRequestLogLine('req] missing-bracket')).toBe(false);
  });
});

describe('createHeartbeatTicker', () => {
  it('returns an async function that calls touchHeartbeat once when invoked', async () => {
    const touch = vi.fn(async () => {});
    const now = vi.fn().mockReturnValue(0);
    const ticker = createHeartbeatTicker({ heartbeatPath: '/x/heartbeat', touch, now });
    await ticker();
    expect(touch).toHaveBeenCalledWith('/x/heartbeat');
  });

  it('buckets consecutive ticks to once per HEARTBEAT_TICK_BUCKET_MS', async () => {
    const touch = vi.fn(async () => {});
    let t = 0;
    const ticker = createHeartbeatTicker({
      heartbeatPath: '/x/heartbeat',
      touch,
      now: () => t,
    });
    await ticker(); // t=0 → touched
    t = HEARTBEAT_TICK_BUCKET_MS - 1;
    await ticker(); // within bucket → skipped
    t = HEARTBEAT_TICK_BUCKET_MS;
    await ticker(); // bucket boundary → touched
    expect(touch).toHaveBeenCalledTimes(2);
  });

  it('does not throw if the touch fn rejects (heartbeat is best-effort)', async () => {
    const touch = vi.fn().mockRejectedValue(new Error('disk full'));
    const ticker = createHeartbeatTicker({
      heartbeatPath: '/x/heartbeat',
      touch,
      now: () => 0,
    });
    await expect(ticker()).resolves.toBeUndefined();
  });

  it('uses Date.now() as the default clock when `now` is omitted', async () => {
    const touch = vi.fn(async () => {});
    const ticker = createHeartbeatTicker({ heartbeatPath: '/x/heartbeat', touch });
    await ticker();
    expect(touch).toHaveBeenCalledTimes(1);
  });
});
