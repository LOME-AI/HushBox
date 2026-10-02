import { describe, expect, expectTypeOf, it } from 'vitest';
import { bindClassDefault, bindRoutePosture, countedInFlow } from './capability.js';
import { CLASS_DEFAULTS } from './class-default.js';
import { MAX_IDENTIFIER_LENGTH } from './consume.js';
import { hmacRateLimitId } from './key-secret.js';
import { reachableFrom } from '../../test-support/rate-limit-reachability.js';
import type { Redis } from '@upstash/redis';
import type {
  CarriedRoutePosture,
  CountAtEdge,
  CountedInFlow,
  NamedRoutePosture,
} from './capability.js';
import type { RoutePosture } from './posture.js';
import type { ThrottleLimit } from './index.js';

/**
 * A Redis double that records each script call's key list AS A GROUP. The
 * shared `scriptedRateLimitRedis` flattens them, which cannot tell one
 * all-or-nothing call over two layers from two calls over one layer each —
 * the property the per-route capability exists to hold.
 */
function groupingRedis(replies: readonly string[] = ['allowed:0:1:0']): {
  redis: Redis;
  calls: string[][];
} {
  const calls: string[][] = [];
  const redis = {
    createScript: () => ({
      exec: (scriptKeys: string[]) => {
        const reply = replies[Math.min(calls.length, replies.length - 1)];
        calls.push([...scriptKeys]);
        return Promise.resolve(reply);
      },
    }),
  } as unknown as Redis;
  return { redis, calls };
}

function edgeOf(posture: { countAtEdge: CountAtEdge | undefined }): CountAtEdge {
  const edge = posture.countAtEdge;
  if (edge === undefined) throw new Error('the posture under test declares an edge layer');
  return edge;
}

function throttle(prefix: string): ThrottleLimit {
  return {
    kind: 'throttle',
    maxAttempts: 9973,
    windowSeconds: 8681,
    buildKey: (id: string) => `${prefix}:${id}`,
  };
}

describe('countedInFlow', () => {
  it('answers the same reference for one entry bound twice', () => {
    const definition = throttle('capability:memo');

    expect(countedInFlow(definition)).toBe(countedInFlow(definition));
  });

  it('answers a distinct reference for a different entry', () => {
    expect(countedInFlow(throttle('capability:a'))).not.toBe(
      countedInFlow(throttle('capability:b'))
    );
  });
});

describe('bindRoutePosture', () => {
  const edgeIp = throttle('capability:edge-ip');
  const edgeCaller = throttle('capability:edge-caller');
  const flowLockout = throttle('capability:flow-lockout');

  it('names every declared layer in keyedBy, in declared order', () => {
    const posture = bindRoutePosture({
      failure: 'closed',
      layers: [
        { identity: 'sessionless-ip', countedAt: 'edge', definition: edgeIp },
        { identity: 'user', countedAt: 'flow', definition: flowLockout },
        { identity: 'caller', countedAt: 'edge', definition: edgeCaller },
      ],
    });

    expect(posture.keyedBy).toStrictEqual(['sessionless-ip', 'user', 'caller']);
  });

  it('names only the edge layers in the edge capability, in declared order', () => {
    const posture = bindRoutePosture({
      failure: 'closed',
      layers: [
        { identity: 'sessionless-ip', countedAt: 'edge', definition: edgeIp },
        { identity: 'user', countedAt: 'flow', definition: flowLockout },
        { identity: 'caller', countedAt: 'edge', definition: edgeCaller },
      ],
    });

    expect(posture.countAtEdge?.keyedBy).toStrictEqual(['sessionless-ip', 'caller']);
  });

  it('holds the memoized reference for each in-flow layer, in declared order', () => {
    const posture = bindRoutePosture({
      failure: 'closed',
      layers: [
        { identity: 'sessionless-ip', countedAt: 'edge', definition: edgeIp },
        { identity: 'user', countedAt: 'flow', definition: flowLockout },
      ],
    });

    expect(posture.countedInFlow).toHaveLength(1);
    expect(posture.countedInFlow[0]).toBe(countedInFlow(flowLockout));
  });

  it('carries no edge capability when nothing is counted at the edge', () => {
    const posture = bindRoutePosture({
      failure: 'closed',
      layers: [{ identity: 'user', countedAt: 'flow', definition: flowLockout }],
    });

    expect(posture.countAtEdge).toBeUndefined();
  });

  it('carries the declared failure posture', () => {
    const posture = bindRoutePosture({
      failure: 'open',
      layers: [{ identity: 'sessionless-ip', countedAt: 'edge', definition: edgeIp }],
    });

    expect(posture.failure).toBe('open');
  });

  // A route the pipeline spends nothing for has no arm the declaration could
  // govern: its layers are counted by the owning slice's flow, which reads no
  // posture, so `open` there would be a declaration nothing can honour.
  it('refuses an open declaration on a route the pipeline spends nothing for', () => {
    expect(() =>
      bindRoutePosture({
        failure: 'open',
        layers: [{ identity: 'user', countedAt: 'flow', definition: flowLockout }],
      })
    ).toThrow(/counted in its own slice flow/);
  });

  it('refuses an open declaration on a route that also counts a layer in flow', () => {
    expect(() =>
      bindRoutePosture({
        failure: 'open',
        layers: [
          { identity: 'ip', countedAt: 'edge', definition: edgeIp },
          { identity: 'claimed-account', countedAt: 'flow', definition: flowLockout },
        ],
      })
    ).toThrow(/counted in its own slice flow/);
  });

  it('accepts a closed declaration on that same mixed route', () => {
    // The positive control: what is refused is the FAILURE value, never the
    // mixture. A mixed route is ordinary — the pipeline spends its edge half
    // and the owning slice spends the rest — and closed is what both halves
    // can honour.
    const posture = bindRoutePosture({
      failure: 'closed',
      layers: [
        { identity: 'ip', countedAt: 'edge', definition: edgeIp },
        { identity: 'claimed-account', countedAt: 'flow', definition: flowLockout },
      ],
    });

    expect(posture.keyedBy).toStrictEqual(['ip', 'claimed-account']);
  });

  it('accepts an open declaration on a route counted only at the edge', () => {
    const posture = bindRoutePosture({
      failure: 'open',
      layers: [{ identity: 'ip', countedAt: 'edge', definition: edgeIp }],
    });

    expect(posture.failure).toBe('open');
  });
});

describe('bindClassDefault', () => {
  const models = { method: 'GET', path: '/models' } as const;

  it('answers an edge bound keyed on the identity its route class declares', () => {
    expect(bindClassDefault('public', models).keyedBy).toEqual([CLASS_DEFAULTS.public.identity]);
  });

  it("spends its route class's default on a counter the route qualifies", async () => {
    const double = groupingRedis();

    const decision = await bindClassDefault('session', {
      method: 'GET',
      path: '/conversations',
    }).count(double.redis, ['user-1']);

    expect(decision.isOk()).toBe(true);

    expect(double.calls).toEqual([
      [
        CLASS_DEFAULTS.session.definition.buildKey(
          `$get /conversations:${hmacRateLimitId('user-1')}`
        ),
      ],
    ]);
  });

  it('spends two counters for two methods of one path', async () => {
    const double = groupingRedis();
    const instructions = '/account/instructions';

    const read = await bindClassDefault('session', { method: 'GET', path: instructions }).count(
      double.redis,
      ['user-1']
    );
    const erase = await bindClassDefault('session', {
      method: 'DELETE',
      path: instructions,
    }).count(double.redis, ['user-1']);

    expect([read.isOk(), erase.isOk()]).toEqual([true, true]);

    expect(double.calls).toEqual([
      [
        CLASS_DEFAULTS.session.definition.buildKey(
          `$get ${instructions}:${hmacRateLimitId('user-1')}`
        ),
      ],
      [
        CLASS_DEFAULTS.session.definition.buildKey(
          `$delete ${instructions}:${hmacRateLimitId('user-1')}`
        ),
      ],
    ]);
  });

  it('answers an edge bound rather than an optional one, so a class default cannot be absent', () => {
    expectTypeOf(bindClassDefault('public', models)).toEqualTypeOf<CountAtEdge>();
  });

  // The route joins the key without passing the identifier bound, so what a
  // CALLER can put in a key is still exactly what that bound measures.
  it('leaves the identifier bound in force on a route-qualified counter', async () => {
    const double = groupingRedis();

    const decision = await bindClassDefault('public', models).count(double.redis, [
      'i'.repeat(MAX_IDENTIFIER_LENGTH + 1),
    ]);

    expect(decision.isErr()).toBe(true);
    expect(double.calls).toEqual([]);
  });
});

describe('CountAtEdge.count', () => {
  const first = throttle('capability:count-first');
  const second = throttle('capability:count-second');

  function twoEdgeLayers(): CountAtEdge {
    return edgeOf(
      bindRoutePosture({
        failure: 'closed',
        layers: [
          { identity: 'sessionless-ip', countedAt: 'edge', definition: first },
          { identity: 'caller', countedAt: 'edge', definition: second },
        ],
      })
    );
  }

  it('spends every edge layer in one round trip, in declared order', async () => {
    const { redis, calls } = groupingRedis();

    const decision = await twoEdgeLayers().count(redis, ['ip-hash', 'caller-hash']);

    expect(decision.isOk()).toBe(true);
    expect(calls).toStrictEqual([
      [
        `capability:count-first:${hmacRateLimitId('ip-hash')}`,
        `capability:count-second:${hmacRateLimitId('caller-hash')}`,
      ],
    ]);
  });

  it('leaves a layer uncounted when the stage resolved no identity for it', async () => {
    const { redis, calls } = groupingRedis();

    const decision = await twoEdgeLayers().count(redis, [null, 'caller-hash']);

    expect(decision.isOk()).toBe(true);
    expect(calls).toStrictEqual([[`capability:count-second:${hmacRateLimitId('caller-hash')}`]]);
  });

  it('admits without touching Redis when no edge layer counts the caller', async () => {
    const { redis, calls } = groupingRedis();

    const decision = await twoEdgeLayers().count(redis, [null, null]);

    expect(calls).toStrictEqual([]);
    expect(decision._unsafeUnwrap()).toStrictEqual({ allowed: true, count: 0 });
  });

  it("answers the refusing layer's wait, without naming a position the caller declared", async () => {
    const { redis } = groupingRedis(['refused:2:7:42']);

    const decision = await twoEdgeLayers().count(redis, ['ip-hash', 'caller-hash']);

    expect(decision._unsafeUnwrap()).toStrictEqual({
      allowed: false,
      count: 7,
      retryAfterSeconds: 42,
    });
  });

  it('throws when the stage supplies an identity list its keyedBy does not describe', () => {
    const { redis } = groupingRedis();

    expect(() => twoEdgeLayers().count(redis, ['ip-hash'])).toThrow(
      /one identity per keyedBy entry/
    );
  });
});

describe('the published capability surface', () => {
  const edge = throttle('capability:secret-edge-prefix');
  const flow = throttle('capability:secret-flow-prefix');
  const posture = bindRoutePosture({
    failure: 'closed',
    layers: [
      { identity: 'sessionless-ip', countedAt: 'edge', definition: edge },
      { identity: 'user', countedAt: 'flow', definition: flow },
    ],
  });
  const reachable = reachableFrom(posture);

  it('reaches neither registry entry', () => {
    expect(reachable).not.toContain(edge);
    expect(reachable).not.toContain(flow);
  });

  it('reaches no key builder, so no caller can mint a counter key', () => {
    expect(reachable).not.toContain(edge.buildKey);
    expect(reachable).not.toContain(flow.buildKey);
  });

  it('reaches no key prefix', () => {
    const strings = reachable.filter((value) => typeof value === 'string');

    expect(strings.filter((value) => value.includes('secret-'))).toStrictEqual([]);
  });

  it('reaches neither cap nor window', () => {
    expect(reachable.filter((value) => value === 9973 || value === 8681)).toStrictEqual([]);
  });

  it('reaches exactly one callable, the edge count', () => {
    expect(reachable.filter((value) => typeof value === 'function')).toStrictEqual([
      edgeOf(posture).count,
    ]);
  });

  it('publishes only the five posture fields', () => {
    expectTypeOf<keyof NamedRoutePosture>().toEqualTypeOf<
      'kind' | 'keyedBy' | 'failure' | 'countAtEdge' | 'countedInFlow'
    >();
  });

  it('publishes only the two edge-capability fields', () => {
    expectTypeOf<keyof CountAtEdge>().toEqualTypeOf<'keyedBy' | 'count'>();
  });

  it('publishes no named field on an in-flow reference', () => {
    expectTypeOf<Extract<keyof CountedInFlow, string>>().toEqualTypeOf<never>();
  });
});

/**
 * The two dimensions as the COMPILER holds them: a counted route names both a
 * counting arm and a failure posture, an exempt one names its exemption class
 * and neither dimension, and an edge layer names no identity that only a slice
 * flow can resolve. Each of those is refused here rather than at runtime,
 * because a runtime case cannot see a declaration that never compiled. Each
 * directive below IS the assertion: an unused `@ts-expect-error` fails
 * typecheck, so a requirement quietly dropped reds here rather than shipping.
 */
describe('what a route posture must declare', () => {
  it('refuses a named declaration that names no failure posture', () => {
    // @ts-expect-error -- a named route declares both dimensions; `failure` is not optional
    const missing: RoutePosture = { kind: 'named', keyedBy: ['ip'] };

    expect(missing.kind).toBe('named');
  });

  it('refuses a class-default declaration that names no failure posture', () => {
    // @ts-expect-error -- a class default is not the source of a failure posture; the route declares one
    const missing: RoutePosture = { kind: 'default' };

    expect(missing.kind).toBe('default');
  });

  it('refuses a failure posture on an exempt declaration', () => {
    // @ts-expect-error -- an exemption reaches no counter, so it has no unspendable case to answer for
    const spurious: RoutePosture = { kind: 'exempt', exemption: 'constant-cost', failure: 'open' };

    expect(spurious.kind).toBe('exempt');
  });

  it('refuses an edge layer keyed on an identity only a slice flow resolves', () => {
    const posture = bindRoutePosture({
      failure: 'closed',
      layers: [
        // @ts-expect-error -- the pipeline stage resolves no claimed account, so that identity is declarable on a flow layer alone
        { identity: 'claimed-account', countedAt: 'edge', definition: throttle('capability:edge') },
      ],
    });

    expect(posture.keyedBy).toStrictEqual(['claimed-account']);
  });

  it('accepts that same identity on a flow layer', () => {
    // The positive control for the directive above: what is refused is WHERE
    // the layer is counted, never the identity being outside the vocabulary.
    // Without this pair the first case reads the same whether the split holds
    // or the identity was simply misspelled.
    const posture = bindRoutePosture({
      failure: 'closed',
      layers: [
        { identity: 'claimed-account', countedAt: 'flow', definition: throttle('capability:flow') },
      ],
    });

    expect(posture.keyedBy).toStrictEqual(['claimed-account']);
  });

  it('refuses an edge layer keyed on an account within one network', () => {
    const posture = bindRoutePosture({
      failure: 'closed',
      layers: [
        // @ts-expect-error -- the account half of that pair arrives in a body the pipeline stage never parses, so the identity is declarable on a flow layer alone
        {
          identity: 'claimed-account-per-network',
          countedAt: 'edge',
          definition: throttle('capability:edge-networked'),
        },
      ],
    });

    expect(posture.keyedBy).toStrictEqual(['claimed-account-per-network']);
  });

  it('accepts an account within one network on a flow layer', () => {
    const posture = bindRoutePosture({
      failure: 'closed',
      layers: [
        {
          identity: 'claimed-account-per-network',
          countedAt: 'flow',
          definition: throttle('capability:flow-networked'),
        },
      ],
    });

    expect(posture.keyedBy).toStrictEqual(['claimed-account-per-network']);
  });

  it('accepts either value on a counted route', () => {
    const open: RoutePosture = { kind: 'default', failure: 'open' };
    const closed: RoutePosture = { kind: 'default', failure: 'closed' };

    expect([open, closed].map((posture) => posture.kind)).toStrictEqual(['default', 'default']);
  });
});

describe('CarriedRoutePosture', () => {
  it('widens only the named arm, leaving the others assignable as they were', () => {
    expectTypeOf<CarriedRoutePosture>().toExtend<RoutePosture>();
  });

  it('carries the class-default and exempt arms unchanged', () => {
    expectTypeOf<Exclude<CarriedRoutePosture, { kind: 'named' }>>().toEqualTypeOf<
      Exclude<RoutePosture, { kind: 'named' }>
    >();
  });
});
