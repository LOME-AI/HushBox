import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionRevokeEnqueueRegistration } from './billing-bindings.js';
import type { JobExecution, JobOutcome, OneShotJobRegistration } from '../../lib/jobs/index.js';

/**
 * The webhook env reduced to the credentials the enqueue-side registration
 * opens its Redis client from. The deadline that client runs under is not in
 * here: it arrives from `apps/api/src/test-support/rate-limit-bound.setup.ts`,
 * which puts the mode's registry entry in force for every test process. No
 * round trip reaches this endpoint: every test here stands a stub in for
 * `fetch`, so the client's own transport is what answers or refuses to.
 */
const env = {
  NODE_ENV: 'development',
  UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
  UPSTASH_REDIS_REST_TOKEN: 'token',
} as const;

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

/**
 * The registration's own handler, over the client this composition site built.
 * No production caller puts a command through that client: the dispatcher runs
 * the handler from its own registry. Invoking the handler here is what makes
 * this site's client carry the watermark bump at all, and so the only way its
 * bound becomes observable.
 */
function revokeHandler(): OneShotJobRegistration['handler'] {
  const registration = createSessionRevokeEnqueueRegistration(env);
  if (registration.kind !== 'oneShot') {
    throw new Error('session.revoke.v1 is a one-shot registration');
  }
  return registration.handler;
}

function executionFor(userId: string): JobExecution<unknown> {
  return {
    jobId: crypto.randomUUID(),
    payload: { userId },
    claims: 1,
    completeWithinTx: () => Promise.reject(new Error('completeWithinTx unexpectedly invoked')),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createSessionRevokeEnqueueRegistration', () => {
  it('ends a watermark bump the store never answers, rather than waiting forever', async () => {
    vi.stubGlobal('fetch', neverAnsweringFetch());
    const handler = revokeHandler();

    const outcome: JobOutcome = await handler(executionFor(crypto.randomUUID()));

    expect(outcome).toEqual({ kind: 'fail', error: 'unavailable' });
  });

  it('still batches commands issued together into one round trip', async () => {
    const { fetch, bodies } = answeringFetch('OK');
    vi.stubGlobal('fetch', fetch);
    const handler = revokeHandler();

    const first = handler(executionFor(crypto.randomUUID()));
    const second = handler(executionFor(crypto.randomUUID()));
    await Promise.all([first, second]);

    expect(bodies).toHaveLength(1);
    const batched = JSON.parse(bodies[0] ?? '[]') as readonly (readonly unknown[])[];
    expect(batched.map((command) => command[0])).toEqual(['set', 'set']);
  });
});
