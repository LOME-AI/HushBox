import { describe, expect, expectTypeOf, it } from 'vitest';
import { clear, countedInFlow, rateLimitKey } from '../../lib/rate-limit/index.js';
import { reachableFrom } from '../../test-support/rate-limit-reachability.js';
import { scriptedRateLimitRedis } from '../../test-support/rate-limit-double.js';
import { CHAT_ROUTE_POSTURES } from './index.js';
import {
  CHAT_GUEST_SEND_IP_RATE_LIMIT,
  CHAT_STOP_IP_RATE_LIMIT,
  CHAT_STREAM_USER_RATE_LIMIT,
  CHAT_TRIAL_REMAINING_IP_RATE_LIMIT,
  CHAT_TRIAL_SEND_IP_RATE_LIMIT,
  CHAT_TRIAL_WEBSOCKET_IP_RATE_LIMIT,
} from './domain/rate-limit.js';
import { TRIAL_QUOTA_IP_RATE_LIMIT, TRIAL_QUOTA_SESSION_RATE_LIMIT } from './domain/trial/quota.js';
import type { RateLimitDefinition, SliceRouteKey } from '../../lib/rate-limit/index.js';
import type { ChatRouteKey } from './rate-limit-posture.js';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type { Hono } from 'hono';

/** The entries this slice's fragment cites, so the leak walk can name each one. */
const CITED_ENTRIES: readonly RateLimitDefinition[] = [
  CHAT_STREAM_USER_RATE_LIMIT,
  CHAT_GUEST_SEND_IP_RATE_LIMIT,
  CHAT_STOP_IP_RATE_LIMIT,
  CHAT_TRIAL_SEND_IP_RATE_LIMIT,
  CHAT_TRIAL_REMAINING_IP_RATE_LIMIT,
  CHAT_TRIAL_WEBSOCKET_IP_RATE_LIMIT,
  TRIAL_QUOTA_IP_RATE_LIMIT,
  TRIAL_QUOTA_SESSION_RATE_LIMIT,
];

describe('the chat posture fragment', () => {
  it('derives a non-empty route-key union from its own manifest', () => {
    expectTypeOf<ChatRouteKey>().not.toBeNever();
  });

  it('resolves that union to nothing when the sub-router has erased its schema', () => {
    // The matched control for the assertion above: an annotated sub-router
    // widens to `BlankSchema`, the key union collapses to `never`, and a
    // fragment then satisfies its target vacuously. The pair is what makes the
    // first assertion a discrimination rather than a formality.
    expectTypeOf<SliceRouteKey<{ basePath: '/chat'; routes: Hono<AppEnv> }>>().toBeNever();
  });

  it('declares at least one route', () => {
    expect(Object.keys(CHAT_ROUTE_POSTURES).length).toBeGreaterThan(0);
  });

  it('leaves the two routes that spend no counter on their class default', () => {
    expect(CHAT_ROUTE_POSTURES['$get /chat/mock/release-stream']).toStrictEqual({
      kind: 'default',
      failure: 'open',
    });
    expect(CHAT_ROUTE_POSTURES['$post /chat/:conversationId/message']).toStrictEqual({
      kind: 'default',
      failure: 'open',
    });
  });
});

describe('the paid send paths', () => {
  it('counts the send window per user at the edge on both session sends', () => {
    expect(CHAT_ROUTE_POSTURES['$post /chat'].keyedBy).toStrictEqual(['user']);
    expect(CHAT_ROUTE_POSTURES['$post /chat/regenerate'].keyedBy).toStrictEqual(['user']);
  });

  it('spends the send entry, and no other, on each session send', async () => {
    // The only way to say WHICH entry a capability closed over: the entry is
    // unreachable from the published value, so the key its own `buildKey`
    // derives is what names it.
    const { redis, keys } = scriptedRateLimitRedis();
    for (const key of ['$post /chat', '$post /chat/regenerate'] as const) {
      const edge = CHAT_ROUTE_POSTURES[key].countAtEdge;
      if (edge === undefined) throw new Error(`${key} declares no edge capability`);
      const decision = await edge.count(redis, ['user-id']);
      expect(decision.isOk()).toBe(true);
    }
    expect(keys).toStrictEqual([
      rateLimitKey(CHAT_STREAM_USER_RATE_LIMIT, 'user-id')._unsafeUnwrap(),
      rateLimitKey(CHAT_STREAM_USER_RATE_LIMIT, 'user-id')._unsafeUnwrap(),
    ]);
  });

  it('splits the guest send across the edge and the flow, in that order', () => {
    // The pre-resolution IP window is counted at the edge; the same send window
    // the session routes count at the edge is spent in the handler
    // here, keyed on the resolved sender. Two positions, two places.
    expect(CHAT_ROUTE_POSTURES['$post /chat/guest'].keyedBy).toStrictEqual([
      'sessionless-ip',
      'caller',
    ]);
    expect(CHAT_ROUTE_POSTURES['$post /chat/guest'].countAtEdge?.keyedBy).toStrictEqual([
      'sessionless-ip',
    ]);
  });

  it('spends only the guest IP entry at the guest send edge', async () => {
    const { redis, keys } = scriptedRateLimitRedis();
    const edge = CHAT_ROUTE_POSTURES['$post /chat/guest'].countAtEdge;
    if (edge === undefined) throw new Error('the guest send declares no edge capability');
    const decision = await edge.count(redis, ['ip-hash']);
    expect(decision.isOk()).toBe(true);
    expect(keys).toStrictEqual([
      rateLimitKey(CHAT_GUEST_SEND_IP_RATE_LIMIT, 'ip-hash')._unsafeUnwrap(),
    ]);
  });

  it('cites the send window in flow on the guest send, and not the window fronting it', () => {
    expect(CHAT_ROUTE_POSTURES['$post /chat/guest'].countedInFlow).toStrictEqual([
      countedInFlow(CHAT_STREAM_USER_RATE_LIMIT),
    ]);
    expect(CHAT_ROUTE_POSTURES['$post /chat/guest'].countedInFlow).not.toContain(
      countedInFlow(CHAT_GUEST_SEND_IP_RATE_LIMIT)
    );
  });

  it('counts the stop window per sessionless caller at the edge', async () => {
    expect(CHAT_ROUTE_POSTURES['$post /chat/stop'].keyedBy).toStrictEqual(['sessionless-ip']);
    const { redis, keys } = scriptedRateLimitRedis();
    const edge = CHAT_ROUTE_POSTURES['$post /chat/stop'].countAtEdge;
    if (edge === undefined) throw new Error('the stop route declares no edge capability');
    const decision = await edge.count(redis, ['ip-hash']);
    expect(decision.isOk()).toBe(true);
    expect(keys).toStrictEqual([rateLimitKey(CHAT_STOP_IP_RATE_LIMIT, 'ip-hash')._unsafeUnwrap()]);
  });
});

describe('the trial paths, whose counters the pipeline never sees', () => {
  it('cites all three counters the trial send spends, in the order it spends them', () => {
    // The abuse throttle answers first, ahead of the route's first Postgres
    // read; the 5/day quota is then one all-or-nothing check over both of its
    // counters, spent in the order `consumeTrialQuota` lists them.
    expect(CHAT_ROUTE_POSTURES['$post /chat/trial'].countedInFlow).toStrictEqual([
      countedInFlow(CHAT_TRIAL_SEND_IP_RATE_LIMIT),
      countedInFlow(TRIAL_QUOTA_SESSION_RATE_LIMIT),
      countedInFlow(TRIAL_QUOTA_IP_RATE_LIMIT),
    ]);
  });

  it('names the trial session between the two addresses it counts', () => {
    expect(CHAT_ROUTE_POSTURES['$post /chat/trial'].keyedBy).toStrictEqual([
      'ip',
      'presented-token',
      'ip',
    ]);
  });

  it('gives the trial send no edge call, because neither layer is counted there', () => {
    expect(CHAT_ROUTE_POSTURES['$post /chat/trial'].countAtEdge).toBeUndefined();
  });

  it('cites the remaining-count throttle alone on the remaining read', () => {
    // The quota itself is READ there, never spent — `readTrialQuotaRemaining`
    // fetches both counters and increments neither — so the read's only spend
    // is its own per-IP throttle.
    expect(CHAT_ROUTE_POSTURES['$get /chat/trial/remaining'].countedInFlow).toStrictEqual([
      countedInFlow(CHAT_TRIAL_REMAINING_IP_RATE_LIMIT),
    ]);
    expect(CHAT_ROUTE_POSTURES['$get /chat/trial/remaining'].countedInFlow).not.toContain(
      countedInFlow(TRIAL_QUOTA_IP_RATE_LIMIT)
    );
    expect(CHAT_ROUTE_POSTURES['$get /chat/trial/remaining'].countAtEdge).toBeUndefined();
  });

  it('counts the websocket upgrade per IP at the edge', async () => {
    expect(CHAT_ROUTE_POSTURES['$get /chat/trial/websocket'].keyedBy).toStrictEqual(['ip']);
    const { redis, keys } = scriptedRateLimitRedis();
    const edge = CHAT_ROUTE_POSTURES['$get /chat/trial/websocket'].countAtEdge;
    if (edge === undefined) throw new Error('the trial websocket declares no edge capability');
    const decision = await edge.count(redis, ['ip-hash']);
    expect(decision.isOk()).toBe(true);
    expect(keys).toStrictEqual([
      rateLimitKey(CHAT_TRIAL_WEBSOCKET_IP_RATE_LIMIT, 'ip-hash')._unsafeUnwrap(),
    ]);
  });
});

describe('what the chat barrel publishes with the fragment', () => {
  it('descends into what the fragment does publish', () => {
    // The positive control for the assertions below: a walk that reached
    // nothing would report every leak absent and read exactly like a clean one.
    const reachable = reachableFrom(CHAT_ROUTE_POSTURES);
    expect(reachable).toContain('user');
    expect(reachable).toContain('sessionless-ip');
  });

  it('reaches no registry entry the fragment cites', () => {
    const reachable = reachableFrom(CHAT_ROUTE_POSTURES);
    for (const entry of CITED_ENTRIES) expect(reachable).not.toContain(entry);
  });

  it('reaches no key builder', () => {
    const reachable = reachableFrom(CHAT_ROUTE_POSTURES);
    for (const entry of CITED_ENTRIES) expect(reachable).not.toContain(entry.buildKey);
  });

  it('reaches no key prefix', () => {
    const strings = reachableFrom(CHAT_ROUTE_POSTURES).filter((value) => typeof value === 'string');
    expect(strings.filter((value) => value.includes('ratelimit:'))).toStrictEqual([]);
  });

  it('reaches neither cap nor window', () => {
    const caps = new Set(
      CITED_ENTRIES.flatMap((entry) => [entry.maxAttempts, entry.windowSeconds])
    );
    const numbers = reachableFrom(CHAT_ROUTE_POSTURES).filter((value) => typeof value === 'number');
    expect(numbers.filter((value) => caps.has(value))).toStrictEqual([]);
  });

  it('reaches one callable per edge-counted route, and none of them is the disarm', () => {
    const callables = reachableFrom(CHAT_ROUTE_POSTURES).filter(
      (value) => typeof value === 'function'
    );
    expect(callables).toHaveLength(5);
    expect(callables).not.toContain(clear);
  });
});
