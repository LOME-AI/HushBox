// The narrow subpath, not the package barrel: every idempotent route's graph
// loads this module, and the barrel pulls a library that throws when workerd
// loads it.
import { hmacSha256Hex } from '@hushbox/crypto/hmac';
import { canonicalJson } from './canonical-json.js';

/** The registry entry this module reads, in whatever record carries it. */
export interface IdempotencyBodyHashSecretEnv {
  readonly IDEMPOTENCY_BODY_HASH_SECRET?: string | undefined;
}

const ENTRY = 'IDEMPOTENCY_BODY_HASH_SECRET';

/**
 * The key every stored `bodyHash` is an HMAC under. A chat turn's body carries
 * its plaintext, and the rest of what it hashes is readable beside the row, so
 * an unkeyed digest would let whoever reads the table confirm guesses of what a
 * user wrote.
 *
 * Held at module scope and write-once for the reason the rate-limit identifier
 * key is (`lib/rate-limit/key-secret.ts`): the hash is reached from route and
 * engine code that carries no env, and one isolate serves one mode, so a
 * second, different key is a composition defect rather than a
 * reconfiguration.
 */
let secret: string | undefined;

function readSecret(env: IdempotencyBodyHashSecretEnv): string {
  const raw = env.IDEMPOTENCY_BODY_HASH_SECRET;
  if (raw === undefined || raw === '') {
    throw new Error(
      `${ENTRY} is missing: every mode declares it in the env registry — ` +
        'set it in wrangler config / .dev.vars rather than falling back to a literal.'
    );
  }
  return raw;
}

/**
 * Puts the isolate's body-hash key in force from the environment that carries
 * it. A repeat is a no-op; a disagreement throws, naming neither value. An env
 * carrying no entry can only establish the key, never contradict one.
 */
export function configureIdempotencyBodyHashSecret(env: IdempotencyBodyHashSecretEnv): void {
  if (secret === undefined) {
    secret = readSecret(env);
    return;
  }
  const raw = env.IDEMPOTENCY_BODY_HASH_SECRET;
  if (raw === undefined || raw === '') return;
  if (raw !== secret) {
    throw new Error(
      `${ENTRY} disagrees with the key already in force — one process serves one mode, so two ` +
        'values is a composition defect.'
    );
  }
}

/**
 * The stored `bodyHash`: HMAC-SHA-256 hex of the canonical body, so key
 * reordering never reads as a different body. Throws when nothing has
 * configured the key, because an unkeyed hash is the defect this exists to
 * close.
 */
export function hashRequestBody(body: unknown): string {
  if (secret === undefined) {
    throw new Error(
      `idempotency body hash key is not configured: ${ENTRY} reaches this module through ` +
        'configureIdempotencyBodyHashSecret, which the bindings stage calls before any handler.'
    );
  }
  return hmacSha256Hex(secret, canonicalJson(body));
}
