import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { envConfig, Mode, resolveRaw } from './env.config.ts';

/**
 * Redis isolation between stack modes is a property of the CONNECTION, never of
 * a key. Every client — production site and integration test alike — takes its
 * endpoint and bearer token from this registry, and no single choke point mints
 * every key, so the token is the only lever that reaches all of them at once.
 * The local Serverless-Redis-HTTP container fronts one logical Redis database
 * per token (`docker/srh-tokens.json`), which is what makes this observable.
 *
 * This suite needs the local stack, which is what `pnpm test` brings up.
 */

function requireRestUrl(): string {
  const url = process.env['UPSTASH_REDIS_REST_URL'];
  if (url === undefined || url === '') {
    throw new Error(
      'UPSTASH_REDIS_REST_URL is required for the Redis mode-isolation test — run through `tsx scripts/with-env.ts`, which is what loads the env files'
    );
  }
  return url;
}

const REST_URL = requireRestUrl();

function tokenFor(mode: Mode): string {
  const raw = resolveRaw(envConfig.UPSTASH_REDIS_REST_TOKEN, mode);
  if (typeof raw !== 'string') {
    throw new TypeError(`UPSTASH_REDIS_REST_TOKEN resolves to no local literal in mode "${mode}"`);
  }
  return raw;
}

/** One Upstash-REST command on the connection the bearer token selects. */
async function command(token: string, argv: readonly string[]): Promise<unknown> {
  const response = await fetch(REST_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(argv),
  });
  const body = (await response.json()) as { result?: unknown; error?: string };
  if (!response.ok || body.error !== undefined) {
    throw new Error(
      `Redis REST command ${argv[0] ?? ''} failed with ${String(response.status)}: ${body.error ?? 'no error body'}`
    );
  }
  return body.result;
}

describe('Redis isolation between stack modes', () => {
  it('hides a key written on one mode connection from every other mode', async () => {
    const key = `mode-isolation-probe:${randomUUID()}`;
    const development = tokenFor(Mode.Development);

    // Expiring, like every key the key registry mints: the `finally` below removes it
    // on every path this process controls, and the TTL covers the one it does not.
    await command(development, ['SET', key, 'written-on-the-development-connection', 'EX', '60']);
    try {
      await expect(command(development, ['GET', key])).resolves.toBe(
        'written-on-the-development-connection'
      );
      await expect(command(tokenFor(Mode.Test), ['GET', key])).resolves.toBeNull();
      await expect(command(tokenFor(Mode.CiVitest), ['GET', key])).resolves.toBeNull();
      await expect(command(tokenFor(Mode.E2E), ['GET', key])).resolves.toBeNull();
    } finally {
      await command(development, ['DEL', key]);
    }
  });
});
