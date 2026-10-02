/**
 * The vocabulary a route's rate-limit posture is written in. It lives here
 * rather than beside the map because both ends need it and they sit on
 * opposite sides of the perimeter: the composition root writes the
 * declarations, the pipeline stage reads them, and middleware may not import
 * the composition root.
 */

/**
 * The identities a layer counted BY THE PIPELINE STAGE can name: every one is
 * derived from the request and the already-resolved principal, with no
 * database read and nothing parsed out of a body. The stage holds a resolver
 * for each and the map is total over this union, so a member added here fails
 * to compile there until the stage can derive it.
 *
 * Two of them deliberately do not count a caller who presented a full session
 * — `sessionless-ip`, because an IP cap that counted one would throttle every
 * user behind a NAT, and `link-credential`, because a full principal reaches no
 * credential resolution — so a route keyed only on those is bounded for guests
 * and unbounded for session holders.
 *
 * `user` and `session-user` both key on the account and differ only in which
 * principals they accept. `user` takes a FULL session and treats anything else
 * as a defect, so it belongs on a route class admitting nothing else;
 * `session-user` takes the account off whichever session-bearing principal the
 * request carries. That is what lets a class admitting more than one of those
 * kinds be keyed per account at all: the alternatives for such a class are an
 * address, which stands for a population rather than a payer, and `caller`,
 * which for every kind but `full` folds in a header the caller supplies and so
 * opens a fresh window per variant.
 *
 * A counter's key segments do not name the identity its layer is declared on,
 * and reading one off the other is how this vocabulary gets misread:
 * `mediaDownloadUserRateLimit` builds a `:user:` segment under a layer declared
 * `caller` (`slices/media/rate-limit-posture.ts`). The declaration is the only
 * statement of what a layer counts.
 */
const EDGE_IDENTITIES = [
  'user',
  'session-user',
  'admin-actor',
  'ip',
  'sessionless-ip',
  'caller',
  'link-credential',
] as const;

export type EdgeIdentity = (typeof EDGE_IDENTITIES)[number];

/**
 * The identities only the OWNING SLICE'S OWN FLOW can resolve, because each
 * names a value the caller supplies and the pipeline stage would have to parse
 * a body or resolve a record to read. They exist so that a counter spent
 * inside a slice can be declared at its route, which is the whole of what a
 * posture records — the bound, never its mount point.
 *
 * Each names what the counter's window stands for, since that is what a reader
 * of the map is asking. `claimed-account` — an account a caller NAMES without
 * having proved it holds one: a login identifier, a registration or
 * verification email, a recovery identifier. The window bounds guesses at that
 * one named account whether or not it exists, which is exactly the bound an
 * address-keyed layer cannot supply against a botnet. `presented-token` — an
 * opaque secret the caller presents that is itself the subject: a verification
 * token, a trial session token. `claimed-share` — a share a caller names in a
 * path before anything resolves it. `claimed-account-per-network` — one named
 * account AND the network the guess came from, together: a window per pair, so
 * what one network spends is its own rather than the whole of that account's.
 * A window keyed on the account alone is spendable in full from a single
 * address, which is how naming an account becomes a way to lock its owner out
 * of a route.
 *
 * None of them is resolvable at the edge, and putting one on an edge layer is
 * a compile error rather than a runtime surprise: the layer type in
 * `lib/rate-limit/capability.ts` is discriminated on where the counting
 * happens for that reason.
 */
const FLOW_ONLY_IDENTITIES = [
  'claimed-account',
  'claimed-account-per-network',
  'presented-token',
  'claimed-share',
] as const;

/**
 * The whole vocabulary a route's `keyedBy` can draw on: a posture records the
 * bound, not its mount point, so it names every layer's identity wherever that
 * layer is counted.
 */
export const POSTURE_IDENTITIES = [...EDGE_IDENTITIES, ...FLOW_ONLY_IDENTITIES] as const;

export type PostureIdentity = (typeof POSTURE_IDENTITIES)[number];

/** The identities that skip a caller holding a full session. */
export const IDENTITIES_SKIPPING_FULL_PRINCIPAL = [
  'sessionless-ip',
  'link-credential',
] as const satisfies readonly EdgeIdentity[];

/**
 * A deliberate absence of a limiter, each class carrying its own obligation.
 * `signature-gated-webhook`: signature verification precedes any I/O the ROUTE
 * ITSELF performs and IS the bound, and a 429 to a provider either buys retries
 * that add load or loses the event outright. `constant-cost`: the route
 * touches no database, Redis, bucket or `fetch`, so a flood of it reaches
 * nothing behind the Worker from the route itself.
 *
 * Every obligation here is stated over the route's own registration and the
 * handler it resolves to, and the check reads no further: what a pipeline
 * stage does ahead of the handler is outside the law and outside the check,
 * for every class in this list. The live instance is the session stage, which
 * reads no posture — a request carrying a parseable sealed session cookie
 * costs one Redis round trip there on an exempt route exactly as on a counted
 * one, and an exempt posture then spends nothing at the rate-limit stage, so
 * nothing in this repo bounds that read.
 *
 * The obligations are structural rather than reviewed: the arch rule
 * `rate-limit-exemptions-prove-their-obligation` reads this list, and a class
 * added here without a checker beside it fails `arch:check` rather than
 * shipping an exemption nothing examines. That rule reads this array as a
 * source literal rather than importing it, so the `export` keyword is the whole
 * of its reachability.
 * @toolContract
 */
export const RATE_LIMIT_EXEMPTIONS = ['signature-gated-webhook', 'constant-cost'] as const;

export type RateLimitExemption = (typeof RATE_LIMIT_EXEMPTIONS)[number];

/**
 * What a route does when its declared bound could not be SPENT, and nothing
 * else. `closed` refuses; `open` admits the request uncounted and reports the
 * admission on the error channel.
 *
 * Two conditions reach it, and they are one event from the route's side —
 * the bound was not spent, so the request is uncounted either way. The counter
 * answered no decision (unreachable, timed out, unreadable reply, or an
 * identifier the primitive refuses as over-long); or the identity the counter
 * would have been keyed on could not be resolved, which in production is the
 * edge leaving no `cf-connecting-ip` on an address-keyed layer. Neither is
 * something a caller can present its way into, which is what makes `open`
 * safe to declare: it hands nobody a self-service bypass
 * (`lib/redis/caller-ip.ts` argues the second, `lib/rate-limit/consume.ts` the
 * over-long identifier).
 *
 * It has NO bearing on a caller past the cap. Over-cap refuses under both
 * values, for every limit kind — the counter was reached and it answered.
 */
export type FailurePosture = 'open' | 'closed';

/**
 * What bounds one route, in two orthogonal declarations. `kind` is the LIMIT:
 * a `named` route has registry entries of its own and takes no class default;
 * a `default` route is counted against its route class's default, declared in
 * `class-default.ts` beside the statement of what that count does with a
 * caller past it; an `exempt` route is bounded by something that is not a
 * counter. The posture records which caller identities a named route's entries
 * count, not which entries they are.
 *
 * `failure` is the other dimension and is required wherever a counter exists,
 * so neither value is inherited from a route class nor implied by the limit
 * kind. `exempt` carries none: it reaches no counter, so it has no unspendable
 * case to answer for, exactly as it has no over-cap case — a value there would
 * declare a behaviour that cannot occur.
 */
export type RoutePosture =
  | {
      readonly kind: 'named';
      readonly keyedBy: readonly [PostureIdentity, ...PostureIdentity[]];
      readonly failure: FailurePosture;
    }
  | { readonly kind: 'default'; readonly failure: FailurePosture }
  | { readonly kind: 'exempt'; readonly exemption: RateLimitExemption };
