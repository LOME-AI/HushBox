import { bindRoutePosture } from '../../lib/rate-limit/index.js';
import { BILLING_RATE_LIMITS } from './domain/rate-limit.js';
import type { CarriedRoutePosture, SliceRouteKey } from '../../lib/rate-limit/index.js';
import type { createBillingManifest } from './routes.js';

/**
 * The route keys this slice contributes, derived from its own manifest. A route
 * added, renamed or removed moves this union, so the declaration below stops
 * compiling until it moves with it.
 */
export type BillingRouteKey = SliceRouteKey<ReturnType<typeof createBillingManifest>>;

/**
 * # How this slice's routes are bounded
 *
 * The card-charge route and the balance read declare layers of their own. Every
 * other route but the webhook is counted against its route class's default — `billing-token` for
 * the routes the mobile → web portal reaches with its own credential,
 * `dev-only` for the held-webhook release, `session` for the rest — on the
 * terms `lib/rate-limit/class-default.ts` states. The payment webhook is
 * bounded by signature verification ahead of any I/O the route itself
 * performs, which is the obligation its exemption class names, and refusing it
 * with a 429 would only make the provider retry or drop the event.
 *
 * The charge route's declaration crosses the slice perimeter as a BOUND
 * COUNTING CAPABILITY, never as a registry entry: `bindRoutePosture` closes
 * over the entries, and a closure's captures have no reflection surface, so
 * the caps, windows and key material stay unreachable from everything this
 * module publishes.
 *
 * It takes no class default because that default is one layer at a backstop
 * number — one sized an order of magnitude above real peak, to stop a script
 * rather than to bound a payer — and `lib/rate-limit/class-default.ts` says so
 * from its own side, that this route is never bounded by that number. This
 * route needs two layers instead: the address, which no caller of it can
 * choose, and the account, which follows a payer onto every address they
 * reach. `session-user` is what reads that account off whichever
 * credential-bearing principal the request carries — the full session and the
 * billing-portal credential this class also admits — so both halves of the
 * class are bounded per account on a value the Worker unsealed rather than one
 * the caller composed. `lib/rate-limit/posture.ts` argues that vocabulary, and
 * what each of its alternatives keys on instead.
 *
 * The IP window still goes FIRST, because the order is what a refusal is
 * attributed to: a refused check leaves its admitting siblings uncounted and
 * answers with the FIRST refusing layer's retry-after, and the address is what
 * holds a caller working through several accounts from one network. The
 * per-account window follows it, sized from one payer's own request ceiling
 * rather than from the address window; `domain/rate-limit.ts` §"Which layer
 * answers whom" carries which layer answers which caller, and §"The
 * arithmetic" what that sizing costs.
 *
 * On the failure axis the charge route declares `closed` — it is the one route
 * in this Worker that turns a request into a processor charge attempt, so an
 * unspendable counter would leave card testing bounded by nothing — while the
 * balance read declares `open` and carries an entry of its own to be able to;
 * `domain/rate-limit.ts` argues that row, including what the declaration does
 * not buy. Every other account-facing route here declares `open` with its
 * route class: each is reached by one authenticated account — the spending
 * reads, and the mint of that payer's own hand-off link into the web portal —
 * its class default is a backstop rather than a tuned bound, and refusing would
 * take from a payer their own spending history, or their way into the portal
 * that shows it, for the length of a degradation. The dev-only held-webhook
 * release declares `open` as well: it answers only off production, where a
 * refusal would stall a test and protect nothing. The webhook carries no failure
 * declaration, because an exemption reaches no counter to be unable to spend.
 */
export const BILLING_ROUTE_POSTURES = {
  '$get /billing/balance': bindRoutePosture({
    failure: 'open',
    layers: [
      {
        identity: 'ip',
        countedAt: 'edge',
        definition: BILLING_RATE_LIMITS.balanceReadRateLimit,
      },
    ],
  }),
  '$post /billing/login-link': { kind: 'default', failure: 'open' },
  '$get /billing/mock/release-webhook': { kind: 'default', failure: 'open' },
  '$post /billing/payments': bindRoutePosture({
    failure: 'closed',
    layers: [
      {
        identity: 'ip',
        countedAt: 'edge',
        definition: BILLING_RATE_LIMITS.cardChargeIpRateLimit,
      },
      {
        identity: 'session-user',
        countedAt: 'edge',
        definition: BILLING_RATE_LIMITS.cardChargeAccountRateLimit,
      },
    ],
  }),
  '$get /billing/spendable': { kind: 'default', failure: 'open' },
  '$get /billing/transactions': { kind: 'default', failure: 'open' },
  '$get /billing/usage/cost-by-model': { kind: 'default', failure: 'open' },
  '$get /billing/usage/models': { kind: 'default', failure: 'open' },
  '$get /billing/usage/spending-by-conversation': { kind: 'default', failure: 'open' },
  '$get /billing/usage/spending-over-time': { kind: 'default', failure: 'open' },
  '$get /billing/usage/summary': { kind: 'default', failure: 'open' },
  '$get /billing/usage': { kind: 'default', failure: 'open' },
  '$post /billing/webhooks/payment': { kind: 'exempt', exemption: 'signature-gated-webhook' },
} satisfies Record<BillingRouteKey, CarriedRoutePosture>;
