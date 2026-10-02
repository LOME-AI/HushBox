import { describe, expect, expectTypeOf, it } from 'vitest';
import { clear, rateLimitKey } from '../../lib/rate-limit/index.js';
import { reachableFrom } from '../../test-support/rate-limit-reachability.js';
import { scriptedRateLimitRedis } from '../../test-support/rate-limit-double.js';
import { ACCOUNT_ROUTE_POSTURES } from './index.js';
import { userSearchRateLimit } from './domain/rate-limit.js';
import type { CarriedRoutePosture, SliceRouteKey } from '../../lib/rate-limit/index.js';
import type { AccountRouteKey } from './rate-limit-posture.js';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type { Hono } from 'hono';

const SEARCH = '$get /account/users/search';

function backstopped(postures: Record<string, CarriedRoutePosture>): Set<string> {
  return new Set(
    Object.entries(postures)
      .filter(([, posture]) => posture.kind === 'default')
      .map(([key]) => key)
  );
}

describe('the account posture fragment', () => {
  it('derives a non-empty route-key union from its own manifest', () => {
    expectTypeOf<AccountRouteKey>().not.toBeNever();
  });

  it('resolves that union to nothing when the sub-router has erased its schema', () => {
    // The matched control for the assertion above: an annotated sub-router
    // widens to `BlankSchema`, the key union collapses to `never`, and a
    // fragment then satisfies its target vacuously. The pair is what makes the
    // first assertion a discrimination rather than a formality.
    expectTypeOf<SliceRouteKey<{ basePath: '/account'; routes: Hono<AppEnv> }>>().toBeNever();
  });

  it('declares at least one route', () => {
    expect(Object.keys(ACCOUNT_ROUTE_POSTURES).length).toBeGreaterThan(0);
  });

  it('names one identity on the user search, counted at the edge', () => {
    expect(ACCOUNT_ROUTE_POSTURES[SEARCH].keyedBy).toStrictEqual(['user']);
    expect(ACCOUNT_ROUTE_POSTURES[SEARCH].countAtEdge?.keyedBy).toStrictEqual(['user']);
  });

  it('spends the user-search entry, and no other, on the identity it is given', async () => {
    // The only way to say WHICH entry the capability closed over: the entry
    // itself is unreachable from the published value, so the key its own
    // `buildKey` derives is what names it.
    const { redis, keys } = scriptedRateLimitRedis();
    const edge = ACCOUNT_ROUTE_POSTURES[SEARCH].countAtEdge;
    if (edge === undefined) throw new Error('the user search declares no edge capability');
    const decision = await edge.count(redis, ['user-id']);
    expect(decision.isOk()).toBe(true);
    expect(keys).toStrictEqual([rateLimitKey(userSearchRateLimit, 'user-id')._unsafeUnwrap()]);
  });

  it('cites nothing in flow, because this slice spends no counter in its domain', () => {
    expect(ACCOUNT_ROUTE_POSTURES[SEARCH].countedInFlow).toStrictEqual([]);
  });

  it('leaves the settings reads and writes to their route class default', () => {
    expect(backstopped(ACCOUNT_ROUTE_POSTURES)).toStrictEqual(
      new Set([
        '$get /account/instructions',
        '$put /account/instructions',
        '$delete /account/instructions',
        '$get /account/preferences/accessibility',
        '$put /account/preferences/accessibility',
      ])
    );
  });

  it('descends into what the fragment does publish', () => {
    // The positive control for the five assertions below: a walk that reached
    // nothing would report every leak absent and read exactly like a clean one.
    expect(reachableFrom(ACCOUNT_ROUTE_POSTURES)).toContain('user');
  });

  it('reaches no registry entry through the barrel', () => {
    expect(reachableFrom(ACCOUNT_ROUTE_POSTURES)).not.toContain(userSearchRateLimit);
  });

  it('reaches no key builder through the barrel', () => {
    expect(reachableFrom(ACCOUNT_ROUTE_POSTURES)).not.toContain(userSearchRateLimit.buildKey);
  });

  it('reaches no key prefix through the barrel', () => {
    const strings = reachableFrom(ACCOUNT_ROUTE_POSTURES).filter(
      (value) => typeof value === 'string'
    );
    expect(strings.filter((value) => value.includes('ratelimit:'))).toStrictEqual([]);
  });

  it('reaches neither cap nor window through the barrel', () => {
    const caps = new Set<number>([
      userSearchRateLimit.maxAttempts,
      userSearchRateLimit.windowSeconds,
    ]);
    const numbers = reachableFrom(ACCOUNT_ROUTE_POSTURES).filter(
      (value) => typeof value === 'number'
    );
    expect(numbers.filter((value) => caps.has(value))).toStrictEqual([]);
  });

  it('reaches exactly one callable through the barrel, and it is not the disarm', () => {
    const callables = reachableFrom(ACCOUNT_ROUTE_POSTURES).filter(
      (value) => typeof value === 'function'
    );
    expect(callables).toHaveLength(1);
    expect(callables).not.toContain(clear);
  });
});
