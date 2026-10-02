import type { ThrottleLimit } from '../../../lib/rate-limit/index.js';

/**
 * Submissions one payer makes inside one window, at the generous end of
 * plausible. §"The arithmetic" argues the term; nothing measures it.
 */
const PEAK_SUBMISSIONS_PER_WINDOW = 6;

/**
 * Requests one submission costs: the form's single dispatch — `useInitiatePayment`
 * in `apps/web/src/hooks/billing/billing.ts` issues one request per attempt —
 * plus the up-to-`MAX_RETRIES` transport retries `apps/web/src/lib/api/retry.ts`
 * adds. §"The arithmetic" argues the term.
 */
const REQUESTS_PER_SUBMISSION = 3;

/** One payer's requests on this route inside one window, at that peak. */
const PER_PAYER_REQUEST_CEILING = PEAK_SUBMISSIONS_PER_WINDOW * REQUESTS_PER_SUBMISSION;

/**
 * The billing slice's rate-limit registry entries: the two windows bounding
 * `$post /billing/payments`, the Worker's only card-charge initiation surface,
 * and the one bounding the balance read. All three are counted at the edge by
 * the pipeline rate-limit stage, from the layers this slice's posture fragment
 * declares; nothing in this slice's own flow spends any of them.
 *
 * A submission on a fresh idempotency key that clears amount validation is
 * what costs a durable `payments` pre-claim, a processor charge attempt and a
 * delayed verification job. The charge windows admit and count more than
 * those: an amount `validateChargeAmount` rejects is counted by both layers
 * and answered 400 with no payment row written, no processor called and no
 * verify job enqueued, and a repeat on a key whose pre-claim is no longer
 * `pending` is counted again and replays off that row with no second charge
 * attempt. So the caps are sized against what a person loading credit does
 * rather than against a read volume, and the arithmetic below prices
 * REQUESTS: a window spends a slot on requests that reach no processor, so
 * the charge attempts it admits are not the number it counts. The balance
 * window is the opposite shape and is sized where its own paragraph says.
 *
 * # What each window bounds, and for whom
 *
 * `cardChargeIpRateLimit` is the address window. It bounds every caller of the
 * route alike, on an identity none of them can choose: an IPv6 caller reduced
 * to its /64, an IPv4 caller hashed verbatim.
 *
 * `cardChargeAccountRateLimit` bounds one ACCOUNT, for every principal this
 * route's class admits. Its `session-user` identity is the `userId` claim on
 * the credential the Worker itself unsealed, which both a `full` and a
 * `billing-portal` principal carry, so the window follows the account onto every
 * address it reaches — the only thing bounding a payer whose network changes
 * between attempts. What every identity in that vocabulary keys on, and which
 * of them a class admitting more than one kind of principal can be keyed per
 * account on at all, is argued once at `lib/rate-limit/posture.ts`.
 *
 * # Which layer answers whom
 *
 * Between the two IDENTITIES, neither contains the other: the account window
 * follows one payer across every address they reach, and the address window
 * holds every account behind one address, so neither identity's request set
 * sits inside the other's. Between one address counter and one account counter
 * containment does hold, case by case and either way round — a payer alone on
 * an address has both counting exactly the same requests, and a payer confined
 * to a shared one has their account counter counting a strict subset of that
 * address counter's — which is why the identities, not the counters, are where
 * the claim is made. So the relation between the caps decides nothing about
 * which window is operative: both are, and either can be the one that refuses.
 * Several accounts behind one address exhaust the address window while every
 * one of their own account windows still has room.
 *
 * What the relation does decide is which layer answers the ordinary payer —
 * one person on one connection — for whom the two counters advance together.
 * The account cap is the smaller, so that payer crosses it first and the
 * number governing them is one payer's own ceiling rather than a co-located
 * population's. It does not become everyone's cap: a payer sharing an address
 * meets whichever of the two windows fills first, and a newcomer arriving at
 * an address several accounts have already spent is refused by the address
 * layer with their own account window untouched.
 *
 * A payer alone on an address therefore never reaches the address window's
 * CAP. They do spend that window — one slot per admitted request, up to their
 * own account cap — and then stop: a refused check leaves its admitting
 * siblings uncounted, so that payer's address counter stops advancing the
 * moment their account window refuses. What no single account can do is
 * EXHAUST the address window; what fills it is the co-located population it is
 * sized against.
 *
 * # The arithmetic
 *
 * One submission costs up to three requests. The form fires one mutation, and
 * the app-wide mutation retry policy (`apps/web/src/lib/api/retry.ts`) adds up
 * to `MAX_RETRIES` more — it retries a transport failure that carried no
 * response, never a status the server answered with.
 *
 * One payer makes at most six submissions in a minute. A decline — wrong card,
 * insufficient funds, a mistyped expiry — has them correct the form and submit
 * again, and filling a card form is a deliberate act of several seconds, so
 * six inside one minute is already someone fighting the form rather than
 * paying. Six submissions at three requests each is eighteen.
 *
 * The account window is that eighteen, to the request: one account gets one
 * payer's own peak minute and nothing on top of it. What it costs is the
 * legitimate payer whose network changes between attempts, who has the same
 * shape as the caller this layer exists to bound and is now held to the same
 * number; what it buys is that an account working through a rotation of
 * addresses is bounded at a plausible peak rather than at a multiple of one.
 * Argue with a term before arguing with the number — the number is their
 * product and nothing else.
 *
 * The address window has to clear a co-located population rather than one
 * payer, because an IPv4 carrier NAT fronts many subscribers on one address
 * and the per-account layer covers none of them. Loading credit is among the
 * rarest things an account does, so what the window must clear is concurrency:
 * four payers at that eighteen-request ceiling inside the same minute.
 * Seventy-two.
 *
 * Neither term is measured and nothing in this system measures one. A refusal
 * here costs somebody a payment, so both are set at the generous end of
 * plausible, and the bound that matters against card testing is that seventy-two
 * a minute is what one address gets however many identities its caller mints.
 *
 * # The balance read's window, and why it is named rather than default
 *
 * `$get /billing/balance` carries an entry of its own for the FAILURE posture
 * rather than for the cap: a balance read is what a payer watches while a
 * charge settles, so it declares `open` and stays answerable when its counter
 * cannot be reached, where the card charge — this slice's other named row —
 * refuses. The cap and the window are the `billing-token` class default's, to
 * the number; the identity is not. This entry keys on the address where that
 * default keys on the account, so every payer behind one address shares this
 * counter while the default gives each of them one of their own — the same six
 * hundred a minute over a wider denominator, which is tighter for anyone
 * sharing an address and identical for a payer alone on one.
 * `lib/rate-limit/class-default.ts` argues that account key against both an
 * address and a caller; that argument is there rather than restated here.
 *
 * What this window's own number has to clear is the web payment form's
 * post-charge confirmation poll, which lands on THIS route: after an approved
 * charge `apps/web/src/components/billing/payment-form.tsx` re-reads the
 * balance every two seconds until the webhook credit arrives or a minute
 * passes, so one settling charge asks at most thirty reads inside one window.
 * Six hundred on the address is twenty of those polls at once behind one
 * carrier NAT — the co-located population the charge windows above are sized
 * against too, where loading credit is among the rarest things an account
 * does.
 *
 * What the declaration does NOT buy is survival of a Redis outage. The route is
 * `billing-token`-classed, so every caller of it presents a session cookie, and
 * `pipelineSession`'s revocation check reads Redis and fails closed with a 503
 * before the rate-limit stage runs at all. The posture governs the arms that
 * remain: a counter failure that is not a whole-store outage, and an address
 * the edge left unresolvable.
 */
export const BILLING_RATE_LIMITS = {
  cardChargeIpRateLimit: {
    kind: 'throttle',
    maxAttempts: 72,
    windowSeconds: 60,
    buildKey: (ipHash: string) => `ratelimit:billing:card-charge:ip:${ipHash}`,
  } as const satisfies ThrottleLimit,
  cardChargeAccountRateLimit: {
    kind: 'throttle',
    maxAttempts: PER_PAYER_REQUEST_CEILING,
    windowSeconds: 60,
    buildKey: (accountId: string) => `ratelimit:billing:card-charge:account:${accountId}`,
  } as const satisfies ThrottleLimit,
  balanceReadRateLimit: {
    kind: 'throttle',
    maxAttempts: 600,
    windowSeconds: 60,
    buildKey: (ipHash: string) => `ratelimit:billing:balance:ip:${ipHash}`,
  } as const satisfies ThrottleLimit,
} as const;
