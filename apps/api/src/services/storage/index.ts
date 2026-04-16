import { createEnvUtilities, type EnvContext } from '@hushbox/shared';
import type { Bindings } from '../../types.js';
import { createMockMediaStorage } from './mock.js';
import { createRealMediaStorage } from './real.js';
import type { MediaStorage } from './types.js';

export type { MediaStorage, MockMediaStorage } from './types.js';
export { StorageReadError, StorageWriteError } from './types.js';
export { createMockMediaStorage } from './mock.js';

type MediaStorageEnv = EnvContext &
  Pick<
    Bindings,
    | 'MEDIA_BUCKET'
    | 'R2_S3_ENDPOINT'
    | 'R2_ACCESS_KEY_ID'
    | 'R2_SECRET_ACCESS_KEY'
    | 'R2_BUCKET_MEDIA'
  >;

/**
 * Get the appropriate MediaStorage based on environment.
 *
 * - Local dev / test / E2E: Returns an in-memory mock (no MinIO required).
 * - CI integration / production: Requires the R2 Workers binding and S3
 *   credentials; fails fast if any are missing.
 */
export function getMediaStorage(env: MediaStorageEnv): MediaStorage {
  const { isLocalDev, isE2E } = createEnvUtilities(env);

  if (isLocalDev || isE2E) {
    return createMockMediaStorage();
  }

  return createRealMediaStorage(env);
}
