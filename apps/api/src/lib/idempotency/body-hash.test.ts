import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hmacSha256Hex } from '@hushbox/crypto';
import { canonicalJson, hashCanonicalJson } from './canonical-json.js';
import type { configureIdempotencyBodyHashSecret, hashRequestBody } from './body-hash.js';

/**
 * Every case needs a module nothing has configured yet, and the key is
 * write-once by design, so each one takes a fresh module registry rather than
 * a reset hook the module deliberately does not offer.
 */
async function freshModule(): Promise<{
  configureIdempotencyBodyHashSecret: typeof configureIdempotencyBodyHashSecret;
  hashRequestBody: typeof hashRequestBody;
}> {
  vi.resetModules();
  return await import('./body-hash.js');
}

const KEY = `key-${crypto.randomUUID()}`;
const BODY = { userMessage: 'yes', history: [{ role: 'user', content: 'a name' }] };

describe('the idempotency body hash', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('is the HMAC of the canonical body under the configured secret', async () => {
    const keyed = await freshModule();
    keyed.configureIdempotencyBodyHashSecret({ IDEMPOTENCY_BODY_HASH_SECRET: KEY });
    expect(keyed.hashRequestBody(BODY)).toBe(hmacSha256Hex(KEY, canonicalJson(BODY)));
  });

  it('differs from the unkeyed digest of the same body', async () => {
    const keyed = await freshModule();
    keyed.configureIdempotencyBodyHashSecret({ IDEMPOTENCY_BODY_HASH_SECRET: KEY });
    expect(keyed.hashRequestBody(BODY)).not.toBe(await hashCanonicalJson(BODY));
  });

  it('differs under a different secret', async () => {
    const keyed = await freshModule();
    keyed.configureIdempotencyBodyHashSecret({ IDEMPOTENCY_BODY_HASH_SECRET: KEY });
    expect(keyed.hashRequestBody(BODY)).not.toBe(
      hmacSha256Hex(`${KEY}-other`, canonicalJson(BODY))
    );
  });

  it('hashes reordered keys identically', async () => {
    const keyed = await freshModule();
    keyed.configureIdempotencyBodyHashSecret({ IDEMPOTENCY_BODY_HASH_SECRET: KEY });
    expect(keyed.hashRequestBody({ a: 1, b: [{ d: 2, c: 3 }] })).toBe(
      keyed.hashRequestBody({ b: [{ c: 3, d: 2 }], a: 1 })
    );
  });

  it('refuses to hash before anything has configured the secret', async () => {
    const keyed = await freshModule();
    expect(() => keyed.hashRequestBody(BODY)).toThrow(/not configured/);
  });

  it('accepts a repeat of the secret already in force', async () => {
    const keyed = await freshModule();
    keyed.configureIdempotencyBodyHashSecret({ IDEMPOTENCY_BODY_HASH_SECRET: KEY });
    keyed.configureIdempotencyBodyHashSecret({ IDEMPOTENCY_BODY_HASH_SECRET: KEY });
    expect(keyed.hashRequestBody(BODY)).toBe(hmacSha256Hex(KEY, canonicalJson(BODY)));
  });

  it('refuses a second secret that disagrees with the one in force', async () => {
    const keyed = await freshModule();
    keyed.configureIdempotencyBodyHashSecret({ IDEMPOTENCY_BODY_HASH_SECRET: KEY });
    expect(() => {
      keyed.configureIdempotencyBodyHashSecret({ IDEMPOTENCY_BODY_HASH_SECRET: `${KEY}-other` });
    }).toThrow(/disagrees/);
  });

  it('names neither secret when two disagree', async () => {
    const keyed = await freshModule();
    keyed.configureIdempotencyBodyHashSecret({ IDEMPOTENCY_BODY_HASH_SECRET: KEY });
    expect(() => {
      keyed.configureIdempotencyBodyHashSecret({ IDEMPOTENCY_BODY_HASH_SECRET: `${KEY}-other` });
    }).toThrow(expect.objectContaining({ message: expect.not.stringContaining(KEY) }));
  });

  it('takes no secret from an env that carries no entry', async () => {
    const keyed = await freshModule();
    keyed.configureIdempotencyBodyHashSecret({ IDEMPOTENCY_BODY_HASH_SECRET: KEY });
    keyed.configureIdempotencyBodyHashSecret({});
    expect(keyed.hashRequestBody(BODY)).toBe(hmacSha256Hex(KEY, canonicalJson(BODY)));
  });

  it('fails fast when the registry entry is absent', async () => {
    const keyed = await freshModule();
    expect(() => {
      keyed.configureIdempotencyBodyHashSecret({});
    }).toThrow(/IDEMPOTENCY_BODY_HASH_SECRET/);
  });

  it('fails fast when the registry entry is empty', async () => {
    const keyed = await freshModule();
    expect(() => {
      keyed.configureIdempotencyBodyHashSecret({ IDEMPOTENCY_BODY_HASH_SECRET: '' });
    }).toThrow(/IDEMPOTENCY_BODY_HASH_SECRET/);
  });
});
