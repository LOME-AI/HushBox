import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { registeredRouteKeys, routeKey } from '../lib/context/index.js';
import { IDENTITIES_SKIPPING_FULL_PRINCIPAL, POSTURE_IDENTITIES } from '../lib/rate-limit/index.js';
import { readRouteClass } from '../middleware/pipeline-markers.js';
import { ACCOUNT_ROUTE_POSTURES } from '../slices/account/index.js';
import { ADMIN_ROUTE_POSTURES } from '../slices/admin/index.js';
import { ANNOUNCEMENTS_ROUTE_POSTURES } from '../slices/announcements/index.js';
import { BILLING_ROUTE_POSTURES } from '../slices/billing/index.js';
import { CHAT_ROUTE_POSTURES } from '../slices/chat/index.js';
import { CONVERSATIONS_ROUTE_POSTURES } from '../slices/conversations/index.js';
import { FEEDBACK_ROUTE_POSTURES } from '../slices/feedback/index.js';
import { GROWTH_ROUTE_POSTURES } from '../slices/growth/index.js';
import { IDENTITY_ROUTE_POSTURES } from '../slices/identity/index.js';
import { MEDIA_ROUTE_POSTURES } from '../slices/media/index.js';
import { MODEL_WEIGHTS_ROUTE_POSTURES } from '../slices/model-weights/index.js';
import { MODELS_ROUTE_POSTURES } from '../slices/models/index.js';
import { NEWSLETTER_ROUTE_POSTURES } from '../slices/newsletter/index.js';
import { NOTIFICATIONS_ROUTE_POSTURES } from '../slices/notifications/index.js';
import { ROADMAP_ROUTE_POSTURES } from '../slices/roadmap/index.js';
import { STATS_ROUTE_POSTURES } from '../slices/stats/index.js';
import { UPDATES_ROUTE_POSTURES } from '../slices/updates/index.js';
import { ROUTE_POSTURES, SLICE_ROUTE_POSTURES } from './rate-limit-posture.js';

/**
 * Each fragment beside the slice that owns it. The compiler holds the merge
 * complete, and holds no fragment to declaring only its own slice's routes: a
 * fragment whose `satisfies` target cites another slice's manifest — or one
 * deriving an empty key union — compiles, and the keys it wrongly claims then
 * REPLACE the owner's, because a later spread member wins. That is invisible to
 * `satisfies` on both sides, so the two cases below are what sees it.
 *
 * The list is held honest by the second case rather than by review: a fragment
 * merged but missing here leaves its keys claimed by nobody.
 */
const FRAGMENTS_BY_OWNER = [
  ['account', ACCOUNT_ROUTE_POSTURES],
  ['admin', ADMIN_ROUTE_POSTURES],
  ['announcements', ANNOUNCEMENTS_ROUTE_POSTURES],
  ['billing', BILLING_ROUTE_POSTURES],
  ['chat', CHAT_ROUTE_POSTURES],
  ['conversations', CONVERSATIONS_ROUTE_POSTURES],
  ['feedback', FEEDBACK_ROUTE_POSTURES],
  ['growth', GROWTH_ROUTE_POSTURES],
  ['identity', IDENTITY_ROUTE_POSTURES],
  ['media', MEDIA_ROUTE_POSTURES],
  ['model-weights', MODEL_WEIGHTS_ROUTE_POSTURES],
  ['models', MODELS_ROUTE_POSTURES],
  ['newsletter', NEWSLETTER_ROUTE_POSTURES],
  ['notifications', NOTIFICATIONS_ROUTE_POSTURES],
  ['roadmap', ROADMAP_ROUTE_POSTURES],
  ['stats', STATS_ROUTE_POSTURES],
  ['updates', UPDATES_ROUTE_POSTURES],
] as const satisfies readonly (readonly [string, object])[];

/** Which slices declare each route key, in merge order. */
function ownersByRouteKey(): ReadonlyMap<string, readonly string[]> {
  const owners = new Map<string, readonly string[]>();
  for (const [slice, fragment] of FRAGMENTS_BY_OWNER) {
    for (const key of Object.keys(fragment)) {
      owners.set(key, [...(owners.get(key) ?? []), slice]);
    }
  }
  return owners;
}

describe('the slice half of the merge', () => {
  it('lets no route key be declared by two slices at once', () => {
    const contested = [...ownersByRouteKey()]
      .filter(([, slices]) => slices.length > 1)
      .map(([key, slices]) => `${key}: ${slices.join(', ')}`);
    expect(contested).toEqual([]);
  });

  it('takes every key it carries from a fragment named above', () => {
    const owners = ownersByRouteKey();
    const unclaimed = Object.keys(SLICE_ROUTE_POSTURES).filter((key) => !owners.has(key));
    expect(unclaimed).toEqual([]);
  });
});

/**
 * The witness map's own witness. `ROUTE_POSTURES` is checked against `AppType`
 * by the compiler, which can only see routes the `.route()` chain carries into
 * that type; walking the assembled router instead is what shows a route the
 * type has lost.
 */
describe('the posture map against the assembled router', () => {
  it('declares a posture for every route the router serves', () => {
    const undeclared = [...registeredRouteKeys(createApp().routes)].filter(
      (key) => !(key in ROUTE_POSTURES)
    );
    expect(undeclared).toEqual([]);
  });

  it('declares a posture for no route the router does not serve', () => {
    const registered = registeredRouteKeys(createApp().routes);
    const orphans = Object.keys(ROUTE_POSTURES).filter((key) => !registered.has(key));
    expect(orphans).toEqual([]);
  });
});

/**
 * The routes whose named limits count no caller holding a full session: every
 * identity they key on skips one. Each was read off its declaration —
 * `/chat/stop` and the `public`-classed `/conversations/:conversationId…`
 * routes carrying the shared guest cap are all keyed on the same
 * skip-a-full-principal identity. No `session`-classed route can join them:
 * the case named for a session-classed route declaring a skipping layer
 * refuses such a layer there at all, because it counts no caller that class
 * admits.
 *
 * Two of the members serve a full session nothing behind the Worker: the
 * funding read and the `my-name` write answer a non-guest `forbidden` before
 * they touch any store, so what goes uncounted there is a constant-cost
 * refusal. The rest answer a full session with real database work.
 *
 * They are named rather than derived because the list IS the finding: sizing a
 * per-principal layer for them is a per-route judgement, and until it is made
 * this set is what a reader needs to see. A new member fails here.
 */
const UNBOUNDED_FOR_FULL_SESSIONS = [
  '$post /chat/stop',
  '$get /conversations/:conversationId/funding',
  '$get /conversations/:conversationId/keychain',
  '$get /conversations/:conversationId/links',
  '$get /conversations/:conversationId/member-keys',
  '$get /conversations/:conversationId/members',
  '$get /conversations/:conversationId/messages',
  '$get /conversations/:conversationId/my-name',
  '$patch /conversations/:conversationId/my-name',
  '$get /conversations/:conversationId/websocket',
  '$post /conversations/:conversationId/websocket-ticket',
  '$get /conversations/:conversationId',
];

describe('what the declared postures bound', () => {
  it('leaves a full-session caller unbounded on exactly the routes known to lack a per-principal layer', () => {
    const unbounded = Object.entries(ROUTE_POSTURES)
      .filter(
        ([, posture]) =>
          posture.kind === 'named' &&
          posture.keyedBy.every((identity) =>
            (IDENTITIES_SKIPPING_FULL_PRINCIPAL as readonly string[]).includes(identity)
          )
      )
      .map(([key]) => key);
    const byName = (a: string, b: string): number => a.localeCompare(b);
    expect(unbounded.toSorted(byName)).toEqual(UNBOUNDED_FOR_FULL_SESSIONS.toSorted(byName));
  });

  it('finds the session-classed routes the skipping-layer case walks', () => {
    // The positive control for it: a walk that resolved no route class would
    // report every posture clean and read exactly like a tree with none to
    // report.
    const sessionClassed = [...createApp().routes].filter(
      (route) => readRouteClass(route.handler) === 'session'
    );

    expect(sessionClassed.length).toBeGreaterThan(0);
  });

  it('leaves no session-classed route declaring a layer keyed on an identity that skips a full principal', () => {
    // `session` is the one class whose authorization matrix admits full
    // principals and NOTHING else, and every identity in
    // `IDENTITIES_SKIPPING_FULL_PRINCIPAL` deliberately declines to count one.
    // Such a layer on such a route therefore spends no counter for any caller
    // the route can serve — dead in every position, not only when it is the
    // route's only layer. Where it IS the only layer the route is left counted
    // by nothing at all, because `named` has already opted it out of the class
    // default. Read off the assembled router rather than listed: the class
    // travels on the handler, so a route re-classed to `session` is caught here
    // without anyone remembering to revisit its posture.
    const declaringADeadLayer = [...createApp().routes]
      .filter((route) => readRouteClass(route.handler) === 'session')
      .map((route) => routeKey(route))
      .filter((key) => {
        const posture = Object.hasOwn(ROUTE_POSTURES, key) ? ROUTE_POSTURES[key] : undefined;
        return (
          posture?.kind === 'named' &&
          posture.keyedBy.some((identity) =>
            (IDENTITIES_SKIPPING_FULL_PRINCIPAL as readonly string[]).includes(identity)
          )
        );
      });

    expect([...new Set(declaringADeadLayer)]).toEqual([]);
  });

  it('keys every named posture on identities drawn from the closed set', () => {
    const offenders = Object.entries(ROUTE_POSTURES)
      .filter(([, posture]) => posture.kind === 'named')
      .filter(([, posture]) => {
        const keyedBy = posture.kind === 'named' ? posture.keyedBy : [];
        return keyedBy.some(
          (identity) => !(POSTURE_IDENTITIES as readonly string[]).includes(identity)
        );
      })
      .map(([key]) => key);
    expect(offenders).toEqual([]);
  });
});
