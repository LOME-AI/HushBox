import { matchedRoutes } from 'hono/route';
import { ERROR_CODES } from '@hushbox/shared';
import { matchedRouteKeys, routeKey } from '../lib/context/index.js';
import { createErrorResponse } from '../lib/errors/index.js';
import { Result, err, ok } from '../lib/result/index.js';
import { markPipelineHandler, readPipelineVariable } from './pipeline-markers.js';
import { FINGERPRINT_CODES } from '../lib/telemetry/index.js';
import { bindClassDefault, rateLimitFailureOf } from '../lib/rate-limit/index.js';
import {
  callerIdentity,
  hashRateLimitId,
  ipIdentity,
  linkCredentialIdentity,
  rateLimitRefusal,
  sessionlessIpIdentity,
} from './rate-limit.js';
import type {
  CarriedRoutePosture,
  CountAtEdge,
  EdgeIdentity,
  FailurePosture,
  RateLimitFailure,
} from '../lib/rate-limit/index.js';
import type { RateLimitDecision } from '../lib/rate-limit/index.js';
import type { AppEnv, Principal, RouteClass } from '../lib/context/index.js';
import type { DomainError } from '../lib/errors/index.js';
import type { Telemetry } from '../lib/telemetry/index.js';
import type { Result as ResultOf } from '../lib/result/index.js';
import type { Context, MiddlewareHandler } from 'hono';
import type { RouterRoute } from 'hono/types';

/**
 * The declarations, keyed `${method} ${path}` exactly as the router reports a
 * registration. The composition root owns the map and its completeness
 * witness; this stage only reads it, so it takes the widest key type a lookup
 * needs rather than re-deriving the route union.
 */
export type RoutePostureMap = Readonly<Record<string, CarriedRoutePosture>>;

export interface PipelineRateLimitOptions {
  /**
   * The posture map, injected by the composition root (the map is keyed off
   * `AppType`, which middleware may not import). Omitting it leaves every
   * matched route admitted — safe only for a surface that mounts no
   * production route, which is why production refuses the omission below.
   */
  readonly postures?: RoutePostureMap;
  /**
   * The request header a shared-link credential arrives on, injected for the
   * same reason the map is: the header is the conversations slice's, and
   * middleware reaches a slice only through the composition root. Required
   * only by the two identities that read it; a posture naming one with no
   * header wired is a composition defect and says so.
   */
  readonly linkCredentialHeader?: string;
}

/** A layer's identity for this request, or `null` when it deliberately skips this caller. */
type ResolvedIdentity = ResultOf<string | null, DomainError>;

/**
 * The production fail-fast for the silent-omission footgun: with no map wired,
 * every route is admitted and the declaration is enforced nowhere. Throws a
 * defect (500) rather than degrading. Checked at first use because slice
 * routes mount after the pipeline.
 */
function assertPosturesWiredInProduction(
  options: PipelineRateLimitOptions | undefined,
  isProduction: boolean
): void {
  if (options?.postures === undefined && isProduction) {
    throw new Error(
      'pipeline misconfigured: a route is reachable in production with no rate-limit ' +
        'posture map wired. Pass PipelineRateLimitOptions.postures at the composition ' +
        'root so an undeclared route is refused rather than served unbounded.'
    );
  }
}

function fullPrincipalUserId(principal: Principal): string {
  if (principal.kind !== 'full') {
    throw new Error(
      "rate-limit posture: a 'user'-keyed layer reached a principal that is not full — " +
        'the route class the declaration sits on admits a caller it cannot be keyed by.'
    );
  }
  return principal.claims.userId;
}

/**
 * The account on the credential the caller presented, whichever
 * credential-bearing principal kind carries it. Read off the claims the
 * pipeline's session stage already unsealed, so it costs no store read and
 * nothing the caller can choose enters it.
 *
 * It throws for a caller carrying no session at all, for the reason
 * {@link fullPrincipalUserId} throws: the route class is what guarantees the
 * principal, so a layer keyed here on a class admitting an anonymous caller is
 * a composition defect rather than a request to answer.
 */
function sessionUserId(principal: Principal): string {
  if (principal.kind === 'full' || principal.kind === 'pending-2fa') {
    return principal.claims.userId;
  }
  if (principal.kind === 'billing-portal') {
    return principal.credential.userId;
  }
  throw new Error(
    "rate-limit posture: a 'session-user'-keyed layer reached a caller carrying no session — " +
      'the route class the declaration sits on admits a principal it cannot be keyed by.'
  );
}

function adminActorEmail(principal: Principal): string {
  if (principal.kind !== 'admin-actor') {
    throw new Error(
      "rate-limit posture: an 'admin-actor'-keyed layer reached a principal that is not " +
        'an admin actor — only an admin-classed route carries one.'
    );
  }
  return principal.email;
}

function requireLinkCredentialHeader(header: string | undefined): string {
  if (header === undefined) {
    throw new Error(
      'pipeline misconfigured: a route posture is keyed on the shared-link credential ' +
        'with no header wired. Pass PipelineRateLimitOptions.linkCredentialHeader at the ' +
        'composition root.'
    );
  }
  return header;
}

/**
 * How the stage derives every identity an EDGE layer can name. Written as a
 * total map over that union rather than a switch, so an identity added to the
 * edge vocabulary fails to compile here until the stage can resolve it — the
 * edge declaration vocabulary and the resolution are one thing, not two lists.
 *
 * Totality over the edge set rather than over the whole of `PostureIdentity`
 * is what lets a route declare a bound its OWNING SLICE counts on an
 * identifier this stage could never derive. Nothing is lost by that: a layer
 * naming one of those identities is a flow layer by construction, and
 * `PostureLayer`'s discrimination on where the counting happens makes putting
 * one on an edge layer a compile error at the declaration site rather than a
 * lookup that resolves to nothing here.
 *
 * None of these reaches a database, and none of them parses a request body: an
 * identity is derived from the request's own headers and the principal the
 * pipeline already resolved, which is what lets a route declare its bound as
 * data.
 */
const IDENTITY_RESOLVERS: Readonly<
  Record<
    EdgeIdentity,
    (c: Context<AppEnv>, linkCredentialHeader: string | undefined) => Promise<ResolvedIdentity>
  >
> = {
  user: (c) => Promise.resolve(ok(fullPrincipalUserId(c.var.principal))),
  'session-user': (c) => Promise.resolve(ok(sessionUserId(c.var.principal))),
  'admin-actor': async (c) => ok(await hashRateLimitId(adminActorEmail(c.var.principal))),
  ip: async (c) => {
    const identity = await ipIdentity(c);
    return identity.map((id): string | null => id);
  },
  'sessionless-ip': async (c) => sessionlessIpIdentity(c),
  caller: async (c, header) => callerIdentity(requireLinkCredentialHeader(header))(c),
  'link-credential': async (c, header) =>
    linkCredentialIdentity(requireLinkCredentialHeader(header))(c),
};

/**
 * The declaration for one matched key, or `undefined` for none. `hasOwn` rather
 * than a plain lookup, so no key can resolve to something `Object.prototype`
 * carries.
 */
function declaredPosture(postures: RoutePostureMap, key: string): CarriedRoutePosture | undefined {
  return Object.hasOwn(postures, key) ? postures[key] : undefined;
}

/** One matched registration and the declaration the posture map holds for it. */
interface MatchedBound {
  readonly route: Pick<RouterRoute, 'method' | 'path'>;
  readonly posture: CarriedRoutePosture;
}

/**
 * The registration behind each of this request's route keys, one per key and in
 * the order {@link matchedRouteKeys} reports them. The join is by
 * {@link routeKey} — this repo's one spelling of a registration, and the same
 * one those keys were derived through — so the registration a bound is spent on
 * IS the one whose key resolved the declaration.
 *
 * Reading the registration rather than the request is what holds those two
 * together. The router dispatches a HEAD request by re-entering its dispatcher
 * with `GET`, so the GET registration is what matched and what the posture
 * lookup admitted while the request's own method still reads `HEAD`; a route
 * component taken from the request would name a route nothing declared, and
 * would hand every GET route's class default a second window of equal size on
 * a method the caller chooses. HEAD is the only such rewrite the router makes.
 */
function matchedRegistrations(
  c: Context<AppEnv>,
  keys: readonly string[]
): ReadonlyMap<string, Pick<RouterRoute, 'method' | 'path'>> {
  const declaredKeys = new Set(keys);
  const registrations = new Map<string, Pick<RouterRoute, 'method' | 'path'>>();
  for (const route of matchedRoutes(c)) {
    const key = routeKey(route);
    if (declaredKeys.has(key) && !registrations.has(key)) registrations.set(key, route);
  }
  return registrations;
}

/**
 * Every matched registration's declaration, or `null` when ANY of them is
 * undeclared. Resolved in full before anything is spent: a request matching one
 * declared route and one undeclared one must cost the declared route's window
 * nothing.
 */
function declaredBounds(
  c: Context<AppEnv>,
  postures: RoutePostureMap,
  keys: readonly string[]
): MatchedBound[] | null {
  const declared: MatchedBound[] = [];
  for (const [key, route] of matchedRegistrations(c, keys)) {
    const posture = declaredPosture(postures, key);
    if (posture === undefined) return null;
    declared.push({ route, posture });
  }
  return declared;
}

/**
 * Where a spend stopped when it answered no decision, and the whole vocabulary
 * of the `rateLimitBypassCause` property {@link reportBypass} carries.
 * `identity` — the value the counter would have been keyed on could not be
 * resolved, so the counter was never asked; in production, on an address-keyed
 * layer, that is the edge not attaching `cf-connecting-ip`. `counter` — the
 * spend reached the counting primitive and came back with no decision, which
 * covers an unreachable store, a check that outran its bound, an unreadable
 * reply, and an identifier the primitive refuses as over-long before it asks
 * the store at all.
 *
 * Both are reportable on a route declaring `open` and on no other: a route
 * declaring `closed` refuses either one, so no bypass exists to name. Which of
 * the two a route meets does not enter that decision — the failure posture is
 * read off the declaration and never off the cause.
 *
 * The `DomainError` code is deliberately not what stands in for this, because
 * it cuts across these two rather than along them. It runs together what they
 * separate: an unreachable store, a check that outran its bound and an
 * unreadable reply all mint `unavailable` (`lib/rate-limit/consume.ts`), and
 * `ipIdentity` refuses with `unavailable` too (`middleware/rate-limit.ts`), so
 * one code spans both causes. It also splits what they hold together: the
 * over-long identifier is a counter-side stop that mints `validation`
 * (`lib/rate-limit/consume.ts`), so reading the code would send an operator
 * looking at the request where the incident is the counter's. Where the spend
 * stopped separates the counter store from the edge, which are two incidents
 * with two different repairs.
 */
type BypassCause = 'identity' | 'counter';

/** A spend that answered no decision: the error, and where it stopped. */
interface EdgeSpendFailure {
  readonly cause: BypassCause;
  readonly error: DomainError;
}

/**
 * Spends one edge bound and answers its decision, or the failure with the
 * phase it stopped in. The ids go to `count` POSITIONALLY against the bound's
 * own `keyedBy` — never a route-level one, which also names the layers the
 * owning slice spends in its own flow and is longer whenever a route mixes the
 * two.
 *
 * The two phases are answered apart rather than collapsed because a route
 * declaring `open` admits on either and has to say which one it met — the two
 * send an operator to different systems. A route declaring `closed` refuses
 * both alike and reads nothing off the phase.
 */
async function spendEdgeBoundByPhase(
  c: Context<AppEnv>,
  edge: CountAtEdge,
  linkCredentialHeader: string | undefined
): Promise<ResultOf<RateLimitDecision, EdgeSpendFailure>> {
  const resolved = await Promise.all(
    edge.keyedBy.map(async (identity) => IDENTITY_RESOLVERS[identity](c, linkCredentialHeader))
  );
  const ids = Result.combine(resolved);
  if (ids.isErr()) return err({ cause: 'identity', error: ids.error });
  const decision = await edge.count(c.var.redis, ids.value);
  return decision.mapErr((error): EdgeSpendFailure => ({ cause: 'counter', error }));
}

/**
 * Spends the pipeline-counted bound a `named` route declares, or `null` when it
 * declares none — either because it is not `named`, or because every layer it
 * names is counted inside its owning slice's flow. A route naming ANY
 * flow-counted layer declares `closed` and is held to it: `bindRoutePosture`
 * refuses an `open` declaration for a bound this stage would spend only part
 * of, since the slice counting the rest refuses on its own terms and reads no
 * posture.
 */
async function spendNamedBound(
  c: Context<AppEnv>,
  route: Pick<RouterRoute, 'method' | 'path'>,
  posture: CarriedRoutePosture,
  linkCredentialHeader: string | undefined
): Promise<Response | null> {
  if (posture.kind !== 'named') return null;
  const edge = posture.countAtEdge;
  if (edge === undefined) return null;
  return answerSpend(
    c,
    route,
    posture.failure,
    await spendEdgeBoundByPhase(c, edge, linkCredentialHeader)
  );
}

/**
 * The bindings stage's logger, which carries every admission this stage could
 * not bound. A `default` declaration asks for it up front, because it also
 * writes the class default's own attribution lines; a `named` one asks only
 * when it has a bypass to report, since a surface mounting the stage over
 * named routes alone never reaches this channel.
 */
function reportingLogger(c: Context<AppEnv>): Telemetry {
  const logger = readPipelineVariable(c, 'logger');
  if (logger === undefined) {
    throw new Error(
      'pipeline order violated: an admission this stage could not bound is reported ' +
        'through the logger, so pipelineRateLimit requires pipelineBindings first.'
    );
  }
  return logger;
}

/**
 * The two variables a class default resolves against, both published by
 * earlier stages: the authorizer's route class and the bindings stage's
 * logger. A `default` declaration reaching this stage without either is a
 * mis-ordered composition, and it fails loudly rather than admitting a route
 * whose whole declared bound is the default it could not resolve.
 */
function classDefaultPrerequisites(c: Context<AppEnv>): {
  routeClass: RouteClass;
  logger: Telemetry;
} {
  const routeClass = readPipelineVariable(c, 'routeClass');
  if (routeClass === undefined) {
    throw new Error(
      'pipeline order violated: a default posture resolves against its route class, so ' +
        'pipelineRateLimit requires pipelineAuthorize first.'
    );
  }
  return { routeClass, logger: reportingLogger(c) };
}

/**
 * How long one isolate stays quiet on a report it has already made about a
 * bound it could not spend.
 *
 * A window rather than a flag, and the difference is the failure being fixed.
 * An unbounded report emits on EVERY request an outage meets, which floods
 * the one channel a human reads with a single repeated fact; a flag inverts it,
 * reporting the first outage an isolate ever meets and staying silent for every
 * later one, and a Worker isolate can live for hours. A minute is the reader's
 * number: during an incident the question is whether it is still happening, so
 * the answer must refresh at the pace someone is looking, and an isolate
 * emitting a report at most once a minute is a rate rather than a flood. It is
 * deliberately its own value and not the class default's window — those bound
 * a caller's requests, this bounds telemetry volume, and one moving is no
 * reason for the other to.
 */
export const BYPASS_REPORT_WINDOW_MS = 60_000;

/**
 * When this isolate last reported a bypass, or `null` if it never has. Module
 * scope is where an isolate's own configuration and memoization already live
 * here (`lib/rate-limit/bound.ts` holds the counter timeout the same way): what
 * the platform forbids is I/O at global evaluation, not a request mutating a
 * module variable, and nothing here is request, user or business state that
 * losing with the isolate would cost anything.
 *
 * It gates REPORTING and never admission — the decision above it is the same
 * whatever this holds.
 */
let lastBypassReportAt: number | null = null;

/**
 * Reports one admission this stage could not bound, on the error channel, which
 * is the only telemetry a deployed Worker retains: the console adapter's lines
 * are ingested nowhere, and the Sentry adapter's log methods are inert, so a
 * `warn` about a bypass has no reader at all. Every route that admits an
 * unspendable bound declares `open` and reaches here — a class default and a
 * named limit alike, since the failure posture is the route's own declaration
 * rather than a property of which of the two paths spent it.
 *
 * WHAT ONE EVENT ESTABLISHES, exactly. At least one request was admitted
 * without being counted, on the route the `rateLimitRoute` tag names, in one
 * isolate, for the reason `rateLimitBypassCause` names ({@link BypassCause} is
 * that tag's whole vocabulary). It is not a count of admitted requests and not
 * a count of outages: an outage bypasses every request that meets it, many
 * isolates across many colos serve at once, and each reports at most once per
 * {@link BYPASS_REPORT_WINDOW_MS} whichever cause it met — so one cause
 * reporting is also what silences the other for that window. Events arriving
 * are a lower bound on the bypass in every direction — the absence of a second
 * event says nothing.
 *
 * Both facts ride as properties because the Sentry scrub drops the message and
 * rebuilds the event from an allowlist; `sentry-scrub.ts` lifts these keys into
 * tags. The route is {@link routeKey}'s spelling, which carries the method and
 * the path template a registration declares — never a request's own method, and
 * nothing a caller supplies; the cause is one of two literals written here.
 */
function reportBypass(
  telemetry: Telemetry,
  route: Pick<RouterRoute, 'method' | 'path'>,
  cause: BypassCause
): void {
  const now = Date.now();
  if (lastBypassReportAt !== null && now - lastBypassReportAt < BYPASS_REPORT_WINDOW_MS) return;
  lastBypassReportAt = now;
  const error = new Error('rate-limit bound could not be spent; request admitted');
  error.name = 'RateLimitBypassed';
  Object.assign(error, { rateLimitRoute: routeKey(route), rateLimitBypassCause: cause });
  telemetry.captureError(error, FINGERPRINT_CODES.rateLimitBypassed);
}

/**
 * What one spend earns its caller: the refusal, or `null` for admitted. This
 * is the ONE place a failure declaration is read — {@link rateLimitRefusal}
 * decides it, and a `null` answered to a FAILED spend is by definition an
 * admission nothing counted, which is what makes the report unconditional here
 * rather than a second reading of the same declaration.
 *
 * A route declaring `closed` therefore reports no BYPASS, and correctly: it
 * admitted nothing to report. Its refusal answers a different question —
 * whether the counter store is reachable, which is the same incident under
 * either declaration — and answers it through the refusal tail
 * {@link rateLimitRefusal} ends in, which reports the dependency behind every
 * availability refusal; a second report here would count one refusal twice.
 */
function answerSpend(
  c: Context<AppEnv>,
  route: Pick<RouterRoute, 'method' | 'path'>,
  failure: FailurePosture,
  spent: ResultOf<RateLimitDecision, EdgeSpendFailure>
): Response | null {
  if (spent.isOk()) return rateLimitRefusal(c, ok(spent.value), failure);
  const refusal = rateLimitRefusal(c, err(spent.error.error), failure);
  if (refusal === null) reportBypass(reportingLogger(c), route, spent.error.cause);
  return refusal;
}

/**
 * Spends a `default` route's class default and answers what the route's two
 * declarations earn its caller. The 429 is the one {@link rateLimitRefusal}
 * builds for a named limit, so the two are indistinguishable to a caller. The
 * crossing is logged as well as refused, and what the line carries that nothing
 * else can is the ATTRIBUTION: {@link rateLimitRefusal} writes no line at all,
 * so without this one a class default's 429 and a named limit's 429 are the
 * same event everywhere they are observed — the message is what separates them.
 *
 * Neither of this function's two answers is a property of it being a class
 * default. A caller past the cap is refused, for every limit kind and under
 * either failure posture. A spend that answers no decision is decided by the
 * route's own `failure` declaration through {@link answerSpend}, exactly as a
 * named route's is — the doctrine that once made this path the Worker's only
 * fail-open arm is now a per-route declaration, reasoned in the fragment that
 * declares each route.
 *
 * The line beside a bypass reaches no channel anything retains, which is why
 * {@link reportBypass} exists; the two log lines here are the class default's
 * own attribution and are written whichever way the declaration falls.
 */
async function spendClassDefault(
  c: Context<AppEnv>,
  route: Pick<RouterRoute, 'method' | 'path'>,
  failure: FailurePosture,
  linkCredentialHeader: string | undefined
): Promise<Response | null> {
  const { routeClass, logger } = classDefaultPrerequisites(c);
  // The counter and the line that reports it read one registration, so a
  // crossing is always logged under the route whose counter it crossed.
  const spent = await spendEdgeBoundByPhase(
    c,
    bindClassDefault(routeClass, route),
    linkCredentialHeader
  );
  const fields = { method: route.method, route: route.path };
  if (spent.isErr()) {
    // The failure names WHICH of the four the counting primitive met. Only that
    // closed literal rides: the error's message and cause chain hold the
    // serialized counter command, whose KEYS embed the identity being counted
    // (`docs/CODE-RULES.md` §Telemetry). Worth carrying on a line no deployment
    // ingests, because this is what a local reader debugs a limiter failure
    // from, and the route alone says which requests were affected and no more.
    const failure: RateLimitFailure | undefined = rateLimitFailureOf(spent.error.error);
    logger.warn('rate-limit class default unavailable', {
      ...fields,
      ...(failure === undefined ? {} : { rateLimitFailure: failure }),
    });
  } else if (!spent.value.allowed) {
    logger.warn('rate-limit class default exceeded', fields);
  }
  return answerSpend(c, route, failure, spent);
}

/**
 * Spends what every matched declaration bounds, or the refusal the first
 * crossing earns. A `default` declaration's whole bound is its class default,
 * so it is spent here rather than beside the named one it does not have.
 */
async function spendDeclaredBounds(
  c: Context<AppEnv>,
  declared: readonly MatchedBound[],
  linkCredentialHeader: string | undefined
): Promise<Response | null> {
  for (const { route, posture } of declared) {
    const refusal = await spendNamedBound(c, route, posture, linkCredentialHeader);
    if (refusal !== null) return refusal;
    if (posture.kind === 'default') {
      const defaultRefusal = await spendClassDefault(
        c,
        route,
        posture.failure,
        linkCredentialHeader
      );
      if (defaultRefusal !== null) return defaultRefusal;
    }
  }
  return null;
}

/**
 * Pipeline stage: DEFAULT-DENY rate-limit posture enforcement — the one
 * execution point for the posture declaration, between authorization and the
 * idempotency stage (403, then 429, then 400). A matched route the map does
 * not declare is refused before its handler runs; a declared route is admitted
 * once the bound it declares has been spent. `named` carries the bound itself
 * — a capability closed over the owning slice's registry entries, of which
 * this stage spends the pipeline-counted ones and leaves the rest to the slice
 * flow that owns them; `default` spends its route class's default, on the
 * terms {@link spendClassDefault} states; `exempt` names the obligation its
 * exemption class carries in a counter's place. Each of the first two also
 * declares what an unspendable bound earns, which {@link answerSpend} is the
 * one reader of.
 *
 * Resolution mirrors the authorizer's, and for the same reason: nothing but
 * the pipeline matched means no such route, which falls through to 404 rather
 * than being denied. A request matching several registrations is refused when
 * ANY of them is undeclared, and spends the bound of each — the router picks
 * the responder after this stage has run, so the fail-closed reading is the
 * only sound one.
 */
export function pipelineRateLimit(options?: PipelineRateLimitOptions): MiddlewareHandler<AppEnv> {
  return markPipelineHandler(async (c, next) => {
    // The envUtils type assumes the env stage ran; verify it — a posture gate
    // that cannot read the mode must be a loud defect, not a silent pass.
    const envUtilities = readPipelineVariable(c, 'envUtils');
    if (envUtilities === undefined) {
      throw new Error('pipeline order violated: pipelineRateLimit requires pipelineEnv first.');
    }
    const keys = matchedRouteKeys(c);
    if (keys.length === 0) return next();
    assertPosturesWiredInProduction(options, envUtilities.isProduction);
    const postures = options?.postures;
    if (postures === undefined) return next();
    const declared = declaredBounds(c, postures, keys);
    if (declared === null) {
      return c.json(createErrorResponse(ERROR_CODES.RATE_LIMITED), 429);
    }
    const refusal = await spendDeclaredBounds(c, declared, options?.linkCredentialHeader);
    if (refusal !== null) return refusal;
    return next();
  });
}
