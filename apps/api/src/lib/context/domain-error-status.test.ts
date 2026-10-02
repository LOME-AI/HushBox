import { Hono } from 'hono';
import { hc } from 'hono/client';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { LOCAL_NEON_DEV_CONFIG, createDb } from '@hushbox/db';
import { DOMAIN_ERROR_CODE_TO_WIRE_CODE, ERROR_CODES } from '@hushbox/shared';
import { TEST_DAY_START, freezeClock, setClock } from '@hushbox/shared/test-time';
import { DOMAIN_ERROR_CODES, notFoundError, unavailableError } from '../errors/index.js';
import { FINGERPRINT_CODES } from '../telemetry/index.js';
import { bindRequestValue } from './request-scope.js';
import { createSentryTelemetry } from '../telemetry/adapters/sentry-adapter.js';
import { STATUS_BY_DOMAIN_CODE, respondDomainError } from './domain-error-status.js';
import type { AppEnv } from './app-env.js';
import type { DomainError, DomainErrorCode } from '../errors/index.js';
import type { Telemetry } from '../telemetry/index.js';
import type { ErrorResponse } from '@hushbox/shared';
import type { Context } from 'hono';
import type { InferResponseType } from 'hono/client';
import type { JSONParsed } from 'hono/utils/types';

function errorOf(code: DomainErrorCode, wireCode?: ErrorResponse['code']): DomainError {
  return {
    code,
    message: 'operator-safe message',
    ...(wireCode === undefined ? {} : { wireCode }),
  };
}

describe('STATUS_BY_DOMAIN_CODE', () => {
  it.each([
    ['validation', 400],
    ['unauthorized', 401],
    ['forbidden', 403],
    ['not_found', 404],
    ['conflict', 409],
    ['rate_limited', 429],
    ['timeout', 504],
    ['unavailable', 503],
  ] as const)('maps %s to %d', (code, status) => {
    expect(STATUS_BY_DOMAIN_CODE[code]).toBe(status);
  });

  it('covers every code in the closed taxonomy', () => {
    const byName = (a: string, b: string): number => a.localeCompare(b);
    expect(Object.keys(STATUS_BY_DOMAIN_CODE).toSorted(byName)).toEqual(
      [...DOMAIN_ERROR_CODES].toSorted(byName)
    );
  });
});

describe('respondDomainError', () => {
  const app = new Hono<AppEnv>().get('/thing', (c) =>
    respondDomainError(c, errorOf(c.req.query('code') as DomainErrorCode))
  );

  it.each([...DOMAIN_ERROR_CODES])('answers the taxonomy wire code for %s', async (code) => {
    const res = await app.request(`/thing?code=${code}`);
    expect(res.status).toBe(STATUS_BY_DOMAIN_CODE[code]);
    expect(await res.json()).toEqual({ code: DOMAIN_ERROR_CODE_TO_WIRE_CODE[code] });
  });

  it('answers 504 for an outbound-call timeout', async () => {
    const res = await app.request('/thing?code=timeout');
    expect(res.status).toBe(504);
  });

  it('honours a carried wire code over the taxonomy mapping', async () => {
    const carrying = new Hono<AppEnv>().get('/thing', (c) =>
      respondDomainError(c, errorOf('validation', ERROR_CODES.UNSUPPORTED_MODALITY))
    );
    const res = await carrying.request('/thing');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.UNSUPPORTED_MODALITY });
  });

  it('keeps the refusal body typed at its status for the typed client', () => {
    const _typeClient = hc<typeof app>('http://demo.invalid');
    expectTypeOf<InferResponseType<typeof _typeClient.thing.$get, 503>>().toEqualTypeOf<
      JSONParsed<ErrorResponse>
    >();
  });
});

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required: run through a package test script.');
}

/** Far below the pool's own deadline, far above a local acquire. */
const SHORT_POOL_DEADLINE_MS = 50;

/**
 * What a driver error would carry into its own message: a query's text and its
 * parameters. Cases below assert it reaches neither the capture nor the wire.
 */
const CAUSE_SENTINEL = 'select * from users where email = sentinel-of-the-cause';

interface RecordedCapture {
  readonly error: Error;
  readonly code: string;
}

/** The typed logger with every capture kept, and every line dropped. */
function capturingLogger(): { telemetry: Telemetry; captures: RecordedCapture[] } {
  const captures: RecordedCapture[] = [];
  const telemetry: Telemetry = {
    debug: (): void => undefined,
    info: (): void => undefined,
    warn: (): void => undefined,
    error: (): void => undefined,
    captureError: (error: Error, errorCode: string): void => {
      captures.push({ error, code: errorCode });
    },
  };
  return { telemetry, captures };
}

/** The one capture a case produced, having asserted there was exactly one. */
function soleCapture(captures: readonly RecordedCapture[]): RecordedCapture {
  expect(captures).toHaveLength(1);
  const [capture] = captures;
  if (capture === undefined) throw new Error('nothing captured');
  return capture;
}

/**
 * The refusal tail as a fresh isolate has it. What it has already reported is
 * latched in module state, so a case that needs an isolate which has reported
 * nothing takes the module again, with the policies whose deadlines it
 * classifies taken from the same fresh graph.
 */
async function freshIsolate(): Promise<{
  readonly respond: typeof respondDomainError;
  readonly policies: typeof import('../resilience/policies.js');
}> {
  vi.resetModules();
  const respondModule = await import('./domain-error-status.js');
  const policies = await import('../resilience/policies.js');
  return { respond: respondModule.respondDomainError, policies };
}

/** A route at `/x` answering the refusal `refusal` builds, with `logger` bound as the bindings stage binds it. */
function refusingApp(
  respond: typeof respondDomainError,
  logger: Telemetry,
  refusal: (c: Context<AppEnv>) => Promise<DomainError>
): Hono<AppEnv> {
  return new Hono<AppEnv>()
    .use('*', async (c, next) => {
      bindRequestValue(c, 'logger', logger);
      await next();
    })
    .get('/x', async (c) => respond(c, await refusal(c)));
}

/**
 * A real pg-pool queued-acquire timeout: the pool's one connection checked
 * out, and a second acquire outliving the pool's own deadline.
 */
async function queuedAcquireTimeout(): Promise<unknown> {
  const db = createDb(DATABASE_URL ?? '', { neonDev: LOCAL_NEON_DEV_CONFIG });
  db.$client.options.connectionTimeoutMillis = SHORT_POOL_DEADLINE_MS;
  const held = await db.$client.connect();
  const cause = await db.$client.connect().then(
    () => new Error('the second acquire was served'),
    (error: unknown) => error
  );
  held.release();
  await db.$client.end();
  return cause;
}

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

/** An error standing in for a driver's, its message carrying {@link CAUSE_SENTINEL}. */
function contentBearingCause(): Error {
  return Object.assign(new Error(CAUSE_SENTINEL), { query: CAUSE_SENTINEL });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('respondDomainError: the capture an availability refusal owes', () => {
  it("captures a refusal behind the pool's queued-acquire deadline once, naming postgres, the arm and the route", async () => {
    const { respond } = await freshIsolate();
    const recorder = capturingLogger();
    const cause = await queuedAcquireTimeout();
    const app = refusingApp(respond, recorder.telemetry, () =>
      Promise.resolve(unavailableError('read failed', cause))
    );

    await app.request('/x');

    const capture = soleCapture(recorder.captures);
    expect(capture.code).toBe(FINGERPRINT_CODES.dependencyUnavailable);
    expect(capture.error).toMatchObject({
      dependency: 'postgres',
      dependencyFailure: 'acquire-timeout',
      dependencyRoute: '$get /x',
    });
  });

  it('answers the refusal it always has while capturing it', async () => {
    const { respond } = await freshIsolate();
    const recorder = capturingLogger();
    const app = refusingApp(respond, recorder.telemetry, () =>
      Promise.resolve(unavailableError('read failed', contentBearingCause()))
    );

    const res = await app.request('/x');

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: ERROR_CODES.UNAVAILABLE });
    expect(recorder.captures).toHaveLength(1);
  });

  it('carries the route, the dependency, the arm and the lateness, and nothing off the error it was handed', async () => {
    const { respond } = await freshIsolate();
    const recorder = capturingLogger();
    const app = refusingApp(respond, recorder.telemetry, () =>
      Promise.resolve(unavailableError(CAUSE_SENTINEL, contentBearingCause()))
    );

    await app.request('/x?secret=value');

    const { error } = soleCapture(recorder.captures);
    // The whole key set, not a lookup of the expected ones: the error the
    // refusal was handed carries a driver's message and query, so a further
    // property — a cause, a message copy, a stringified error — is the one way
    // that content reaches the retained channel.
    expect(Object.keys(error)).toEqual([
      'name',
      'dependencyRoute',
      'dependency',
      'dependencyFailure',
      'dependencyLate',
    ]);
    expect(error.name).toBe('DependencyUnavailable');
    expect(Reflect.get(error, 'dependencyRoute')).toBe('$get /x');
    expect(Reflect.get(error, 'dependency')).toBe('unknown');
    expect(Reflect.get(error, 'dependencyFailure')).toBe('unknown');
    expect(Reflect.get(error, 'dependencyLate')).toBe(false);
    expect(error.cause).toBeUndefined();
    const surface = `${error.name} ${error.message} ${JSON.stringify(error)}`;
    expect(surface).not.toContain(CAUSE_SENTINEL);
  });

  it('captures a refusal answered as a timeout', async () => {
    const { respond, policies } = await freshIsolate();
    const recorder = capturingLogger();
    const app = refusingApp(respond, recorder.telemetry, async () => {
      const result = await policies
        .timeoutPolicy({ timeoutMs: 1 })
        .run(() => new Promise<never>(() => {}));
      return result._unsafeUnwrapErr();
    });

    const res = await app.request('/x');

    expect(res.status).toBe(504);
    expect(soleCapture(recorder.captures).error).toMatchObject({ dependencyFailure: 'deadline' });
  });

  it('says the isolate was late when the deadline behind the refusal fired late', async () => {
    const { respond, policies } = await freshIsolate();
    const recorder = capturingLogger();
    const app = refusingApp(respond, recorder.telemetry, async () => {
      freezeClock(TEST_DAY_START, { toFake: ['Date'] });
      const result = await policies.timeoutPolicy({ timeoutMs: 10 }).run(() => {
        queueMicrotask(() => {
          setClock(TEST_DAY_START + 10 + policies.LATE_TIMER_THRESHOLD_MS + 1);
        });
        return new Promise<never>(() => {});
      });
      return result._unsafeUnwrapErr();
    });

    await app.request('/x');

    expect(soleCapture(recorder.captures).error).toMatchObject({
      dependencyFailure: 'deadline',
      dependencyLate: true,
    });
  });

  it('captures nothing for a refusal that is not an availability failure', async () => {
    const { respond } = await freshIsolate();
    const recorder = capturingLogger();
    const app = refusingApp(respond, recorder.telemetry, (c) =>
      Promise.resolve(
        c.req.query('kind') === 'missing'
          ? notFoundError('no such thing')
          : unavailableError('read failed')
      )
    );

    await app.request('/x');
    expect(recorder.captures).toHaveLength(1);
    const res = await app.request('/x?kind=missing');

    expect(res.status).toBe(404);
    expect(recorder.captures).toHaveLength(1);
  });

  it('captures once per isolate for one dependency and arm while the window holds', async () => {
    freezeClock(TEST_DAY_START, { toFake: ['Date'] });
    const { respond } = await freshIsolate();
    const recorder = capturingLogger();
    const app = refusingApp(respond, recorder.telemetry, () =>
      Promise.resolve(unavailableError('read failed'))
    );

    await app.request('/x');
    await app.request('/x');

    expect(recorder.captures).toHaveLength(1);
  });

  it('captures another arm inside the window of the first', async () => {
    freezeClock(TEST_DAY_START, { toFake: ['Date'] });
    const { respond, policies } = await freshIsolate();
    const recorder = capturingLogger();
    const app = refusingApp(respond, recorder.telemetry, async (c) => {
      if (c.req.query('arm') !== 'deadline') return unavailableError('read failed');
      const result = await policies
        .timeoutPolicy({ timeoutMs: 1 })
        .run(() => new Promise<never>(() => {}));
      return result._unsafeUnwrapErr();
    });

    await app.request('/x');
    await app.request('/x?arm=deadline');

    expect(recorder.captures.map(({ error }) => Reflect.get(error, 'dependencyFailure'))).toEqual([
      'unknown',
      'deadline',
    ]);
  });

  it('captures another dependency failing on the same arm inside the window of the first', async () => {
    freezeClock(TEST_DAY_START, { toFake: ['Date'] });
    const { respond } = await freshIsolate();
    const recorder = capturingLogger();
    // The server's own answer, as the driver's error carries it: a severity
    // beside a SQLSTATE. The classifier's tests pin that shape against the
    // installed driver.
    const postgresAnswer = Object.assign(new Error('division by zero'), {
      severity: 'ERROR',
      code: '22012',
    });
    const redisAnswer: DomainError & { readonly rateLimitFailure: 'store-error' } = {
      ...unavailableError('rate limit consume failed'),
      rateLimitFailure: 'store-error',
    };
    const app = refusingApp(respond, recorder.telemetry, (c) =>
      Promise.resolve(
        c.req.query('store') === 'postgres'
          ? unavailableError('read failed', postgresAnswer)
          : redisAnswer
      )
    );

    await app.request('/x');
    await app.request('/x?store=postgres');

    expect(
      recorder.captures.map(({ error }) => [
        Reflect.get(error, 'dependency'),
        Reflect.get(error, 'dependencyFailure'),
      ])
    ).toEqual([
      ['redis', 'server-error'],
      ['postgres', 'server-error'],
    ]);
  });

  it('captures again in the same isolate once its window has elapsed', async () => {
    freezeClock(TEST_DAY_START, { toFake: ['Date'] });
    const { respond } = await freshIsolate();
    const { DEPENDENCY_REPORT_WINDOW_MS } = await import('./domain-error-status.js');
    const recorder = capturingLogger();
    const app = refusingApp(respond, recorder.telemetry, () =>
      Promise.resolve(unavailableError('read failed'))
    );

    await app.request('/x');
    setClock(TEST_DAY_START + DEPENDENCY_REPORT_WINDOW_MS);
    await app.request('/x');

    expect(recorder.captures).toHaveLength(2);
  });

  it('leaves the route off a refusal no registration matched', async () => {
    const { respond } = await freshIsolate();
    const recorder = capturingLogger();
    const app = new Hono<AppEnv>().use('*', (c) => {
      bindRequestValue(c, 'logger', recorder.telemetry);
      return Promise.resolve(respond(c, unavailableError('read failed')));
    });

    await app.request('/nowhere');

    expect(Object.keys(soleCapture(recorder.captures).error)).not.toContain('dependencyRoute');
  });

  it('answers the refusal without a capture when no logger is bound', async () => {
    const { respond } = await freshIsolate();
    const app = new Hono<AppEnv>().get('/x', (c) => respond(c, unavailableError('read failed')));

    const res = await app.request('/x');

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: ERROR_CODES.UNAVAILABLE });
  });

  it('reaches the Sentry wire carrying the route and the classification, and none of the cause', async () => {
    const { respond } = await freshIsolate();
    const envelopes: unknown[] = [];
    const flushes: Promise<unknown>[] = [];
    const telemetry = createSentryTelemetry({
      dsn: 'https://abc123@o1.ingest.sentry.io/42',
      transport: () => ({
        send: (envelope: unknown) => {
          envelopes.push(envelope);
          return Promise.resolve({});
        },
        flush: () => Promise.resolve(true),
      }),
      scheduleFlush: (task) => flushes.push(task),
    });
    const cause = await queuedAcquireTimeout();
    const app = refusingApp(respond, telemetry, () =>
      Promise.resolve(unavailableError(CAUSE_SENTINEL, cause))
    );

    await app.request('/x');
    await Promise.all(flushes);

    expect(sentryEventTags(envelopes)).toEqual({
      errorCode: FINGERPRINT_CODES.dependencyUnavailable,
      dependency: 'postgres',
      dependencyFailure: 'acquire-timeout',
      dependencyLate: false,
      dependencyRoute: '$get /x',
    });
    expect(JSON.stringify(envelopes)).not.toContain(CAUSE_SENTINEL);
  });
});
