import { describe, expect, expectTypeOf, it } from 'vitest';
import { clear, countedInFlow, rateLimitKey } from '../../lib/rate-limit/index.js';
import { reachableFrom } from '../../test-support/rate-limit-reachability.js';
import { MEDIA_ROUTE_POSTURES } from './index.js';
import { MEDIA_RATE_LIMITS } from './domain/rate-limit.js';
import type {
  CountAtEdge,
  RateLimitDefinition,
  SliceRouteKey,
} from '../../lib/rate-limit/index.js';
import type { MediaRouteKey } from './rate-limit-posture.js';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type { Hono } from 'hono';

const MEMBER = '$get /media/:contentItemId/download-url';
const SHARE = '$get /media/shared/:shareId/:contentItemId/download-url';

/** The entries this slice's fragment cites, so the leak walk can name each one. */
const CITED_ENTRIES: readonly RateLimitDefinition[] = [
  MEDIA_RATE_LIMITS.mediaDownloadGuestIpRateLimit,
  MEDIA_RATE_LIMITS.mediaDownloadUserRateLimit,
  MEDIA_RATE_LIMITS.mediaDownloadLinkLookupRateLimit,
  MEDIA_RATE_LIMITS.mediaDownloadLinkMintRateLimit,
  MEDIA_RATE_LIMITS.sharePresignIpRateLimit,
];

/** The Redis handle `count` takes, named off the capability rather than the infra module. */
type CountRedis = Parameters<CountAtEdge['count']>[0];

/**
 * Records the key list of each script call as a GROUP, so a single
 * all-or-nothing call over three entries is distinguishable from three calls
 * over one entry each. The shared `scriptedRateLimitRedis` flattens them and
 * cannot tell those apart, and all-or-nothing across the member path's layers
 * is the property this route's layered declaration exists to hold.
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

describe('the media posture fragment', () => {
  it('derives a non-empty route-key union from its own manifest', () => {
    expectTypeOf<MediaRouteKey>().not.toBeNever();
  });

  it('resolves that union to nothing when the sub-router has erased its schema', () => {
    // The matched control for the assertion above: an annotated sub-router
    // widens to `BlankSchema`, the key union collapses to `never`, and a
    // fragment then satisfies its target vacuously. The pair is what makes the
    // first assertion a discrimination rather than a formality.
    expectTypeOf<SliceRouteKey<{ basePath: '/media'; routes: Hono<AppEnv> }>>().toBeNever();
  });

  it('declares at least one route', () => {
    expect(Object.keys(MEDIA_ROUTE_POSTURES).length).toBeGreaterThan(0);
  });
});

describe('the member download path, which spends four counters', () => {
  it('names one identity per layer, wherever each is counted', () => {
    // Four positions: the three the declaration spends at the edge, then the
    // per-link mint window the handler spends once the credential has resolved
    // to a linkId. `keyedBy` spans both, and the repeated 'link-credential' is
    // the fourth layer rather than a duplicate to fold away.
    expect(MEDIA_ROUTE_POSTURES[MEMBER].keyedBy).toStrictEqual([
      'sessionless-ip',
      'caller',
      'link-credential',
      'link-credential',
    ]);
  });

  it('takes only the three edge identities in its edge call', () => {
    expect(MEDIA_ROUTE_POSTURES[MEMBER].countAtEdge?.keyedBy).toStrictEqual([
      'sessionless-ip',
      'caller',
      'link-credential',
    ]);
  });

  it('spends its three edge entries in one round trip, in declared order', async () => {
    const { redis, calls } = groupingRedis();
    const edge = MEDIA_ROUTE_POSTURES[MEMBER].countAtEdge;
    if (edge === undefined) throw new Error('the member download declares no edge capability');
    const decision = await edge.count(redis, ['ip-hash', 'caller-id', 'credential-hash']);
    expect(decision.isOk()).toBe(true);
    expect(calls).toStrictEqual([
      [
        rateLimitKey(MEDIA_RATE_LIMITS.mediaDownloadGuestIpRateLimit, 'ip-hash')._unsafeUnwrap(),
        rateLimitKey(MEDIA_RATE_LIMITS.mediaDownloadUserRateLimit, 'caller-id')._unsafeUnwrap(),
        rateLimitKey(
          MEDIA_RATE_LIMITS.mediaDownloadLinkLookupRateLimit,
          'credential-hash'
        )._unsafeUnwrap(),
      ],
    ]);
  });

  it('spends nothing for a caller every edge layer skips', async () => {
    // A full principal is skipped by the sessionless-IP and link-credential
    // resolvers and keys by userId on the caller layer, so a route can reach
    // the edge call with fewer identities than layers; three nulls is the
    // degenerate case of that, and it must touch no counter at all.
    const { redis, calls } = groupingRedis();
    const edge = MEDIA_ROUTE_POSTURES[MEMBER].countAtEdge;
    if (edge === undefined) throw new Error('the member download declares no edge capability');
    const decision = await edge.count(redis, [null, null, null]);
    expect(decision.isOk()).toBe(true);
    expect(calls).toStrictEqual([]);
  });

  it('cites the per-link mint window in flow, and not the lookup window it fronts', () => {
    // Discriminating: the two per-link entries are separate objects, so this
    // says WHICH of them the handler spends. The lookup window is spent at the
    // edge and would be a citation of the wrong side of the resolution.
    expect(MEDIA_ROUTE_POSTURES[MEMBER].countedInFlow).toStrictEqual([
      countedInFlow(MEDIA_RATE_LIMITS.mediaDownloadLinkMintRateLimit),
    ]);
    expect(MEDIA_ROUTE_POSTURES[MEMBER].countedInFlow).not.toContain(
      countedInFlow(MEDIA_RATE_LIMITS.mediaDownloadLinkLookupRateLimit)
    );
  });
});

describe('the share download path', () => {
  it('names the address it counts at the edge ahead of the share it counts in flow', () => {
    expect(MEDIA_ROUTE_POSTURES[SHARE].keyedBy).toStrictEqual(['ip', 'claimed-share']);
  });

  it('leaves the edge call keyed on the address alone', () => {
    expect(MEDIA_ROUTE_POSTURES[SHARE].countAtEdge?.keyedBy).toStrictEqual(['ip']);
  });

  it('spends the share presign entry, and no other, on the identity it is given', async () => {
    const { redis, calls } = groupingRedis();
    const edge = MEDIA_ROUTE_POSTURES[SHARE].countAtEdge;
    if (edge === undefined) throw new Error('the share download declares no edge capability');
    const decision = await edge.count(redis, ['ip-hash']);
    expect(decision.isOk()).toBe(true);
    expect(calls).toStrictEqual([
      [rateLimitKey(MEDIA_RATE_LIMITS.sharePresignIpRateLimit, 'ip-hash')._unsafeUnwrap()],
    ]);
  });

  it('cites the re-mint counter the handler spends on the share it was asked for', () => {
    expect(MEDIA_ROUTE_POSTURES[SHARE].countedInFlow).toStrictEqual([
      countedInFlow(MEDIA_RATE_LIMITS.sharePresignRemintRateLimit),
    ]);
  });

  it('does not cite the member path per-link mint counter on the share path', () => {
    // What makes the citation above discriminating: the two flow-counted media
    // entries are distinct objects, so the binding factory memoizes distinct
    // references and this assertion reads WHICH counter is cited.
    expect(MEDIA_ROUTE_POSTURES[SHARE].countedInFlow).not.toContain(
      countedInFlow(MEDIA_RATE_LIMITS.mediaDownloadLinkMintRateLimit)
    );
  });
});

describe('what the media barrel publishes with the fragment', () => {
  it('descends into what the fragment does publish', () => {
    // The positive control for the assertions below: a walk that reached
    // nothing would report every leak absent and read exactly like a clean one.
    const reachable = reachableFrom(MEDIA_ROUTE_POSTURES);
    expect(reachable).toContain('link-credential');
    expect(reachable).toContain('ip');
  });

  it('reaches no registry entry the fragment cites', () => {
    const reachable = reachableFrom(MEDIA_ROUTE_POSTURES);
    for (const entry of CITED_ENTRIES) expect(reachable).not.toContain(entry);
  });

  it('reaches no key builder', () => {
    const reachable = reachableFrom(MEDIA_ROUTE_POSTURES);
    for (const entry of CITED_ENTRIES) expect(reachable).not.toContain(entry.buildKey);
  });

  it('reaches no key prefix', () => {
    const strings = reachableFrom(MEDIA_ROUTE_POSTURES).filter(
      (value) => typeof value === 'string'
    );
    expect(strings.filter((value) => value.includes('ratelimit:'))).toStrictEqual([]);
  });

  it('reaches neither cap nor window', () => {
    const caps = new Set(
      CITED_ENTRIES.flatMap((entry) => [entry.maxAttempts, entry.windowSeconds])
    );
    const numbers = reachableFrom(MEDIA_ROUTE_POSTURES).filter(
      (value) => typeof value === 'number'
    );
    expect(numbers.filter((value) => caps.has(value))).toStrictEqual([]);
  });

  it('reaches one callable per edge-counted route, and neither is the disarm', () => {
    const callables = reachableFrom(MEDIA_ROUTE_POSTURES).filter(
      (value) => typeof value === 'function'
    );
    expect(callables).toHaveLength(2);
    expect(callables).not.toContain(clear);
  });
});
