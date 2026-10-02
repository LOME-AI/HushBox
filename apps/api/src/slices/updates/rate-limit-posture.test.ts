import { describe, expect, expectTypeOf, it } from 'vitest';
import { clear, rateLimitKey } from '../../lib/rate-limit/index.js';
import { reachableFrom } from '../../test-support/rate-limit-reachability.js';
import { scriptedRateLimitRedis } from '../../test-support/rate-limit-double.js';
import { UPDATES_ROUTE_POSTURES } from './index.js';
import { bundleDownloadIpRateLimit } from './domain/rate-limit.js';
import type { SliceRouteKey } from '../../lib/rate-limit/index.js';
import type { UpdatesRouteKey } from './rate-limit-posture.js';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type { Hono } from 'hono';

const DOWNLOAD = '$get /updates/download/:platform/:version';

describe('the updates posture fragment', () => {
  it('derives a non-empty route-key union from its own manifest', () => {
    expectTypeOf<UpdatesRouteKey>().not.toBeNever();
  });

  it('resolves that union to nothing when the sub-router has erased its schema', () => {
    // The matched control for the assertion above: an annotated sub-router
    // widens to `BlankSchema`, the key union collapses to `never`, and a
    // fragment then satisfies its target vacuously. The pair is what makes the
    // first assertion a discrimination rather than a formality.
    expectTypeOf<SliceRouteKey<{ basePath: '/updates'; routes: Hono<AppEnv> }>>().toBeNever();
  });

  it('declares at least one route', () => {
    expect(Object.keys(UPDATES_ROUTE_POSTURES).length).toBeGreaterThan(0);
  });

  it('names the obligation the version read carries in a counter’s place', () => {
    expect(UPDATES_ROUTE_POSTURES['$get /updates/current']).toStrictEqual({
      kind: 'exempt',
      exemption: 'constant-cost',
    });
  });

  it('names one identity on the bundle download, counted at the edge', () => {
    expect(UPDATES_ROUTE_POSTURES[DOWNLOAD].keyedBy).toStrictEqual(['ip']);
    expect(UPDATES_ROUTE_POSTURES[DOWNLOAD].countAtEdge?.keyedBy).toStrictEqual(['ip']);
  });

  it('spends the bundle download entry, and no other, on the identity it is given', async () => {
    // The only way to say WHICH entry the capability closed over: the entry
    // itself is unreachable from the published value, so the key its own
    // `buildKey` derives is what names it.
    const { redis, keys } = scriptedRateLimitRedis();
    const edge = UPDATES_ROUTE_POSTURES[DOWNLOAD].countAtEdge;
    if (edge === undefined) throw new Error('the bundle download declares no edge capability');
    const decision = await edge.count(redis, ['ip-hash']);
    expect(decision.isOk()).toBe(true);
    expect(keys).toStrictEqual([
      rateLimitKey(bundleDownloadIpRateLimit, 'ip-hash')._unsafeUnwrap(),
    ]);
  });

  it('cites nothing in flow, because this slice counts only at the edge', () => {
    expect(UPDATES_ROUTE_POSTURES[DOWNLOAD].countedInFlow).toStrictEqual([]);
  });

  it('descends into what the fragment does publish', () => {
    // The positive control for the five assertions below: a walk that reached
    // nothing would report every leak absent and read exactly like a clean one.
    expect(reachableFrom(UPDATES_ROUTE_POSTURES)).toContain('ip');
  });

  it('reaches no registry entry through the barrel', () => {
    expect(reachableFrom(UPDATES_ROUTE_POSTURES)).not.toContain(bundleDownloadIpRateLimit);
  });

  it('reaches no key builder through the barrel', () => {
    expect(reachableFrom(UPDATES_ROUTE_POSTURES)).not.toContain(bundleDownloadIpRateLimit.buildKey);
  });

  it('reaches no key prefix through the barrel', () => {
    const strings = reachableFrom(UPDATES_ROUTE_POSTURES).filter(
      (value) => typeof value === 'string'
    );
    expect(strings.filter((value) => value.includes('ratelimit:'))).toStrictEqual([]);
  });

  it('reaches neither cap nor window through the barrel', () => {
    const caps = new Set<number>([
      bundleDownloadIpRateLimit.maxAttempts,
      bundleDownloadIpRateLimit.windowSeconds,
    ]);
    const numbers = reachableFrom(UPDATES_ROUTE_POSTURES).filter(
      (value) => typeof value === 'number'
    );
    expect(numbers.filter((value) => caps.has(value))).toStrictEqual([]);
  });

  it('reaches exactly one callable through the barrel, and it is not the disarm', () => {
    const callables = reachableFrom(UPDATES_ROUTE_POSTURES).filter(
      (value) => typeof value === 'function'
    );
    expect(callables).toHaveLength(1);
    expect(callables).not.toContain(clear);
  });
});
