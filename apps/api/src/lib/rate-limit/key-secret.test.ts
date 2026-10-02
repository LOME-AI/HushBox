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

  it('refuses to key before anything has configured it', async () => {
    const keyed = await freshModule();
    expect(() => keyed.hmacRateLimitId('carol@hushbox.ai')).toThrow(/not configured/);
  });

  it('accepts a repeat of the key already in force', async () => {
    const keyed = await freshModule();
    keyed.configureRateLimitKeySecret({ RATE_LIMIT_KEY_SECRET: KEY });
    keyed.configureRateLimitKeySecret({ RATE_LIMIT_KEY_SECRET: KEY });
    expect(keyed.hmacRateLimitId('a')).toBe(hmacSha256Hex(KEY, 'a'));
  });

  it('refuses a second key that disagrees with the one in force', async () => {
    const keyed = await freshModule();
    keyed.configureRateLimitKeySecret({ RATE_LIMIT_KEY_SECRET: KEY });
    expect(() => {
      keyed.configureRateLimitKeySecret({ RATE_LIMIT_KEY_SECRET: `${KEY}-other` });
    }).toThrow(/disagrees/);
  });

  it('names neither key when two disagree', async () => {
    const keyed = await freshModule();
    keyed.configureRateLimitKeySecret({ RATE_LIMIT_KEY_SECRET: KEY });
    expect(() => {
      keyed.configureRateLimitKeySecret({ RATE_LIMIT_KEY_SECRET: `${KEY}-other` });
    }).toThrow(expect.objectContaining({ message: expect.not.stringContaining(KEY) }));
  });

  it('takes no key from an env that carries no entry', async () => {
    const keyed = await freshModule();
    keyed.configureRateLimitKeySecret({ RATE_LIMIT_KEY_SECRET: KEY });
    keyed.configureRateLimitKeySecret({});
    expect(keyed.hmacRateLimitId('a')).toBe(hmacSha256Hex(KEY, 'a'));
  });

  it('fails fast when the registry entry is absent', async () => {
    const keyed = await freshModule();
    expect(() => {
      keyed.configureRateLimitKeySecret({});
    }).toThrow(/RATE_LIMIT_KEY_SECRET/);
  });

  it('fails fast when the registry entry is empty', async () => {
    const keyed = await freshModule();
    expect(() => {
      keyed.configureRateLimitKeySecret({ RATE_LIMIT_KEY_SECRET: '' });
    }).toThrow(/RATE_LIMIT_KEY_SECRET/);
  });
});
