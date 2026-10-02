import { describe, expect, expectTypeOf, it } from 'vitest';
import { clear, rateLimitKey } from '../../lib/rate-limit/index.js';
import { reachableFrom } from '../../test-support/rate-limit-reachability.js';
import { scriptedRateLimitRedis } from '../../test-support/rate-limit-double.js';
import { NEWSLETTER_ROUTE_POSTURES } from './index.js';
import {
  newsletterConfirmIpRateLimit,
  newsletterSubscribeIpRateLimit,
  newsletterUnsubscribeIpRateLimit,
} from './domain/rate-limit.js';
import type { CarriedRoutePosture, SliceRouteKey } from '../../lib/rate-limit/index.js';
import type { NewsletterRouteKey } from './rate-limit-posture.js';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type { Hono } from 'hono';

const SUBSCRIBE = '$post /newsletter/subscribe';
const CONFIRM = '$post /newsletter/confirm';
const UNSUBSCRIBE = '$post /newsletter/unsubscribe';
const IP_CAPPED = [SUBSCRIBE, CONFIRM, UNSUBSCRIBE] as const;

async function keyTouchedBy(posture: CarriedRoutePosture): Promise<string[]> {
  if (posture.kind !== 'named' || posture.countAtEdge === undefined) {
    throw new Error('the route declares no edge capability');
  }
  const { redis, keys } = scriptedRateLimitRedis();
  const decision = await posture.countAtEdge.count(redis, ['ip-hash']);
  expect(decision.isOk()).toBe(true);
  return keys;
}

describe('the newsletter posture fragment', () => {
  it('derives a non-empty route-key union from its own manifest', () => {
    expectTypeOf<NewsletterRouteKey>().not.toBeNever();
  });

  it('resolves that union to nothing when the sub-router has erased its schema', () => {
    // The matched control for the assertion above: an annotated sub-router
    // widens to `BlankSchema`, the key union collapses to `never`, and a
    // fragment then satisfies its target vacuously. The pair is what makes the
    // first assertion a discrimination rather than a formality.
    expectTypeOf<SliceRouteKey<{ basePath: '/newsletter'; routes: Hono<AppEnv> }>>().toBeNever();
  });

  it('declares at least one route', () => {
    expect(Object.keys(NEWSLETTER_ROUTE_POSTURES).length).toBeGreaterThan(0);
  });

  it('names one identity on each of the three public routes, counted at the edge', () => {
    for (const key of IP_CAPPED) {
      expect(NEWSLETTER_ROUTE_POSTURES[key].keyedBy).toStrictEqual(['ip']);
      expect(NEWSLETTER_ROUTE_POSTURES[key].countAtEdge?.keyedBy).toStrictEqual(['ip']);
    }
  });

  it('spends a separate entry on each public route, one key per route', async () => {
    // The only way to say WHICH entry each capability closed over: the entries
    // are unreachable from the published value, so the key each `buildKey`
    // derives is what names it. Confirm and unsubscribe carry the same cap and
    // the same window, so the key is also the only thing telling them apart.
    expect(await keyTouchedBy(NEWSLETTER_ROUTE_POSTURES[SUBSCRIBE])).toStrictEqual([
      rateLimitKey(newsletterSubscribeIpRateLimit, 'ip-hash')._unsafeUnwrap(),
    ]);
    expect(await keyTouchedBy(NEWSLETTER_ROUTE_POSTURES[CONFIRM])).toStrictEqual([
      rateLimitKey(newsletterConfirmIpRateLimit, 'ip-hash')._unsafeUnwrap(),
    ]);
    expect(await keyTouchedBy(NEWSLETTER_ROUTE_POSTURES[UNSUBSCRIBE])).toStrictEqual([
      rateLimitKey(newsletterUnsubscribeIpRateLimit, 'ip-hash')._unsafeUnwrap(),
    ]);
  });

  it('cites nothing in flow on any route, because this slice counts only at the edge', () => {
    for (const key of IP_CAPPED) {
      expect(NEWSLETTER_ROUTE_POSTURES[key].countedInFlow).toStrictEqual([]);
    }
  });

  it('names the obligation the provider webhook carries in a counter’s place', () => {
    expect(NEWSLETTER_ROUTE_POSTURES['$post /newsletter/webhooks/resend']).toStrictEqual({
      kind: 'exempt',
      exemption: 'signature-gated-webhook',
    });
  });

  it('leaves the two session-classed settings routes to their route class default', () => {
    expect(NEWSLETTER_ROUTE_POSTURES['$get /newsletter/me']).toStrictEqual({
      kind: 'default',
      failure: 'open',
    });
    expect(NEWSLETTER_ROUTE_POSTURES['$put /newsletter/me']).toStrictEqual({
      kind: 'default',
      failure: 'open',
    });
  });

  it('descends into what the fragment does publish', () => {
    // The positive control for the five assertions below: a walk that reached
    // nothing would report every leak absent and read exactly like a clean one.
    expect(reachableFrom(NEWSLETTER_ROUTE_POSTURES)).toContain('ip');
  });

  it('reaches no registry entry through the barrel', () => {
    const reachable = reachableFrom(NEWSLETTER_ROUTE_POSTURES);
    expect(reachable).not.toContain(newsletterSubscribeIpRateLimit);
    expect(reachable).not.toContain(newsletterConfirmIpRateLimit);
    expect(reachable).not.toContain(newsletterUnsubscribeIpRateLimit);
  });

  it('reaches no key builder through the barrel', () => {
    const reachable = reachableFrom(NEWSLETTER_ROUTE_POSTURES);
    expect(reachable).not.toContain(newsletterSubscribeIpRateLimit.buildKey);
    expect(reachable).not.toContain(newsletterConfirmIpRateLimit.buildKey);
    expect(reachable).not.toContain(newsletterUnsubscribeIpRateLimit.buildKey);
  });

  it('reaches no key prefix through the barrel', () => {
    const strings = reachableFrom(NEWSLETTER_ROUTE_POSTURES).filter(
      (value) => typeof value === 'string'
    );
    expect(strings.filter((value) => value.includes('ratelimit:'))).toStrictEqual([]);
  });

  it('reaches neither cap nor window through the barrel', () => {
    const caps = new Set<number>([
      newsletterSubscribeIpRateLimit.maxAttempts,
      newsletterSubscribeIpRateLimit.windowSeconds,
      newsletterConfirmIpRateLimit.maxAttempts,
      newsletterConfirmIpRateLimit.windowSeconds,
      newsletterUnsubscribeIpRateLimit.maxAttempts,
      newsletterUnsubscribeIpRateLimit.windowSeconds,
    ]);
    const numbers = reachableFrom(NEWSLETTER_ROUTE_POSTURES).filter(
      (value) => typeof value === 'number'
    );
    expect(numbers.filter((value) => caps.has(value))).toStrictEqual([]);
  });

  it('reaches one callable per edge-counted route, and none of them is the disarm', () => {
    const callables = reachableFrom(NEWSLETTER_ROUTE_POSTURES).filter(
      (value) => typeof value === 'function'
    );
    expect(callables).toHaveLength(3);
    expect(callables).not.toContain(clear);
  });
});
