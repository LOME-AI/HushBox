// The narrow subpath, not the package barrel: every rate-limited graph loads this
// module, and the barrel pulls a library that throws when workerd loads it.
import { hmacSha256Hex } from '@hushbox/crypto/hmac';

/** The registry entry this module reads, in whatever record carries it. */
export interface RateLimitKeySecretEnv {
  readonly RATE_LIMIT_KEY_SECRET?: string | undefined;
}

const ENTRY = 'RATE_LIMIT_KEY_SECRET';

/**
 * The key every rate-limit identifier is HMACed under before it names a Redis
 * key, so the store never holds an email, a login identifier or a token, and an
 * unkeyed digest of one cannot be reversed against a dictionary by whoever
 * reads the keyspace.
 *
 * Held at module scope and write-once for the reasons the Redis bound beside it
 * is (`lib/rate-limit/bound.ts`): the counter is reached from slice domains
 * that carry no env, and one isolate serves one mode, so a second, different
 * key is a composition defect rather than a reconfiguration.
 */
let secret: string | undefined;

function readSecret(env: RateLimitKeySecretEnv): string {
  const raw = env.RATE_LIMIT_KEY_SECRET;
  if (raw === undefined || raw === '') {
    throw new Error(
      `${ENTRY} is missing: every mode declares it in the env registry — ` +
        'set it in wrangler config / .dev.vars rather than falling back to a literal.'
    );
  }
  return raw;
}

/**
 * Puts the isolate's identifier key in force from the environment that carries
 * it, at every entry that puts the Redis bound in force. A repeat is a no-op;
 * a disagreement throws, naming neither value. An env carrying no entry can
 * only establish the key, never contradict one, exactly as the bound's
 * configuration reads it.
 */
export function configureRateLimitKeySecret(env: RateLimitKeySecretEnv): void {
  if (secret === undefined) {
    secret = readSecret(env);
    return;
  }
  const raw = env.RATE_LIMIT_KEY_SECRET;
  if (raw === undefined || raw === '') return;
  if (raw !== secret) {
    throw new Error(
      `${ENTRY} disagrees with the key already in force — one process serves one mode, so two ` +
        'values is a composition defect.'
    );
  }
}

/**
 * The keyed digest a counter key carries in place of the identifier: 64 hex
 * characters, so it also carries no key delimiter. Throws when nothing has
 * configured the key, because a counter keyed on the raw identifier is the
 * defect this exists to close.
 */
export function hmacRateLimitId(id: string): string {
  if (secret === undefined) {
    throw new Error(
      `rate limit identifier key is not configured: ${ENTRY} reaches this module through ` +
        'configureRateLimitKeySecret, which every isolate entry calls before any counter check.'
    );
  }
  return hmacSha256Hex(secret, id);
}
