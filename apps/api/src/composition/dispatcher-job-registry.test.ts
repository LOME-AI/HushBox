import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDispatcherRedis } from './dispatcher-job-registry.js';
import type { DomainError } from '../lib/errors/index.js';
import type { Bindings } from '../lib/context/app-env.js';

/**
 * The dispatcher env reduced to the credentials the Redis client is opened
 * from. The deadline that client runs under is not in here: it arrives from
 * `apps/api/src/test-support/rate-limit-bound.setup.ts`, which puts the mode's
 * registry entry in force for every test process. No round trip reaches this
 * endpoint: every test here stands a stub in for `fetch`, so the client's own
 * transport is what answers or refuses to.
 */
const env: Bindings = {
  NODE_ENV: 'development',
  UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
  UPSTASH_REDIS_REST_TOKEN: 'token',
};

/**
 * The endpoint's own shape, as `apps/api/src/lib/resilience/bounded-redis.test.ts`
 * states it: the client pipelines, so it posts an array of commands and reads
 * back one base64-encoded result per command. Recording the posted bodies is
 * what makes "issued together, travelled together" observable rather than
 * asserted.
 */
function answeringFetch(value: string): {
  readonly fetch: typeof globalThis.fetch;
  readonly bodies: string[];
} {
  const bodies: string[] = [];
  const stub: typeof globalThis.fetch = (_input, init) => {
    const body = init?.body;
    if (typeof body !== 'string') {
      throw new TypeError('the client posts its pipeline as a JSON string');
    }
    bodies.push(body);
    const commands = JSON.parse(body) as unknown[];
    return Promise.resolve(Response.json(commands.map(() => ({ result: btoa(value) }))));
  };
  return { fetch: stub, bodies };
}

/** A store that accepts the request and never answers it. */
function neverAnsweringFetch(): typeof globalThis.fetch {
  return () => new Promise<Response>(() => {});
}

async function caughtError(work: Promise<unknown>): Promise<DomainError> {
  const rejection = await work.then(
    () => undefined,
    (error: unknown) => error as DomainError
  );
  if (rejection === undefined) throw new Error('expected the round trip to reject');
  return rejection;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('openDispatcherRedis', () => {
  it('ends a round trip the store never answers, rather than waiting forever', async () => {
    vi.stubGlobal('fetch', neverAnsweringFetch());
    const redis = openDispatcherRedis(env);

    const error = await caughtError(redis.get('key'));

    expect(error.code).toBe('timeout');
  });

  it('still batches commands issued together into one round trip', async () => {
    const { fetch, bodies } = answeringFetch('stored');
    vi.stubGlobal('fetch', fetch);
    const redis = openDispatcherRedis(env);

    await Promise.all([redis.get('one'), redis.get('two')]);

    expect(bodies).toEqual([
      JSON.stringify([
        ['get', 'one'],
        ['get', 'two'],
      ]),
    ]);
  });
});
