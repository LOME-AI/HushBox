import { describe, expect, it } from 'vitest';
import { TEST_DAY_START, secondsAt, testUuidV7 } from '@hushbox/shared/test-time';
import { scrubSentryEvent } from './sentry-scrub.js';
import type { ErrorEvent, EventHint } from '@sentry/cloudflare';

/** An inert fixture stamp: nothing in this file reads it against a clock. */
const FIXTURE_STAMP_SECONDS = secondsAt(TEST_DAY_START);

const MESSAGE_SENTINEL = 'SELECT * FROM users WHERE email = leak@example.com';
const PII_SENTINEL = 'alice@example.com';
const BODY_SENTINEL = 'request body with prompt text';
/** RFC 5737 documentation address. */
const CALLER_IP_SENTINEL = '203.0.113.9';

/**
 * One error carrying, under every tag the scrub emits off an error, a property
 * that tag's gate reads at a value it admits, plus the content-bearing siblings
 * a widened gate would carry to the wire with them; `callerIp` appears in no
 * other fixture here, so a gate widened onto it at the address this one carries
 * reddens the tag-name guard and nothing else, while one admitting only some
 * other address passes unseen. No real error raises both the absorbed-loss pair
 * and the rate-limit-bypass pair, so this fixture is deliberately synthetic: the
 * guard it feeds is over the tag NAMES the scrub may emit, not over any one
 * producer.
 *
 * Its reach is what the scrub emits for this one error and nothing wider: a new
 * tag reddens the guard exactly when its gate emits here. Reading a name on this
 * list is neither sufficient nor necessary for that. Not sufficient: a gate on
 * one of these names that narrows past the value the fixture carries stays
 * silent — one reading `statusCode` but admitting only 5xx passes unseen,
 * because the fixture carries 429. Not necessary: a gate that emits without
 * consulting the error reddens the guard having read nothing from this list.
 * What escapes is a gate silent against this error — one on a name this fixture
 * omits, unless it reports that name's absence, and one narrowing past a value
 * it carries — and the widening then lands with the guard green. A gate added
 * inside one of the scrub's spread helpers is on that same footing, since what
 * decides is whether the gate emits for this error, not the edit site.
 * That gap is disclosed rather than closed, deliberately. It can be narrowed:
 * scrubbing once per candidate value shape through permissive proxies and
 * unioning the emitted key sets does catch every gate shape the scrub holds
 * today. But a proxy only answers the shapes it was built for, so it misses a
 * gate that enumerates a novel closed set or matches a novel narrow regex —
 * and those are the gates the admission rule tells a tag-adder to prefer. The
 * cleverer canary would therefore buy least on the path the rule pushes people
 * down, while reading as though it covered everything, which is the worse
 * failure of the two. So the honest statement of the reach is the control that
 * lasts: this guard is the backstop for a careless widening, and the rule
 * commented on `scrubSentryEvent`'s `tags:` object is what a deliberate one
 * has to satisfy.
 */
function everyTaggedProperty(): Error {
  return Object.assign(new Error('tagged ' + MESSAGE_SENTINEL), {
    statusCode: 429,
    runId: testUuidV7(0),
    absorbedNanoUsd: '2000',
    rateLimitRoute: '$get /conversations/:id',
    rateLimitBypassCause: 'identity',
    dependencyRoute: '$get /admin/dashboard',
    dependency: 'postgres',
    dependencyFailure: 'acquire-timeout',
    dependencyLate: false,
    totpStrandedUserId: testUuidV7(0),
    totpStrandedRoute: '/auth/login/2fa/verify',
    backupStaleMinutes: 540,
    backupLifecycleNoncurrentDays: 3650,
    backupNoncurrentVersionDays: 41,
    growthClampedGrain: 'day',
    growthClampedBucket: '2026-02-11',
    growthClampedPath: '/pricing',
    resultChars: 12_423,
    droppedSourceCount: 7,
    conversationId: testUuidV7(0),
    supersededEpoch: 3,
    predecessorEpoch: 1,
    userEmail: PII_SENTINEL,
    callerIp: CALLER_IP_SENTINEL,
  });
}

/**
 * What a reader who just reddened the tag-name guard is told. It states the
 * admission rule rather than the list, because a guard that only reports that
 * the set changed trains the next reader to update the constant.
 */
const TAG_ADMISSION_RULE = [
  'The set of tag names that may reach Sentry changed. Do not update this list to match it.',
  'The rule governs a tag lifted from a property of the reported error; a tag whose value the',
  'scrub takes from somewhere else closes its value space at that other source or not at all,',
  "and the comment on scrubSentryEvent's tags: object states that scope in full.",
  'A new tag is admitted when its gate is an ENUMERATION over a closed value space, which is',
  'total over what a producer can emit and so rests on nothing the producer promises',
  '(`rateLimitBypassCause` is that shape). Where the value space cannot be closed, the gate only',
  "CHECKS the producer's promise, and the producer must carry a test asserting the VALUE it emits",
  "under that name as well as the emitted error's WHOLE own-key set:",
  "apps/api/src/middleware/pipeline-rate-limit.test.ts, 'carries the route it could not bound, and",
  "nothing else off the request', is that test for `rateLimitRoute`, and asserts both.",
].join(' ');

function hostileEvent(): ErrorEvent {
  return {
    type: undefined,
    event_id: 'e-1',
    timestamp: FIXTURE_STAMP_SECONDS,
    platform: 'javascript',
    level: 'error',
    environment: 'production',
    release: 'app@1.0.0',
    message: MESSAGE_SENTINEL,
    transaction: '/conversations/abc?token=secret',
    server_name: 'host-internal-name',
    user: { email: PII_SENTINEL, ip_address: '203.0.113.7' },
    request: {
      url: 'https://api.example.com/chat?q=secret',
      headers: { cookie: 'session=secret-cookie' },
      data: BODY_SENTINEL,
    },
    breadcrumbs: [{ message: 'breadcrumb with content' }],
    extra: { requestSnapshot: BODY_SENTINEL },
    contexts: { trace: { trace_id: 'abc', span_id: 'def' } },
    tags: { errorCode: 'db_query_failed', smuggled: PII_SENTINEL },
    fingerprint: ['custom'],
    exception: { values: [{ type: 'Error', value: MESSAGE_SENTINEL }] },
  };
}

describe('scrubSentryEvent field allowlist', () => {
  it('drops every content-capable field from the event', () => {
    const scrubbed = scrubSentryEvent(hostileEvent(), {});

    const serialized = JSON.stringify(scrubbed);
    expect(serialized).not.toContain(MESSAGE_SENTINEL);
    expect(serialized).not.toContain(PII_SENTINEL);
    expect(serialized).not.toContain(BODY_SENTINEL);
    expect(serialized).not.toContain('secret');
  });

  it('emits no request, user, breadcrumb, extra, or contexts keys', () => {
    const scrubbed = scrubSentryEvent(hostileEvent(), {});

    expect(scrubbed).not.toHaveProperty('request');
    expect(scrubbed).not.toHaveProperty('user');
    expect(scrubbed).not.toHaveProperty('breadcrumbs');
    expect(scrubbed).not.toHaveProperty('extra');
    expect(scrubbed).not.toHaveProperty('contexts');
    expect(scrubbed).not.toHaveProperty('message');
    expect(scrubbed).not.toHaveProperty('transaction');
    expect(scrubbed).not.toHaveProperty('server_name');
  });

  it('preserves exactly the allowlisted top-level field set so a widened allowlist fails here', () => {
    const scrubbed = scrubSentryEvent(hostileEvent(), {});

    // The scrub rebuilds the event from an allowlist rather than deleting
    // known-bad fields. This pins the EXACT set of top-level keys that may
    // survive for the event `hostileEvent` builds, so a field added to the
    // allowlist breaks this assertion when it survives for that event — the
    // regression guard against a silent allowlist expansion. Its reach is
    // bounded the way the tag-name guard's is, and the docblock on
    // `everyTaggedProperty` states that shape in full: a field kept only when
    // the event carries a property this fixture omits survives for no event
    // here and passes unseen. Set comparison is order-independent and rejects
    // both extra and missing keys.
    expect(new Set(Object.keys(scrubbed ?? {}))).toEqual(
      new Set([
        'type',
        'event_id',
        'timestamp',
        'platform',
        'level',
        'environment',
        'release',
        'exception',
        'tags',
        'fingerprint',
      ])
    );
  });

  it('preserves exactly the allowlisted tag name set so a widened tag allowlist fails here', () => {
    const scrubbed = scrubSentryEvent(hostileEvent(), {
      originalException: everyTaggedProperty(),
    });

    // The companion to the top-level field-set guard, one layer down: the tag
    // object is rebuilt from an allowlist too, so this pins the EXACT set of
    // tag NAMES that may survive against the error the fixture builds. A
    // further name breaks this assertion exactly when its gate emits against
    // that error — which an ungated tag does, and which a gate reading a
    // property `everyTaggedProperty` omits, or narrowing past the value it
    // carries, does not; that fixture's docblock states the residual reach and
    // why it is stated rather than engineered away. When it does break, the
    // message it fails with is the rule that decides whether the further one
    // may be added at all.
    // Set comparison rejects both extra and missing names.
    expect(new Set(Object.keys(scrubbed?.tags ?? {})), TAG_ADMISSION_RULE).toEqual(
      new Set([
        'errorCode',
        'statusCode',
        'runId',
        'absorbedNanoUsd',
        'rateLimitRoute',
        'rateLimitBypassCause',
        'dependencyRoute',
        'dependency',
        'dependencyFailure',
        'dependencyLate',
        'totpStrandedUserId',
        'totpStrandedRoute',
        'backupStaleMinutes',
        'backupLifecycleNoncurrentDays',
        'backupNoncurrentVersionDays',
        'growthClampedGrain',
        'growthClampedBucket',
        'growthClampedPath',
        'resultChars',
        'droppedSourceCount',
        'conversationId',
        'supersededEpoch',
        'predecessorEpoch',
      ])
    );
  });

  it('keeps the opaque envelope fields', () => {
    const scrubbed = scrubSentryEvent(hostileEvent(), {});

    expect(scrubbed?.event_id).toBe('e-1');
    expect(scrubbed?.timestamp).toBe(FIXTURE_STAMP_SECONDS);
    expect(scrubbed?.platform).toBe('javascript');
    expect(scrubbed?.level).toBe('error');
    expect(scrubbed?.environment).toBe('production');
    expect(scrubbed?.release).toBe('app@1.0.0');
  });

  it('keeps only the errorCode tag', () => {
    const scrubbed = scrubSentryEvent(hostileEvent(), {});

    expect(scrubbed?.tags).toEqual({ errorCode: 'db_query_failed' });
  });

  it('sets the errorCode as a fingerprint component alongside default grouping', () => {
    const scrubbed = scrubSentryEvent(hostileEvent(), {});

    expect(scrubbed?.fingerprint).toEqual(['{{ default }}', 'db_query_failed']);
  });

  it('surfaces a provider-failure statusCode as a discrete tag while dropping message, url, and body', () => {
    const error = Object.assign(new Error('provider failed: ' + MESSAGE_SENTINEL), {
      statusCode: 429,
      url: 'https://openrouter.ai/api/v1/chat?key=' + PII_SENTINEL,
      responseBody: BODY_SENTINEL,
    });

    const scrubbed = scrubSentryEvent(hostileEvent(), { originalException: error });

    expect(scrubbed?.tags).toEqual({ errorCode: 'db_query_failed', statusCode: 429 });
    const serialized = JSON.stringify(scrubbed);
    expect(serialized).not.toContain(MESSAGE_SENTINEL);
    expect(serialized).not.toContain(BODY_SENTINEL);
    expect(serialized).not.toContain(PII_SENTINEL);
    expect(serialized).not.toContain('openrouter.ai');
  });

  it('surfaces an absorbed-loss runId and absorbedNanoUsd as discrete tags while dropping message and PII', () => {
    const error = Object.assign(new Error('run absorbed unbilled spend ' + MESSAGE_SENTINEL), {
      runId: testUuidV7(0),
      // The nano-USD bigint as a string — money is never Number()-coerced.
      absorbedNanoUsd: '2000',
      // A PII-bearing sibling property must NOT surface: only the two
      // allowlisted keys travel.
      userEmail: PII_SENTINEL,
    });

    const scrubbed = scrubSentryEvent(hostileEvent(), { originalException: error });

    expect(scrubbed?.tags).toEqual({
      errorCode: 'db_query_failed',
      runId: testUuidV7(0),
      absorbedNanoUsd: '2000',
    });
    const serialized = JSON.stringify(scrubbed);
    expect(serialized).not.toContain(MESSAGE_SENTINEL);
    expect(serialized).not.toContain(PII_SENTINEL);
  });

  it('drops a non-string runId and a non-numeric-string absorbedNanoUsd rather than surfacing content', () => {
    const error = Object.assign(new Error('x'), {
      runId: { leaked: PII_SENTINEL },
      absorbedNanoUsd: 'lots ' + PII_SENTINEL,
    });

    const scrubbed = scrubSentryEvent(hostileEvent(), { originalException: error });

    expect(scrubbed?.tags).toEqual({ errorCode: 'db_query_failed' });
    expect(JSON.stringify(scrubbed)).not.toContain(PII_SENTINEL);
  });

  it('drops a string runId that is not the shape the run minter produces', () => {
    // A type check admits the whole of the string space, so under a gate that
    // checks only the type, text assigned to an allowlisted name reaches the
    // wire on the strength of the name alone.
    const error = Object.assign(new Error('x'), {
      runId: 'run for ' + PII_SENTINEL,
      absorbedNanoUsd: '2000',
    });

    const scrubbed = scrubSentryEvent(hostileEvent(), { originalException: error });

    expect(scrubbed?.tags).toEqual({ errorCode: 'db_query_failed', absorbedNanoUsd: '2000' });
    expect(JSON.stringify(scrubbed)).not.toContain(PII_SENTINEL);
  });

  it('drops a numeric (non-string) absorbedNanoUsd — the amount travels only as a nano-USD string', () => {
    const error = Object.assign(new Error('x'), {
      runId: testUuidV7(0),
      absorbedNanoUsd: 2000,
    });

    const scrubbed = scrubSentryEvent(hostileEvent(), { originalException: error });

    expect(scrubbed?.tags).toEqual({
      errorCode: 'db_query_failed',
      runId: testUuidV7(0),
    });
  });

  it('surfaces the route a rate-limit bypass could not bound as a discrete tag', () => {
    const error = Object.assign(new Error('counter unreachable ' + MESSAGE_SENTINEL), {
      rateLimitRoute: '$get /conversations/:id',
      // A sibling property carrying content must not travel with it.
      requestedPath: '/conversations/' + PII_SENTINEL,
    });

    const scrubbed = scrubSentryEvent(hostileEvent(), { originalException: error });

    expect(scrubbed?.tags).toEqual({
      errorCode: 'db_query_failed',
      rateLimitRoute: '$get /conversations/:id',
    });
    expect(JSON.stringify(scrubbed)).not.toContain(PII_SENTINEL);
  });

  it('surfaces where a rate-limit bypass stopped as a discrete tag', () => {
    const error = Object.assign(new Error('could not be spent ' + MESSAGE_SENTINEL), {
      rateLimitRoute: '$get /conversations/:id',
      rateLimitBypassCause: 'identity',
    });

    const scrubbed = scrubSentryEvent(hostileEvent(), { originalException: error });

    expect(scrubbed?.tags).toEqual({
      errorCode: 'db_query_failed',
      rateLimitRoute: '$get /conversations/:id',
      rateLimitBypassCause: 'identity',
    });
  });

  it('drops a rateLimitBypassCause that is not one of the causes it may name', () => {
    const error = Object.assign(new Error('x'), {
      rateLimitRoute: '$get /conversations/:id',
      rateLimitBypassCause: 'identity of ' + PII_SENTINEL,
    });

    const scrubbed = scrubSentryEvent(hostileEvent(), { originalException: error });

    expect(scrubbed?.tags).toEqual({
      errorCode: 'db_query_failed',
      rateLimitRoute: '$get /conversations/:id',
    });
    expect(JSON.stringify(scrubbed)).not.toContain(PII_SENTINEL);
  });

  it('surfaces the dependency, the arm and the lateness behind an availability refusal as discrete tags', () => {
    // Every value each gate may admit, not one of them: the three gates are
    // enumerations, so what each must be shown doing is admitting its whole set.
    const values = [
      ['postgres', 'acquire-timeout', false],
      ['postgres', 'serial-overlap', true],
      ['redis', 'connect-timeout', true],
      ['unknown', 'statement-timeout', false],
      ['postgres', 'deadline', true],
      ['redis', 'transport', false],
      ['unknown', 'server-error', true],
      ['postgres', 'unknown', false],
    ] as const;
    for (const [dependency, dependencyFailure, dependencyLate] of values) {
      const error = Object.assign(new Error('refused ' + MESSAGE_SENTINEL), {
        dependencyRoute: '$get /conversations/:id',
        dependency,
        dependencyFailure,
        dependencyLate,
      });

      const scrubbed = scrubSentryEvent(hostileEvent(), { originalException: error });

      expect(scrubbed?.tags).toEqual({
        errorCode: 'db_query_failed',
        dependencyRoute: '$get /conversations/:id',
        dependency,
        dependencyFailure,
        dependencyLate,
      });
    }
  });

  it('drops a dependency, an arm and a lateness that are not values those tags may carry', () => {
    const error = Object.assign(new Error('x'), {
      dependencyRoute: '$get /conversations/:id',
      dependency: 'postgres at ' + PII_SENTINEL,
      dependencyFailure: 'deadline for ' + PII_SENTINEL,
      dependencyLate: 'late for ' + PII_SENTINEL,
    });

    const scrubbed = scrubSentryEvent(hostileEvent(), { originalException: error });

    expect(scrubbed?.tags).toEqual({
      errorCode: 'db_query_failed',
      dependencyRoute: '$get /conversations/:id',
    });
    expect(JSON.stringify(scrubbed)).not.toContain(PII_SENTINEL);
  });

  it('drops a dependencyRoute that is not shaped like a route key', () => {
    const error = Object.assign(new Error('x'), {
      dependencyRoute: 'visited /conversations by ' + PII_SENTINEL,
      dependency: 'redis',
    });

    const scrubbed = scrubSentryEvent(hostileEvent(), { originalException: error });

    expect(scrubbed?.tags).toEqual({ errorCode: 'db_query_failed', dependency: 'redis' });
    expect(JSON.stringify(scrubbed)).not.toContain(PII_SENTINEL);
  });

  it('drops a rateLimitRoute that is not shaped like a route key', () => {
    const error = Object.assign(new Error('x'), {
      rateLimitRoute: 'visited /conversations by ' + PII_SENTINEL,
    });

    const scrubbed = scrubSentryEvent(hostileEvent(), { originalException: error });

    expect(scrubbed?.tags).toEqual({ errorCode: 'db_query_failed' });
    expect(JSON.stringify(scrubbed)).not.toContain(PII_SENTINEL);
  });

  it('surfaces how stale a backup repository is as a discrete tag', () => {
    const error = Object.assign(new Error('backup is old ' + MESSAGE_SENTINEL), {
      backupStaleMinutes: 540,
      // A sibling property carrying content must not travel with it.
      snapshotKey: 'repository/snapshots/' + PII_SENTINEL,
    });

    const scrubbed = scrubSentryEvent(hostileEvent(), { originalException: error });

    expect(scrubbed?.tags).toEqual({ errorCode: 'db_query_failed', backupStaleMinutes: 540 });
    expect(JSON.stringify(scrubbed)).not.toContain(PII_SENTINEL);
  });

  it('surfaces the retention duration a drifted lifecycle rule states as a discrete tag', () => {
    const error = Object.assign(new Error('rule drifted ' + MESSAGE_SENTINEL), {
      backupLifecycleNoncurrentDays: 3650,
    });

    const scrubbed = scrubSentryEvent(hostileEvent(), { originalException: error });

    expect(scrubbed?.tags).toEqual({
      errorCode: 'db_query_failed',
      backupLifecycleNoncurrentDays: 3650,
    });
  });

  it('surfaces how long an overdue backup version has been noncurrent as a discrete tag', () => {
    const error = Object.assign(new Error('version overdue ' + MESSAGE_SENTINEL), {
      backupNoncurrentVersionDays: 41,
      // A sibling property naming the object must not travel with it.
      versionKey: 'repository/data/' + PII_SENTINEL,
    });

    const scrubbed = scrubSentryEvent(hostileEvent(), { originalException: error });

    expect(scrubbed?.tags).toEqual({
      errorCode: 'db_query_failed',
      backupNoncurrentVersionDays: 41,
    });
    expect(JSON.stringify(scrubbed)).not.toContain(PII_SENTINEL);
  });

  it('drops a backup count that is not a whole non-negative number rather than surfacing content', () => {
    const error = Object.assign(new Error('x'), {
      backupStaleMinutes: '540 ' + PII_SENTINEL,
      backupLifecycleNoncurrentDays: -1,
      backupNoncurrentVersionDays: { days: 41 },
    });

    const scrubbed = scrubSentryEvent(hostileEvent(), { originalException: error });

    expect(scrubbed?.tags).toEqual({ errorCode: 'db_query_failed' });
    expect(JSON.stringify(scrubbed)).not.toContain(PII_SENTINEL);
  });

  it('drops a fractional backup count — a whole count is the only shape that travels', () => {
    const error = Object.assign(new Error('x'), { backupStaleMinutes: 540.5 });

    const scrubbed = scrubSentryEvent(hostileEvent(), { originalException: error });

    expect(scrubbed?.tags).toEqual({ errorCode: 'db_query_failed' });
  });

  it('surfaces the size of an oversize search payload as a discrete tag and nothing else of it', () => {
    // The shape the search adapter captures under search_result_oversize, plus a
    // sibling carrying search text that must not travel with the size.
    const error = Object.assign(new Error('web search payload exceeds the reserved result size'), {
      resultChars: 12_423,
      query: 'search for ' + PII_SENTINEL,
    });
    error.name = 'SearchResultOversize';
    const event = { ...hostileEvent(), tags: { errorCode: 'search_result_oversize' } };

    const scrubbed = scrubSentryEvent(event, { originalException: error });

    expect(scrubbed?.tags).toEqual({ errorCode: 'search_result_oversize', resultChars: 12_423 });
    expect(JSON.stringify(scrubbed)).not.toContain(PII_SENTINEL);
  });

  it('surfaces how many sources a stored search row dropped as a discrete tag and nothing else of it', () => {
    // The shape the model-call node captures under search_row_oversize, plus a
    // sibling carrying a source title that must not travel with the count.
    const error = Object.assign(
      new Error('stored web search rows dropped sources to fit their allowance'),
      { droppedSourceCount: 7, sourceTitle: 'page about ' + PII_SENTINEL }
    );
    error.name = 'SearchRowOversize';
    const event = { ...hostileEvent(), tags: { errorCode: 'search_row_oversize' } };

    const scrubbed = scrubSentryEvent(event, { originalException: error });

    expect(scrubbed?.tags).toEqual({ errorCode: 'search_row_oversize', droppedSourceCount: 7 });
    expect(JSON.stringify(scrubbed)).not.toContain(PII_SENTINEL);
  });

  it('drops a search oversize count that is not a whole non-negative number rather than surfacing content', () => {
    const error = Object.assign(new Error('x'), {
      resultChars: '12423 ' + PII_SENTINEL,
      droppedSourceCount: -1,
    });

    const scrubbed = scrubSentryEvent(hostileEvent(), { originalException: error });

    expect(scrubbed?.tags).toEqual({ errorCode: 'db_query_failed' });
    expect(JSON.stringify(scrubbed)).not.toContain(PII_SENTINEL);
  });

  it('drops a fractional search oversize count, since a whole count is the only shape that travels', () => {
    const error = Object.assign(new Error('x'), { resultChars: 12.5, droppedSourceCount: 7.5 });

    const scrubbed = scrubSentryEvent(hostileEvent(), { originalException: error });

    expect(scrubbed?.tags).toEqual({ errorCode: 'db_query_failed' });
  });

  it('surfaces a superseded epoch as discrete conversation and epoch tags while dropping message and PII', () => {
    const error = Object.assign(new Error('recovery superseded ' + MESSAGE_SENTINEL), {
      conversationId: testUuidV7(0),
      supersededEpoch: 3,
      predecessorEpoch: 1,
      userEmail: PII_SENTINEL,
    });
    error.name = 'EpochRotationSuperseded';
    const event = { ...hostileEvent(), tags: { errorCode: 'epoch_rotation_superseded' } };

    const scrubbed = scrubSentryEvent(event, { originalException: error });

    expect(scrubbed?.tags).toEqual({
      errorCode: 'epoch_rotation_superseded',
      conversationId: testUuidV7(0),
      supersededEpoch: 3,
      predecessorEpoch: 1,
    });
    const serialized = JSON.stringify(scrubbed);
    expect(serialized).not.toContain(MESSAGE_SENTINEL);
    expect(serialized).not.toContain(PII_SENTINEL);
  });

  it('drops a conversationId that is not shaped like a row id', () => {
    const error = Object.assign(new Error('x'), {
      conversationId: PII_SENTINEL,
      supersededEpoch: 3,
    });

    const scrubbed = scrubSentryEvent(hostileEvent(), { originalException: error });

    expect(scrubbed?.tags).toEqual({ errorCode: 'db_query_failed', supersededEpoch: 3 });
    expect(JSON.stringify(scrubbed)).not.toContain(PII_SENTINEL);
  });

  it('drops an epoch number that is not a whole non-negative count', () => {
    const error = Object.assign(new Error('x'), {
      supersededEpoch: '3 ' + PII_SENTINEL,
      predecessorEpoch: 1.5,
    });

    const scrubbed = scrubSentryEvent(hostileEvent(), { originalException: error });

    expect(scrubbed?.tags).toEqual({ errorCode: 'db_query_failed' });
    expect(JSON.stringify(scrubbed)).not.toContain(PII_SENTINEL);
  });

  it('surfaces a lowered growth landing count as discrete grain, bucket and path tags while dropping message and PII', () => {
    const error = Object.assign(new Error('landing count lowered ' + MESSAGE_SENTINEL), {
      growthClampedGrain: 'day',
      growthClampedBucket: '2026-02-11',
      growthClampedPath: '/pricing',
      // A PII-bearing sibling property must NOT surface: only the three
      // allowlisted keys travel.
      visitorHash: PII_SENTINEL,
    });

    const scrubbed = scrubSentryEvent(hostileEvent(), { originalException: error });

    expect(scrubbed?.tags).toEqual({
      errorCode: 'db_query_failed',
      growthClampedGrain: 'day',
      growthClampedBucket: '2026-02-11',
      growthClampedPath: '/pricing',
    });
    expect(JSON.stringify(scrubbed)).not.toContain(PII_SENTINEL);
  });

  it('surfaces an hour-grain bucket key, which is the other shape a growth bucket takes', () => {
    const error = Object.assign(new Error('x'), {
      growthClampedGrain: 'hour',
      growthClampedBucket: '2026-02-11T09',
      growthClampedPath: '/',
    });

    const scrubbed = scrubSentryEvent(hostileEvent(), { originalException: error });

    expect(scrubbed?.tags).toEqual({
      errorCode: 'db_query_failed',
      growthClampedGrain: 'hour',
      growthClampedBucket: '2026-02-11T09',
      growthClampedPath: '/',
    });
  });

  it('drops a growth grain outside the closed set of grains', () => {
    const error = Object.assign(new Error('x'), { growthClampedGrain: 'week ' + PII_SENTINEL });

    const scrubbed = scrubSentryEvent(hostileEvent(), { originalException: error });

    expect(scrubbed?.tags).toEqual({ errorCode: 'db_query_failed' });
    expect(JSON.stringify(scrubbed)).not.toContain(PII_SENTINEL);
  });

  it('drops a growth bucket of no bucket shape rather than surfacing content', () => {
    const error = Object.assign(new Error('x'), {
      growthClampedBucket: '2026-02-11 ' + PII_SENTINEL,
    });

    const scrubbed = scrubSentryEvent(hostileEvent(), { originalException: error });

    expect(scrubbed?.tags).toEqual({ errorCode: 'db_query_failed' });
    expect(JSON.stringify(scrubbed)).not.toContain(PII_SENTINEL);
  });

  it('drops a growth path of no path shape rather than surfacing content', () => {
    const error = Object.assign(new Error('x'), {
      growthClampedPath: '/pricing?who=' + PII_SENTINEL,
    });

    const scrubbed = scrubSentryEvent(hostileEvent(), { originalException: error });

    expect(scrubbed?.tags).toEqual({ errorCode: 'db_query_failed' });
    expect(JSON.stringify(scrubbed)).not.toContain(PII_SENTINEL);
  });

  it('drops a growth path past the length every growth path column is bounded at', () => {
    const error = Object.assign(new Error('x'), {
      growthClampedPath: `/${'a'.repeat(200)}`,
    });

    const scrubbed = scrubSentryEvent(hostileEvent(), { originalException: error });

    expect(scrubbed?.tags).toEqual({ errorCode: 'db_query_failed' });
  });

  it('surfaces a stranded second factor as discrete user-id and route tags while dropping message and PII', () => {
    const error = Object.assign(new Error('stored TOTP secret ' + MESSAGE_SENTINEL), {
      totpStrandedUserId: testUuidV7(0),
      totpStrandedRoute: '/auth/login/2fa/verify',
      // A PII-bearing sibling property must NOT surface: only the two
      // allowlisted keys travel.
      userEmail: PII_SENTINEL,
    });

    const scrubbed = scrubSentryEvent(hostileEvent(), { originalException: error });

    expect(scrubbed?.tags).toEqual({
      errorCode: 'db_query_failed',
      totpStrandedUserId: testUuidV7(0),
      totpStrandedRoute: '/auth/login/2fa/verify',
    });
    const serialized = JSON.stringify(scrubbed);
    expect(serialized).not.toContain(MESSAGE_SENTINEL);
    expect(serialized).not.toContain(PII_SENTINEL);
  });

  it('drops a totpStrandedUserId that is not shaped like a row id', () => {
    const error = Object.assign(new Error('x'), {
      totpStrandedUserId: PII_SENTINEL,
      totpStrandedRoute: '/auth/login/2fa/verify',
    });

    const scrubbed = scrubSentryEvent(hostileEvent(), { originalException: error });

    expect(scrubbed?.tags).toEqual({
      errorCode: 'db_query_failed',
      totpStrandedRoute: '/auth/login/2fa/verify',
    });
    expect(JSON.stringify(scrubbed)).not.toContain(PII_SENTINEL);
  });

  it('drops a totpStrandedRoute that is not shaped like a registered path template', () => {
    const error = Object.assign(new Error('x'), {
      totpStrandedUserId: testUuidV7(0),
      totpStrandedRoute: '/auth/login/2fa/verify?as=' + PII_SENTINEL,
    });

    const scrubbed = scrubSentryEvent(hostileEvent(), { originalException: error });

    expect(scrubbed?.tags).toEqual({
      errorCode: 'db_query_failed',
      totpStrandedUserId: testUuidV7(0),
    });
    expect(JSON.stringify(scrubbed)).not.toContain(PII_SENTINEL);
  });

  it('finds the statusCode in the cause chain', () => {
    const root = Object.assign(new Error('root'), { statusCode: 503 });
    const outer = new Error('outer', { cause: root });

    const scrubbed = scrubSentryEvent(hostileEvent(), { originalException: outer });

    expect(scrubbed?.tags?.['statusCode']).toBe(503);
  });

  it('omits the statusCode tag when the error carries none', () => {
    const scrubbed = scrubSentryEvent(hostileEvent(), { originalException: new Error('x') });

    expect(scrubbed?.tags).toEqual({ errorCode: 'db_query_failed' });
    expect(scrubbed?.tags).not.toHaveProperty('statusCode');
  });

  it('drops a non-numeric statusCode rather than surfacing content', () => {
    const error = Object.assign(new Error('x'), { statusCode: 'Internal ' + PII_SENTINEL });

    const scrubbed = scrubSentryEvent(hostileEvent(), { originalException: error });

    expect(scrubbed?.tags).toEqual({ errorCode: 'db_query_failed' });
    expect(JSON.stringify(scrubbed)).not.toContain(PII_SENTINEL);
  });

  it('falls back to unknown when the errorCode tag is absent', () => {
    const event = hostileEvent();
    delete event.tags;

    const scrubbed = scrubSentryEvent(event, {});

    expect(scrubbed?.tags).toEqual({ errorCode: 'unknown' });
    expect(scrubbed?.fingerprint).toEqual(['{{ default }}', 'unknown']);
  });

  it('fails closed on an unscrubbable event', () => {
    const event = hostileEvent();
    Object.defineProperty(event, 'tags', {
      get(): never {
        throw new Error('hostile getter');
      },
    });

    expect(scrubSentryEvent(event, {})).toBeNull();
  });
});

describe('scrubSentryEvent exception chain', () => {
  function hintFor(error: unknown): EventHint {
    return { originalException: error };
  }

  it('rebuilds one exception value per error in the cause chain', () => {
    const root = new RangeError('root cause with ' + MESSAGE_SENTINEL);
    const middle = new TypeError('middle with ' + PII_SENTINEL, { cause: root });
    const outer = new Error('outer with ' + BODY_SENTINEL, { cause: middle });

    const scrubbed = scrubSentryEvent(hostileEvent(), hintFor(outer));

    expect(scrubbed?.exception?.values).toHaveLength(3);
  });

  it('orders the chain deepest cause first with the reported error last', () => {
    const root = new RangeError('root');
    const outer = new TypeError('outer', { cause: root });

    const scrubbed = scrubSentryEvent(hostileEvent(), hintFor(outer));

    expect(scrubbed?.exception?.values?.map((value) => value.type)).toEqual([
      'RangeError',
      'TypeError',
    ]);
  });

  it('never carries an exception message', () => {
    const outer = new Error(MESSAGE_SENTINEL, { cause: new Error(PII_SENTINEL) });

    const scrubbed = scrubSentryEvent(hostileEvent(), hintFor(outer));

    const serialized = JSON.stringify(scrubbed);
    expect(serialized).not.toContain(MESSAGE_SENTINEL);
    expect(serialized).not.toContain(PII_SENTINEL);
    for (const value of scrubbed?.exception?.values ?? []) {
      expect(value).not.toHaveProperty('value');
    }
  });

  it('stops the walk at a non-Error cause and drops its content', () => {
    const outer = new Error('outer', { cause: 'string cause with ' + PII_SENTINEL });

    const scrubbed = scrubSentryEvent(hostileEvent(), hintFor(outer));

    expect(scrubbed?.exception?.values).toHaveLength(1);
    expect(JSON.stringify(scrubbed)).not.toContain(PII_SENTINEL);
  });

  it('caps the chain at five exception values', () => {
    let error = new Error('depth 0');
    for (let depth = 1; depth < 8; depth += 1) {
      error = new Error(`depth ${String(depth)}`, { cause: error });
    }

    const scrubbed = scrubSentryEvent(hostileEvent(), hintFor(error));

    expect(scrubbed?.exception?.values).toHaveLength(5);
  });

  it('parses frames into filename, lineno, and colno', () => {
    const scrubbed = scrubSentryEvent(hostileEvent(), hintFor(new Error('x')));

    const frames = scrubbed?.exception?.values?.[0]?.stacktrace?.frames ?? [];
    expect(frames.length).toBeGreaterThan(0);
    const last = frames.at(-1);
    expect(typeof last?.filename).toBe('string');
    expect(typeof last?.lineno).toBe('number');
    expect(typeof last?.colno).toBe('number');
  });

  it('orders frames oldest-call-first with the crash site last', () => {
    function innerThrow(): Error {
      return new Error('boom');
    }
    function outerCall(): Error {
      return innerThrow();
    }

    const scrubbed = scrubSentryEvent(hostileEvent(), hintFor(outerCall()));

    const frames = scrubbed?.exception?.values?.[0]?.stacktrace?.frames ?? [];
    const names = frames.map((frame) => frame.function ?? '');
    expect(names.indexOf('outerCall')).toBeLessThan(names.indexOf('innerThrow'));
    expect(names.at(-1)).toBe('innerThrow');
  });

  it('drops frame-shaped lines embedded in the message while keeping real frames', () => {
    const error = new Error('boom\n    at fake (/srv/app/secret-content.ts:1:1)');

    const scrubbed = scrubSentryEvent(hostileEvent(), hintFor(error));

    const serialized = JSON.stringify(scrubbed);
    expect(serialized).not.toContain('secret-content');
    expect(scrubbed?.exception?.values?.[0]?.stacktrace?.frames?.length).toBeGreaterThan(0);
  });

  it('emits no frames when the stack header cannot be derived (fail closed)', () => {
    const error = new Error('m');
    error.stack = `mangled by a library: ${PII_SENTINEL}\n    at real (file.ts:1:1)`;

    const scrubbed = scrubSentryEvent(hostileEvent(), hintFor(error));

    expect(scrubbed?.exception?.values?.[0]?.stacktrace).toBeUndefined();
    expect(JSON.stringify(scrubbed)).not.toContain(PII_SENTINEL);
  });

  it('omits the stacktrace for an error without a stack', () => {
    const error = new Error('no trace');
    delete error.stack;

    const scrubbed = scrubSentryEvent(hostileEvent(), hintFor(error));

    expect(scrubbed?.exception?.values?.[0]?.stacktrace).toBeUndefined();
  });

  it('sanitizes a content-bearing error name', () => {
    const error = new Error('x');
    error.name = 'ENOENT: /srv/secrets/id_rsa';

    const scrubbed = scrubSentryEvent(hostileEvent(), hintFor(error));

    expect(scrubbed?.exception?.values?.[0]?.type).toBe('Error');
    expect(JSON.stringify(scrubbed)).not.toContain('id_rsa');
  });

  it('emits empty exception values for a non-Error originalException', () => {
    const scrubbed = scrubSentryEvent(
      hostileEvent(),
      hintFor('thrown string with ' + PII_SENTINEL)
    );

    expect(scrubbed?.exception?.values).toEqual([]);
    expect(JSON.stringify(scrubbed)).not.toContain(PII_SENTINEL);
  });

  it('emits empty exception values when the hint is absent', () => {
    const scrubbed = scrubSentryEvent(hostileEvent());

    expect(scrubbed?.exception?.values).toEqual([]);
  });

  it('parses a location-only frame line without a function name', () => {
    const error = new Error('m');
    error.stack = 'Error: m\n    at /srv/app/file.ts:5:7';

    const scrubbed = scrubSentryEvent(hostileEvent(), hintFor(error));

    const frame = scrubbed?.exception?.values?.[0]?.stacktrace?.frames?.[0];
    expect(frame).toEqual({ filename: '/srv/app/file.ts', lineno: 5, colno: 7, in_app: true });
  });

  it('drops a frame line with an unparseable location', () => {
    const error = new Error('m');
    error.stack = 'Error: m\n    at foo (native)';

    const scrubbed = scrubSentryEvent(hostileEvent(), hintFor(error));

    expect(scrubbed?.exception?.values?.[0]?.stacktrace).toBeUndefined();
  });

  it('drops a degenerate empty frame line', () => {
    const error = new Error('m');
    error.stack = 'Error: m\n    at ';

    const scrubbed = scrubSentryEvent(hostileEvent(), hintFor(error));

    expect(scrubbed?.exception?.values?.[0]?.stacktrace).toBeUndefined();
  });

  it('keeps frames for an empty-message error (header is the bare name)', () => {
    // Cleared post-construction: V8 derives the stack header lazily at first
    // access, so this exercises the bare-name header (no `: message` part).
    const error = new Error('placeholder');
    error.message = '';

    const scrubbed = scrubSentryEvent(hostileEvent(), hintFor(error));

    expect(scrubbed?.exception?.values?.[0]?.stacktrace?.frames?.length).toBeGreaterThan(0);
  });
});

describe('scrubSentryEvent with a minimal event', () => {
  it('omits envelope fields the event does not carry', () => {
    const scrubbed = scrubSentryEvent({ type: undefined });

    expect(scrubbed).not.toHaveProperty('event_id');
    expect(scrubbed).not.toHaveProperty('timestamp');
    expect(scrubbed).not.toHaveProperty('platform');
    expect(scrubbed).not.toHaveProperty('level');
    expect(scrubbed).not.toHaveProperty('environment');
    expect(scrubbed).not.toHaveProperty('release');
    expect(scrubbed?.tags).toEqual({ errorCode: 'unknown' });
  });
});
