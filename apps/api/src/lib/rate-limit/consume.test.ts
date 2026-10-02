import { errors } from '@upstash/redis';
import { describe, expect, it, vi } from 'vitest';
import { domainWireCode, validationError } from '../errors/index.js';
import { STATUS_BY_DOMAIN_CODE } from '../context/domain-error-status.js';
import type { Redis } from '@upstash/redis';
import type { ThrottleLimit } from './definition.js';

/**
 * Short enough that the bound arm settles inside a test, and long enough that
 * a stub answering on the microtask queue never races it.
 */
const BOUND_MS = 50;

const LIMIT: ThrottleLimit = {
  kind: 'throttle',
  maxAttempts: 1,
  windowSeconds: 60,
  buildKey: (id: string) => `test:rate-limit:consume:${id}`,
};

/**
 * A module graph running under {@link BOUND_MS} rather than the mode's own
 * value. The bound is write-once at module scope and the suite's setup file
 * already put the mode's value in force, so a fresh registry is the only way
 * to run a check under a different one.
 */
async function freshConsume(): Promise<typeof import('./consume.js')> {
  vi.resetModules();
  const bound = await import('./bound.js');
  bound.configureRateLimitBound({ RATE_LIMIT_REDIS_TIMEOUT_MS: String(BOUND_MS) });
  const keySecret = await import('./key-secret.js');
  keySecret.configureRateLimitKeySecret(process.env);
  return await import('./consume.js');
}

/**
 * A client whose script call settles as `settle` says. The assertion stands in
 * for the client's whole surface, which no case here needs: `consumeLayers`
 * reaches exactly `createScript(...).exec(...)`, and a hand-built object typed
 * as the class would have to declare its several hundred commands.
 */
function scriptClient(settle: () => Promise<string>): Redis {
  return { createScript: () => ({ exec: settle }) } as unknown as Redis;
}

describe('a counter check that answers no decision', () => {
  it('names the bound when the store never answers', async () => {
    const { consume, rateLimitFailureOf } = await freshConsume();
    const failed = await consume(
      scriptClient(() => new Promise<string>(() => {})),
      LIMIT,
      'never-answers'
    );
    expect(rateLimitFailureOf(failed._unsafeUnwrapErr())).toBe('timeout');
  });

  it('names transport when the request to the store throws', async () => {
    const { consume, rateLimitFailureOf } = await freshConsume();
    const failed = await consume(
      scriptClient(() => Promise.reject(new TypeError('fetch failed'))),
      LIMIT,
      'throws'
    );
    expect(rateLimitFailureOf(failed._unsafeUnwrapErr())).toBe('transport');
  });

  it('names the store when the store answers with an error', async () => {
    const { consume, rateLimitFailureOf } = await freshConsume();
    const failed = await consume(
      scriptClient(() => Promise.reject(new errors.UpstashError('WRONGTYPE'))),
      LIMIT,
      'store-errors'
    );
    expect(rateLimitFailureOf(failed._unsafeUnwrapErr())).toBe('store-error');
  });

  it('names the reply when the store answers something it cannot read', async () => {
    const { consume, rateLimitFailureOf } = await freshConsume();
    const failed = await consume(
      scriptClient(() => Promise.resolve('surprise')),
      LIMIT,
      'garbled'
    );
    expect(rateLimitFailureOf(failed._unsafeUnwrapErr())).toBe('unreadable');
  });

  it('reads no failure off an error this module did not mint', async () => {
    const { rateLimitFailureOf } = await freshConsume();
    expect(rateLimitFailureOf(validationError('not from a counter check'))).toBeUndefined();
  });
});

describe('the refusal a caller sees', () => {
  it('is the same one whichever failure the check met', async () => {
    const { consume, rateLimitFailureOf } = await freshConsume();
    const settlements = [
      (): Promise<string> => new Promise<string>(() => {}),
      (): Promise<string> => Promise.reject(new TypeError('fetch failed')),
      (): Promise<string> => Promise.reject(new errors.UpstashError('WRONGTYPE')),
      (): Promise<string> => Promise.resolve('surprise'),
    ];
    const met: (string | undefined)[] = [];
    for (const settle of settlements) {
      const failed = await consume(scriptClient(settle), LIMIT, 'caller-view');
      const error = failed._unsafeUnwrapErr();
      met.push(rateLimitFailureOf(error));
      expect(STATUS_BY_DOMAIN_CODE[error.code]).toBe(503);
      expect(domainWireCode(error)).toBe('UNAVAILABLE');
      expect(error.wireCode).toBeUndefined();
    }
    // Four distinct diagnoses behind one refusal is the whole point.
    expect(new Set(met).size).toBe(4);
  });
});

describe('the counter key', () => {
  it('carries the keyed digest of an email in place of the email', async () => {
    const { rateLimitKey } = await freshConsume();
    const { hmacRateLimitId } = await import('./key-secret.js');

    expect(rateLimitKey(LIMIT, 'carol@hushbox.ai')._unsafeUnwrap()).toBe(
      LIMIT.buildKey(hmacRateLimitId('carol@hushbox.ai'))
    );
  });

  it('names no part of the identifier it was given', async () => {
    const { rateLimitKey } = await freshConsume();

    expect(rateLimitKey(LIMIT, 'a@a.aa')._unsafeUnwrap()).toMatch(
      /^test:rate-limit:consume:[\da-f]{64}$/
    );
  });
});
