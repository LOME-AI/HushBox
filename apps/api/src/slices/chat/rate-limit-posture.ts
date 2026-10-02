import { bindRoutePosture } from '../../lib/rate-limit/index.js';
import {
  CHAT_GUEST_SEND_IP_RATE_LIMIT,
  CHAT_STOP_IP_RATE_LIMIT,
  CHAT_STREAM_USER_RATE_LIMIT,
  CHAT_TRIAL_REMAINING_IP_RATE_LIMIT,
  CHAT_TRIAL_SEND_IP_RATE_LIMIT,
  CHAT_TRIAL_WEBSOCKET_IP_RATE_LIMIT,
} from './domain/rate-limit.js';
import { TRIAL_QUOTA_IP_RATE_LIMIT, TRIAL_QUOTA_SESSION_RATE_LIMIT } from './domain/trial/quota.js';
import type { CarriedRoutePosture, SliceRouteKey } from '../../lib/rate-limit/index.js';
import type { createChatManifest } from './routes.js';

/**
 * The route keys this slice contributes, derived from its own manifest. A route
 * added, renamed or removed moves this union, so the declaration below stops
 * compiling until it moves with it.
 */
export type ChatRouteKey = SliceRouteKey<ReturnType<typeof createChatManifest>>;

/**
 * # How this slice's routes are bounded
 *
 * The declaration crosses the slice perimeter as a BOUND COUNTING CAPABILITY,
 * never as a registry entry: `bindRoutePosture` closes over the entries, and a
 * closure's captures have no reflection surface, so the caps, windows, key
 * material and the `clear` disarm stay unreachable from everything this module
 * publishes.
 *
 * The send window is one entry counted in two places. The session sends count
 * it at the edge, keyed on the authenticated user; the guest send counts the
 * same entry in the handler, because its key is the sender principal that
 * route resolves server-side, which the edge cannot derive for a link guest.
 * The window counted ahead of the guest send is a different entry for a
 * different job: it bounds callers whose credential has not resolved yet.
 *
 * The trial paths are counted entirely in flow. The send spends its per-IP
 * abuse throttle before the first Postgres read, then the 5/day quota once the
 * turn compiles — and the quota is ONE all-or-nothing check across two
 * counters, declared as the two layers it is. Its sibling keys on the trial
 * session token the caller presents, which is a `presented-token`: the
 * pipeline resolves no such thing, and the flow that mints the token does.
 * (Both quota keys carry the UTC day that scopes them; the day scopes the key,
 * the identity is still the caller's session or address.) The remaining-count
 * read spends only its own throttle — it READS both quota counters and
 * increments neither.
 *
 * On the failure axis every route that can buy inference declares `closed`:
 * the counter is the only thing between a caller and provider spend we cannot
 * un-spend, which is the clearest case the assignment rule names. `$post
 * /chat/stop` is the one named row here declaring `open`, for a money reason
 * pointing the other way — it is the abort path for a run that is already
 * being paid for, and `docs/ARCHITECTURE.md` promises a caller blocked from
 * the socket can always abort one, so refusing it bills a user for a run they
 * tried to stop. A route counted only in flow declares `closed` and its own
 * slice enforces that; the pipeline spends nothing for it.
 */
export const CHAT_ROUTE_POSTURES = {
  '$post /chat/:conversationId/message': { kind: 'default', failure: 'open' },
  '$post /chat/guest': bindRoutePosture({
    failure: 'closed',
    layers: [
      {
        identity: 'sessionless-ip',
        countedAt: 'edge',
        definition: CHAT_GUEST_SEND_IP_RATE_LIMIT,
      },
      { identity: 'caller', countedAt: 'flow', definition: CHAT_STREAM_USER_RATE_LIMIT },
    ],
  }),
  '$get /chat/mock/release-stream': { kind: 'default', failure: 'open' },
  '$post /chat/regenerate': bindRoutePosture({
    failure: 'closed',
    layers: [{ identity: 'user', countedAt: 'edge', definition: CHAT_STREAM_USER_RATE_LIMIT }],
  }),
  '$post /chat/stop': bindRoutePosture({
    failure: 'open',
    layers: [
      { identity: 'sessionless-ip', countedAt: 'edge', definition: CHAT_STOP_IP_RATE_LIMIT },
    ],
  }),
  '$get /chat/trial/remaining': bindRoutePosture({
    failure: 'closed',
    layers: [{ identity: 'ip', countedAt: 'flow', definition: CHAT_TRIAL_REMAINING_IP_RATE_LIMIT }],
  }),
  '$get /chat/trial/websocket': bindRoutePosture({
    failure: 'closed',
    layers: [{ identity: 'ip', countedAt: 'edge', definition: CHAT_TRIAL_WEBSOCKET_IP_RATE_LIMIT }],
  }),
  '$post /chat/trial': bindRoutePosture({
    failure: 'closed',
    layers: [
      { identity: 'ip', countedAt: 'flow', definition: CHAT_TRIAL_SEND_IP_RATE_LIMIT },
      {
        identity: 'presented-token',
        countedAt: 'flow',
        definition: TRIAL_QUOTA_SESSION_RATE_LIMIT,
      },
      { identity: 'ip', countedAt: 'flow', definition: TRIAL_QUOTA_IP_RATE_LIMIT },
    ],
  }),
  '$post /chat': bindRoutePosture({
    failure: 'closed',
    layers: [{ identity: 'user', countedAt: 'edge', definition: CHAT_STREAM_USER_RATE_LIMIT }],
  }),
} satisfies Record<ChatRouteKey, CarriedRoutePosture>;
