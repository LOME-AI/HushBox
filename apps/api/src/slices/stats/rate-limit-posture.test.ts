import { describe, expect, expectTypeOf, it } from 'vitest';
import { clear, rateLimitKey } from '../../lib/rate-limit/index.js';
import { reachableFrom } from '../../test-support/rate-limit-reachability.js';
import { scriptedRateLimitRedis } from '../../test-support/rate-limit-double.js';
import { STATS_ROUTE_POSTURES } from './index.js';
import { statsIpRateLimit } from './domain/index.js';
import type { SliceRouteKey } from '../../lib/rate-limit/index.js';
import type { StatsRouteKey } from './rate-limit-posture.js';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type { Hono } from 'hono';

const STATS = '$get /public/stats';

describe('the stats posture fragment', () => {
  it('derives a non-empty route-key union from its own manifest', () => {
    expectTypeOf<StatsRouteKey>().not.toBeNever();
  });

  it('resolves that union to nothing when the sub-router has erased its schema', () => {
    // The matched control for the assertion above: an annotated sub-router
    // widens to `BlankSchema`, the key union collapses to `never`, and a
    // fragment then satisfies its target vacuously. The pair is what makes the
    // first assertion a discrimination rather than a formality.
    expectTypeOf<SliceRouteKey<{ basePath: '/public'; routes: Hono<AppEnv> }>>().toBeNever();
  });

  it('derives its own route and not the sibling slice sharing the base path', () => {
    // `/public` is served by two manifests. Each fragment types itself off its
    // OWN manifest, so this union carries one key; were the derivation reading
    // the mounted path instead, the roadmap route would appear here and the
    // declaration below would then be missing a key.
    expectTypeOf<StatsRouteKey>().toEqualTypeOf<'$get /public/stats'>();
  });

  it('declares at least one route', () => {
    expect(Object.keys(STATS_ROUTE_POSTURES).length).toBeGreaterThan(0);
  });

  it('names one identity on the public stats read, counted at the edge', () => {
    expect(STATS_ROUTE_POSTURES[STATS].keyedBy).toStrictEqual(['ip']);
    expect(STATS_ROUTE_POSTURES[STATS].countAtEdge?.keyedBy).toStrictEqual(['ip']);
  });

  it('spends the stats entry, and no other, on the identity it is given', async () => {
    // The only way to say WHICH entry the capability closed over: the entry
    // itself is unreachable from the published value, so the key its own
    // `buildKey` derives is what names it. It also discriminates against the
    // sibling `/public` slice's entry, whose cap and window are identical and
    // whose key differs in one segment.
    const { redis, keys } = scriptedRateLimitRedis();
    const edge = STATS_ROUTE_POSTURES[STATS].countAtEdge;
    if (edge === undefined) throw new Error('the stats read declares no edge capability');
    const decision = await edge.count(redis, ['ip-hash']);
    expect(decision.isOk()).toBe(true);
    expect(keys).toStrictEqual([rateLimitKey(statsIpRateLimit, 'ip-hash')._unsafeUnwrap()]);
  });

  it('cites nothing in flow, because this slice spends no counter in its domain', () => {
    expect(STATS_ROUTE_POSTURES[STATS].countedInFlow).toStrictEqual([]);
  });

  it('descends into what the fragment does publish', () => {
    // The positive control for the five assertions below: a walk that reached
    // nothing would report every leak absent and read exactly like a clean one.
    expect(reachableFrom(STATS_ROUTE_POSTURES)).toContain('ip');
  });

  it('reaches no registry entry through the barrel', () => {
    expect(reachableFrom(STATS_ROUTE_POSTURES)).not.toContain(statsIpRateLimit);
  });

  it('reaches no key builder through the barrel', () => {
    expect(reachableFrom(STATS_ROUTE_POSTURES)).not.toContain(statsIpRateLimit.buildKey);
  });

  it('reaches no key prefix through the barrel', () => {
    const strings = reachableFrom(STATS_ROUTE_POSTURES).filter(
      (value) => typeof value === 'string'
    );
    expect(strings.filter((value) => value.includes('ratelimit:'))).toStrictEqual([]);
  });

  it('reaches neither cap nor window through the barrel', () => {
    const caps = new Set<number>([statsIpRateLimit.maxAttempts, statsIpRateLimit.windowSeconds]);
    const numbers = reachableFrom(STATS_ROUTE_POSTURES).filter(
      (value) => typeof value === 'number'
    );
    expect(numbers.filter((value) => caps.has(value))).toStrictEqual([]);
  });

  it('reaches exactly one callable through the barrel, and it is not the disarm', () => {
    const callables = reachableFrom(STATS_ROUTE_POSTURES).filter(
      (value) => typeof value === 'function'
    );
    expect(callables).toHaveLength(1);
    expect(callables).not.toContain(clear);
  });
});
