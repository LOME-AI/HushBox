// GET /chat/trial/websocket: the per-IP window that bounds anonymous upgrades.
import { afterAll, describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { callerIpIdForAddress } from '../../lib/redis/index.js';
import { getPath, recordingUpgrade } from '../../test-support/chat-routes.integration.setup.js';
import { CHAT_TRIAL_WEBSOCKET_IP_RATE_LIMIT } from './domain/index.js';
import { rateLimitKey } from '../../lib/rate-limit/index.js';

/**
 * The trial's send path is quota-gated; the upgrade is not, so this window is
 * the only thing between an anonymous caller and unbounded Durable Object
 * connections. It is proven through the assembled pipeline because that is
 * where the counting has to happen — ahead of the upgrade, or the connection
 * is already issued when the refusal lands.
 */

const redis = new Redis({
  url: process.env['UPSTASH_REDIS_REST_URL'] ?? '',
  token: process.env['UPSTASH_REDIS_REST_TOKEN'] ?? '',
});

const keysToClean: string[] = [];

afterAll(async () => {
  for (const key of keysToClean) await redis.del(key);
});

/** A fresh address per test, so no window here is one another test spends. */
async function freshAddress(): Promise<string> {
  const address = `198.51.100.${String(Math.floor(Math.random() * 255))}-${crypto.randomUUID()}`;
  keysToClean.push(
    rateLimitKey(
      CHAT_TRIAL_WEBSOCKET_IP_RATE_LIMIT,
      await callerIpIdForAddress(address)
    )._unsafeUnwrap()
  );
  return address;
}

describe('chat route: GET /chat/trial/websocket per-IP throttle', () => {
  it('refuses the upgrade past the cap from one address', async () => {
    const { calls, realtime } = recordingUpgrade();
    const ip = await freshAddress();
    const headers = { 'cf-connecting-ip': ip };
    const { maxAttempts } = CHAT_TRIAL_WEBSOCKET_IP_RATE_LIMIT;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const admitted = await getPath('/chat/trial/websocket', realtime, headers);
      expect(admitted.status).not.toBe(429);
    }

    const refused = await getPath('/chat/trial/websocket', realtime, headers);
    expect(refused.status).toBe(429);
    // The refusal lands BEFORE the upgrade: an over-cap caller buys no
    // connection, which is the whole point of capping this route.
    expect(calls).toHaveLength(maxAttempts);
  });
});
