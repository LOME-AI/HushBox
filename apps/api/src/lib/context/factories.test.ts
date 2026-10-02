import { describe, it, expect, vi } from 'vitest';
import { Redis } from '@upstash/redis';
import { expectExposes } from '@hushbox/shared/test-assertions';
import { createRequestDb, createRequestRedis } from './factories.js';
import type { RequiredBindings } from './app-env.js';

const bindings: RequiredBindings = {
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/hushbox',
  UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
  UPSTASH_REDIS_REST_TOKEN: 'token',
  IRON_SESSION_SECRET: 'secret-at-least-32-characters-long!!',
};

describe('createRequestDb', () => {
  /**
   * Both arms return a client of the same shape. The dev arm additionally writes
   * the local neon-proxy settings onto the neon driver's module-global config,
   * which is the only mark the choice leaves — and `@neondatabase/serverless` is
   * not a dependency of this package, so nothing reachable here tells the arms
   * apart. The contract asserted, and claimed, is therefore the shared shape.
   */
  it('exposes select from both the dev and the non-dev arm', () => {
    expectExposes(createRequestDb(bindings, { isDev: true }), 'select');
    expectExposes(createRequestDb(bindings, { isDev: false }), 'select');
  });

  it('returns a fresh client per call (no module-level singleton)', () => {
    expect(createRequestDb(bindings, { isDev: true })).not.toBe(
      createRequestDb(bindings, { isDev: true })
    );
  });
});

describe('createRequestRedis', () => {
  it('returns a Redis client', () => {
    expect(createRequestRedis(bindings)).toBeInstanceOf(Redis);
  });

  it('returns a fresh client per call (no module-level singleton)', () => {
    expect(createRequestRedis(bindings)).not.toBe(createRequestRedis(bindings));
  });

  it('takes its round-trip bound from the entry the isolate put in force', async () => {
    // A fresh module registry is an isolate that has configured nothing. The
    // bound is per-mode registry data, so a client built there has no value to
    // run under and says which entry is missing; a constant held in this tree
    // would build one regardless.
    vi.resetModules();
    const unconfigured = await import('./factories.js');

    expect(() => unconfigured.createRequestRedis(bindings)).toThrow('RATE_LIMIT_REDIS_TIMEOUT_MS');
  });

  it('answers a failed round trip with a typed domain error, not the raw client error', async () => {
    // The store answers, and its answer is a failure. An unbounded client
    // throws its own `UpstashError`, which carries no taxonomy code; only a
    // client built through the policy factory translates it, so this is what
    // distinguishes the two without waiting out a deadline.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (): Promise<Response> =>
          Promise.resolve(Response.json({ error: 'store refused' }, { status: 500 }))
      )
    );
    try {
      await expect(createRequestRedis(bindings).get('key')).rejects.toMatchObject({
        code: 'unavailable',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
