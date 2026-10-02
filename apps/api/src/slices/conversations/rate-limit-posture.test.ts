import { describe, expect, expectTypeOf, it } from 'vitest';
import { clear, rateLimitKey } from '../../lib/rate-limit/index.js';
import { reachableFrom } from '../../test-support/rate-limit-reachability.js';
import { scriptedRateLimitRedis } from '../../test-support/rate-limit-double.js';
import { CONVERSATIONS_ROUTE_POSTURES } from './index.js';
import {
  guestConversationIpRateLimit,
  linkCreateRateLimit,
  memberKeysBatchRateLimit,
  publicShareReadRateLimit,
  shareCreateRateLimit,
} from './domain/rate-limit.js';
import type { CarriedRoutePosture, SliceRouteKey } from '../../lib/rate-limit/index.js';
import type { ConversationsRouteKey } from './rate-limit-posture.js';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type { Hono } from 'hono';

const GUEST_REACHABLE = [
  '$get /conversations/:conversationId',
  '$get /conversations/:conversationId/websocket',
  '$post /conversations/:conversationId/websocket-ticket',
  '$get /conversations/:conversationId/members',
  '$get /conversations/:conversationId/funding',
  '$get /conversations/:conversationId/keychain',
  '$get /conversations/:conversationId/member-keys',
  '$get /conversations/:conversationId/my-name',
  '$patch /conversations/:conversationId/my-name',
  '$get /conversations/:conversationId/messages',
  '$get /conversations/:conversationId/links',
] as const;

const LINK_MINT = '$post /conversations/:conversationId/links';
const SHARE_CREATE = '$post /conversations/:conversationId/shares';
const KEYCHAIN_BATCH = '$get /conversations/member-keys/batch';
const SHARE_READ = '$get /conversations/shared/message/:shareId';

const ENTRIES = [
  guestConversationIpRateLimit,
  linkCreateRateLimit,
  memberKeysBatchRateLimit,
  publicShareReadRateLimit,
  shareCreateRateLimit,
];

async function keysTouchedBy(
  posture: CarriedRoutePosture,
  ids: readonly (string | null)[],
  replies?: readonly string[]
): Promise<string[]> {
  if (posture.kind !== 'named' || posture.countAtEdge === undefined) {
    throw new Error('the route declares no edge capability');
  }
  const { redis, keys } =
    replies === undefined ? scriptedRateLimitRedis() : scriptedRateLimitRedis(replies);
  const decision = await posture.countAtEdge.count(redis, ids);
  expect(decision.isOk()).toBe(true);
  expect(decision._unsafeUnwrap().allowed).toBe(true);
  return keys;
}

describe('the conversations posture fragment', () => {
  it('derives a non-empty route-key union from its own manifest', () => {
    expectTypeOf<ConversationsRouteKey>().not.toBeNever();
  });

  it('resolves that union to nothing when the sub-router has erased its schema', () => {
    // The matched control for the assertion above: an annotated sub-router
    // widens to `BlankSchema`, the key union collapses to `never`, and a
    // fragment then satisfies its target vacuously. The pair is what makes the
    // first assertion a discrimination rather than a formality.
    expectTypeOf<SliceRouteKey<{ basePath: '/conversations'; routes: Hono<AppEnv> }>>().toBeNever();
  });

  it('declares at least one route', () => {
    expect(Object.keys(CONVERSATIONS_ROUTE_POSTURES).length).toBeGreaterThan(0);
  });

  it('names the sessionless IP on every route a link guest can reach', () => {
    for (const key of GUEST_REACHABLE) {
      expect(CONVERSATIONS_ROUTE_POSTURES[key].keyedBy).toStrictEqual(['sessionless-ip']);
      expect(CONVERSATIONS_ROUTE_POSTURES[key].countAtEdge?.keyedBy).toStrictEqual([
        'sessionless-ip',
      ]);
    }
  });

  it('spends one shared window from every guest-reachable route', async () => {
    // One entry across the whole set: the cap is on credential resolutions per
    // IP per minute, not per path, so each capability has to derive the SAME key.
    // The entries are unreachable from the published value, so the key each
    // `buildKey` derives is the only thing that can say so.
    const expected = [rateLimitKey(guestConversationIpRateLimit, 'ip-hash')._unsafeUnwrap()];
    for (const key of GUEST_REACHABLE) {
      expect(await keysTouchedBy(CONVERSATIONS_ROUTE_POSTURES[key], ['ip-hash'])).toStrictEqual(
        expected
      );
    }
  });

  it('counts the link mint on the account identity alone', () => {
    // The mint is `session`-classed, so every caller it can serve holds a full
    // session — and the guest window declines to count one. A layer keyed on
    // that window here would spend no counter for any admitted caller, in any
    // position, so the mint's per-account window is the whole declaration.
    expect(CONVERSATIONS_ROUTE_POSTURES[LINK_MINT].keyedBy).toStrictEqual(['user']);
    expect(CONVERSATIONS_ROUTE_POSTURES[LINK_MINT].countAtEdge?.keyedBy).toStrictEqual(['user']);
  });

  it('spends the mint entry on the link mint', async () => {
    expect(await keysTouchedBy(CONVERSATIONS_ROUTE_POSTURES[LINK_MINT], ['user-id'])).toStrictEqual(
      [rateLimitKey(linkCreateRateLimit, 'user-id')._unsafeUnwrap()]
    );
  });

  it('spends the share-create entry on the shared-message create', async () => {
    expect(CONVERSATIONS_ROUTE_POSTURES[SHARE_CREATE].keyedBy).toStrictEqual(['caller']);
    expect(
      await keysTouchedBy(CONVERSATIONS_ROUTE_POSTURES[SHARE_CREATE], ['caller-id'])
    ).toStrictEqual([rateLimitKey(shareCreateRateLimit, 'caller-id')._unsafeUnwrap()]);
  });

  it('spends the batch-keychain entry on the batch read', async () => {
    expect(CONVERSATIONS_ROUTE_POSTURES[KEYCHAIN_BATCH].keyedBy).toStrictEqual(['user']);
    expect(
      await keysTouchedBy(CONVERSATIONS_ROUTE_POSTURES[KEYCHAIN_BATCH], ['user-id'])
    ).toStrictEqual([rateLimitKey(memberKeysBatchRateLimit, 'user-id')._unsafeUnwrap()]);
  });

  it('spends the share-read entry on the public share read', async () => {
    expect(CONVERSATIONS_ROUTE_POSTURES[SHARE_READ].keyedBy).toStrictEqual(['ip']);
    expect(
      await keysTouchedBy(CONVERSATIONS_ROUTE_POSTURES[SHARE_READ], ['ip-hash'])
    ).toStrictEqual([rateLimitKey(publicShareReadRateLimit, 'ip-hash')._unsafeUnwrap()]);
  });

  it('cites nothing in flow anywhere, because this slice spends no counter in its domain', () => {
    const cited = Object.values(CONVERSATIONS_ROUTE_POSTURES).flatMap((posture) =>
      posture.kind === 'named' ? posture.countedInFlow : []
    );
    expect(cited).toStrictEqual([]);
  });

  it('pins the exact set of routes it declares default', () => {
    const backstopped = new Set(
      Object.entries(CONVERSATIONS_ROUTE_POSTURES)
        .filter(([, posture]) => posture.kind === 'default')
        .map(([key]) => key)
    );
    expect(backstopped).toStrictEqual(
      new Set([
        '$post /conversations',
        '$get /conversations',
        '$patch /conversations/:conversationId',
        '$delete /conversations/:conversationId',
        '$post /conversations/:conversationId/members',
        '$post /conversations/:conversationId/members/:memberId/remove',
        '$post /conversations/:conversationId/leave',
        '$post /conversations/:conversationId/epochs',
        '$patch /conversations/:conversationId/membership/mute',
        '$patch /conversations/:conversationId/membership/pin',
        '$patch /conversations/:conversationId/read',
        '$patch /conversations/:conversationId/membership/accept',
        '$post /conversations/:conversationId/membership/decline',
        '$patch /conversations/:conversationId/member/:memberId/privilege',
        '$put /conversations/:conversationId/member/:memberId/budget',
        '$put /conversations/:conversationId/budget',
        '$get /conversations/:conversationId/budgets',
        '$get /conversations/:conversationId/forks',
        '$post /conversations/:conversationId/forks',
        '$patch /conversations/:conversationId/forks/:forkId',
        '$put /conversations/:conversationId/forks/:forkId/tip',
        '$delete /conversations/:conversationId/forks/:forkId',
        '$post /conversations/:conversationId/links/:linkId/revoke',
        '$patch /conversations/:conversationId/links/:linkId/privilege',
        '$patch /conversations/:conversationId/links/:linkId/name',
      ])
    );
  });

  it('descends into what the fragment does publish', () => {
    // The positive control for the five assertions below: a walk that reached
    // nothing would report every leak absent and read exactly like a clean one.
    expect(reachableFrom(CONVERSATIONS_ROUTE_POSTURES)).toContain('sessionless-ip');
  });

  it('reaches no registry entry through the barrel', () => {
    const reachable = reachableFrom(CONVERSATIONS_ROUTE_POSTURES);
    for (const entry of ENTRIES) expect(reachable).not.toContain(entry);
  });

  it('reaches no key builder through the barrel', () => {
    const reachable = reachableFrom(CONVERSATIONS_ROUTE_POSTURES);
    for (const entry of ENTRIES) expect(reachable).not.toContain(entry.buildKey);
  });

  it('reaches no key prefix through the barrel', () => {
    const strings = reachableFrom(CONVERSATIONS_ROUTE_POSTURES).filter(
      (value) => typeof value === 'string'
    );
    expect(strings.filter((value) => value.includes('ratelimit:'))).toStrictEqual([]);
  });

  it('reaches neither cap nor window through the barrel', () => {
    const caps = new Set<number>(
      ENTRIES.flatMap((entry) => [entry.maxAttempts, entry.windowSeconds])
    );
    const numbers = reachableFrom(CONVERSATIONS_ROUTE_POSTURES).filter(
      (value) => typeof value === 'number'
    );
    expect(numbers.filter((value) => caps.has(value))).toStrictEqual([]);
  });

  it('reaches one callable per counted route, and none of them is the disarm', () => {
    const callables = reachableFrom(CONVERSATIONS_ROUTE_POSTURES).filter(
      (value) => typeof value === 'function'
    );
    expect(callables).toHaveLength(GUEST_REACHABLE.length + 4);
    expect(callables).not.toContain(clear);
  });
});
