import {
  MAX_MEDIA_OBJECT_BYTES,
  MEDIA_DOWNLOAD_URL_TTL_SECONDS,
  createEnvUtilities,
} from '@hushbox/shared';
import { createR2Storage } from './storage-r2.js';
import type { EnvContext } from '@hushbox/shared';
import type { Database } from '@hushbox/db';
import type { R2NetworkOptions } from './storage-r2.js';
import type { Storage } from '../ports/index.js';

/** The R2/S3 bindings the storage adapter needs (same names the local stack sets). */
interface R2StorageEnv extends EnvContext {
  R2_S3_ENDPOINT?: string;
  R2_BUCKET_MEDIA?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
}

function requireBinding(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(
      `${name} is required to build the R2 storage adapter — there is no degraded mode`
    );
  }
  return value;
}

/**
 * Non-production storage retry window. Against local MinIO (dev/CI), host CPU
 * oversubscription under a full Playwright worker set produces transient
 * multi-second unavailability bursts; an idempotent PUT (last-write-wins) can
 * safely ride one out given a wide enough retry budget. This window (~8 retries
 * summing to ~16s, comfortably under the client's ~30s render deadline)
 * replaces storage-r2's fail-fast DEFAULT_NETWORK (maxRetries:2,
 * maxDelayMs:1000) — but only outside production. Production keeps
 * DEFAULT_NETWORK so a genuine R2 outage still fails fast.
 */
export const NON_PROD_STORAGE_NETWORK: Partial<R2NetworkOptions> = {
  maxRetries: 8,
  initialDelayMs: 100,
  maxDelayMs: 5000,
};

/**
 * Production retry envelope for the deleted-account media reclaim sweep. One
 * chunk of that sweep issues its chunk size in sequential deletes
 * (`apps/api/src/slices/media/domain/reclaim-user.ts`), and once the object
 * store is degraded each delete spends the per-attempt timeout on every
 * attempt and then waits out the backoff between attempts — this window names
 * only `maxRetries` and `timeoutMs`, so those waits come from storage-r2's
 * `DEFAULT_NETWORK` and land on the same budget. The chunk loop starts a chunk
 * with only `CHUNK_SOFT_CUTOFF_FRACTION` of the registration's execution
 * budget left to finish it (`apps/api/src/lib/jobs/chunked.ts`). So what has
 * to stay inside that remainder is chunk size x (timeoutMs x (maxRetries + 1)
 * + the inherited backoff), with margin rather than at equality: a window
 * sized to meet the remainder exactly overruns on any term its derivation
 * leaves out, and the backoff is such a term. Move the chunk size, the
 * budget, the cutoff fraction or the inherited backoff and this window moves
 * with them. Production only — every other mode keeps
 * {@link NON_PROD_STORAGE_NETWORK}, whose MinIO-contention window is the wider
 * decision this must not undo.
 */
export const MEDIA_RECLAIM_STORAGE_NETWORK = {
  maxRetries: 2,
  timeoutMs: 1800,
} satisfies Partial<R2NetworkOptions>;

/**
 * Callers whose production window is not the adapter's fail-fast default. The
 * call site names itself rather than passing a window, so the arithmetic a
 * window satisfies stays beside the window instead of at the composition site.
 */
type StorageCaller = 'default' | 'media-reclaim';

/**
 * Resolve the storage retry window for the current mode and caller: the wider
 * non-prod window for every non-production mode (development, ciVitest, ciE2E)
 * whoever asks, and in production the caller's own envelope, or `undefined` so
 * storage-r2's DEFAULT_NETWORK stands. Env mode is decided via
 * `createEnvUtilities`, never a bare var-existence check.
 */
export function storageNetworkForEnv(
  env: EnvContext,
  caller: StorageCaller = 'default'
): Partial<R2NetworkOptions> | undefined {
  if (!createEnvUtilities(env).isProduction) return NON_PROD_STORAGE_NETWORK;
  return caller === 'media-reclaim' ? MEDIA_RECLAIM_STORAGE_NETWORK : undefined;
}

/**
 * The composition-root R2 storage adapter, bound from env. One aws4fetch
 * codepath serves MinIO (dev/CI) and Cloudflare R2 (production), so there is no
 * mock branch — only the endpoint and credentials vary. The size cap and
 * presign TTL come from `@hushbox/shared` (the single source), and `isCI` gates
 * the service-evidence writes the adapter records after a real S3 op. Missing
 * config fails fast rather than degrading. The retry window widens outside
 * production (see `storageNetworkForEnv`) so a MinIO contention burst is ridden
 * out instead of surfacing as a spurious 503.
 */
export function createR2StorageFromEnv(
  env: R2StorageEnv,
  db: Database,
  caller: StorageCaller = 'default'
): Storage {
  const { isCI } = createEnvUtilities(env);
  // Omit `network` entirely where the caller's mode resolves none so the
  // adapter's DEFAULT_NETWORK applies; passing `undefined` is rejected under
  // exactOptionalPropertyTypes.
  const network = storageNetworkForEnv(env, caller);
  return createR2Storage({
    endpoint: requireBinding(env.R2_S3_ENDPOINT, 'R2_S3_ENDPOINT'),
    bucket: requireBinding(env.R2_BUCKET_MEDIA, 'R2_BUCKET_MEDIA'),
    accessKeyId: requireBinding(env.R2_ACCESS_KEY_ID, 'R2_ACCESS_KEY_ID'),
    secretAccessKey: requireBinding(env.R2_SECRET_ACCESS_KEY, 'R2_SECRET_ACCESS_KEY'),
    maxObjectBytes: MAX_MEDIA_OBJECT_BYTES,
    defaultPresignTtlSeconds: MEDIA_DOWNLOAD_URL_TTL_SECONDS,
    db,
    isCI,
    ...(network === undefined ? {} : { network }),
  });
}
