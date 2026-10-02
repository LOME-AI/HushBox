import { createErrorResponse, domainWireCode, isAvailabilityCode } from '../errors/index.js';
import { FINGERPRINT_CODES } from '../telemetry/fingerprint-codes.js';
import { dependencyFailureOf } from './dependency-failure.js';
import { matchedRouteKeys } from './route-keys.js';
import type { AppEnv } from './app-env.js';
import type { DependencyFailure } from './dependency-failure.js';
import type { RefusalResponse } from './respond.js';
import type { DomainError, DomainErrorCode } from '../errors/index.js';
import type { Telemetry } from '../telemetry/port.js';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * The single `DomainError` → HTTP status map, and the refusal tail every route
 * answers a domain failure with.
 *
 * It lives here rather than in `lib/errors` because the map is transport
 * vocabulary annotated with a Hono type, and `lib/errors` is the module every
 * slice imports to *build* errors — housing it there would drag the framework's
 * type surface into all of them. It is deliberately not a middleware error
 * boundary: each route keeps its visible `respondDomainError(...)` call, because
 * a handler returning a widened type erases its route schema from `AppType` and
 * blinds the typed client.
 *
 * `timeout` is 504, not 408: the only producers of a `timeout` DomainError are
 * the resilience layer's outbound-call deadline and timeout policies, so it
 * always means an upstream call exceeded its deadline — never that the client
 * was slow to send, which is what 408 states.
 */
export const STATUS_BY_DOMAIN_CODE = {
  validation: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  timeout: 504,
  unavailable: 503,
} as const satisfies Record<DomainErrorCode, ContentfulStatusCode>;

/**
 * How long one isolate stays quiet about a (dependency, failure arm) pair it
 * has already reported. A window rather than a flag: an unbounded report floods
 * the one channel a human reads with a single repeated fact during an outage,
 * and a flag would report the first outage an isolate meets and none after it,
 * while an isolate can live for hours. A minute refreshes at the pace someone
 * reading an incident looks. It bounds telemetry volume and nothing else.
 */
export const DEPENDENCY_REPORT_WINDOW_MS = 60_000;

/**
 * When this isolate last reported each (dependency, failure arm) pair. Module
 * scope is where an isolate's own reporting state lives: it gates REPORTING and
 * never the answer, and losing it with the isolate costs nothing. Keyed by the
 * pair so an outage of one store cannot silence another's.
 */
const lastDependencyReportAt = new Map<string, number>();

/**
 * The logger the bindings stage bound, or `undefined` on a context it never
 * ran on: Hono types a declared variable as always present, and this is where
 * that promise is not taken.
 */
function boundLogger(c: Context<AppEnv>): Telemetry | undefined {
  return c.get('logger');
}

/**
 * Reports an availability refusal on the error channel, which is the only
 * telemetry a deployed Worker retains; the caller's wire code names no
 * dependency, so without this the name is lost.
 *
 * WHAT ONE EVENT ESTABLISHES, exactly. At least one request in one isolate was
 * refused because the named dependency failed on the named arm, on the route
 * the `dependencyRoute` tag names. It is not a count of refusals and not a
 * count of outages: many isolates serve at once, and each reports each pair at
 * most once per {@link DEPENDENCY_REPORT_WINDOW_MS}.
 *
 * WHAT MAY NOT RIDE. It is handed the classification, a closed-set lookup, and
 * nothing else of the error. The error's message and cause chain
 * hold driver and store errors whose messages embed query text, parameters and
 * serialized commands with their keys, so they never travel
 * (`docs/CODE-RULES.md` §Telemetry). The route is a registration's key, so
 * nothing a caller supplies reaches it.
 *
 * Telemetry never fails a request, so a context the bindings stage has not
 * given a logger answers its refusal uncaptured; the assembled Worker binds one
 * ahead of every route.
 */
function reportDependencyFailure(c: Context<AppEnv>, classified: DependencyFailure): void {
  const logger = boundLogger(c);
  if (logger === undefined) return;
  const pair = `${classified.dependency}:${classified.failure}`;
  const now = Date.now();
  const lastReportAt = lastDependencyReportAt.get(pair);
  if (lastReportAt !== undefined && now - lastReportAt < DEPENDENCY_REPORT_WINDOW_MS) return;
  lastDependencyReportAt.set(pair, now);
  // The terminal registration is the last one matched; a request nothing
  // routed has none, and its report names no route.
  const route = matchedRouteKeys(c).at(-1);
  const report = new Error('an availability refusal named the dependency behind it');
  report.name = 'DependencyUnavailable';
  Object.assign(report, {
    ...(route === undefined ? {} : { dependencyRoute: route }),
    dependency: classified.dependency,
    dependencyFailure: classified.failure,
    dependencyLate: classified.late,
  });
  logger.captureError(report, FINGERPRINT_CODES.dependencyUnavailable);
}

/**
 * Answers the `{code}` refusal body — an error's carried wire code when it has
 * one — at the mapped status. An availability refusal's classification is
 * recorded on the request for its request line, on every refusal, and reported
 * on the retained channel under the latch.
 */
export function respondDomainError(c: Context<AppEnv>, error: DomainError): RefusalResponse {
  if (isAvailabilityCode(error.code)) {
    const classified = dependencyFailureOf(error);
    c.set('dependencyFailure', classified);
    reportDependencyFailure(c, classified);
  }
  return c.json(createErrorResponse(domainWireCode(error)), STATUS_BY_DOMAIN_CODE[error.code]);
}
