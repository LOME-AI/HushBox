import { bindRoutePosture } from '../../lib/rate-limit/index.js';
import {
  guestConversationIpRateLimit,
  linkCreateRateLimit,
  memberKeysBatchRateLimit,
  publicShareReadRateLimit,
  shareCreateRateLimit,
} from './domain/rate-limit.js';
import type { CarriedRoutePosture, SliceRouteKey } from '../../lib/rate-limit/index.js';
import type { createConversationsManifest } from './routes.js';

/**
 * The route keys this slice contributes, derived from its own manifest. A route
 * added, renamed or removed moves this union, so the declaration below stops
 * compiling until it moves with it.
 */
export type ConversationsRouteKey = SliceRouteKey<ReturnType<typeof createConversationsManifest>>;

/**
 * # How this slice's routes are bounded
 *
 * The declaration crosses the slice perimeter as a BOUND COUNTING CAPABILITY,
 * never as a registry entry: `bindRoutePosture` closes over the entries, and a
 * closure's captures have no reflection surface, so the caps, windows, key
 * material and the `clear` disarm stay unreachable from everything this module
 * publishes.
 *
 * Each route below carries the bounds it is counted under:
 *
 * - The guest window is the widest. Every route a link guest can reach
 *   resolves a caller-chosen credential or ticket, so ONE entry spans them all
 *   and is keyed on the sessionless IP — rotating the credential or ticket
 *   would otherwise mint a fresh window per request. It is spent ahead of that
 *   resolution, so it also counts a caller presenting no credential at all,
 *   which answers 401 and looks nothing up. It counts nobody holding a full
 *   session, which is why a route keyed only on it is bounded for guests and
 *   unbounded for session holders — and why it sits on `public`-classed
 *   routes alone. A `session`-classed route
 *   admits full principals and nothing else, so the window there would count no
 *   caller the route can serve, in any layer position; the composition suite's
 *   case for a session-classed route declaring a skipping layer refuses one.
 * - The link mint carries a per-account window instead. It is the volume bound
 *   on `shared_links` rows, which the member cap does not supply: a lapsed or
 *   revoked link holds no member slot. The mint is `session`-classed and
 *   POST-only, so it carries that window alone, while the link LIST on the same
 *   path is `public`-classed and carries the guest window alone.
 * - Shared-message creation and the batch keychain read each carry one window
 *   of their own, the create keyed on the caller and the batch read on the
 *   account: the first is what inserts `shared_messages` rows, the second is
 *   the most expensive authenticated read the slice answers. Both
 *   windows are spent ahead of body and query validation, so each also counts
 *   requests that insert and read nothing.
 * - The public share read is unauthenticated, so it is keyed on the plain IP
 *   and throttles link-id scraping.
 *
 * Everything else is session-classed work.
 * Nothing in this slice's domain spends a counter, so no route cites one in
 * flow.
 *
 * The failure axis follows who can reach a route. Every guest-reachable route
 * declares `closed`: the counter is what stands between an unauthenticated
 * caller and the resolution of its credential or ticket plus the conversation
 * read behind it, and a caller presenting no session is exactly the one no
 * earlier stage has bounded. The session-classed routes on their class
 * default declare `open` with the rest of that class — one authenticated
 * account is the bound there, and refusing would take a signed-in member's
 * own conversations away from
 * them for the length of a degradation. The session-classed routes carrying a
 * named window of their own declare `closed` instead: each has one because the
 * class default is not the bound it needs — the link mint and shared-message
 * creation bound the rows they insert, and the batch keychain read is the most
 * expensive authenticated read the slice answers — so an unspendable counter
 * would remove exactly the bound the window exists to be.
 */
export const CONVERSATIONS_ROUTE_POSTURES = {
  '$post /conversations': { kind: 'default', failure: 'open' },
  '$get /conversations': { kind: 'default', failure: 'open' },
  '$get /conversations/:conversationId': bindRoutePosture({
    failure: 'closed',
    layers: [
      { identity: 'sessionless-ip', countedAt: 'edge', definition: guestConversationIpRateLimit },
    ],
  }),
  '$patch /conversations/:conversationId': { kind: 'default', failure: 'open' },
  '$delete /conversations/:conversationId': { kind: 'default', failure: 'open' },
  '$get /conversations/:conversationId/websocket': bindRoutePosture({
    failure: 'closed',
    layers: [
      { identity: 'sessionless-ip', countedAt: 'edge', definition: guestConversationIpRateLimit },
    ],
  }),
  '$post /conversations/:conversationId/websocket-ticket': bindRoutePosture({
    failure: 'closed',
    layers: [
      { identity: 'sessionless-ip', countedAt: 'edge', definition: guestConversationIpRateLimit },
    ],
  }),
  '$get /conversations/:conversationId/members': bindRoutePosture({
    failure: 'closed',
    layers: [
      { identity: 'sessionless-ip', countedAt: 'edge', definition: guestConversationIpRateLimit },
    ],
  }),
  '$post /conversations/:conversationId/members': { kind: 'default', failure: 'open' },
  '$post /conversations/:conversationId/members/:memberId/remove': {
    kind: 'default',
    failure: 'open',
  },
  '$post /conversations/:conversationId/leave': { kind: 'default', failure: 'open' },
  '$post /conversations/:conversationId/epochs': { kind: 'default', failure: 'open' },
  '$patch /conversations/:conversationId/membership/mute': { kind: 'default', failure: 'open' },
  '$patch /conversations/:conversationId/membership/pin': { kind: 'default', failure: 'open' },
  '$patch /conversations/:conversationId/read': { kind: 'default', failure: 'open' },
  '$patch /conversations/:conversationId/membership/accept': { kind: 'default', failure: 'open' },
  '$post /conversations/:conversationId/membership/decline': { kind: 'default', failure: 'open' },
  '$patch /conversations/:conversationId/member/:memberId/privilege': {
    kind: 'default',
    failure: 'open',
  },
  '$put /conversations/:conversationId/member/:memberId/budget': {
    kind: 'default',
    failure: 'open',
  },
  '$put /conversations/:conversationId/budget': { kind: 'default', failure: 'open' },
  '$get /conversations/:conversationId/budgets': { kind: 'default', failure: 'open' },
  '$get /conversations/:conversationId/funding': bindRoutePosture({
    failure: 'closed',
    layers: [
      { identity: 'sessionless-ip', countedAt: 'edge', definition: guestConversationIpRateLimit },
    ],
  }),
  '$get /conversations/:conversationId/keychain': bindRoutePosture({
    failure: 'closed',
    layers: [
      { identity: 'sessionless-ip', countedAt: 'edge', definition: guestConversationIpRateLimit },
    ],
  }),
  '$get /conversations/:conversationId/member-keys': bindRoutePosture({
    failure: 'closed',
    layers: [
      { identity: 'sessionless-ip', countedAt: 'edge', definition: guestConversationIpRateLimit },
    ],
  }),
  '$get /conversations/:conversationId/my-name': bindRoutePosture({
    failure: 'closed',
    layers: [
      { identity: 'sessionless-ip', countedAt: 'edge', definition: guestConversationIpRateLimit },
    ],
  }),
  '$patch /conversations/:conversationId/my-name': bindRoutePosture({
    failure: 'closed',
    layers: [
      { identity: 'sessionless-ip', countedAt: 'edge', definition: guestConversationIpRateLimit },
    ],
  }),
  '$get /conversations/member-keys/batch': bindRoutePosture({
    failure: 'closed',
    layers: [{ identity: 'user', countedAt: 'edge', definition: memberKeysBatchRateLimit }],
  }),
  '$get /conversations/:conversationId/messages': bindRoutePosture({
    failure: 'closed',
    layers: [
      { identity: 'sessionless-ip', countedAt: 'edge', definition: guestConversationIpRateLimit },
    ],
  }),
  '$get /conversations/:conversationId/forks': { kind: 'default', failure: 'open' },
  '$post /conversations/:conversationId/forks': { kind: 'default', failure: 'open' },
  '$patch /conversations/:conversationId/forks/:forkId': { kind: 'default', failure: 'open' },
  '$put /conversations/:conversationId/forks/:forkId/tip': { kind: 'default', failure: 'open' },
  '$delete /conversations/:conversationId/forks/:forkId': { kind: 'default', failure: 'open' },
  '$post /conversations/:conversationId/links': bindRoutePosture({
    failure: 'closed',
    layers: [{ identity: 'user', countedAt: 'edge', definition: linkCreateRateLimit }],
  }),
  '$get /conversations/:conversationId/links': bindRoutePosture({
    failure: 'closed',
    layers: [
      { identity: 'sessionless-ip', countedAt: 'edge', definition: guestConversationIpRateLimit },
    ],
  }),
  '$post /conversations/:conversationId/links/:linkId/revoke': {
    kind: 'default',
    failure: 'open',
  },
  '$patch /conversations/:conversationId/links/:linkId/privilege': {
    kind: 'default',
    failure: 'open',
  },
  '$patch /conversations/:conversationId/links/:linkId/name': { kind: 'default', failure: 'open' },
  '$post /conversations/:conversationId/shares': bindRoutePosture({
    failure: 'closed',
    layers: [{ identity: 'caller', countedAt: 'edge', definition: shareCreateRateLimit }],
  }),
  '$get /conversations/shared/message/:shareId': bindRoutePosture({
    failure: 'closed',
    layers: [{ identity: 'ip', countedAt: 'edge', definition: publicShareReadRateLimit }],
  }),
} satisfies Record<ConversationsRouteKey, CarriedRoutePosture>;
