import { AwsClient } from 'aws4fetch';
import { MEDIA_DOWNLOAD_URL_TTL_SECONDS } from '@hushbox/shared';
import type { Bindings, R2BucketBinding } from '../../types.js';
import { StorageReadError, StorageWriteError, type MediaStorage } from './types.js';

/**
 * The subset of `Bindings` needed to run the real MediaStorage.
 * All fields optional so we can validate at construction time and fail-fast
 * with a clear error if anything is missing.
 */
type RealMediaStorageEnv = Pick<
  Bindings,
  | 'MEDIA_BUCKET'
  | 'R2_S3_ENDPOINT'
  | 'R2_ACCESS_KEY_ID'
  | 'R2_SECRET_ACCESS_KEY'
  | 'R2_BUCKET_MEDIA'
>;

interface ValidatedConfig {
  bucket: R2BucketBinding;
  endpoint: string;
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function requireConfig(env: RealMediaStorageEnv): ValidatedConfig {
  if (!env.MEDIA_BUCKET) {
    throw new Error('MEDIA_BUCKET binding is required for real media storage');
  }
  if (!env.R2_S3_ENDPOINT) {
    throw new Error('R2_S3_ENDPOINT is required for real media storage');
  }
  if (!env.R2_ACCESS_KEY_ID) {
    throw new Error('R2_ACCESS_KEY_ID is required for real media storage');
  }
  if (!env.R2_SECRET_ACCESS_KEY) {
    throw new Error('R2_SECRET_ACCESS_KEY is required for real media storage');
  }
  if (!env.R2_BUCKET_MEDIA) {
    throw new Error('R2_BUCKET_MEDIA is required for real media storage');
  }
  return {
    bucket: env.MEDIA_BUCKET,
    endpoint: env.R2_S3_ENDPOINT,
    bucketName: env.R2_BUCKET_MEDIA,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  };
}

function buildPresignUrl(endpoint: string, bucket: string, key: string, ttlSec: number): string {
  // Normalize the endpoint: drop trailing slash to avoid `//bucket/...`.
  const base = endpoint.replace(/\/+$/, '');
  // Percent-encode each key segment so slashes in the object key are encoded too
  // (aws4fetch signs the exact path, so any unencoded '/' would change the signature).
  const encodedKey = encodeURIComponent(key);
  return `${base}/${encodeURIComponent(bucket)}/${encodedKey}?X-Amz-Expires=${String(ttlSec)}`;
}

/**
 * Real MediaStorage — writes via Cloudflare's R2 Workers binding,
 * reads via presigned S3 GET URLs signed with aws4fetch.
 */
export function createRealMediaStorage(env: RealMediaStorageEnv): MediaStorage {
  const config = requireConfig(env);

  const aws = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: 's3',
    region: 'auto',
  });

  return {
    isMock: false,

    async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
      try {
        await config.bucket.put(key, bytes, { httpMetadata: { contentType } });
      } catch (error) {
        throw new StorageWriteError(`Failed to write ${key}`, { cause: error });
      }
    },

    async delete(key: string): Promise<void> {
      try {
        await config.bucket.delete(key);
      } catch (error) {
        throw new StorageWriteError(`Failed to delete ${key}`, { cause: error });
      }
    },

    async mintDownloadUrl(params: {
      key: string;
      expiresInSec?: number;
    }): Promise<{ url: string; expiresAt: string }> {
      const ttl = params.expiresInSec ?? MEDIA_DOWNLOAD_URL_TTL_SECONDS;
      const url = buildPresignUrl(config.endpoint, config.bucketName, params.key, ttl);
      try {
        const signed = await aws.sign(url, { method: 'GET', aws: { signQuery: true } });
        const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
        return { url: signed.url, expiresAt };
      } catch (error) {
        throw new StorageReadError(`Failed to mint download URL for ${params.key}`, {
          cause: error,
        });
      }
    },
  };
}
