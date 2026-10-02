import { httpStatusCode, sanitizeErrorName, stackFrameLines } from '../error-scrub.js';
import type { ErrorEvent, EventHint, Exception, StackFrame } from '@sentry/cloudflare';

/**
 * The Sentry `beforeSend` scrub: the last gate before an event leaves the
 * process (structural cause-chain scrubbing lives at the Telemetry port).
 * It rebuilds the event from an allowlist instead of deleting known-bad
 * fields, so anything the SDK or a future integration adds is dropped by
 * default: request bodies, headers, cookies, user, breadcrumbs, extra,
 * contexts, transaction, server_name, and the SDK's own exception parse
 * (whose `value` carries the raw error message) all die here.
 *
 * Exception values are re-derived from `hint.originalException`, walking the
 * `cause` chain, through the single-sourced error-scrub helpers shared with
 * the console adapter: error NAMES pass only when identifier-shaped, MESSAGES
 * are dropped wholesale (driver errors embed query parameters), and stack
 * text keeps only call-site frames after stripping the derived
 * `name: message` header — a stack whose header cannot be derived is dropped
 * wholesale (fail closed).
 */

/** Mirrors the SDK's linked-errors default: the reported error plus at most
 * four causes. */
const MAX_CHAIN_LENGTH = 5;

function parseLocation(
  location: string
): Pick<StackFrame, 'filename' | 'lineno' | 'colno'> | undefined {
  const parsed = /^(.*):(\d+):(\d+)$/.exec(location);
  if (!parsed?.[1] || !parsed[2] || !parsed[3]) {
    return undefined;
  }
  return { filename: parsed[1], lineno: Number(parsed[2]), colno: Number(parsed[3]) };
}

/**
 * One V8 frame line → a structured Sentry frame. Lines that fit no known
 * shape are dropped (fail closed): only runtime-derived code locations may
 * travel.
 */
function parseFrameLine(line: string): StackFrame | undefined {
  const at = /^\s+at\s+(.*)$/.exec(line);
  if (!at?.[1]) {
    return undefined;
  }
  const callSite = /^(.*)\s\((.*)\)$/.exec(at[1]);
  const location = parseLocation(callSite?.[2] ?? at[1]);
  if (location === undefined) {
    return undefined;
  }
  const functionName = callSite?.[1];
  return {
    ...(functionName === undefined ? {} : { function: functionName }),
    ...location,
    in_app: true,
  };
}

function safeException(error: Error): Exception {
  // Sentry's frame order is oldest call first, crash site last — the reverse
  // of V8's stack text.
  const frames = stackFrameLines(error)
    .map((line) => parseFrameLine(line))
    .filter((frame): frame is StackFrame => frame !== undefined)
    .toReversed();
  return {
    type: sanitizeErrorName(error.name),
    ...(frames.length > 0 ? { stacktrace: { frames } } : {}),
  };
}

function errorChain(originalException: unknown): Error[] {
  const chain: Error[] = [];
  let current: unknown = originalException;
  while (current instanceof Error && chain.length < MAX_CHAIN_LENGTH) {
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

function safeExceptionValues(originalException: unknown): Exception[] {
  // Deepest cause first, reported error last — the SDK's linked-errors order.
  return errorChain(originalException)
    .toReversed()
    .map((error) => safeException(error));
}

/**
 * The HTTP status closest to the reported error — provider failures carry it on
 * the reported `APICallError` or a shallow cause. Only the integer travels
 * (see `httpStatusCode`); message, url, and body stay dropped.
 */
function firstHttpStatusCode(originalException: unknown): number | undefined {
  for (const error of errorChain(originalException)) {
    const status = httpStatusCode(error);
    if (status !== undefined) {
      return status;
    }
  }
  return undefined;
}

/** A nano-USD `bigint` rendered with `.toString()` — an optionally-signed run
 * of decimal digits. Anything else in `absorbedNanoUsd` is a content vector. */
const NANO_USD_STRING = /^-?\d+$/;

/**
 * A run id as the conversation room mints one — `crypto.randomUUID()`, so the
 * canonical lowercase hyphenated form. Anything else under `runId` is a content
 * vector. It stands apart from {@link ROW_ID}, which happens to describe the
 * same characters: the two gates close different producers' ids, and collapsing
 * them would make a change to what a row id looks like silently move what a run
 * id may be.
 */
const RUN_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;

/**
 * The absorbed-platform-loss diagnostics an error carries, surfaced as discrete
 * tags so an operator can SEE which run cost the platform money and how much.
 * Membership is the two property names and nothing else — every capture that
 * names a run and the nano-USD absorbed for it is carried, whichever raise
 * minted it — so a new producer of that pair needs no change here, provided it
 * mints its run id as the room does. Both keys are
 * non-PII by construction: `runId` is the DO-minted random run id
 * (`crypto.randomUUID()`, so no embedded timestamp; persisted as
 * `idempotency_keys.runId` / `usage_records.runId`), never the client-supplied
 * `runKey` — an attacker-controllable value in an allowlisted tag would bypass
 * this scrub — and never a user id, email, or content; `absorbedNanoUsd` is the
 * absorbed platform loss as a nano-USD string (money is never
 * Number()-coerced). Only a `runId` of the {@link RUN_ID} shape and a
 * digits-only nano-USD `absorbedNanoUsd` travel — any other type or shape is a
 * content vector and is dropped (fail closed), mirroring the statusCode
 * discipline. Neither shape closes its value space the way an enumeration
 * closes one, so each producer still carries the test the tag-admission rule
 * demands of a gate that only checks a promise. A key added to the record this
 * returns is spread into {@link scrubSentryEvent}'s `tags:` object and reaches
 * the wire without that object being edited, so it must clear the
 * tag-admission rule commented there — the same bar as a key written into that
 * object directly.
 */
function absorbedLossTags(originalException: unknown): {
  runId?: string;
  absorbedNanoUsd?: string;
} {
  if (!(originalException instanceof Error)) {
    return {};
  }
  const runId: unknown = Reflect.get(originalException, 'runId');
  const absorbedNanoUsd: unknown = Reflect.get(originalException, 'absorbedNanoUsd');
  return {
    ...(typeof runId === 'string' && RUN_ID.test(runId) ? { runId } : {}),
    ...(typeof absorbedNanoUsd === 'string' && NANO_USD_STRING.test(absorbedNanoUsd)
      ? { absorbedNanoUsd }
      : {}),
  };
}

/**
 * A route key as this repo spells one — `$<method> <path template>`, the shape
 * `routeKey` (`apps/api/src/lib/context/route-keys.ts`) builds from a
 * registration. A registered path carries no whitespace, so the space after the
 * method is the only one a well-formed value has.
 */
const ROUTE_KEY = /^\$[a-z]+ \/\S*$/;

/**
 * Where a rate-limit bypass stopped, as the producer names it
 * (`apps/api/src/middleware/pipeline-rate-limit.ts` calls this vocabulary
 * `BypassCause`). Restated here rather than imported, for the reason every
 * other value in this file is: this gate is the last one before the wire and
 * must not trust the producer to have kept its own promise. Drift costs the tag
 * and nothing else — an unrecognized value is dropped, which is the safe
 * direction.
 */
const BYPASS_CAUSES: ReadonlySet<string> = new Set(['identity', 'counter']);

/**
 * What a rate-limit bypass could not bound and why, surfaced as discrete tags
 * so an operator reading the event learns WHICH route was admitted uncounted
 * and WHICH system to look at, rather than only that something was. Both are
 * non-PII by construction: the route is built from a route REGISTRATION — a
 * method and a path template compiled into the Worker — so no caller-supplied
 * component and no concrete path can reach it, and the cause is one of two
 * literals the producer writes. Only a string of the route-key shape and a
 * cause this file recognizes travel; anything else is a content vector and is
 * dropped (fail closed), like the statusCode and absorbed-loss keys. What this
 * record holds is spread into {@link scrubSentryEvent}'s `tags:` object, so a
 * third key here is a third tag on the wire; the tag-admission rule commented
 * on that object is what decides whether it may be one.
 */
function rateLimitBypassTags(originalException: unknown): {
  rateLimitRoute?: string;
  rateLimitBypassCause?: string;
} {
  if (!(originalException instanceof Error)) {
    return {};
  }
  const route: unknown = Reflect.get(originalException, 'rateLimitRoute');
  const cause: unknown = Reflect.get(originalException, 'rateLimitBypassCause');
  return {
    ...(typeof route === 'string' && ROUTE_KEY.test(route) ? { rateLimitRoute: route } : {}),
    ...(typeof cause === 'string' && BYPASS_CAUSES.has(cause)
      ? { rateLimitBypassCause: cause }
      : {}),
  };
}

/**
 * The dependencies and failure arms an availability refusal is classified into,
 * as the producer names them (the request context's `dependencyFailureOf`
 * answers these vocabularies as `Dependency` and `DependencyFailureArm`). Restated
 * here rather than imported, for the reason every other value in this file is:
 * this gate is the last one before the wire and must not trust the producer to
 * have kept its own promise. Drift costs the tag and nothing else — an
 * unrecognized value is dropped, which is the safe direction.
 */
const DEPENDENCIES: ReadonlySet<string> = new Set(['postgres', 'redis', 'unknown']);
const DEPENDENCY_FAILURES: ReadonlySet<string> = new Set([
  'acquire-timeout',
  'serial-overlap',
  'connect-timeout',
  'statement-timeout',
  'deadline',
  'transport',
  'server-error',
  'unknown',
]);

/**
 * WHICH dependency an availability refusal met, on WHICH arm, whether the
 * isolate's own event loop was late, and on which route, surfaced as discrete
 * tags so an operator reading a 503 learns which system to look at and whether
 * to look at a system at all — a late isolate blames no dependency. The first
 * three gates are ENUMERATIONS over closed sets (the lateness over the two
 * booleans), so nothing else can travel under those names whatever the
 * producer attaches; that matters here because the error the classification is
 * read from holds driver and store errors whose messages embed query text and
 * counter keys. The route is a shape check, built from a registration by the
 * producer, whose test asserts the value and the emitted error's whole own-key
 * set (`apps/api/src/lib/context/domain-error-status.test.ts`). What this
 * record holds is spread into {@link scrubSentryEvent}'s `tags:` object, so a
 * fifth key here is a fifth tag on the wire; the tag-admission rule commented
 * on that object is what decides whether it may be one.
 */
function dependencyFailureTags(originalException: unknown): {
  dependencyRoute?: string;
  dependency?: string;
  dependencyFailure?: string;
  dependencyLate?: boolean;
} {
  if (!(originalException instanceof Error)) {
    return {};
  }
  const route: unknown = Reflect.get(originalException, 'dependencyRoute');
  const dependency: unknown = Reflect.get(originalException, 'dependency');
  const failure: unknown = Reflect.get(originalException, 'dependencyFailure');
  const late: unknown = Reflect.get(originalException, 'dependencyLate');
  return {
    ...(typeof route === 'string' && ROUTE_KEY.test(route) ? { dependencyRoute: route } : {}),
    ...(typeof dependency === 'string' && DEPENDENCIES.has(dependency) ? { dependency } : {}),
    ...(typeof failure === 'string' && DEPENDENCY_FAILURES.has(failure)
      ? { dependencyFailure: failure }
      : {}),
    ...(typeof late === 'boolean' ? { dependencyLate: late } : {}),
  };
}

/**
 * A row id as this repo mints one — the canonical lowercase hyphenated uuid
 * form, which is what `users.id` holds and all a repair operation is addressed
 * by. Anything else under `totpStrandedUserId` is a content vector.
 */
const ROW_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;

/**
 * A matched route template as Hono's `routePath` returns one: a leading slash,
 * then segments and `:param` placeholders compiled from a registration. The
 * character set admits nothing an address, a query string, or free text needs.
 * A concrete path built from those same characters matches too, and does not
 * need to be dropped: the producer emits `routePath(c)`, which is the
 * registered template.
 */
const PATH_TEMPLATE = /^\/[\w/:-]*$/;

/**
 * WHICH user's second factor is stranded and WHERE the lockout was observed,
 * surfaced as discrete tags so an operator paged by the event can run the
 * per-user repair operation — a page naming no user names no repair. The user
 * id travels here by explicit ruling and is the narrowest thing that
 * identifies the row: no email, no username, no content. The route is the
 * matched route TEMPLATE, compiled from a registration, so no concrete path
 * and nothing a caller supplies can reach it. Only a value of the row-id shape
 * and one of the path-template shape travel; anything else is a content vector
 * and is dropped (fail closed), like the statusCode and rate-limit keys. What
 * this record holds is spread into {@link scrubSentryEvent}'s `tags:` object,
 * so a third key here is a third tag on the wire; the tag-admission rule
 * commented on that object is what decides whether it may be one.
 */
function strandedSecondFactorTags(originalException: unknown): {
  totpStrandedUserId?: string;
  totpStrandedRoute?: string;
} {
  if (!(originalException instanceof Error)) {
    return {};
  }
  const userId: unknown = Reflect.get(originalException, 'totpStrandedUserId');
  const route: unknown = Reflect.get(originalException, 'totpStrandedRoute');
  return {
    ...(typeof userId === 'string' && ROW_ID.test(userId) ? { totpStrandedUserId: userId } : {}),
    ...(typeof route === 'string' && PATH_TEMPLATE.test(route) ? { totpStrandedRoute: route } : {}),
  };
}

/**
 * A whole non-negative count, the only shape either backup-audit tag travels
 * in. A number carries no text, and rejecting fractions and negatives keeps
 * the tag reading as a count rather than as a channel: the value space cannot
 * be closed the way an enumeration closes one, so the narrowest total check
 * over it is what stands here.
 */
function wholeCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * WHAT the backup auditor measured, surfaced as discrete tags so an operator
 * paged by a backup finding learns which repair it is: a repository stale by
 * one missed run is a different story from one stale by four days, and a
 * retention rule someone widened by a day is a different story from one set to
 * ten years, and a version overdue by a day is a different story from one
 * overdue by a year — the code alone separates none of them. All are non-PII by
 * construction and by more than the producer's care: two are durations the
 * auditor measured against its own clock, so they name no instant; the third is
 * a day count the object store published in its own bucket configuration. None
 * is derived from a request, a user, or any content — the auditor that
 * raises them reads object metadata and a bucket policy and nothing else.
 * Only a whole non-negative number travels under any of these names; anything
 * else is a content vector and is dropped (fail closed), like the statusCode
 * and rate-limit keys. What this record holds is spread into
 * {@link scrubSentryEvent}'s `tags:` object, so another key here is another tag
 * on the wire; the tag-admission rule commented on that object is what decides
 * whether it may be one — and because {@link wholeCount} is a shape check
 * rather than an enumeration, each producer carries the test that rule demands
 * (`apps/api/src/slices/media/domain/audit/entries.test.ts` asserts, for each of
 * these tags, both the value and the emitted error's whole own-key set).
 */
function backupAuditTags(originalException: unknown): {
  backupStaleMinutes?: number;
  backupLifecycleNoncurrentDays?: number;
  backupNoncurrentVersionDays?: number;
} {
  if (!(originalException instanceof Error)) {
    return {};
  }
  const stale: unknown = Reflect.get(originalException, 'backupStaleMinutes');
  const lifecycle: unknown = Reflect.get(originalException, 'backupLifecycleNoncurrentDays');
  const version: unknown = Reflect.get(originalException, 'backupNoncurrentVersionDays');
  const staleMinutes = wholeCount(stale);
  const noncurrentDays = wholeCount(lifecycle);
  const noncurrentVersionDays = wholeCount(version);
  return {
    ...(staleMinutes === undefined ? {} : { backupStaleMinutes: staleMinutes }),
    ...(noncurrentDays === undefined ? {} : { backupLifecycleNoncurrentDays: noncurrentDays }),
    ...(noncurrentVersionDays === undefined
      ? {}
      : { backupNoncurrentVersionDays: noncurrentVersionDays }),
  };
}

/**
 * The aggregate grains growth counts in, as the schema's own enum spells them.
 * Restated here rather than imported, for the reason every other value in this
 * file is: this gate is the last one before the wire and must not trust the
 * producer to have kept its own promise. Drift costs the tag and nothing else —
 * an unrecognized value is dropped, which is the safe direction.
 */
const GROWTH_GRAINS: ReadonlySet<string> = new Set(['hour', 'day']);

/**
 * A growth bucket key: a UTC day, and an hour of one where the grain is the
 * hour. The character set admits nothing free text or an address needs.
 */
const GROWTH_BUCKET_KEY = /^\d{4}-\d{2}-\d{2}(?:T\d{2})?$/;

/**
 * A growth page path and the length every growth path column is bounded at,
 * restated from the shared pattern for the reason above. A path is validated
 * against the built page set before anything counts it, so no caller-supplied
 * component reaches a bucket at all; the shape check is what makes that hold
 * here without trusting it.
 */
const GROWTH_PATH = /^\/[a-z0-9/-]*$/;
const GROWTH_PATH_MAX_LENGTH = 200;

/**
 * WHICH stored row a re-roll had to bring back inside its own landings-within-
 * visitors check, surfaced as discrete tags so an operator paged by it can read
 * the row — a page saying a count was lowered without saying which row names no
 * repair, and the loss it stands for is a counting store that dropped members,
 * which nothing else in the system observes. All three are non-PII by
 * construction: the grain is one of two literals the schema's enum holds, the
 * bucket is a UTC day or hour label derived from the bucket being reduced, and
 * the path is one of the site's own built pages, which is what the counting
 * path validates against before a beacon opens a key. Only a grain this file
 * recognizes, a value of the bucket-key shape and a path within the shape and
 * the length bound travel; anything else is a content vector and is dropped
 * (fail closed), like the statusCode and rate-limit keys. What this record
 * holds is spread into {@link scrubSentryEvent}'s `tags:` object, so a fourth
 * key here is a fourth tag on the wire; the tag-admission rule commented on
 * that object is what decides whether it may be one — and because two of these
 * gates are shape checks rather than enumerations, the producer carries the
 * test that rule demands (`apps/api/src/slices/growth/domain/rollup.integration.test.ts`
 * asserts, for these tags, both the values and the emitted error's whole own-key
 * set).
 */
function landingClampTags(originalException: unknown): {
  growthClampedGrain?: string;
  growthClampedBucket?: string;
  growthClampedPath?: string;
} {
  if (!(originalException instanceof Error)) {
    return {};
  }
  const grain: unknown = Reflect.get(originalException, 'growthClampedGrain');
  const bucket: unknown = Reflect.get(originalException, 'growthClampedBucket');
  const path: unknown = Reflect.get(originalException, 'growthClampedPath');
  return {
    ...(typeof grain === 'string' && GROWTH_GRAINS.has(grain) ? { growthClampedGrain: grain } : {}),
    ...(typeof bucket === 'string' && GROWTH_BUCKET_KEY.test(bucket)
      ? { growthClampedBucket: bucket }
      : {}),
    ...(typeof path === 'string' && path.length <= GROWTH_PATH_MAX_LENGTH && GROWTH_PATH.test(path)
      ? { growthClampedPath: path }
      : {}),
  };
}

/**
 * HOW FAR a web search ran past the storage the admission hold reserves for,
 * surfaced as discrete tags so an operator paged by either oversize code learns
 * whether the bound needs a small revision or a large one. Both are counts the
 * producer computes over lengths it measured, never over text: the payload's
 * serialized length under `search_result_oversize`, the number of sources the
 * stored rows dropped under `search_row_oversize`. Only a whole non-negative
 * number travels under either name; anything else is a content vector and is
 * dropped (fail closed), like the backup counts. What this record holds is
 * spread into {@link scrubSentryEvent}'s `tags:` object, so another key here is
 * another tag on the wire; the tag-admission rule commented on that object is
 * what decides whether it may be one. Because {@link wholeCount} is a shape
 * check rather than an enumeration, each producer carries the test that rule
 * demands, asserting the value and the emitted error's whole own-key set:
 * `apps/api/src/slices/models/adapters/brave-search.test.ts` ("reports an
 * oversize payload by its size alone") and
 * `apps/api/src/slices/workflows/domain/nodes/model-call-execution.test.ts`
 * ("reports the dropped sources by their count alone").
 */
function searchOversizeTags(originalException: unknown): {
  resultChars?: number;
  droppedSourceCount?: number;
} {
  if (!(originalException instanceof Error)) {
    return {};
  }
  const resultChars = wholeCount(Reflect.get(originalException, 'resultChars'));
  const droppedSourceCount = wholeCount(Reflect.get(originalException, 'droppedSourceCount'));
  return {
    ...(resultChars === undefined ? {} : { resultChars }),
    ...(droppedSourceCount === undefined ? {} : { droppedSourceCount }),
  };
}

/**
 * WHICH conversation a recovery rotation superseded an unverifiable epoch in,
 * and which epochs, surfaced as discrete tags: the server holds no key, so this
 * event is the only channel an operator learns of a bad rotation on, and one
 * naming no conversation names nothing to look at. All three are identifiers,
 * never content: the conversation id is a row id, and the epochs are the
 * numbers the accepted rotation named. Only a value of the {@link ROW_ID} shape
 * and whole non-negative epoch numbers travel; anything else is a content
 * vector and is dropped (fail closed), like the backup counts. What this record
 * holds is spread into {@link scrubSentryEvent}'s `tags:` object, so another
 * key here is another tag on the wire; the tag-admission rule commented on that
 * object is what decides whether it may be one. Neither gate is an enumeration,
 * so the producer carries the test that rule demands, asserting the values and
 * the emitted error's whole own-key set: the conversations slice's epoch
 * rotation acceptance test, "reports the superseded epoch to Sentry by its
 * identifiers alone".
 */
function supersededEpochTags(originalException: unknown): {
  conversationId?: string;
  supersededEpoch?: number;
  predecessorEpoch?: number;
} {
  if (!(originalException instanceof Error)) {
    return {};
  }
  const conversationId: unknown = Reflect.get(originalException, 'conversationId');
  const supersededEpoch = wholeCount(Reflect.get(originalException, 'supersededEpoch'));
  const predecessorEpoch = wholeCount(Reflect.get(originalException, 'predecessorEpoch'));
  return {
    ...(typeof conversationId === 'string' && ROW_ID.test(conversationId)
      ? { conversationId }
      : {}),
    ...(supersededEpoch === undefined ? {} : { supersededEpoch }),
    ...(predecessorEpoch === undefined ? {} : { predecessorEpoch }),
  };
}

/** The opaque envelope fields that survive: SDK- or config-derived, never
 * content-capable. */
function keptEnvelopeFields(event: ErrorEvent): Partial<ErrorEvent> {
  return {
    ...(event.event_id === undefined ? {} : { event_id: event.event_id }),
    ...(event.timestamp === undefined ? {} : { timestamp: event.timestamp }),
    ...(event.platform === undefined ? {} : { platform: event.platform }),
    ...(event.level === undefined ? {} : { level: event.level }),
    ...(event.environment === undefined ? {} : { environment: event.environment }),
    ...(event.release === undefined ? {} : { release: event.release }),
  };
}

export function scrubSentryEvent(event: ErrorEvent, hint?: EventHint): ErrorEvent | null {
  try {
    const taggedCode = event.tags?.['errorCode'];
    const errorCode = typeof taggedCode === 'string' ? taggedCode : 'unknown';
    const reported: unknown = hint?.originalException;
    const statusCode = firstHttpStatusCode(reported);
    return {
      type: undefined,
      ...keptEnvelopeFields(event),
      exception: { values: safeExceptionValues(reported) },
      // Scope: this governs a tag lifted from a property of the reported error.
      // A tag whose value the scrub takes from somewhere else closes its value
      // space at that other source or not at all — the fingerprint code is
      // closed by its union at the Telemetry port, and a status lifted from a
      // third-party error rests on being coerced to a finite number, a type
      // that carries no text. Neither has a producer in this repo to pin.
      //
      // A tag name added to this object is admitted when its gate is an
      // ENUMERATION over a closed value space (`BYPASS_CAUSES` is that shape):
      // such a gate is total over what a producer can emit, so the tag rests on
      // nothing the producer promises. Where the value space cannot be closed —
      // a shape regex, a bare `typeof` — the gate only CHECKS the producer's
      // promise, so the producer must carry a test asserting the VALUE it emits
      // under that name as well as the emitted error's WHOLE own-key set. The
      // key set catches a SECOND property arriving on that error; the value
      // catches the name being re-sourced, which the key set cannot see — a
      // client-supplied identifier assigned to `runId` leaves the key set
      // identical. `apps/api/src/middleware/pipeline-rate-limit.test.ts`
      // ("carries the route it could not bound, and nothing else off the
      // request") is that test for `rateLimitRoute`, and asserts both. A guard
      // in this file's test pins the surviving set of names, but it sees a new
      // tag exactly when that tag's gate emits against its fixture error — an
      // ungated tag does; a gate reading a property that fixture omits, or
      // narrowing past a value it carries, does not. So this rule, not the
      // guard, is what a new tag has to satisfy.
      tags: {
        errorCode,
        ...(statusCode === undefined ? {} : { statusCode }),
        ...absorbedLossTags(reported),
        ...rateLimitBypassTags(reported),
        ...dependencyFailureTags(reported),
        ...strandedSecondFactorTags(reported),
        ...backupAuditTags(reported),
        ...landingClampTags(reported),
        ...searchOversizeTags(reported),
        ...supersededEpochTags(reported),
      },
      // '{{ default }}' keeps Sentry's stack-based grouping; errorCode splits
      // groups per logical failure (stack-only grouping merges distinct
      // failures that share a call path).
      fingerprint: ['{{ default }}', errorCode],
    };
    // eslint-disable-next-line catch-swallow/no-silent-catch -- fail closed: an event that cannot be scrubbed is dropped (null), never emitted.
  } catch {
    // Fail closed: an event that cannot be scrubbed never leaves the process.
    return null;
  }
}
