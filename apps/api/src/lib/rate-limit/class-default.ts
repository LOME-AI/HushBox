import { routeKey } from '../context/index.js';
import type { RouteClass } from '../context/index.js';
import type { ThrottleLimit } from './definition.js';
import type { EdgeIdentity, IDENTITIES_SKIPPING_FULL_PRINCIPAL } from './posture.js';
import type { RouterRoute } from 'hono/types';

/**
 * # The class defaults
 *
 * What a `default` posture resolves to: one cap, window and caller identity
 * per route class, spent by the pipeline stage on a counter OF ITS OWN for
 * every route that declares no named limit of its own ({@link classDefaultFor}
 * narrows a class's row to one route). A class default is a BACKSTOP, not
 * policy — roughly an order of magnitude above real peak, high enough that no
 * legitimate caller meets it and low enough to stop a script. Anything needing
 * a tuned number is a named limit instead, and `docs/RATE-LIMITING.md` carries
 * that split.
 *
 * **These defaults REFUSE** a caller past the cap, with the same 429 a named
 * limit answers, and that is a property of the cap being reached rather than of
 * this table: it holds for every route, under either failure posture.
 *
 * What a route does when the default cannot be SPENT is not decided here at
 * all. It is the route's own `failure` declaration, and two conditions reach
 * it: the counter answering no decision, and the identity it would be keyed on
 * failing to resolve — which is not the counter's health, and which every
 * address-keyed row a production caller can reach can meet (`ipIdentity`
 * refuses whenever production carries no `cf-connecting-ip`). A route
 * declaring `open` admits
 * either one and the admission is reported; a route declaring `closed` refuses
 * either one. What a route's value is chosen by is one question — with the
 * counter unspendable, is it worse to refuse this route or to admit it
 * uncounted? — and the answer is reasoned per route in the fragment that
 * declares it, never here.
 *
 * The numbers are reasoned, and nothing can measure them: Workers observability
 * is off and no log line is retained, so "ship it, watch, then size" is not
 * available here. What each row is reasoned FROM is stated with the table.
 */

/**
 * The identities a class default may be keyed on: every identity the pipeline
 * stage can resolve except the two that deliberately skip a caller holding a
 * full session. The stage is what spends a class default, so the wider
 * flow-only vocabulary is unreachable from here by construction. The exclusion is
 * the point rather than tidiness — a class default keyed on a skipping identity
 * would bound the class's guests and leave its session holders counted by
 * nothing, which is the gap a class default exists to close.
 */
type ClassDefaultIdentity = Exclude<
  EdgeIdentity,
  (typeof IDENTITIES_SKIPPING_FULL_PRINCIPAL)[number]
>;

/**
 * A class default as it is spent: the identity it counts, and the counter it
 * counts on. {@link CLASS_DEFAULTS} carries the class-wide key template;
 * {@link classDefaultFor} answers this same shape with the counter narrowed to
 * one route.
 */
interface ClassDefault {
  readonly identity: ClassDefaultIdentity;
  readonly definition: ThrottleLimit;
}

/**
 * Every class has a row, and the compiler holds that total: a route class added
 * to `ROUTE_CLASSES` fails to compile here until it has a default, so no class
 * can reach the stage as a declared bound with nothing behind it.
 *
 * For every class here, more than one identity resolves for every caller it
 * admits, so a row records which others were available and why this one won.
 * `ip` and `caller` answer for a principal of any kind; `user` and
 * `admin-actor` throw a defect on any principal but their own, so they are
 * available only where the class admits that one kind. `caller` is therefore
 * available for every row and chosen for none: it is the one member that folds
 * in a component the caller supplies — for a caller holding no full session, a
 * hash of the link-credential header beside the address — where every identity
 * chosen below is read off something the caller cannot choose, a user id or an
 * admin email off a credential the Worker verified, or the address off the
 * header Cloudflare's edge attaches, which is the only one the identity reads
 * in production.
 *
 * `session` admits full principals alone, so `user`, `session-user`, `ip` and
 * `caller` are all available. `ip` is the widest of them, standing for
 * everyone behind an address rather than the one account; `session-user` and
 * `caller` both resolve to that same user id for a full principal, so they
 * differ from `user` only in what each does should this class ever admit a
 * second principal kind — `user` throws, `session-user` keys on that session's
 * own account, and `caller` quietly begins folding in the header. `user` is
 * chosen because the class admits nothing else and the throw is the louder
 * answer to a matrix that widened. `admin` admits the admin-actor
 * principal alone, so `admin-actor`, `ip` and `caller` are available.
 * `admin-actor` is chosen because it hashes the `email` claim Cloudflare
 * Access signed, so one window stands for one allowlisted actor and is read
 * off a value the Worker verified rather than one the caller composed. `ip` is
 * rejected for standing for everyone behind an address rather than the one
 * actor. `caller` is rejected on rotatability rather than on granularity: for
 * a principal of any kind but `full` it folds a hash of the link-credential
 * header in beside the address whenever that header decodes to non-empty
 * bytes, so an admin actor varying the header would open a counter per
 * variant. `billing-token` admits full sessions AND the billing-portal
 * credential, so `user` throws on the portal half and `session-user`, `ip` and
 * `caller` are what is left; its paragraph below argues that choice in full. `public`,
 * `pending-2fa` and `dev-only` admit a caller carrying no session at all,
 * which leaves `ip` and `caller` alone — no account exists to key on — and
 * between those two `ip` wins on the rotatability the `admin` row states.
 *
 * A cap is sized against ONE ROUTE's peak for one identity in the window, since
 * {@link classDefaultFor} gives every route its own counter. `session` keys per
 * user, so its key stands for one account, and a client driven by one person
 * runs to tens of requests a minute on its busiest single endpoint. An
 * address-keyed row aggregates everyone sharing an egress address rather than
 * one caller, so its key stands for a population rather than one person, and
 * every such row a production caller can reach carries `session`'s backstop
 * despite backing fewer routes: what a per-route cap has to sit above is
 * the population behind the key, never the number of routes in front of it.
 * A row whose class no production caller reaches stands outside that
 * derivation and is sized by the argument its own paragraph makes.
 *
 * `admin` keys per admin: the admin stage matches the individual `email` claim
 * on the Access assertion against the exact-match allowlist, and the identity
 * hashes that same claim — a value Cloudflare Access signed rather than one the
 * caller composed — so one admin's window is their own. It carries `session`'s
 * backstop anyway, because an admin identity aggregates whenever several
 * callers act as one allowlisted actor — which is what our own suite does, its
 * workers running as one — and because nothing here is the authentication
 * bound — that is a hardware key at Cloudflare Access — while the sensitive
 * admin reads carry their own named hourly limits on top.
 *
 * `billing-token` keys on the account, and the two alternatives it rejects are
 * why that is worth stating. `caller` resolves to a user id for a full
 * principal and, for the credential the mobile → web handoff mints,
 * to the address folded together with a hash of the link-credential header — a
 * header read for every `caller`-keyed route from one pipeline-wide wiring, on
 * any base64 that decodes to non-empty bytes. A portal caller sending a
 * fresh credential per request would therefore open a fresh counter per
 * request and meet no cap at any rate, on reads that run against both Redis
 * and Postgres — one of them the funding snapshot admission itself is computed
 * from, so the load lands on every other user's admission check. `ip` closes
 * that escape, since the address is the one component of the composite a
 * caller cannot vary, and it is what this row keyed on while no identity
 * resolved an account for the portal half. It bought the closure with a
 * window standing for a population: several payers behind one carrier NAT
 * shared one counter, and one account reaching the class from several
 * addresses got a window per address.
 *
 * `session-user` closes the same escape on a value the caller cannot vary
 * either — the account id on the session the Worker itself unsealed — and
 * gives up neither direction of that trade. Every caller this class admits
 * carries a session, so no caller falls through to an address, and this row
 * joins `session` and `admin` in standing for one caller rather than one
 * network. What it costs is stated rather than buried: several sessions behind
 * one address now draw a window each where the address key held them to one
 * between them, so an address holding many accounts reaches this class harder
 * than before. That is accepted for the same reason the `session` row accepts
 * it — the accounts themselves are what registration and login bound, this row
 * is a backstop an order of magnitude above real peak rather than an
 * anti-abuse bound, and no route this row bounds turns a request into spend:
 * the class's one spending route, `$post /billing/payments`, carries named
 * layers of its own instead.
 *
 * Two of this class's four routes reach this counter, and naming them is what
 * keeps a re-sizing honest: `$get /billing/spendable` and
 * `$get /billing/transactions`, a signed-in payer's own funding and ledger
 * reads. The other two carry named entries instead and never this number.
 * `$post /billing/payments` is bounded by named layers of its own, keyed first
 * on the address no caller can choose. `$get /billing/balance` is bounded by
 * the address-keyed entry `slices/billing/domain/rate-limit.ts` argues, and
 * the web payment form's post-charge confirmation poll is that entry's
 * population to clear rather than this one's — its shape is stated there,
 * beside the number it sizes. The cap is left where it was: a backstop is not
 * re-sized because its key narrowed.
 *
 * `dev-only` is the row with no production existence: the class answers 404
 * there, at the authorizer, which runs before the stage that spends this
 * counter — so nothing but our own tooling ever reaches it, and the cap clears
 * a suite polling one dev endpoint for the length of a window. It is the
 * table's highest for that reason rather than from any measured peak.
 */
export const CLASS_DEFAULTS = {
  public: {
    identity: 'ip',
    definition: {
      kind: 'throttle',
      maxAttempts: 600,
      windowSeconds: 60,
      buildKey: (ipHash: string) => `ratelimit:default:public:${ipHash}`,
    },
  },
  session: {
    identity: 'user',
    definition: {
      kind: 'throttle',
      maxAttempts: 600,
      windowSeconds: 60,
      buildKey: (userId: string) => `ratelimit:default:session:${userId}`,
    },
  },
  'pending-2fa': {
    identity: 'ip',
    definition: {
      kind: 'throttle',
      maxAttempts: 600,
      windowSeconds: 60,
      buildKey: (ipHash: string) => `ratelimit:default:pending-2fa:${ipHash}`,
    },
  },
  'billing-token': {
    identity: 'session-user',
    definition: {
      kind: 'throttle',
      maxAttempts: 600,
      windowSeconds: 60,
      buildKey: (userId: string) => `ratelimit:default:billing-token:${userId}`,
    },
  },
  'dev-only': {
    identity: 'ip',
    definition: {
      kind: 'throttle',
      maxAttempts: 3000,
      windowSeconds: 60,
      buildKey: (ipHash: string) => `ratelimit:default:dev-only:${ipHash}`,
    },
  },
  admin: {
    identity: 'admin-actor',
    definition: {
      kind: 'throttle',
      maxAttempts: 600,
      windowSeconds: 60,
      buildKey: (actorHash: string) => `ratelimit:default:admin:${actorHash}`,
    },
  },
} as const satisfies Record<RouteClass, ClassDefault>;

/**
 * One route's class default: its class's identity, cap and window, on a counter
 * that route qualifies — so a caller exhausting one route's window leaves every
 * sibling route of the class untouched. The consequence is that a caller may
 * spend a full window on each route of a class; a second layer bounding the
 * class as a whole was considered and declined.
 *
 * The route is qualified through {@link routeKey}, this repo's one spelling of
 * a route as `$method /path` — the unit the posture map is keyed by. A path
 * alone would leave every method of one path sharing a window, so a client
 * looping one method could exhaust the budget its siblings spend.
 *
 * The route rides the identifier the class's own `buildKey` receives, so
 * {@link CLASS_DEFAULTS}'s templates stay the one statement of where a class
 * default's keys live. That composition is injective because `consume` hands
 * `buildKey` the identity's keyed digest, which is hex and carries no `:`, so
 * the route and the identity are recoverable either side of the key's last
 * colon.
 *
 * A route key is built from a registration rather than from anything a caller
 * supplies, which is why `MAX_IDENTIFIER_LENGTH` still bounds every part of the
 * key a caller can reach.
 */
export function classDefaultFor(
  routeClass: RouteClass,
  route: Pick<RouterRoute, 'method' | 'path'>
): ClassDefault {
  const { identity, definition } = CLASS_DEFAULTS[routeClass];
  return {
    identity,
    definition: {
      ...definition,
      buildKey: (id: string) => definition.buildKey(`${routeKey(route)}:${id}`),
    },
  };
}
