import { describe, expect, expectTypeOf, it } from 'vitest';
import { clear, rateLimitKey } from '../../lib/rate-limit/index.js';
import { BILLING_ROUTE_POSTURES } from './index.js';
import { BILLING_RATE_LIMITS } from './domain/rate-limit.js';
import { reachableFrom } from '../../test-support/rate-limit-reachability.js';
import type {
  CountAtEdge,
  RateLimitDefinition,
  SliceRouteKey,
} from '../../lib/rate-limit/index.js';
import type { BillingRouteKey } from './rate-limit-posture.js';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type { Hono } from 'hono';

const CHARGE = '$post /billing/payments';
const BALANCE = '$get /billing/balance';

/** The two routes the `billing-token` class admits both session kinds on and
 *  leaves entirely to that class's default. */
const OTHER_BILLING_TOKEN_ROUTES = [
  '$get /billing/spendable',
  '$get /billing/transactions',
] as const;

/** The entries this slice's fragment cites, so the leak walk can name each one. */
const CITED_ENTRIES: readonly RateLimitDefinition[] = [
  BILLING_RATE_LIMITS.cardChargeIpRateLimit,
  BILLING_RATE_LIMITS.cardChargeAccountRateLimit,
  BILLING_RATE_LIMITS.balanceReadRateLimit,
];

/** The Redis handle `count` takes, named off the capability rather than the infra module. */
type CountRedis = Parameters<CountAtEdge['count']>[0];

/**
 * Records the key list of each script call as a GROUP, so a single
 * all-or-nothing call over both entries is distinguishable from two calls over
 * one entry each — which is the property that makes a caller refused by one
 * layer leave the other layer's counter untouched.
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

describe('the billing posture fragment', () => {
  it('derives a non-empty route-key union from its own manifest', () => {
    expectTypeOf<BillingRouteKey>().not.toBeNever();
  });

  it('resolves that union to nothing when the sub-router has erased its schema', () => {
    // The matched control for the assertion above: an annotated sub-router
    // widens to `BlankSchema`, the key union collapses to `never`, and a
    // fragment then satisfies its target vacuously. The pair is what makes the
    // first assertion a discrimination rather than a formality.
    expectTypeOf<SliceRouteKey<{ basePath: '/billing'; routes: Hono<AppEnv> }>>().toBeNever();
  });

  it('declares at least one route', () => {
    expect(Object.keys(BILLING_ROUTE_POSTURES).length).toBeGreaterThan(0);
  });

  it('names the obligation the webhook carries in a counter’s place', () => {
    expect(BILLING_ROUTE_POSTURES['$post /billing/webhooks/payment']).toStrictEqual({
      kind: 'exempt',
      exemption: 'signature-gated-webhook',
    });
  });

  it('counts two routes of its own and leaves the rest to their class defaults', () => {
    const kinds = new Set(Object.values(BILLING_ROUTE_POSTURES).map((posture) => posture.kind));
    expect(kinds).toStrictEqual(new Set(['default', 'named', 'exempt']));
    const named = Object.entries(BILLING_ROUTE_POSTURES)
      .filter(([, posture]) => posture.kind === 'named')
      .map(([key]) => key);
    expect(named).toStrictEqual([BALANCE, CHARGE]);
  });

  it('leaves the class default as the whole bound of the other billing-token routes', () => {
    for (const key of OTHER_BILLING_TOKEN_ROUTES) {
      expect(BILLING_ROUTE_POSTURES[key]).toStrictEqual({ kind: 'default', failure: 'open' });
    }
  });
});

describe('the balance read', () => {
  it('carries a named limit of its own rather than its route class default', () => {
    expect(BILLING_ROUTE_POSTURES[BALANCE].kind).toBe('named');
    expect(BILLING_ROUTE_POSTURES[BALANCE].keyedBy).toStrictEqual(['ip']);
  });

  it('declares the failure posture that keeps a balance read answerable', () => {
    expect(BILLING_ROUTE_POSTURES[BALANCE].failure).toBe('open');
  });

  it('bounds it at the number its route class default bounded it at', () => {
    // The entry carries the class default's number without carrying its key:
    // this row is address-keyed where that default keys on the account, so it
    // aggregates the payers behind one address where the default gives each of
    // them a counter. The reason for the move is the failure posture, and
    // holding the number is what keeps the move from re-sizing anything.
    expect(BILLING_RATE_LIMITS.balanceReadRateLimit.maxAttempts).toBe(600);
    expect(BILLING_RATE_LIMITS.balanceReadRateLimit.windowSeconds).toBe(60);
  });
});

describe('the card-charge route', () => {
  it('names the address first and the account after it', () => {
    // The order is the declaration's substance, not its formatting: a refusal
    // is attributed to the first refusing layer, and the address window is the
    // one holding a caller who has reached the route from several accounts.
    expect(BILLING_ROUTE_POSTURES[CHARGE].keyedBy).toStrictEqual(['ip', 'session-user']);
  });

  it('counts both of its layers at the edge and none in flow', () => {
    expect(BILLING_ROUTE_POSTURES[CHARGE].countAtEdge?.keyedBy).toStrictEqual([
      'ip',
      'session-user',
    ]);
    expect(BILLING_ROUTE_POSTURES[CHARGE].countedInFlow).toStrictEqual([]);
  });

  it('keys the account layer on an identity no caller of the route can vary', () => {
    // What the account keying buys, and the reason it is the identity rather
    // than the cap that answers card testing: every principal this route's
    // class admits carries a session the Worker unsealed, so that window
    // follows ONE account rather than falling back to an address folded with a
    // header the caller chose.
    expect(BILLING_ROUTE_POSTURES[CHARGE].keyedBy).not.toContain('caller');
  });

  it('spends both entries in one round trip, in declared order', async () => {
    const { redis, calls } = groupingRedis();
    const edge = BILLING_ROUTE_POSTURES[CHARGE].countAtEdge;
    if (edge === undefined) throw new Error('the card-charge route declares no edge capability');
    const decision = await edge.count(redis, ['ip-hash', 'account-id']);
    expect(decision.isOk()).toBe(true);
    expect(calls).toStrictEqual([
      [
        rateLimitKey(BILLING_RATE_LIMITS.cardChargeIpRateLimit, 'ip-hash')._unsafeUnwrap(),
        rateLimitKey(BILLING_RATE_LIMITS.cardChargeAccountRateLimit, 'account-id')._unsafeUnwrap(),
      ],
    ]);
  });

  it('keys both windows under one route-scoped prefix, on the dimension each counts', () => {
    // The key is what an operator reads during an incident, so both halves of
    // it are pinned: the prefix, which is what a reset target has to match, and
    // the segment naming the dimension, which is the only thing telling those
    // two counters apart in a keyspace.
    expect(BILLING_RATE_LIMITS.cardChargeIpRateLimit.buildKey('id')).toBe(
      'ratelimit:billing:card-charge:ip:id'
    );
    expect(BILLING_RATE_LIMITS.cardChargeAccountRateLimit.buildKey('id')).toBe(
      'ratelimit:billing:card-charge:account:id'
    );
  });

  it('sizes the address window at four co-located payers’ minute', () => {
    // Typed rather than derived from the account window, so re-sizing either is
    // a deliberate diff a reader meets beside the judgement that produced it.
    expect(BILLING_RATE_LIMITS.cardChargeIpRateLimit.maxAttempts).toBe(72);
    expect(BILLING_RATE_LIMITS.cardChargeIpRateLimit.windowSeconds).toBe(60);
  });

  it('sizes the account window at one payer’s own minute', () => {
    expect(BILLING_RATE_LIMITS.cardChargeAccountRateLimit.maxAttempts).toBe(18);
    expect(BILLING_RATE_LIMITS.cardChargeAccountRateLimit.windowSeconds).toBe(60);
  });

  it('keeps the per-account window the tighter of the two', () => {
    // The claim this assertion pins is stated once, in `domain/rate-limit.ts`
    // §"Which layer answers whom"; restating it here would be a second copy
    // nothing holds to the first. The assertion exists so that raising the
    // account cap to or past the address cap fails a test rather than quietly
    // contradicting that section. The relation is the property; the values
    // above are one pair satisfying it.
    expect(BILLING_RATE_LIMITS.cardChargeAccountRateLimit.maxAttempts).toBeLessThan(
      BILLING_RATE_LIMITS.cardChargeIpRateLimit.maxAttempts
    );
  });
});

describe('what the billing barrel publishes with the fragment', () => {
  it('descends into what the fragment does publish', () => {
    // The positive control for the assertions below: a walk that reached
    // nothing would report every leak absent and read exactly like a clean one.
    const reachable = reachableFrom(BILLING_ROUTE_POSTURES);
    expect(reachable).toContain('signature-gated-webhook');
    expect(reachable).toContain('ip');
    expect(reachable).toContain('session-user');
  });

  it('reaches no registry entry the fragment cites', () => {
    const reachable = reachableFrom(BILLING_ROUTE_POSTURES);
    for (const entry of CITED_ENTRIES) expect(reachable).not.toContain(entry);
  });

  it('reaches no key builder', () => {
    const reachable = reachableFrom(BILLING_ROUTE_POSTURES);
    for (const entry of CITED_ENTRIES) expect(reachable).not.toContain(entry.buildKey);
  });

  it('reaches no key prefix', () => {
    const strings = reachableFrom(BILLING_ROUTE_POSTURES).filter(
      (value) => typeof value === 'string'
    );
    expect(strings.filter((value) => value.includes('ratelimit:'))).toStrictEqual([]);
  });

  it('reaches neither cap nor window', () => {
    const caps = new Set(
      CITED_ENTRIES.flatMap((entry) => [entry.maxAttempts, entry.windowSeconds])
    );
    const numbers = reachableFrom(BILLING_ROUTE_POSTURES).filter(
      (value) => typeof value === 'number'
    );
    expect(numbers.filter((value) => caps.has(value))).toStrictEqual([]);
  });

  it('reaches one callable per counted route, and neither is the disarm', () => {
    const callables = reachableFrom(BILLING_ROUTE_POSTURES).filter(
      (value) => typeof value === 'function'
    );
    expect(callables).toHaveLength(2);
    expect(callables).not.toContain(clear);
  });
});
