// Imported through the hmac subpath: the workerd test project runs this module
// unbundled, and there the crypto barrel's `@cloudflare/voprf-ts` dependency
// throws on load.
import { hmacSha256Hex } from '@hushbox/crypto/hmac';
import { createKeyedSecret } from '../context/keyed-secret.js';
import { canonicalJson } from './canonical-json.js';

/** The registry entry this module reads, in whatever record carries it. */
export interface IdempotencyBodyHashSecretEnv {
  readonly IDEMPOTENCY_BODY_HASH_SECRET?: string | undefined;
}

/**
 * The key every stored `bodyHash` is an HMAC under. A chat turn's body carries
 * its plaintext beside fields the database also holds, so an unkeyed digest
 * would let whoever reads the table test guesses of what a user wrote. Held at
 * module scope because some code that computes the hash takes no env (`byKey`
 * and the admin op engine among it).
 */
const secret = createKeyedSecret({
  entry: 'IDEMPOTENCY_BODY_HASH_SECRET',
  configurer: 'configureIdempotencyBodyHashSecret',
});

/** Puts the isolate's body-hash key in force from the environment that carries it. */
export function configureIdempotencyBodyHashSecret(env: IdempotencyBodyHashSecretEnv): void {
  secret.configure(env);
}

/**
 * The stored `bodyHash`: HMAC-SHA-256 hex of the canonical body, so reordering
 * the body's object keys never reads as a different body. Throws when nothing has
 * configured the key, because an unkeyed hash is the defect this exists to
 * close.
 */
export function hashRequestBody(body: unknown): string {
  return hmacSha256Hex(secret.read(), canonicalJson(body));
}
