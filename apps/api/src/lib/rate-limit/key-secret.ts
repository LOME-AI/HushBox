// Imported through the hmac subpath: the workerd test project runs this module
// unbundled, and there the crypto barrel's `@cloudflare/voprf-ts` dependency
// throws on load.
import { hmacSha256Hex } from '@hushbox/crypto/hmac';
import { createKeyedSecret } from '../context/keyed-secret.js';

/** The registry entry this module reads, in whatever record carries it. */
export interface RateLimitKeySecretEnv {
  readonly RATE_LIMIT_KEY_SECRET?: string | undefined;
}

/**
 * The key every rate-limit identifier is HMACed under before it names a Redis
 * key, so the store never holds an email, a login identifier or a token, and an
 * unkeyed digest of one cannot be reversed against a dictionary by whoever
 * reads the keyspace. Held at module scope, as the Redis bound beside it is
 * (`lib/rate-limit/bound.ts`), because the counter is reached from slice
 * domains that carry no env.
 */
const secret = createKeyedSecret({
  entry: 'RATE_LIMIT_KEY_SECRET',
  configurer: 'configureRateLimitKeySecret',
});

/**
 * Puts the isolate's identifier key in force from the environment that carries
 * it, at every entry that puts the Redis bound in force.
 */
export function configureRateLimitKeySecret(env: RateLimitKeySecretEnv): void {
  secret.configure(env);
}

/**
 * The keyed digest a counter key carries in place of the identifier: 64 hex
 * characters, so it also carries no key delimiter. Throws when nothing has
 * configured the key, because a counter keyed on the raw identifier is the
 * defect this exists to close.
 */
export function hmacRateLimitId(id: string): string {
  return hmacSha256Hex(secret.read(), id);
}
