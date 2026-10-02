import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { configureRateLimitBound, rateLimitBound } from './bound.js';

/**
 * Every case needs a module that nothing has configured yet, and the bound is
 * write-once by design — so each one takes a fresh module registry rather than
 * a reset hook the module deliberately does not offer.
 */
async function freshModule(): Promise<{
  configureRateLimitBound: typeof configureRateLimitBound;
  rateLimitBound: typeof rateLimitBound;
}> {
  vi.resetModules();
  return await import('./bound.js');
}

describe('the rate-limit Redis bound', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('reads its value from the registry entry', async () => {
    const bound = await freshModule();
    bound.configureRateLimitBound({ RATE_LIMIT_REDIS_TIMEOUT_MS: '250' });
    expect(bound.rateLimitBound().timeoutMs).toBe(250);
  });

  it('refuses to answer before anything has configured it', async () => {
    const bound = await freshModule();
    expect(() => bound.rateLimitBound()).toThrow(/not configured/);
  });

  it('accepts a repeat of the value already in force', async () => {
    const bound = await freshModule();
    bound.configureRateLimitBound({ RATE_LIMIT_REDIS_TIMEOUT_MS: '250' });
    bound.configureRateLimitBound({ RATE_LIMIT_REDIS_TIMEOUT_MS: '250' });
    expect(bound.rateLimitBound().timeoutMs).toBe(250);
  });

  it('keeps the running policy across a repeat rather than replacing it', async () => {
    const bound = await freshModule();
    bound.configureRateLimitBound({ RATE_LIMIT_REDIS_TIMEOUT_MS: '250' });
    const first = bound.rateLimitBound().runner;
    bound.configureRateLimitBound({ RATE_LIMIT_REDIS_TIMEOUT_MS: '250' });
    expect(bound.rateLimitBound().runner).toBe(first);
  });

  it('refuses a second value that disagrees with the one in force', async () => {
    const bound = await freshModule();
    bound.configureRateLimitBound({ RATE_LIMIT_REDIS_TIMEOUT_MS: '250' });
    expect(() => {
      bound.configureRateLimitBound({ RATE_LIMIT_REDIS_TIMEOUT_MS: '5000' });
    }).toThrow(/250.*5000|5000.*250/);
  });

  // An env with no entry states no value, so it cannot disagree with one. The
  // missing-entry fail-fast belongs to the first caller, and every runtime has
  // one; a later caller lacking what an earlier one carried is a test fixture,
  // never a deployment, since one deployment's roots read one env record.
  it('takes no value from an env that carries no entry', async () => {
    const bound = await freshModule();
    bound.configureRateLimitBound({ RATE_LIMIT_REDIS_TIMEOUT_MS: '250' });
    bound.configureRateLimitBound({});
    expect(bound.rateLimitBound().timeoutMs).toBe(250);
  });

  it('answers the same runner every time, so one policy serves the isolate', async () => {
    const bound = await freshModule();
    bound.configureRateLimitBound({ RATE_LIMIT_REDIS_TIMEOUT_MS: '250' });
    expect(bound.rateLimitBound().runner).toBe(bound.rateLimitBound().runner);
  });

  it('fails fast when the registry entry is absent', async () => {
    const bound = await freshModule();
    expect(() => {
      bound.configureRateLimitBound({});
    }).toThrow(/RATE_LIMIT_REDIS_TIMEOUT_MS/);
  });

  it('fails fast when the value is not a number', async () => {
    const bound = await freshModule();
    expect(() => {
      bound.configureRateLimitBound({ RATE_LIMIT_REDIS_TIMEOUT_MS: 'soon' });
    }).toThrow(/RATE_LIMIT_REDIS_TIMEOUT_MS/);
  });

  it('fails fast on a value no wait can be bounded by', async () => {
    const bound = await freshModule();
    expect(() => {
      bound.configureRateLimitBound({ RATE_LIMIT_REDIS_TIMEOUT_MS: '0' });
    }).toThrow(/RATE_LIMIT_REDIS_TIMEOUT_MS/);
  });

  it('fails fast on a fractional millisecond', async () => {
    const bound = await freshModule();
    expect(() => {
      bound.configureRateLimitBound({ RATE_LIMIT_REDIS_TIMEOUT_MS: '250.5' });
    }).toThrow(/RATE_LIMIT_REDIS_TIMEOUT_MS/);
  });
});
