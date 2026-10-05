import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hmacSha256Hex } from '@hushbox/crypto';
import type { configureRateLimitKeySecret, hmacRateLimitId } from './key-secret.js';

/**
 * Every case needs a module that nothing has configured yet, and the key is
 * write-once by design — so each one takes a fresh module registry rather than
 * a reset hook the module deliberately does not offer.
 */
async function freshModule(): Promise<{
  configureRateLimitKeySecret: typeof configureRateLimitKeySecret;
  hmacRateLimitId: typeof hmacRateLimitId;
}> {
  vi.resetModules();
  return await import('./key-secret.js');
}

const KEY = `key-${crypto.randomUUID()}`;

describe('the rate-limit identifier key', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('keys an identifier under the configured secret', async () => {
    const keyed = await freshModule();
    keyed.configureRateLimitKeySecret({ RATE_LIMIT_KEY_SECRET: KEY });
    expect(keyed.hmacRateLimitId('carol@hushbox.ai')).toBe(hmacSha256Hex(KEY, 'carol@hushbox.ai'));
  });

  it('reads its key from the RATE_LIMIT_KEY_SECRET entry', async () => {
    const keyed = await freshModule();
    expect(() => {
      keyed.configureRateLimitKeySecret({});
    }).toThrow(/RATE_LIMIT_KEY_SECRET is missing/);
  });

  it('names its configurer when nothing has configured the key', async () => {
    const keyed = await freshModule();
    expect(() => keyed.hmacRateLimitId('carol@hushbox.ai')).toThrow(/configureRateLimitKeySecret/);
  });
});
