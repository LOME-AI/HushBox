import { createMediaStorage, type MediaStorageEnv } from './media-storage.js';
import type { MediaStorage } from './types.js';

export type { MediaStorage } from './types.js';
export { StorageReadError, StorageWriteError } from './types.js';
export type { MediaStorageEnv } from './media-storage.js';

/**
 * Construct the media storage client. Single codepath — MinIO in dev/CI, R2
 * in production, branched only by env config (R2_S3_ENDPOINT and credentials).
 *
 * Tests that need a stub construct one inline per-test (matching the Redis
 * stub pattern); there is no factory-level mock implementation.
 */
export function getMediaStorage(env: MediaStorageEnv): MediaStorage {
  return createMediaStorage(env);
}
