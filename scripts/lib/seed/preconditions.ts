/**
 * Every refusal the seed makes before it writes anything, and the runtime
 * clients and secrets it opens.
 */

import { Redis } from '@upstash/redis';
import { isLocalHostUrl } from '@hushbox/db/local-host-url';
import { Mode, resolveRaw } from '@hushbox/shared';
import { envConfig } from '@hushbox/shared/env.config';

export const SEED_REMOTE_REFUSAL_MESSAGE =
  'Refusing to seed: DATABASE_URL does not point at a local database. ' +
  'The seed is local-development only and must never run against a remote (production) database.';

export const SEED_REMOTE_CACHE_REFUSAL_MESSAGE =
  'Refusing to seed: UPSTASH_REDIS_REST_URL does not point at a local cache. ' +
  'The seed writes authoritative wallet balances through the cache and must never ' +
  'run against a remote (production) cache.';

/** The seed is local-development only, for every target it touches. */
export function isLocalDatabaseUrl(databaseUrl: string): boolean {
  return isLocalHostUrl(databaseUrl);
}

/** Fail-closed guard: a remote (non-local) DATABASE_URL aborts before any write. */
export function assertLocalDatabaseUrl(databaseUrl: string): void {
  if (!isLocalDatabaseUrl(databaseUrl)) {
    throw new Error(SEED_REMOTE_REFUSAL_MESSAGE);
  }
}

/**
 * Fail-closed guard: a remote (non-local) cache URL aborts before any balance
 * write. The database assertion alone does not cover a mixed environment — a
 * local DATABASE_URL beside a leftover remote cache URL, which is what a stale
 * exported shell variable produces.
 */
function assertLocalCacheUrl(cacheUrl: string): void {
  if (!isLocalHostUrl(cacheUrl)) {
    throw new Error(SEED_REMOTE_CACHE_REFUSAL_MESSAGE);
  }
}

/**
 * The seed takes no arguments — every run seeds everything. Fail fast on any
 * argument (especially the removed `--profile` flag) instead of silently
 * ignoring it and seeding something the caller did not expect.
 */
export function assertNoSeedArgs(argv: readonly string[]): void {
  const first = argv[0];
  if (first === undefined) return;
  if (first === '--profile') {
    throw new Error(
      'seed: profiles were removed — `pnpm db:seed` seeds everything; drop the --profile flag'
    );
  }
  throw new Error(`seed: unexpected argument "${first}" (the seed takes no arguments)`);
}

/** Upstash Redis client for the authoritative-balance writes (`setWalletBalance`). */
export function createSeedRedis(): Redis {
  const url = requireEnv('UPSTASH_REDIS_REST_URL');
  assertLocalCacheUrl(url);
  return new Redis({ url, token: requireEnv('UPSTASH_REDIS_REST_TOKEN') });
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`seed: ${name} is required (run pnpm generate:env)`);
  }
  return value;
}

type SeedSecretName = 'OPAQUE_KEK' | 'TOTP_ENCRYPTION_SECRET';

/**
 * A runtime identity secret. Prefer the process env `with-env` injects; fall
 * back to the development-mode config value. Each MUST be the value the API
 * reads: the KEK seals every persona's server material and keys the crypto
 * cache, the TOTP secret seals every enrolled second factor — the runtime
 * values are the only ones that make a seeded persona loginable.
 */
export function resolveSeedSecret(name: SeedSecretName): string {
  const fromEnv = process.env[name];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const resolved = resolveRaw(envConfig[name], Mode.Development);
  /* v8 ignore next 3 -- defensive: the development-mode config always resolves both secrets to a non-empty string */
  if (typeof resolved !== 'string' || resolved.length === 0) {
    throw new Error(`seed: ${name} could not be resolved`);
  }
  return resolved;
}

export interface SeedSecrets {
  readonly opaqueKekSecret: string;
  readonly totpEncryptionSecret: string;
}
