import { describe, expect, it } from 'vitest';
import {
  scriptedRateLimitRedis,
  unreachableRateLimitRedis,
} from '../../../test-support/rate-limit-double.js';
import {
  CHAT_GUEST_SEND_IP_RATE_LIMIT,
  CHAT_STOP_IP_RATE_LIMIT,
  CHAT_STREAM_USER_RATE_LIMIT,
  CHAT_TRIAL_SEND_IP_RATE_LIMIT,
  consumeChatStreamUserLimit,
  consumeTrialSendIpLimit,
} from './rate-limit.js';
import { rateLimitKey } from '../../../lib/rate-limit/index.js';

describe('the chat slice registry entries', () => {
  it('caps a paid chat send at 30 per 60-second window per key', () => {
    expect(CHAT_STREAM_USER_RATE_LIMIT).toMatchObject({
      kind: 'throttle',
      maxAttempts: 30,
      windowSeconds: 60,
    });
    expect(CHAT_STREAM_USER_RATE_LIMIT.buildKey('u-1')).toBe('ratelimit:chat:stream:user:u-1');
  });

  it('caps each per-IP surface at 120 per 60-second window under its own key', () => {
    for (const entry of [
      CHAT_GUEST_SEND_IP_RATE_LIMIT,
      CHAT_STOP_IP_RATE_LIMIT,
      CHAT_TRIAL_SEND_IP_RATE_LIMIT,
    ]) {
      expect(entry).toMatchObject({ kind: 'throttle', maxAttempts: 120, windowSeconds: 60 });
    }
    const keys = [
      CHAT_GUEST_SEND_IP_RATE_LIMIT.buildKey('ip'),
      CHAT_STOP_IP_RATE_LIMIT.buildKey('ip'),
      CHAT_TRIAL_SEND_IP_RATE_LIMIT.buildKey('ip'),
    ];
    expect(new Set(keys).size).toBe(3);
  });
});

/**
 * These wrappers exist to bind one entry to one identifier; the counting they
 * delegate to is measured against real Redis in
 * `lib/rate-limit/consume.integration.test.ts`. So what is pinned here is the
 * binding — which key each spends — and the fail-closed surface.
 */
describe('the chat slice limiters', () => {
  it('spends the paid-send entry under the identifier it is given', async () => {
    const { redis, keys } = scriptedRateLimitRedis();
    const decision = await consumeChatStreamUserLimit(redis, 'user-7');
    expect(decision._unsafeUnwrap().allowed).toBe(true);
    expect(keys).toEqual([rateLimitKey(CHAT_STREAM_USER_RATE_LIMIT, 'user-7')._unsafeUnwrap()]);
  });

  it('spends the trial entry under the hashed caller IP', async () => {
    const { redis, keys } = scriptedRateLimitRedis();
    const decision = await consumeTrialSendIpLimit(redis, 'ip-hash');
    expect(decision._unsafeUnwrap().allowed).toBe(true);
    expect(keys).toEqual([rateLimitKey(CHAT_TRIAL_SEND_IP_RATE_LIMIT, 'ip-hash')._unsafeUnwrap()]);
  });

  it('carries the retry window through a refusal', async () => {
    const { redis } = scriptedRateLimitRedis(['refused:1:31:42']);
    const decision = await consumeChatStreamUserLimit(redis, 'user');
    expect(decision._unsafeUnwrap()).toEqual({ allowed: false, count: 31, retryAfterSeconds: 42 });
  });

  it('fails closed (unavailable) when Redis is down', async () => {
    const result = await consumeChatStreamUserLimit(unreachableRateLimitRedis(), 'user');
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});
