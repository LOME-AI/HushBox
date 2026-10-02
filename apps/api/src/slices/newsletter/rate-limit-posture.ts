import { bindRoutePosture } from '../../lib/rate-limit/index.js';
import {
  newsletterConfirmIpRateLimit,
  newsletterSubscribeIpRateLimit,
  newsletterUnsubscribeIpRateLimit,
} from './domain/rate-limit.js';
import type { CarriedRoutePosture, SliceRouteKey } from '../../lib/rate-limit/index.js';
import type { createNewsletterManifest } from './routes.js';

/**
 * The route keys this slice contributes, derived from its own manifest. A route
 * added, renamed or removed moves this union, so the declaration below stops
 * compiling until it moves with it.
 */
export type NewsletterRouteKey = SliceRouteKey<ReturnType<typeof createNewsletterManifest>>;

/**
 * # How this slice's routes are bounded
 *
 * The declaration crosses the slice perimeter as a BOUND COUNTING CAPABILITY,
 * never as a registry entry: `bindRoutePosture` closes over the entries, and a
 * closure's captures have no reflection surface, so the caps, windows, key
 * material and the `clear` disarm stay unreachable from everything this module
 * publishes.
 *
 * Three routes are unauthenticated and carry a per-IP window each, one entry per
 * route: signup, because each request can send a confirmation email, and the two
 * token-consumption routes, because the token is the credential a prober would
 * be guessing at. All three are abuse throttles rather than secret-guessing
 * reservations, so nothing clears them on success.
 *
 * The provider webhook is bounded by signature verification ahead of any I/O
 * the route itself performs, which is the obligation `signature-gated-webhook`
 * names; the verification covers the raw body, so it runs before the request can
 * be authorized at all. A 429 there would only make the provider retry or drop a
 * delivery. The two settings routes are session-classed and touch at most one
 * row each on their route class's default — the write validates its body after
 * the counter is spent, so a rejected one is counted and writes nothing.
 *
 * Nothing in this slice's domain spends a counter, so no route cites one in
 * flow: the per-address resend throttle that bounds mail volume per target is a
 * database-side check, not a rate-limit entry.
 *
 * The failure axis splits the three counted routes rather than following them.
 * Signup declares `closed` because each admitted request can send a mail we
 * pay for, and confirm declares `closed` because its token is the credential a
 * prober is guessing at — a counter that cannot be spent is the only thing
 * between an outage and either. Unsubscribe declares `open` against the same
 * shape, because honouring an unsubscribe — including one-click — is a legal
 * obligation rather than a product preference, and a 503 there is a failure to
 * honour it. The two settings routes are session-classed and declare `open`
 * with the rest of their class.
 */
export const NEWSLETTER_ROUTE_POSTURES = {
  '$post /newsletter/subscribe': bindRoutePosture({
    failure: 'closed',
    layers: [{ identity: 'ip', countedAt: 'edge', definition: newsletterSubscribeIpRateLimit }],
  }),
  '$post /newsletter/confirm': bindRoutePosture({
    failure: 'closed',
    layers: [{ identity: 'ip', countedAt: 'edge', definition: newsletterConfirmIpRateLimit }],
  }),
  '$post /newsletter/unsubscribe': bindRoutePosture({
    failure: 'open',
    layers: [{ identity: 'ip', countedAt: 'edge', definition: newsletterUnsubscribeIpRateLimit }],
  }),
  '$post /newsletter/webhooks/resend': { kind: 'exempt', exemption: 'signature-gated-webhook' },
  '$get /newsletter/me': { kind: 'default', failure: 'open' },
  '$put /newsletter/me': { kind: 'default', failure: 'open' },
} satisfies Record<NewsletterRouteKey, CarriedRoutePosture>;
