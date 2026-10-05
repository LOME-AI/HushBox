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

  it('reads its key from the IDEMPOTENCY_BODY_HASH_SECRET entry', async () => {
    const keyed = await freshModule();
    expect(() => {
      keyed.configureIdempotencyBodyHashSecret({});
    }).toThrow(/IDEMPOTENCY_BODY_HASH_SECRET is missing/);
  });

  it('names its configurer when nothing has configured the key', async () => {
    const keyed = await freshModule();
    expect(() => keyed.hashRequestBody(BODY)).toThrow(/configureIdempotencyBodyHashSecret/);
  });
});
