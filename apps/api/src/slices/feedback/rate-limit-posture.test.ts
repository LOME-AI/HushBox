import { describe, expect, expectTypeOf, it } from 'vitest';
import { clear, rateLimitKey } from '../../lib/rate-limit/index.js';
import { reachableFrom } from '../../test-support/rate-limit-reachability.js';
import { FEEDBACK_ROUTE_POSTURES } from './index.js';
import { feedbackSubmitHourlyRateLimit, feedbackSubmitRateLimit } from './domain/rate-limit.js';
import type { CountAtEdge, SliceRouteKey } from '../../lib/rate-limit/index.js';
import type { FeedbackRouteKey } from './rate-limit-posture.js';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type { Hono } from 'hono';

/** The Redis handle `count` takes, named off the capability rather than the infra module. */
type CountRedis = Parameters<CountAtEdge['count']>[0];

/**
 * Records the key list of each script call as a GROUP, so a single
 * all-or-nothing call over two entries is distinguishable from two calls over
 * one entry each — which is the property this route's two-entry declaration
 * exists to hold.
 */
function groupingRedis(): { redis: CountRedis; calls: string[][] } {
  const calls: string[][] = [];
  const redis = {
    createScript: () => ({
      exec: (scriptKeys: string[]) => {
        calls.push([...scriptKeys]);
        return Promise.resolve('allowed:0:1:0');
      },
    }),
  } as unknown as CountRedis;
  return { redis, calls };
}

describe('the feedback posture fragment', () => {
  it('derives a non-empty route-key union from its own manifest', () => {
    expectTypeOf<FeedbackRouteKey>().not.toBeNever();
  });

  it('resolves that union to nothing when the sub-router has erased its schema', () => {
    // The matched control for the assertion above: an annotated sub-router
    // widens to `BlankSchema`, the key union collapses to `never`, and a
    // fragment then satisfies its target vacuously. The pair is what makes the
    // first assertion a discrimination rather than a formality.
    expectTypeOf<SliceRouteKey<{ basePath: '/feedback'; routes: Hono<AppEnv> }>>().toBeNever();
  });

  it('declares at least one route', () => {
    expect(Object.keys(FEEDBACK_ROUTE_POSTURES).length).toBeGreaterThan(0);
  });

  it('names one identity per declared layer, so the two entries occupy two positions', () => {
    expect(FEEDBACK_ROUTE_POSTURES['$post /feedback'].keyedBy).toStrictEqual(['caller', 'caller']);
  });

  it('spends both entries on one caller in a single round trip', async () => {
    const { redis, calls } = groupingRedis();
    const edge = FEEDBACK_ROUTE_POSTURES['$post /feedback'].countAtEdge;
    if (edge === undefined) throw new Error('the feedback route declares no edge capability');
    const decision = await edge.count(redis, ['caller-hash', 'caller-hash']);
    expect(decision.isOk()).toBe(true);
    expect(calls).toStrictEqual([
      [
        rateLimitKey(feedbackSubmitRateLimit, 'caller-hash')._unsafeUnwrap(),
        rateLimitKey(feedbackSubmitHourlyRateLimit, 'caller-hash')._unsafeUnwrap(),
      ],
    ]);
  });

  it('descends into what the fragment does publish', () => {
    // The positive control for the assertions below: a walk that reached
    // nothing would report every leak absent and read exactly like a clean one.
    expect(reachableFrom(FEEDBACK_ROUTE_POSTURES)).toContain('caller');
  });

  it('reaches neither registry entry through the barrel', () => {
    const reachable = reachableFrom(FEEDBACK_ROUTE_POSTURES);
    expect(reachable).not.toContain(feedbackSubmitRateLimit);
    expect(reachable).not.toContain(feedbackSubmitHourlyRateLimit);
  });

  it('reaches no key builder through the barrel', () => {
    const reachable = reachableFrom(FEEDBACK_ROUTE_POSTURES);
    expect(reachable).not.toContain(feedbackSubmitRateLimit.buildKey);
    expect(reachable).not.toContain(feedbackSubmitHourlyRateLimit.buildKey);
  });

  it('reaches no key prefix through the barrel', () => {
    const strings = reachableFrom(FEEDBACK_ROUTE_POSTURES).filter(
      (value) => typeof value === 'string'
    );
    expect(strings.filter((value) => value.includes('ratelimit:'))).toStrictEqual([]);
  });

  it('reaches neither cap nor window through the barrel', () => {
    const caps = new Set<number>([
      feedbackSubmitRateLimit.maxAttempts,
      feedbackSubmitRateLimit.windowSeconds,
      feedbackSubmitHourlyRateLimit.maxAttempts,
      feedbackSubmitHourlyRateLimit.windowSeconds,
    ]);
    const numbers = reachableFrom(FEEDBACK_ROUTE_POSTURES).filter(
      (value) => typeof value === 'number'
    );
    expect(numbers.filter((value) => caps.has(value))).toStrictEqual([]);
  });

  it('reaches exactly one callable through the barrel, and it is not the disarm', () => {
    const callables = reachableFrom(FEEDBACK_ROUTE_POSTURES).filter(
      (value) => typeof value === 'function'
    );
    expect(callables).toHaveLength(1);
    expect(callables).not.toContain(clear);
  });
});
