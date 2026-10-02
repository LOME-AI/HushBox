import { afterEach, describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { errors } from '@upstash/redis';
import { ERROR_CODES, createEnvUtilities } from '@hushbox/shared';
import { TEST_DAY_START, freezeClock, setClock } from '@hushbox/shared/test-time';
import { applyPipeline } from './pipeline.js';
import { routeClass } from './pipeline-markers.js';
import { BYPASS_REPORT_WINDOW_MS, pipelineRateLimit } from './pipeline-rate-limit.js';
import { hashRateLimitId } from './rate-limit.js';
import { DEPENDENCY_REPORT_WINDOW_MS } from '../lib/context/domain-error-status.js';
import { FINGERPRINT_CODES } from '../lib/telemetry/index.js';
import { createSentryTelemetry } from '../lib/telemetry/adapters/sentry-adapter.js';
import { idempotencyExempt } from '../lib/idempotency/index.js';
import {
  CLASS_DEFAULTS,
  bindRoutePosture,
  hmacRateLimitId,
  rateLimitKey,
} from '../lib/rate-limit/index.js';
import { bindRequestValue } from '../lib/context/index.js';
import { callerIpIdForAddress } from '../lib/redis/index.js';
import {
  scriptedRateLimitRedis,
  unreachableRateLimitRedis,
} from '../test-support/rate-limit-double.js';
import { mintLinkCredential } from '../test-support/link-credential.js';
import { ROUTE_POSTURES } from '../composition/rate-limit-posture.js';
import { LINK_CREDENTIAL_HEADER, linkCreateRateLimit } from '../slices/conversations/index.js';
import {
  feedbackSubmitHourlyRateLimit,
  feedbackSubmitRateLimit,
} from '../slices/feedback/index.js';
import { MEDIA_RATE_LIMITS } from '../slices/media/index.js';
import type { Redis } from '@upstash/redis';
import type { RoutePostureMap } from './pipeline-rate-limit.js';
import type { ThrottleLimit } from '../lib/rate-limit/index.js';
import type {
  AppEnv,
  Bindings,
  Principal,
  RouteClass,
  SessionClaims,
} from '../lib/context/index.js';
import type { EnvUtilities } from '@hushbox/shared';
import type { SafeLogFields, Telemetry, TelemetryEnv } from '../lib/telemetry/index.js';

async function jsonBody<T = Record<string, unknown>>(res: Response): Promise<T> {
  return await res.json();
}

const devEnv: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/hushbox',
  UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
  UPSTASH_REDIS_REST_TOKEN: 'token',
  IRON_SESSION_SECRET: 'secret-at-least-32-characters-long!!',
  TELEMETRY_SINKS: 'console',
};

const productionEnv: Bindings & TelemetryEnv = { ...devEnv, NODE_ENV: 'production' };

const inFlowOnly = {
  kind: 'throttle',
  maxAttempts: 4,
  windowSeconds: 60,
  buildKey: (id: string) => `posture-fixture:in-flow:${id}`,
} as const satisfies ThrottleLimit;

/**
 * Postures for the fixture routes below, in the same shape the composition
 * root supplies: one entry per declared route key, and deliberately none for
 * `/undeclared`, which is what the default-deny answers.
 */
const postures: RoutePostureMap = {
  '$get /declared': { kind: 'default', failure: 'open' },
  '$get /exempted': { kind: 'exempt', exemption: 'signature-gated-webhook' },
  // Counted inside its own slice's flow, so the stage has nothing to spend for
  // it — the arm that keeps this suite's pipeline cases free of a Redis double.
  '$get /named': bindRoutePosture({
    failure: 'closed',
    layers: [{ identity: 'ip', countedAt: 'flow', definition: inFlowOnly }],
  }),
  '$get /dev': { kind: 'default', failure: 'open' },
  '$post /mutate': { kind: 'default', failure: 'open' },
};

function createTestApp(options?: { readonly postures?: RoutePostureMap }): Hono<AppEnv> {
  return (
    applyPipeline(new Hono<AppEnv>(), options === undefined ? {} : { rateLimit: options })
      // The composed app maps defects to `{code: INTERNAL}`; this surfaces the
      // thrown message instead, so a fail-fast can be told from any other 500.
      .onError((error, c) => c.json({ message: error.message }, 500))
      .get('/declared', routeClass('public'), (c) => c.json({ route: 'declared' }))
      .get('/exempted', routeClass('public'), (c) => c.json({ route: 'exempted' }))
      .get('/named', routeClass('public'), (c) => c.json({ route: 'named' }))
      .get('/dev', routeClass('dev-only'), (c) => c.json({ route: 'dev' }))
      .get('/undeclared', routeClass('public'), (c) => c.json({ route: 'undeclared' }))
      .get('/unmarked-undeclared', (c) => c.json({ route: 'unmarked' }))
      .post(
        '/undeclared-mutation',
        routeClass('public'),
        idempotencyExempt('naturally-idempotent'),
        (c) => c.json({ route: 'undeclared-mutation' })
      )
  );
}

const wired = createTestApp({ postures });

describe('pipelineRateLimit: the posture gate', () => {
  it('refuses a matched route the posture map does not declare', async () => {
    const res = await wired.request('/undeclared', {}, devEnv);
    expect(res.status).toBe(429);
  });

  it('answers the refusal with the uniform rate-limited code', async () => {
    const res = await wired.request('/undeclared', {}, devEnv);
    expect(await jsonBody(res)).toEqual({ code: ERROR_CODES.RATE_LIMITED });
  });

  it('never runs the handler of a route the posture map does not declare', async () => {
    let handlerRan = false;
    const app = applyPipeline(new Hono<AppEnv>(), { rateLimit: { postures } }).get(
      '/undeclared',
      routeClass('public'),
      (c) => {
        handlerRan = true;
        return c.json({ route: 'undeclared' });
      }
    );
    await app.request('/undeclared', {}, devEnv);
    expect(handlerRan).toBe(false);
  });

  it('serves a route declared with a class-default posture', async () => {
    const res = await wired.request('/declared', {}, devEnv);
    expect(res.status).toBe(200);
  });

  it('serves a route declared with a named posture', async () => {
    const res = await wired.request('/named', {}, devEnv);
    expect(res.status).toBe(200);
  });

  it('serves a route declared exempt', async () => {
    const res = await wired.request('/exempted', {}, devEnv);
    expect(res.status).toBe(200);
  });

  it('serves a dev-only route declared with a class-default posture', async () => {
    const res = await wired.request('/dev', {}, devEnv);
    expect(res.status).toBe(200);
  });

  it('falls through to 404 when nothing but the pipeline matched', async () => {
    const res = await wired.request('/no-such-route', {}, devEnv);
    expect(res.status).toBe(404);
  });
});

describe('pipelineRateLimit: where it sits in the pipeline', () => {
  it('leaves the authorizer to answer first (undeclared class outranks undeclared posture)', async () => {
    const res = await wired.request('/unmarked-undeclared', {}, devEnv);
    expect(res.status).toBe(403);
    expect(await jsonBody(res)).toEqual({ code: ERROR_CODES.FORBIDDEN });
  });

  it('answers before the idempotency stage (no key required to be refused)', async () => {
    const res = await wired.request('/undeclared-mutation', { method: 'POST' }, devEnv);
    expect(res.status).toBe(429);
  });

  it('leaves the idempotency stage to answer a declared mutating route', async () => {
    const app = applyPipeline(new Hono<AppEnv>(), { rateLimit: { postures } }).post(
      '/mutate',
      routeClass('public'),
      (c) => c.json({ ok: true })
    );
    const res = await app.request('/mutate', { method: 'POST' }, devEnv);
    expect(res.status).toBe(400);
    expect(await jsonBody(res)).toEqual({ code: ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED });
  });
});

describe('pipelineRateLimit: an unwired posture map', () => {
  it('serves every matched route outside production', async () => {
    const res = await createTestApp().request('/undeclared', {}, devEnv);
    expect(res.status).toBe(200);
  });

  it('fails fast in production rather than serving a route no map bounds', async () => {
    const res = await createTestApp().request('/undeclared', {}, productionEnv);
    expect(res.status).toBe(500);
    const body = await jsonBody<{ message: string }>(res);
    expect(body.message).toMatch(/posture/);
  });

  it('still 404s an unmatched path in production', async () => {
    const res = await createTestApp().request('/no-such-route', {}, productionEnv);
    expect(res.status).toBe(404);
  });

  it('fails fast when applied without the env stage (pipeline order violated)', async () => {
    const app = new Hono<AppEnv>()
      .use('*', pipelineRateLimit({ postures }))
      .get('/declared', routeClass('public'), (c) => c.json({ route: 'declared' }))
      .onError((error, c) => c.json({ message: error.message }, 500));
    const res = await app.request('/declared', {}, devEnv);
    expect(res.status).toBe(500);
    const body = await jsonBody<{ message: string }>(res);
    expect(body.message).toMatch(/pipeline order/);
  });
});

/**
 * The counting half. These build the stage directly rather than through
 * `applyPipeline`, because the bindings stage mints a real Redis client from
 * the env and what belongs to the stage is which IDENTIFIER each declared
 * identity resolves to and what it does with a decision — the counting itself
 * is `lib/rate-limit`'s and is measured against real Redis there.
 */
const DEVELOPMENT = createEnvUtilities({ NODE_ENV: 'development' });

/**
 * Production, for the cases about an identity that cannot be resolved. Outside
 * production every `ip`-keyed identity resolves through the fallback chain and
 * that arm is unreachable, so the mode is the whole of what makes it reachable.
 */
const PRODUCTION = createEnvUtilities({ NODE_ENV: 'production' });

const NO_PRINCIPAL: Principal = { kind: 'none' };
const CALLER_IP = '203.0.113.7';
const CREDENTIAL_HEADER = 'x-link-auth';
const LINK_TOKEN = mintLinkCredential().token;
const OTHER_LINK_TOKEN = mintLinkCredential().token;

function throttle(name: string, maxAttempts: number): ThrottleLimit {
  return {
    kind: 'throttle',
    maxAttempts,
    windowSeconds: 60,
    buildKey: (id: string) => `posture-fixture:${name}:${id}`,
  };
}

const firstEdge = throttle('first', 2);
const secondEdge = throttle('second', 5);

function billingPortalPrincipal(userId: string): Principal {
  return {
    kind: 'billing-portal',
    credential: {
      credentialKind: 'billing-portal',
      userId,
      sessionId: `credential-${userId}`,
      createdAt: 0,
    },
  };
}

function withCredential(token: string): { headers: Record<string, string> } {
  return { headers: { ...fromCaller.headers, [CREDENTIAL_HEADER]: token } };
}

function fullPrincipal(userId: string): Principal {
  return { kind: 'full', claims: sessionClaims(userId) };
}

function sessionClaims(userId: string): SessionClaims {
  return {
    userId,
    sessionId: 'session',
    createdAt: 0,
    pending2FA: false,
    pending2FAExpiresAt: 0,
  };
}

interface RecordedLine {
  readonly msg: string;
  readonly fields: SafeLogFields | undefined;
}

/** The typed logger, with every line it emitted kept for the assertion. */
function recordingLogger(): { telemetry: Telemetry; lines: RecordedLine[] } {
  const lines: RecordedLine[] = [];
  const record = (msg: string, fields?: SafeLogFields): void => {
    lines.push({ msg, fields });
  };
  const telemetry: Telemetry = {
    debug: record,
    info: record,
    warn: record,
    error: record,
    captureError: (): void => undefined,
  };
  return { telemetry, lines };
}

const SENTRY_DSN = 'https://abc123@o1.ingest.sentry.io/42';

interface SentryEnvelopeItem {
  readonly headers: { readonly type?: string };
  readonly payload: { readonly tags?: Record<string, unknown> };
}

/** The tags on the one error event a spy transport received. */
function sentryEventTags(envelopes: readonly unknown[]): Record<string, unknown> | undefined {
  for (const envelope of envelopes) {
    const [, items] = envelope as [
      unknown,
      [SentryEnvelopeItem['headers'], SentryEnvelopeItem['payload']][],
    ];
    for (const [headers, payload] of items) {
      if (headers.type === 'event') return payload.tags;
    }
  }
  return undefined;
}

interface RecordedCapture {
  readonly error: Error;
  readonly code: string;
}

/** The typed logger with every capture kept — the retained channel's half. */
function capturingLogger(): { telemetry: Telemetry; captures: RecordedCapture[] } {
  const captures: RecordedCapture[] = [];
  const telemetry: Telemetry = {
    ...recordingLogger().telemetry,
    captureError: (error: Error, errorCode: string): void => {
      captures.push({ error, code: errorCode });
    },
  };
  return { telemetry, captures };
}

/**
 * The stage as a fresh isolate has it. What an unreachable counter reports is
 * latched in module state, so a case needing an isolate that has reported
 * nothing yet takes the module again rather than reaching into that state —
 * which is also the closest a node test gets to the thing being modelled.
 * The bound its counter checks run under is per-module too, and arrives from
 * the process environment exactly as the suite's own setup takes it.
 */
async function freshIsolateStage(): Promise<typeof pipelineRateLimit> {
  vi.resetModules();
  const rateLimit = await import('../lib/rate-limit/index.js');
  rateLimit.configureRateLimitBound(process.env);
  rateLimit.configureRateLimitKeySecret(process.env);
  const stage = await import('./pipeline-rate-limit.js');
  return stage.pipelineRateLimit;
}

/**
 * What a case supplies around the stage: the two variables it reads from
 * earlier stages rather than from its options — the authorizer's route class,
 * which a class default resolves against, and the bindings stage's logger,
 * which carries the observation — plus the stage itself, so a case can drive an
 * isolate-fresh copy of the module under test.
 */
interface StageVariables {
  readonly routeClass?: RouteClass;
  readonly logger?: Telemetry;
  readonly stage?: typeof pipelineRateLimit;
  readonly envUtils?: EnvUtilities;
}

function stageApp(
  routePostures: RoutePostureMap,
  redis: Redis,
  principal: Principal = NO_PRINCIPAL,
  variables: StageVariables = {}
): Hono<AppEnv> {
  const declaredClass = variables.routeClass ?? 'public';
  const logger = variables.logger ?? recordingLogger().telemetry;
  const stage = variables.stage ?? pipelineRateLimit;
  const envUtilities = variables.envUtils ?? DEVELOPMENT;
  return (
    new Hono<AppEnv>()
      .use('*', async (c, next) => {
        c.set('envUtils', envUtilities);
        bindRequestValue(c, 'redis', redis);
        bindRequestValue(c, 'principal', principal);
        c.set('routeClass', declaredClass);
        bindRequestValue(c, 'logger', logger);
        await next();
      })
      .use('*', stage({ postures: routePostures, linkCredentialHeader: CREDENTIAL_HEADER }))
      .get('/counted', (c) => c.json({ ok: true }))
      .post('/counted', (c) => c.json({ ok: true }))
      // A registration whose template differs from the concrete path it is
      // requested at. Every other fixture route here spells its own path, so an
      // assertion on a logged `route` would read the same string whether the
      // field carried the template or the URL.
      .get('/counted/:id', (c) => c.json({ ok: true }))
      // A second registration `/counted/:id` also matches, so a request can be
      // driven through two declarations at once.
      .get('/counted/overlap', (c) => c.json({ ok: true }))
  );
}

const fromCaller = { headers: { 'cf-connecting-ip': CALLER_IP } };

describe('pipelineRateLimit: what the stage spends', () => {
  it('spends the declared entry under the identity the posture names', async () => {
    const double = scriptedRateLimitRedis();
    const app = stageApp(
      {
        '$get /counted': bindRoutePosture({
          failure: 'closed',
          layers: [{ identity: 'ip', countedAt: 'edge', definition: firstEdge }],
        }),
      },
      double.redis
    );

    const res = await app.request('/counted', fromCaller, devEnv);

    expect(res.status).toBe(200);
    expect(double.keys).toEqual([
      unwrapKey(rateLimitKey(firstEdge, await callerIpIdForAddress(CALLER_IP))),
    ]);
  });

  it('spends every edge layer in one round trip, positionally against the declared order', async () => {
    // A refusal short-circuits a STACK of checks, so a run that touched both
    // keys under a refusing reply cannot have made two calls.
    const double = scriptedRateLimitRedis(['refused:1:3:57']);
    const app = stageApp(
      {
        '$post /counted': bindRoutePosture({
          failure: 'closed',
          layers: [
            { identity: 'user', countedAt: 'edge', definition: firstEdge },
            { identity: 'ip', countedAt: 'edge', definition: secondEdge },
          ],
        }),
      },
      double.redis,
      fullPrincipal('user-1')
    );

    await app.request('/counted', { ...fromCaller, method: 'POST' }, devEnv);

    expect(double.keys).toEqual([
      unwrapKey(rateLimitKey(firstEdge, 'user-1')),
      unwrapKey(rateLimitKey(secondEdge, await callerIpIdForAddress(CALLER_IP))),
    ]);
  });

  it('spends one identity twice when a route declares it twice', async () => {
    const double = scriptedRateLimitRedis();
    const app = stageApp(
      {
        '$post /counted': bindRoutePosture({
          failure: 'closed',
          layers: [
            { identity: 'caller', countedAt: 'edge', definition: firstEdge },
            { identity: 'caller', countedAt: 'edge', definition: secondEdge },
          ],
        }),
      },
      double.redis,
      fullPrincipal('user-2')
    );

    await app.request('/counted', { ...fromCaller, method: 'POST' }, devEnv);

    expect(double.keys).toEqual([
      unwrapKey(rateLimitKey(firstEdge, 'user-2')),
      unwrapKey(rateLimitKey(secondEdge, 'user-2')),
    ]);
  });

  it('spends only the edge layers of a route that also counts one in flow', async () => {
    const double = scriptedRateLimitRedis();
    const app = stageApp(
      {
        '$get /counted': bindRoutePosture({
          failure: 'closed',
          layers: [
            { identity: 'ip', countedAt: 'edge', definition: firstEdge },
            { identity: 'link-credential', countedAt: 'flow', definition: secondEdge },
          ],
        }),
      },
      double.redis
    );

    const res = await app.request('/counted', fromCaller, devEnv);

    expect(res.status).toBe(200);
    expect(double.keys).toEqual([
      unwrapKey(rateLimitKey(firstEdge, await callerIpIdForAddress(CALLER_IP))),
    ]);
  });

  it('keys a billing-portal caller on the account its session carries', async () => {
    // The gap this identity closes: `user` treats a billing-portal principal as
    // a defect and `caller` falls back to that caller's address folded with a
    // header it supplies, so the one class admitting both session kinds could
    // be keyed per account for neither.
    const double = scriptedRateLimitRedis();
    const app = stageApp(
      {
        '$get /counted': bindRoutePosture({
          failure: 'closed',
          layers: [{ identity: 'session-user', countedAt: 'edge', definition: firstEdge }],
        }),
      },
      double.redis,
      billingPortalPrincipal('payer-1')
    );

    await app.request('/counted', fromCaller, devEnv);

    expect(double.keys).toEqual([unwrapKey(rateLimitKey(firstEdge, 'payer-1'))]);
  });

  it('keys a full caller on that same account', async () => {
    const double = scriptedRateLimitRedis();
    const app = stageApp(
      {
        '$get /counted': bindRoutePosture({
          failure: 'closed',
          layers: [{ identity: 'session-user', countedAt: 'edge', definition: firstEdge }],
        }),
      },
      double.redis,
      fullPrincipal('payer-1')
    );

    await app.request('/counted', fromCaller, devEnv);

    expect(double.keys).toEqual([unwrapKey(rateLimitKey(firstEdge, 'payer-1'))]);
  });

  it('keys a half-authenticated caller on the account its session carries', async () => {
    const double = scriptedRateLimitRedis();
    const app = stageApp(
      {
        '$get /counted': bindRoutePosture({
          failure: 'closed',
          layers: [{ identity: 'session-user', countedAt: 'edge', definition: firstEdge }],
        }),
      },
      double.redis,
      { kind: 'pending-2fa', claims: sessionClaims('half-authenticated') }
    );

    await app.request('/counted', fromCaller, devEnv);

    expect(double.keys).toEqual([unwrapKey(rateLimitKey(firstEdge, 'half-authenticated'))]);
  });

  it('reads nothing but the principal to derive it', async () => {
    // The property the whole edge vocabulary rests on: the stage resolves an
    // identity ahead of the handler and parses no body, so a request whose
    // body is unreadable is keyed exactly as any other.
    const double = scriptedRateLimitRedis();
    const app = stageApp(
      {
        '$post /counted': bindRoutePosture({
          failure: 'closed',
          layers: [{ identity: 'session-user', countedAt: 'edge', definition: firstEdge }],
        }),
      },
      double.redis,
      billingPortalPrincipal('payer-2')
    );

    await app.request(
      '/counted',
      { ...fromCaller, method: 'POST', body: 'not json at all' },
      devEnv
    );

    expect(double.keys).toEqual([unwrapKey(rateLimitKey(firstEdge, 'payer-2'))]);
  });

  it('keys an admin route on the hashed access identity, never the raw email', async () => {
    const double = scriptedRateLimitRedis();
    const app = stageApp(
      {
        '$get /counted': bindRoutePosture({
          failure: 'closed',
          layers: [{ identity: 'admin-actor', countedAt: 'edge', definition: firstEdge }],
        }),
      },
      double.redis,
      { kind: 'admin-actor', email: 'ops@hushbox.ai', audience: 'aud', role: 'operator' }
    );

    await app.request('/counted', fromCaller, devEnv);

    expect(double.keys).toEqual([
      unwrapKey(rateLimitKey(firstEdge, await hashRateLimitId('ops@hushbox.ai'))),
    ]);
  });

  it('admits without touching Redis when every declared layer skips the caller', async () => {
    const double = scriptedRateLimitRedis();
    const app = stageApp(
      {
        '$get /counted': bindRoutePosture({
          failure: 'closed',
          layers: [{ identity: 'sessionless-ip', countedAt: 'edge', definition: firstEdge }],
        }),
      },
      double.redis,
      fullPrincipal('user-3')
    );

    const res = await app.request('/counted', fromCaller, devEnv);

    expect(res.status).toBe(200);
    expect(double.keys).toEqual([]);
  });

  it("spends its route class's default for a route declared default", async () => {
    const double = scriptedRateLimitRedis();
    const app = stageApp({ '$get /counted': { kind: 'default', failure: 'open' } }, double.redis);

    await app.request('/counted', fromCaller, devEnv);

    expect(double.keys).toEqual([
      CLASS_DEFAULTS.public.definition.buildKey(
        `$get /counted:${hmacRateLimitId(await callerIpIdForAddress(CALLER_IP))}`
      ),
    ]);
  });

  it('keys the class default on the identity the route class declares', async () => {
    const double = scriptedRateLimitRedis();
    const app = stageApp(
      { '$get /counted': { kind: 'default', failure: 'open' } },
      double.redis,
      fullPrincipal('user-default'),
      { routeClass: 'session' }
    );

    await app.request('/counted', fromCaller, devEnv);

    expect(double.keys).toEqual([
      CLASS_DEFAULTS.session.definition.buildKey(
        `$get /counted:${hmacRateLimitId('user-default')}`
      ),
    ]);
  });

  // The escape a caller-controlled key component opens, closed at the key
  // rather than by a second counter: the link-credential header is read for
  // every `caller`-keyed route from one pipeline-wide wiring, and any base64
  // decoding to non-empty bytes is accepted, so a `caller`-keyed
  // `billing-token` default would hand a billing-portal credential a fresh counter
  // per request and no cap at any rate. The account claim the session carries
  // is the component the caller cannot vary, and it is what this default keys
  // on.
  it('gives a billing-portal caller rotating its link credential one class-default counter', async () => {
    const double = scriptedRateLimitRedis();
    const app = stageApp(
      { '$get /counted': { kind: 'default', failure: 'open' } },
      double.redis,
      billingPortalPrincipal('payer'),
      { routeClass: 'billing-token' }
    );

    await app.request('/counted', withCredential(LINK_TOKEN), devEnv);
    await app.request('/counted', withCredential(OTHER_LINK_TOKEN), devEnv);

    const key = CLASS_DEFAULTS['billing-token'].definition.buildKey(
      `$get /counted:${hmacRateLimitId('payer')}`
    );
    expect(double.keys).toEqual([key, key]);
  });

  // The direction the address key could not hold: two billing-portal credentials
  // behind one address are two payers, and the default now stands for one
  // caller rather than one network.
  it('gives two billing-portal callers on one address two class-default counters', async () => {
    const double = scriptedRateLimitRedis();
    const first = stageApp(
      { '$get /counted': { kind: 'default', failure: 'open' } },
      double.redis,
      billingPortalPrincipal('payer-a'),
      { routeClass: 'billing-token' }
    );
    const second = stageApp(
      { '$get /counted': { kind: 'default', failure: 'open' } },
      double.redis,
      billingPortalPrincipal('payer-b'),
      { routeClass: 'billing-token' }
    );

    await first.request('/counted', fromCaller, devEnv);
    await second.request('/counted', fromCaller, devEnv);

    const build = CLASS_DEFAULTS['billing-token'].definition.buildKey;
    expect(double.keys).toEqual([
      build(`$get /counted:${hmacRateLimitId('payer-a')}`),
      build(`$get /counted:${hmacRateLimitId('payer-b')}`),
    ]);
  });

  // Requested at a concrete path one of the templates does not spell, so the
  // key is shown carrying the TEMPLATE: the concrete path can hold user content
  // (share ids, tokens) and a key built from it would both leak and split one
  // route's counter across every id it is called with.
  it('gives two routes of one class two counters for one caller', async () => {
    const double = scriptedRateLimitRedis();
    const app = stageApp(
      {
        '$get /counted': { kind: 'default', failure: 'open' },
        '$get /counted/:id': { kind: 'default', failure: 'open' },
      },
      double.redis
    );

    await app.request('/counted', fromCaller, devEnv);
    await app.request('/counted/abc', fromCaller, devEnv);

    const keyedCallerId = hmacRateLimitId(await callerIpIdForAddress(CALLER_IP));
    expect(double.keys).toEqual([
      CLASS_DEFAULTS.public.definition.buildKey(`$get /counted:${keyedCallerId}`),
      CLASS_DEFAULTS.public.definition.buildKey(`$get /counted/:id:${keyedCallerId}`),
    ]);
  });

  // The unit a route key names is a method AND a path: two methods of one path
  // are two routes, and a client looping one of them must not spend the window
  // the others count on.
  it('gives two methods of one path two counters for one caller', async () => {
    const double = scriptedRateLimitRedis();
    const app = stageApp(
      {
        '$get /counted': { kind: 'default', failure: 'open' },
        '$post /counted': { kind: 'default', failure: 'open' },
      },
      double.redis
    );

    await app.request('/counted', fromCaller, devEnv);
    await app.request('/counted', { ...fromCaller, method: 'POST' }, devEnv);

    const keyedCallerId = hmacRateLimitId(await callerIpIdForAddress(CALLER_IP));
    expect(double.keys).toEqual([
      CLASS_DEFAULTS.public.definition.buildKey(`$get /counted:${keyedCallerId}`),
      CLASS_DEFAULTS.public.definition.buildKey(`$post /counted:${keyedCallerId}`),
    ]);
  });

  // The router dispatches a HEAD request by re-entering its dispatcher with
  // `GET`, so the GET registration is what matched and what the posture lookup
  // admitted, while the request's own method still reads `HEAD`. A counter
  // keyed off that method would open a second window of equal size on the same
  // registration, and the method is the caller's to choose — so the route class
  // default of every GET route would be worth twice its declared cap.
  it('gives a HEAD request and a GET request to one route the same counter', async () => {
    const double = scriptedRateLimitRedis();
    const app = stageApp({ '$get /counted': { kind: 'default', failure: 'open' } }, double.redis);

    await app.request('/counted', fromCaller, devEnv);
    await app.request('/counted', { ...fromCaller, method: 'HEAD' }, devEnv);

    const key = CLASS_DEFAULTS.public.definition.buildKey(
      `$get /counted:${hmacRateLimitId(await callerIpIdForAddress(CALLER_IP))}`
    );
    expect(double.keys).toEqual([key, key]);
  });

  it('gives two calls to one route by one caller the same counter', async () => {
    const double = scriptedRateLimitRedis();
    const app = stageApp({ '$get /counted': { kind: 'default', failure: 'open' } }, double.redis);

    await app.request('/counted', fromCaller, devEnv);
    await app.request('/counted', fromCaller, devEnv);

    const key = CLASS_DEFAULTS.public.definition.buildKey(
      `$get /counted:${hmacRateLimitId(await callerIpIdForAddress(CALLER_IP))}`
    );
    expect(double.keys).toEqual([key, key]);
  });

  // A request matching two declarations spends a bound per match, and each
  // lands on the counter of the registration whose key resolved it — the same
  // registration the posture lookup read. The alternative, one route template
  // named for the whole request, would spend both on one of the two counters
  // and leave the other declaration's window untouched by every request that
  // reaches it.
  it('spends each matched declaration on the counter of its own registration', async () => {
    const double = scriptedRateLimitRedis();
    const app = stageApp(
      {
        '$get /counted/:id': { kind: 'default', failure: 'open' },
        '$get /counted/overlap': { kind: 'default', failure: 'open' },
      },
      double.redis
    );

    await app.request('/counted/overlap', fromCaller, devEnv);

    const keyedCallerId = hmacRateLimitId(await callerIpIdForAddress(CALLER_IP));
    expect(double.keys).toEqual([
      CLASS_DEFAULTS.public.definition.buildKey(`$get /counted/:id:${keyedCallerId}`),
      CLASS_DEFAULTS.public.definition.buildKey(`$get /counted/overlap:${keyedCallerId}`),
    ]);
  });

  it('spends nothing for a named route counted only inside its slice flow', async () => {
    const double = scriptedRateLimitRedis();
    const app = stageApp(
      {
        '$get /counted': bindRoutePosture({
          failure: 'closed',
          layers: [
            { identity: 'ip', countedAt: 'flow', definition: firstEdge },
            { identity: 'ip', countedAt: 'flow', definition: secondEdge },
          ],
        }),
      },
      double.redis
    );

    const res = await app.request('/counted', fromCaller, devEnv);

    expect(res.status).toBe(200);
    expect(double.keys).toEqual([]);
  });
});

describe('pipelineRateLimit: what a decision earns', () => {
  const countedByIp: RoutePostureMap = {
    '$get /counted': bindRoutePosture({
      failure: 'closed',
      layers: [{ identity: 'ip', countedAt: 'edge', definition: firstEdge }],
    }),
  };

  it('refuses a caller past its window with the uniform 429 and its retry window', async () => {
    const app = stageApp(countedByIp, scriptedRateLimitRedis(['refused:1:3:57']).redis);

    const res = await app.request('/counted', fromCaller, devEnv);

    expect(res.status).toBe(429);
    expect(await jsonBody(res)).toEqual({
      code: ERROR_CODES.RATE_LIMITED,
      details: { retryAfterSeconds: 57 },
    });
  });

  it('never runs the handler of a refused request', async () => {
    let handlerRan = false;
    const app = new Hono<AppEnv>()
      .use('*', async (c, next) => {
        c.set('envUtils', DEVELOPMENT);
        bindRequestValue(c, 'redis', scriptedRateLimitRedis(['refused:1:3:57']).redis);
        bindRequestValue(c, 'principal', { kind: 'none' });
        await next();
      })
      .use(
        '*',
        pipelineRateLimit({ postures: countedByIp, linkCredentialHeader: CREDENTIAL_HEADER })
      )
      .get('/counted', (c) => {
        handlerRan = true;
        return c.json({ ok: true });
      });

    await app.request('/counted', fromCaller, devEnv);

    expect(handlerRan).toBe(false);
  });

  it('fails closed when the counter cannot be reached', async () => {
    const app = stageApp(countedByIp, unreachableRateLimitRedis());

    const res = await app.request('/counted', fromCaller, devEnv);

    expect(res.status).toBe(503);
  });
});

/** A key the shared builder produced, or a loud failure if it refused the id. */
function unwrapKey(built: ReturnType<typeof rateLimitKey>): string {
  if (built.isErr()) throw new Error('rate-limit key builder refused a fixture identifier');
  return built.value;
}

function realPostureApp(
  method: string,
  path: string,
  redis: Redis,
  principal: Principal
): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
    .use('*', async (c, next) => {
      c.set('envUtils', DEVELOPMENT);
      bindRequestValue(c, 'redis', redis);
      bindRequestValue(c, 'principal', principal);
      await next();
    })
    .use(
      '*',
      pipelineRateLimit({
        postures: ROUTE_POSTURES,
        linkCredentialHeader: LINK_CREDENTIAL_HEADER,
      })
    );
  app.on(method, path, (c) => c.json({ ok: true }));
  return app;
}

/**
 * The cases driven against the REAL {@link ROUTE_POSTURES} map rather than a
 * fixture of the same shape — this file's only readers of a shipped
 * declaration. Each pins that its route spends exactly the edge layers its
 * shipped row declares, which is where an arity bug surfaces first: `count`
 * throws on an id list its `keyedBy` does not describe.
 */
describe('the shipped rows, driven against the real posture map', () => {
  it('spends both caller windows of the feedback submit, on the one identity', async () => {
    const double = scriptedRateLimitRedis();
    const app = realPostureApp('POST', '/feedback', double.redis, fullPrincipal('user-fb'));

    const res = await app.request('/feedback', { method: 'POST', ...fromCaller }, devEnv);

    expect(res.status).toBe(200);
    expect(double.keys).toEqual([
      unwrapKey(rateLimitKey(feedbackSubmitRateLimit, 'user-fb')),
      unwrapKey(rateLimitKey(feedbackSubmitHourlyRateLimit, 'user-fb')),
    ]);
  });

  it('spends the three EDGE layers of the media member presign, never the fourth', async () => {
    const double = scriptedRateLimitRedis();
    const app = realPostureApp('GET', '/media/:contentItemId/download-url', double.redis, {
      kind: 'none',
    });

    const res = await app.request(
      '/media/item/download-url',
      { headers: { ...fromCaller.headers, [LINK_CREDENTIAL_HEADER]: LINK_TOKEN } },
      devEnv
    );

    const ipHash = await callerIpIdForAddress(CALLER_IP);
    const credentialHash = await hashRateLimitId(LINK_TOKEN);
    expect(res.status).toBe(200);
    // Exactly the three EDGE entries, in declared order. The fourth layer is
    // the per-link MINT, spent by the handler once the credential has resolved
    // to a linkId — a value no identity here can derive.
    expect(double.keys).toEqual([
      unwrapKey(rateLimitKey(MEDIA_RATE_LIMITS.mediaDownloadGuestIpRateLimit, ipHash)),
      // The composite caller identity is keyed whole, separators included.
      unwrapKey(
        rateLimitKey(
          MEDIA_RATE_LIMITS.mediaDownloadUserRateLimit,
          `ip:${ipHash}:link:${credentialHash}`
        )
      ),
      unwrapKey(rateLimitKey(MEDIA_RATE_LIMITS.mediaDownloadLinkLookupRateLimit, credentialHash)),
    ]);
  });

  it('spends only the link mint, keyed on the account minting the link', async () => {
    const double = scriptedRateLimitRedis();
    const app = realPostureApp(
      'POST',
      '/conversations/:conversationId/links',
      double.redis,
      fullPrincipal('user-mint')
    );

    const res = await app.request(
      '/conversations/abc/links',
      { method: 'POST', ...fromCaller },
      devEnv
    );

    expect(res.status).toBe(200);
    // The mint is the only layer this route declares, so the single key is its
    // whole declaration rather than the subset a skipping layer would leave.
    expect(double.keys).toEqual([unwrapKey(rateLimitKey(linkCreateRateLimit, 'user-mint'))]);
  });

  it('spends nothing at the edge for the trial send, whose two layers are both in flow', async () => {
    const double = scriptedRateLimitRedis();
    const app = realPostureApp('POST', '/chat/trial', double.redis, { kind: 'none' });

    const res = await app.request('/chat/trial', { method: 'POST', ...fromCaller }, devEnv);

    expect(res.status).toBe(200);
    expect(double.keys).toEqual([]);
  });

  it('spends nothing at the edge for the deletion finish, whose two layers are both in flow', async () => {
    const double = scriptedRateLimitRedis();
    const app = realPostureApp(
      'POST',
      '/auth/account/delete/finish',
      double.redis,
      fullPrincipal('user-del')
    );

    const res = await app.request(
      '/auth/account/delete/finish',
      { method: 'POST', ...fromCaller },
      devEnv
    );

    expect(res.status).toBe(200);
    expect(double.keys).toEqual([]);
  });
});

/**
 * A class default REFUSES a caller past its cap and ADMITS one whose counter it
 * could not reach — two arms of one function, and these cases exist to hold
 * them apart, because a change that moved the second while fixing the first
 * would be a security bypass wearing a rate-limit fix.
 *
 * The status and the log line are asserted separately: a default that stopped
 * logging would keep every status here green.
 */
describe('pipelineRateLimit: what a class default earns', () => {
  const defaultRoute: RoutePostureMap = { '$get /counted': { kind: 'default', failure: 'open' } };

  it('refuses a caller past its class default with the uniform 429 and its retry window', async () => {
    const app = stageApp(defaultRoute, scriptedRateLimitRedis(['refused:1:3:57']).redis);

    const res = await app.request('/counted', fromCaller, devEnv);

    expect(res.status).toBe(429);
    expect(await jsonBody(res)).toEqual({
      code: ERROR_CODES.RATE_LIMITED,
      details: { retryAfterSeconds: 57 },
    });
  });

  it('never runs the handler of a request its class default refused', async () => {
    let handlerRan = false;
    const app = new Hono<AppEnv>()
      .use('*', async (c, next) => {
        c.set('envUtils', DEVELOPMENT);
        bindRequestValue(c, 'redis', scriptedRateLimitRedis(['refused:1:3:57']).redis);
        bindRequestValue(c, 'principal', NO_PRINCIPAL);
        c.set('routeClass', 'public');
        bindRequestValue(c, 'logger', recordingLogger().telemetry);
        await next();
      })
      .use('*', pipelineRateLimit({ postures: defaultRoute }))
      .get('/counted', (c) => {
        handlerRan = true;
        return c.json({ ok: true });
      });

    await app.request('/counted', fromCaller, devEnv);

    expect(handlerRan).toBe(false);
  });

  // Requested at a concrete path the template does not spell, because the
  // `route` field is a PRIVACY property before it is a naming one: the routes
  // this line fires on include `/notifications/device-tokens/:token` and
  // `/dev/mailbox/:id`, whose path tokens the telemetry rules forbid logging.
  // Asserted on a route whose template equals its path, the field reads the
  // same either way and the assertion cannot fail in that direction.
  it('logs the crossing beside the refusal it answers, naming the template', async () => {
    const recorder = recordingLogger();
    const app = stageApp(
      { '$get /counted/:id': { kind: 'default', failure: 'open' } },
      scriptedRateLimitRedis(['refused:1:3:57']).redis,
      undefined,
      {
        logger: recorder.telemetry,
      }
    );

    const res = await app.request('/counted/abc', fromCaller, devEnv);

    expect(res.status).toBe(429);
    expect(recorder.lines).toEqual([
      {
        msg: 'rate-limit class default exceeded',
        fields: { method: 'GET', route: '/counted/:id' },
      },
    ]);
  });

  // The counter and the line read one registration, so the crossing a HEAD
  // request earns is reported under the registration that served it. The
  // request's own method is captured here rather than assumed: it is what the
  // line would carry if the two halves were read from different sources, and
  // the two assertions together are what tell those sources apart.
  it("names the serving registration's method on a HEAD request's crossing", async () => {
    const recorder = recordingLogger();
    let requestMethod = '';
    const app = new Hono<AppEnv>()
      .use('*', async (c, next) => {
        c.set('envUtils', DEVELOPMENT);
        bindRequestValue(c, 'redis', scriptedRateLimitRedis(['refused:1:3:57']).redis);
        bindRequestValue(c, 'principal', NO_PRINCIPAL);
        c.set('routeClass', 'public');
        bindRequestValue(c, 'logger', recorder.telemetry);
        requestMethod = c.req.method;
        await next();
      })
      .use('*', pipelineRateLimit({ postures: defaultRoute }))
      .get('/counted', (c) => c.json({ ok: true }));

    await app.request('/counted', { ...fromCaller, method: 'HEAD' }, devEnv);

    expect(requestMethod).toBe('HEAD');
    expect(recorder.lines).toEqual([
      { msg: 'rate-limit class default exceeded', fields: { method: 'GET', route: '/counted' } },
    ]);
  });

  it('logs nothing for a caller inside its class default', async () => {
    const recorder = recordingLogger();
    const app = stageApp(defaultRoute, scriptedRateLimitRedis().redis, undefined, {
      logger: recorder.telemetry,
    });

    await app.request('/counted', fromCaller, devEnv);

    expect(recorder.lines).toEqual([]);
  });

  it('admits when the class default cannot be reached, where a named limit fails closed', async () => {
    const app = stageApp(defaultRoute, unreachableRateLimitRedis());

    const res = await app.request('/counted', fromCaller, devEnv);

    expect(res.status).toBe(200);
  });

  // Whole-line equality rather than a lookup of the failure: this channel is
  // ingested nowhere and read locally, so what it carries is the whole account
  // of a limiter failure anyone gets, and a field arriving beside these is as
  // much a change to that account as one going missing.
  it('logs the bypass an unreachable class default admits, naming the failure', async () => {
    const recorder = recordingLogger();
    const app = stageApp(defaultRoute, unreachableRateLimitRedis(), undefined, {
      logger: recorder.telemetry,
    });

    await app.request('/counted', fromCaller, devEnv);

    expect(recorder.lines).toEqual([
      {
        msg: 'rate-limit class default unavailable',
        fields: { method: 'GET', route: '/counted', rateLimitFailure: 'transport' },
      },
    ]);
  });

  it('names the store error on the line when the endpoint answered with one', async () => {
    const recorder = recordingLogger();
    const app = stageApp(defaultRoute, counterErroringRedis(), undefined, {
      logger: recorder.telemetry,
    });

    await app.request('/counted', fromCaller, devEnv);

    expect(recorder.lines).toEqual([
      {
        msg: 'rate-limit class default unavailable',
        fields: { method: 'GET', route: '/counted', rateLimitFailure: 'store-error' },
      },
    ]);
  });

  // The same hazard the retained channel carries, on the channel a local
  // reader tails: the endpoint's own error embeds the serialized command, and
  // a counter check's command holds the KEYS naming the identity counted.
  it("keeps the endpoint error's own text off the line it writes", async () => {
    const recorder = recordingLogger();
    const app = stageApp(defaultRoute, counterErroringRedis(), undefined, {
      logger: recorder.telemetry,
    });

    await app.request('/counted', fromCaller, devEnv);

    expect(JSON.stringify(recorder.lines)).not.toContain(COUNTER_KEY_SENTINEL);
  });

  it('fails fast when a default route reaches the stage with no route class', async () => {
    const app = new Hono<AppEnv>()
      .use('*', async (c, next) => {
        c.set('envUtils', DEVELOPMENT);
        bindRequestValue(c, 'redis', scriptedRateLimitRedis().redis);
        bindRequestValue(c, 'principal', NO_PRINCIPAL);
        bindRequestValue(c, 'logger', recordingLogger().telemetry);
        await next();
      })
      .use('*', pipelineRateLimit({ postures: defaultRoute }))
      .get('/counted', (c) => c.json({ ok: true }))
      .onError((error, c) => c.json({ message: error.message }, 500));

    const res = await app.request('/counted', fromCaller, devEnv);

    expect(res.status).toBe(500);
    const body = await jsonBody<{ message: string }>(res);
    expect(body.message).toMatch(/pipelineAuthorize/);
  });

  it('fails fast when a default route reaches the stage with nothing to log through', async () => {
    const app = new Hono<AppEnv>()
      .use('*', async (c, next) => {
        c.set('envUtils', DEVELOPMENT);
        bindRequestValue(c, 'redis', scriptedRateLimitRedis().redis);
        bindRequestValue(c, 'principal', NO_PRINCIPAL);
        c.set('routeClass', 'public');
        await next();
      })
      .use('*', pipelineRateLimit({ postures: defaultRoute }))
      .get('/counted', (c) => c.json({ ok: true }))
      .onError((error, c) => c.json({ message: error.message }, 500));

    const res = await app.request('/counted', fromCaller, devEnv);

    expect(res.status).toBe(500);
    const body = await jsonBody<{ message: string }>(res);
    expect(body.message).toMatch(/pipelineBindings/);
  });
});

/**
 * What a counter the stage could not reach reports, as opposed to what it
 * decides — the decision is above, and this suite must never change it. The
 * cases here are about the ONE channel this deployment retains: the console
 * adapter's lines are ingested nowhere and the Sentry adapter's log methods
 * are inert, so `captureError` is the whole of what a human can be told.
 */
describe('pipelineRateLimit: what an unreachable class default reports', () => {
  const defaultRoute: RoutePostureMap = { '$get /counted': { kind: 'default', failure: 'open' } };

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports the bypass on the channel this deployment retains', async () => {
    const recorder = capturingLogger();
    const app = stageApp(defaultRoute, unreachableRateLimitRedis(), undefined, {
      logger: recorder.telemetry,
      stage: await freshIsolateStage(),
    });

    await app.request('/counted', fromCaller, devEnv);

    expect(recorder.captures).toHaveLength(1);
    expect(recorder.captures[0]?.code).toBe(FINGERPRINT_CODES.rateLimitBypassed);
  });

  it('reports one bypass per isolate while the window holds, never one per request', async () => {
    freezeClock(TEST_DAY_START);
    const recorder = capturingLogger();
    const app = stageApp(defaultRoute, unreachableRateLimitRedis(), undefined, {
      logger: recorder.telemetry,
      stage: await freshIsolateStage(),
    });

    await app.request('/counted', fromCaller, devEnv);
    await app.request('/counted', fromCaller, devEnv);

    expect(recorder.captures).toHaveLength(1);
  });

  it('reports again in the same isolate once its report window has elapsed', async () => {
    freezeClock(TEST_DAY_START);
    const recorder = capturingLogger();
    const app = stageApp(defaultRoute, unreachableRateLimitRedis(), undefined, {
      logger: recorder.telemetry,
      stage: await freshIsolateStage(),
    });

    await app.request('/counted', fromCaller, devEnv);
    setClock(TEST_DAY_START + BYPASS_REPORT_WINDOW_MS);
    await app.request('/counted', fromCaller, devEnv);

    expect(recorder.captures).toHaveLength(2);
  });

  it('reports again from a fresh isolate inside one window, because the latch is per isolate', async () => {
    freezeClock(TEST_DAY_START);
    const first = capturingLogger();
    const second = capturingLogger();
    const bypass = async (recorder: { telemetry: Telemetry }): Promise<void> => {
      const app = stageApp(defaultRoute, unreachableRateLimitRedis(), undefined, {
        logger: recorder.telemetry,
        stage: await freshIsolateStage(),
      });
      await app.request('/counted', fromCaller, devEnv);
    };

    await bypass(first);
    await bypass(second);

    // The clock never moved, so the second report can only be the second
    // isolate's own empty latch — a latch shared across isolates would show
    // exactly one capture here.
    expect([first.captures.length, second.captures.length]).toEqual([1, 1]);
  });

  it('reaches the Sentry wire through the real adapter, tagged and scrubbed', async () => {
    const envelopes: unknown[] = [];
    const flushes: Promise<unknown>[] = [];
    const telemetry = createSentryTelemetry({
      dsn: SENTRY_DSN,
      transport: () => ({
        send: (envelope: unknown) => {
          envelopes.push(envelope);
          return Promise.resolve({});
        },
        flush: () => Promise.resolve(true),
      }),
      scheduleFlush: (task) => flushes.push(task),
    });
    const app = stageApp(defaultRoute, unreachableRateLimitRedis(), undefined, {
      logger: telemetry,
      stage: await freshIsolateStage(),
    });

    await app.request('/counted', fromCaller, devEnv);
    await Promise.all(flushes);

    expect(sentryEventTags(envelopes)).toEqual({
      errorCode: FINGERPRINT_CODES.rateLimitBypassed,
      rateLimitRoute: '$get /counted',
      rateLimitBypassCause: 'counter',
    });
  });

  it('carries the route it could not bound, and nothing else off the request', async () => {
    const recorder = capturingLogger();
    const app = stageApp(defaultRoute, unreachableRateLimitRedis(), undefined, {
      logger: recorder.telemetry,
      stage: await freshIsolateStage(),
    });

    await app.request('/counted?secret=value', fromCaller, devEnv);

    const captured = recorder.captures[0]?.error ?? new Error('nothing captured');
    // The whole key set, not a lookup of the one expected: what this guards
    // against is a SECOND property arriving off the request — a query string,
    // a header, an identity — where the scrub's allowlist would be the only
    // thing standing between it and the wire.
    expect(Object.keys(captured)).toEqual(['name', 'rateLimitRoute', 'rateLimitBypassCause']);
    expect(captured.name).toBe('RateLimitBypassed');
    expect(Reflect.get(captured, 'rateLimitRoute')).toBe('$get /counted');
    expect(Reflect.get(captured, 'rateLimitBypassCause')).toBe('counter');
  });
});

/** The cause the one bypass a case produced names, having asserted there was one. */
function soleBypassCause(captures: readonly RecordedCapture[]): unknown {
  expect(captures).toHaveLength(1);
  return Reflect.get(captures[0]?.error ?? new Error('nothing captured'), 'rateLimitBypassCause');
}

/**
 * WHICH conditions reach that report and which do not, and what each is named.
 * The stage admits on more than one failure, and the two send an operator to
 * different systems: `counter` to the counter store, `identity` to the edge
 * that attaches the caller's address — where the counter is healthy and was
 * asked nothing. Nothing else in this suite pins the mapping, so a condition
 * silently renamed, added, or folded into the other reads as a correct event
 * pointing at the wrong system.
 */
describe('pipelineRateLimit: which failures reach that report', () => {
  const defaultRoute: RoutePostureMap = { '$get /counted': { kind: 'default', failure: 'open' } };

  it('names the counter when the counter answered no decision', async () => {
    const recorder = capturingLogger();
    const app = stageApp(defaultRoute, unreachableRateLimitRedis(), undefined, {
      logger: recorder.telemetry,
      stage: await freshIsolateStage(),
    });

    await app.request('/counted', fromCaller, devEnv);

    expect(soleBypassCause(recorder.captures)).toBe('counter');
  });

  it('names the identity when the counter was never asked', async () => {
    const double = scriptedRateLimitRedis();
    const recorder = capturingLogger();
    const app = stageApp(defaultRoute, double.redis, undefined, {
      logger: recorder.telemetry,
      stage: await freshIsolateStage(),
      envUtils: PRODUCTION,
    });

    // No `cf-connecting-ip`. In production that header is the only address an
    // `ip`-keyed identity may believe, so the request carries nothing to key a
    // window on and the spend stops before the counter.
    const res = await app.request('/counted', {}, devEnv);

    expect(res.status).toBe(200);
    expect(soleBypassCause(recorder.captures)).toBe('identity');
    // The counter here is HEALTHY and was asked nothing, which is the whole of
    // what separates this condition from the one above.
    expect(double.keys).toEqual([]);
  });

  it('reports nothing for a caller its class default admitted', async () => {
    const recorder = capturingLogger();
    const app = stageApp(defaultRoute, scriptedRateLimitRedis().redis, undefined, {
      logger: recorder.telemetry,
      stage: await freshIsolateStage(),
    });

    const res = await app.request('/counted', fromCaller, devEnv);

    expect(res.status).toBe(200);
    expect(recorder.captures).toEqual([]);
  });

  it('reports nothing for a caller its class default refused', async () => {
    const recorder = capturingLogger();
    const app = stageApp(
      defaultRoute,
      scriptedRateLimitRedis(['refused:1:3:57']).redis,
      undefined,
      { logger: recorder.telemetry, stage: await freshIsolateStage() }
    );

    const res = await app.request('/counted', fromCaller, devEnv);

    expect(res.status).toBe(429);
    expect(recorder.captures).toEqual([]);
  });
});

/**
 * The sentinel a real endpoint error would carry into its own message. The
 * client builds an `UpstashError` from the response body AND the serialized
 * request, and a counter check's request is the script with its KEYS — which
 * embed the identity being counted. Cases below assert this string reaches
 * neither the captured error nor the wire.
 */
const COUNTER_KEY_SENTINEL = 'counter-key-of-the-identity-being-counted';

/**
 * A Redis whose script call fails the way the endpoint's own failure does:
 * with the client's `UpstashError`, message and all. The cast is the one the
 * sibling doubles in `test-support/rate-limit-double.ts` carry and for the
 * same reason — the primitive reaches `createScript().exec` and nothing else,
 * so standing up the whole client surface would state nothing the case tests.
 */
function counterErroringRedis(): Redis {
  return {
    createScript: () => ({
      exec: () =>
        Promise.reject(
          new errors.UpstashError(
            `ERR unknown command, command was: ["EVALSHA","sha","1","${COUNTER_KEY_SENTINEL}"]`
          )
        ),
    }),
  } as unknown as Redis;
}

/** The one capture a case produced, having asserted there was one. */
function soleCapture(captures: readonly RecordedCapture[]): RecordedCapture {
  expect(captures).toHaveLength(1);
  const [capture] = captures;
  if (capture === undefined) throw new Error('nothing captured');
  return capture;
}

/** The fingerprint the one capture a case produced carries, having asserted there was one. */
function soleCounterCode(captures: readonly RecordedCapture[]): string | undefined {
  expect(captures).toHaveLength(1);
  return captures[0]?.code;
}

/** The failure arm the one dependency report a case produced names, having asserted there was one. */
function soleCounterFailure(captures: readonly RecordedCapture[]): unknown {
  expect(captures).toHaveLength(1);
  return Reflect.get(captures[0]?.error ?? new Error('nothing captured'), 'dependencyFailure');
}

/**
 * What a counter store the stage could not reach reports on the arm that
 * REFUSED. A route declaring `closed` admits nothing, so it has no bypass — but
 * the store being unreachable is the same incident whichever posture the route
 * declared, and the refusal names it through the one report every availability
 * refusal makes, so the fail-closed half of an outage does not leave a 503 whose
 * code names no dependency.
 *
 * These cases are about the report only. What the caller is answered is the
 * law's, is unchanged, and is driven there.
 */
describe('pipelineRateLimit: what an unreachable counter store reports', () => {
  const closedDefault: RoutePostureMap = {
    '$get /counted': { kind: 'default', failure: 'closed' },
  };
  const openDefault: RoutePostureMap = { '$get /counted': { kind: 'default', failure: 'open' } };

  afterEach(() => {
    vi.useRealTimers();
  });

  async function refusedApp(
    recorder: { telemetry: Telemetry },
    redis: Redis = unreachableRateLimitRedis()
  ): Promise<Hono<AppEnv>> {
    return stageApp(closedDefault, redis, undefined, {
      logger: recorder.telemetry,
      stage: await freshIsolateStage(),
    });
  }

  it('reports the unreachable store once, as the dependency behind the refusal', async () => {
    const recorder = capturingLogger();
    const app = await refusedApp(recorder);

    await app.request('/counted', fromCaller, devEnv);

    // The whole list of codes: one dependency report, and no second report of
    // the same refusal under any other code.
    expect(recorder.captures.map((capture) => capture.code)).toEqual([
      FINGERPRINT_CODES.dependencyUnavailable,
    ]);
    expect(recorder.captures[0]?.error).toMatchObject({ dependency: 'redis' });
  });

  it('answers the caller the same refusal it always has while reporting it', async () => {
    const recorder = capturingLogger();
    const app = await refusedApp(recorder);

    const res = await app.request('/counted', fromCaller, devEnv);

    expect(res.status).toBe(503);
    expect(await jsonBody(res)).toEqual({ code: ERROR_CODES.RATE_LIMIT_UNAVAILABLE });
    expect(recorder.captures).toHaveLength(1);
  });

  it('reports once per isolate while the window holds, never once per request', async () => {
    freezeClock(TEST_DAY_START);
    const recorder = capturingLogger();
    const app = await refusedApp(recorder);

    await app.request('/counted', fromCaller, devEnv);
    await app.request('/counted', fromCaller, devEnv);

    expect(recorder.captures).toHaveLength(1);
  });

  it('reports again in the same isolate once its report window has elapsed', async () => {
    freezeClock(TEST_DAY_START);
    const recorder = capturingLogger();
    const app = await refusedApp(recorder);

    await app.request('/counted', fromCaller, devEnv);
    setClock(TEST_DAY_START + DEPENDENCY_REPORT_WINDOW_MS);
    await app.request('/counted', fromCaller, devEnv);

    expect(recorder.captures).toHaveLength(2);
  });

  it('names the transport failure when the request to the store threw', async () => {
    const recorder = capturingLogger();
    const app = await refusedApp(recorder);

    await app.request('/counted', fromCaller, devEnv);

    expect(soleCounterFailure(recorder.captures)).toBe('transport');
  });

  it('names the store error when the endpoint answered with one', async () => {
    const recorder = capturingLogger();
    const app = await refusedApp(recorder, counterErroringRedis());

    await app.request('/counted', fromCaller, devEnv);

    expect(soleCounterFailure(recorder.captures)).toBe('server-error');
  });

  it('carries the route and the classification, and nothing off the error it was handed', async () => {
    const recorder = capturingLogger();
    const app = await refusedApp(recorder, counterErroringRedis());

    await app.request('/counted?secret=value', fromCaller, devEnv);

    const captured = recorder.captures[0]?.error ?? new Error('nothing captured');
    // The whole key set, not a lookup of the two expected: the endpoint error
    // this arm was handed carries the counter KEYS in its own message, so a
    // third property — a cause, a message copy, a stringified error — is the
    // one way the identity being counted reaches the retained channel.
    expect(Object.keys(captured)).toEqual([
      'name',
      'dependencyRoute',
      'dependency',
      'dependencyFailure',
      'dependencyLate',
    ]);
    expect(captured.name).toBe('DependencyUnavailable');
    expect(Reflect.get(captured, 'dependencyRoute')).toBe('$get /counted');
    expect(Reflect.get(captured, 'dependency')).toBe('redis');
    expect(Reflect.get(captured, 'dependencyFailure')).toBe('server-error');
    expect(captured.cause).toBeUndefined();
    const surface = `${captured.name} ${captured.message} ${JSON.stringify(captured)}`;
    expect(surface).not.toContain(COUNTER_KEY_SENTINEL);
  });

  it('reaches the Sentry wire carrying the route, and none of the endpoint error', async () => {
    const envelopes: unknown[] = [];
    const flushes: Promise<unknown>[] = [];
    const telemetry = createSentryTelemetry({
      dsn: SENTRY_DSN,
      transport: () => ({
        send: (envelope: unknown) => {
          envelopes.push(envelope);
          return Promise.resolve({});
        },
        flush: () => Promise.resolve(true),
      }),
      scheduleFlush: (task) => flushes.push(task),
    });
    const app = stageApp(closedDefault, counterErroringRedis(), undefined, {
      logger: telemetry,
      stage: await freshIsolateStage(),
    });

    await app.request('/counted', fromCaller, devEnv);
    await Promise.all(flushes);

    // Route, store and arm: an operator who learns only that the counter was
    // unreachable is sent to the whole store, while the arm names which of a
    // deadline, a transport failure or an error the store answered to look at.
    // `toMatchObject` rather than `toEqual`, because what this case is for is
    // the second assertion — that the endpoint error's own message reaches
    // neither tag nor envelope.
    expect(sentryEventTags(envelopes)).toMatchObject({
      errorCode: FINGERPRINT_CODES.dependencyUnavailable,
      dependencyRoute: '$get /counted',
      dependency: 'redis',
      dependencyFailure: 'server-error',
    });
    expect(JSON.stringify(envelopes)).not.toContain(COUNTER_KEY_SENTINEL);
  });

  it('names no dependency when the identity could not resolve and the store was never asked', async () => {
    const recorder = capturingLogger();
    const app = stageApp(closedDefault, scriptedRateLimitRedis().redis, undefined, {
      logger: recorder.telemetry,
      stage: await freshIsolateStage(),
      envUtils: PRODUCTION,
    });

    // No `cf-connecting-ip`, so the spend stops before the counter: the store
    // is healthy and naming it would send an operator to the wrong system.
    const res = await app.request('/counted', {}, devEnv);

    expect(res.status).toBe(503);
    expect(soleCapture(recorder.captures).error).toMatchObject({
      dependency: 'unknown',
      dependencyFailure: 'unknown',
    });
  });

  it('reports nothing for a caller the counter refused', async () => {
    const recorder = capturingLogger();
    const app = await refusedApp(recorder, scriptedRateLimitRedis(['refused:1:3:57']).redis);

    const res = await app.request('/counted', fromCaller, devEnv);

    expect(res.status).toBe(429);
    expect(recorder.captures).toEqual([]);
  });

  it('leaves a route declaring open reporting its bypass and nothing else', async () => {
    const recorder = capturingLogger();
    const app = stageApp(openDefault, unreachableRateLimitRedis(), undefined, {
      logger: recorder.telemetry,
      stage: await freshIsolateStage(),
    });

    const res = await app.request('/counted', fromCaller, devEnv);

    expect(res.status).toBe(200);
    expect(recorder.captures).toHaveLength(1);
    expect(recorder.captures[0]?.code).toBe(FINGERPRINT_CODES.rateLimitBypassed);
  });

  it('holds its own window, so neither report can silence the other', async () => {
    freezeClock(TEST_DAY_START);
    const recorder = capturingLogger();
    const stage = await freshIsolateStage();
    const options = { logger: recorder.telemetry, stage };
    const admitted = stageApp(openDefault, unreachableRateLimitRedis(), undefined, options);
    const refused = stageApp(closedDefault, unreachableRateLimitRedis(), undefined, options);

    await admitted.request('/counted', fromCaller, devEnv);
    await refused.request('/counted', fromCaller, devEnv);

    // The clock never moved, so a single shared latch would show one capture.
    expect(recorder.captures.map((capture) => capture.code)).toEqual([
      FINGERPRINT_CODES.rateLimitBypassed,
      FINGERPRINT_CODES.dependencyUnavailable,
    ]);
  });
});

/**
 * THE LAW, driven across every declared combination of the two dimensions.
 * Over-cap refuses whatever the failure posture says — the counter was reached
 * and it answered — and the failure posture decides the two ways a spend can
 * answer nothing: the counter never replying, and the identity it would have
 * been keyed on never resolving. Each cell is driven rather than reasoned
 * about, and the report each answer owes its reader is asserted in the same
 * case as the answer, because an admission nothing reports leaves no one able
 * to learn that a route ran unbounded, and a refusal nothing reports leaves no
 * one able to learn the counter store is down.
 */
describe('pipelineRateLimit: the law, over both dimensions', () => {
  const openNamed: RoutePostureMap = {
    '$get /counted': bindRoutePosture({
      failure: 'open',
      layers: [{ identity: 'ip', countedAt: 'edge', definition: firstEdge }],
    }),
  };
  const closedNamed: RoutePostureMap = {
    '$get /counted': bindRoutePosture({
      failure: 'closed',
      layers: [{ identity: 'ip', countedAt: 'edge', definition: firstEdge }],
    }),
  };
  const openDefault: RoutePostureMap = {
    '$get /counted': { kind: 'default', failure: 'open' },
  };
  const closedDefault: RoutePostureMap = {
    '$get /counted': { kind: 'default', failure: 'closed' },
  };

  /** A request whose `ip`-keyed identity cannot resolve: production reads only
   *  `cf-connecting-ip`, and this request carries none. */
  async function withoutAnAddress(
    routePostures: RoutePostureMap,
    recorder: { telemetry: Telemetry }
  ): Promise<Response> {
    const app = stageApp(routePostures, scriptedRateLimitRedis().redis, undefined, {
      logger: recorder.telemetry,
      stage: await freshIsolateStage(),
      envUtils: PRODUCTION,
    });
    return await app.request('/counted', {}, devEnv);
  }

  async function withAnUnreachableCounter(
    routePostures: RoutePostureMap,
    recorder: { telemetry: Telemetry }
  ): Promise<Response> {
    const app = stageApp(routePostures, unreachableRateLimitRedis(), undefined, {
      logger: recorder.telemetry,
      stage: await freshIsolateStage(),
    });
    return await app.request('/counted', fromCaller, devEnv);
  }

  async function pastTheCap(routePostures: RoutePostureMap): Promise<Response> {
    const app = stageApp(routePostures, scriptedRateLimitRedis(['refused:1:3:57']).redis);
    return await app.request('/counted', fromCaller, devEnv);
  }

  it('refuses a caller past the cap on a named route declaring open', async () => {
    const res = await pastTheCap(openNamed);

    expect(res.status).toBe(429);
  });

  it('refuses a caller past the cap on a named route declaring closed', async () => {
    const res = await pastTheCap(closedNamed);

    expect(res.status).toBe(429);
  });

  it('refuses a caller past the cap on a default route declaring open', async () => {
    const res = await pastTheCap(openDefault);

    expect(res.status).toBe(429);
  });

  it('refuses a caller past the cap on a default route declaring closed', async () => {
    const res = await pastTheCap(closedDefault);

    expect(res.status).toBe(429);
  });

  it('admits an unreachable counter on a named route declaring open, and reports it', async () => {
    const recorder = capturingLogger();

    const res = await withAnUnreachableCounter(openNamed, recorder);

    expect(res.status).toBe(200);
    expect(soleBypassCause(recorder.captures)).toBe('counter');
  });

  it('refuses an unreachable counter on a named route declaring closed, and reports the store', async () => {
    const recorder = capturingLogger();

    const res = await withAnUnreachableCounter(closedNamed, recorder);

    expect(res.status).toBe(503);
    expect(soleCounterCode(recorder.captures)).toBe(FINGERPRINT_CODES.dependencyUnavailable);
  });

  it('admits an unreachable counter on a default route declaring open, and reports it', async () => {
    const recorder = capturingLogger();

    const res = await withAnUnreachableCounter(openDefault, recorder);

    expect(res.status).toBe(200);
    expect(soleBypassCause(recorder.captures)).toBe('counter');
  });

  it('refuses an unreachable counter on a default route declaring closed, and reports the store', async () => {
    const recorder = capturingLogger();

    const res = await withAnUnreachableCounter(closedDefault, recorder);

    expect(res.status).toBe(503);
    expect(soleCounterCode(recorder.captures)).toBe(FINGERPRINT_CODES.dependencyUnavailable);
  });

  it('admits an unresolvable identity on a named route declaring open, and reports it', async () => {
    const recorder = capturingLogger();

    const res = await withoutAnAddress(openNamed, recorder);

    expect(res.status).toBe(200);
    expect(soleBypassCause(recorder.captures)).toBe('identity');
  });

  it('refuses an unresolvable identity on a named route declaring closed, naming no dependency', async () => {
    const recorder = capturingLogger();

    const res = await withoutAnAddress(closedNamed, recorder);

    expect(res.status).toBe(503);
    expect(soleCapture(recorder.captures).error).toMatchObject({ dependency: 'unknown' });
  });

  it('admits an unresolvable identity on a default route declaring open, and reports it', async () => {
    const recorder = capturingLogger();

    const res = await withoutAnAddress(openDefault, recorder);

    expect(res.status).toBe(200);
    expect(soleBypassCause(recorder.captures)).toBe('identity');
  });

  it('refuses an unresolvable identity on a default route declaring closed, naming no dependency', async () => {
    const recorder = capturingLogger();

    const res = await withoutAnAddress(closedDefault, recorder);

    expect(res.status).toBe(503);
    expect(soleCapture(recorder.captures).error).toMatchObject({ dependency: 'unknown' });
  });

  // The refusal a closed route answers is the limiter's own code, which is what
  // a money guard on the client reads: the two dimensions changed which routes
  // reach it, never what it says.
  it('answers a closed refusal with the limiter-unavailable code', async () => {
    const recorder = capturingLogger();

    const res = await withAnUnreachableCounter(closedDefault, recorder);

    expect(await jsonBody(res)).toEqual({ code: ERROR_CODES.RATE_LIMIT_UNAVAILABLE });
  });

  // An exempt route reaches no counter, so it has no arm either dimension could
  // govern — which is why it carries no failure declaration at all.
  it('spends nothing at all for an exempt route', async () => {
    const double = scriptedRateLimitRedis();
    const app = stageApp(
      { '$get /counted': { kind: 'exempt', exemption: 'constant-cost' } },
      double.redis
    );

    const res = await app.request('/counted', fromCaller, devEnv);

    expect(res.status).toBe(200);
    expect(double.keys).toEqual([]);
  });
});

describe('pipelineRateLimit: a posture the composition cannot key', () => {
  const countedByUser: RoutePostureMap = {
    '$get /counted': bindRoutePosture({
      failure: 'closed',
      layers: [{ identity: 'user', countedAt: 'edge', definition: firstEdge }],
    }),
  };

  function defectMessage(app: Hono<AppEnv>): Hono<AppEnv> {
    return app.onError((error, c) => c.json({ message: error.message }, 500));
  }

  it('fails loudly when a user-keyed layer meets a caller that is not a full principal', async () => {
    const app = defectMessage(
      stageApp(countedByUser, scriptedRateLimitRedis().redis, { kind: 'none' })
    );

    const res = await app.request('/counted', fromCaller, devEnv);

    expect(res.status).toBe(500);
    const body = await jsonBody<{ message: string }>(res);
    expect(body.message).toMatch(/not full/);
  });

  it('fails loudly when a session-keyed layer meets a caller carrying no session', async () => {
    const app = defectMessage(
      stageApp(
        {
          '$get /counted': bindRoutePosture({
            failure: 'closed',
            layers: [{ identity: 'session-user', countedAt: 'edge', definition: firstEdge }],
          }),
        },
        scriptedRateLimitRedis().redis,
        { kind: 'none' }
      )
    );

    const res = await app.request('/counted', fromCaller, devEnv);

    expect(res.status).toBe(500);
    const body = await jsonBody<{ message: string }>(res);
    expect(body.message).toMatch(/carrying no session/);
  });

  it('fails loudly when an admin-keyed layer meets a caller that is not an admin actor', async () => {
    const app = defectMessage(
      stageApp(
        {
          '$get /counted': bindRoutePosture({
            failure: 'closed',
            layers: [{ identity: 'admin-actor', countedAt: 'edge', definition: firstEdge }],
          }),
        },
        scriptedRateLimitRedis().redis,
        fullPrincipal('user-not-admin')
      )
    );

    const res = await app.request('/counted', fromCaller, devEnv);

    expect(res.status).toBe(500);
    const body = await jsonBody<{ message: string }>(res);
    expect(body.message).toMatch(/admin actor/);
  });

  it('fails loudly when a credential-keyed layer is wired with no credential header', async () => {
    const app = new Hono<AppEnv>()
      .use('*', async (c, next) => {
        c.set('envUtils', DEVELOPMENT);
        bindRequestValue(c, 'redis', scriptedRateLimitRedis().redis);
        bindRequestValue(c, 'principal', { kind: 'none' });
        await next();
      })
      .use(
        '*',
        pipelineRateLimit({
          postures: {
            '$get /counted': bindRoutePosture({
              failure: 'closed',
              layers: [{ identity: 'caller', countedAt: 'edge', definition: firstEdge }],
            }),
          },
        })
      )
      .get('/counted', (c) => c.json({ ok: true }))
      .onError((error, c) => c.json({ message: error.message }, 500));

    const res = await app.request('/counted', fromCaller, devEnv);

    expect(res.status).toBe(500);
    const body = await jsonBody<{ message: string }>(res);
    expect(body.message).toMatch(/linkCredentialHeader/);
  });
});
