import { AwsClient } from 'aws4fetch';
import { MEDIA_DOWNLOAD_URL_TTL_SECONDS } from '@hushbox/shared';
import { StorageReadError, StorageWriteError, type MediaStorage } from './types.js';

/**
 * Subset of env vars the storage layer needs. All five are required at
 * construction time — fail-fast with a clear error if any is missing.
 *
 * Same code path branches only on env config: MinIO endpoint+creds in
 * dev/CI, R2 S3 endpoint+API token in production. No Workers binding.
 */
export interface MediaStorageEnv {
  R2_S3_ENDPOINT?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET_MEDIA?: string;
}

interface ValidatedConfig {
  endpoint: string;
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function requireConfig(env: MediaStorageEnv): ValidatedConfig {
  if (env.R2_S3_ENDPOINT === undefined || env.R2_S3_ENDPOINT.length === 0) {
    throw new Error('R2_S3_ENDPOINT is required for media storage');
  }
  if (env.R2_ACCESS_KEY_ID === undefined || env.R2_ACCESS_KEY_ID.length === 0) {
    throw new Error('R2_ACCESS_KEY_ID is required for media storage');
  }
  if (env.R2_SECRET_ACCESS_KEY === undefined || env.R2_SECRET_ACCESS_KEY.length === 0) {
    throw new Error('R2_SECRET_ACCESS_KEY is required for media storage');
  }
  if (env.R2_BUCKET_MEDIA === undefined || env.R2_BUCKET_MEDIA.length === 0) {
    throw new Error('R2_BUCKET_MEDIA is required for media storage');
  }
  return {
    endpoint: env.R2_S3_ENDPOINT,
    bucketName: env.R2_BUCKET_MEDIA,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  };
}

function buildObjectUrl(endpoint: string, bucket: string, key: string): string {
  const base = endpoint.replace(/\/+$/, '');
  return `${base}/${encodeURIComponent(bucket)}/${encodeURIComponent(key)}`;
}

function buildPresignUrl(endpoint: string, bucket: string, key: string, ttlSec: number): string {
  return `${buildObjectUrl(endpoint, bucket, key)}?X-Amz-Expires=${String(ttlSec)}`;
}

interface ListUrlParams {
  endpoint: string;
  bucket: string;
  prefix: string;
  cursor: string | undefined;
  limit: number;
}

function buildListUrl(input: ListUrlParams): string {
  const base = input.endpoint.replace(/\/+$/, '');
  const params = new URLSearchParams({
    'list-type': '2',
    prefix: input.prefix,
    'max-keys': String(input.limit),
  });
  if (input.cursor !== undefined) {
    params.set('continuation-token', input.cursor);
  }
  return `${base}/${encodeURIComponent(input.bucket)}?${params.toString()}`;
}

const DEFAULT_LIST_LIMIT = 1000;

export function createMediaStorage(env: MediaStorageEnv): MediaStorage {
  const config = requireConfig(env);

  const aws = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: 's3',
    region: 'auto',
  });

  return {
    async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
      const url = buildObjectUrl(config.endpoint, config.bucketName, key);
      try {
        const arrayBuffer = bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength
        ) as ArrayBuffer;
        const response = await aws.fetch(url, {
          method: 'PUT',
          body: arrayBuffer,
          headers: { 'Content-Type': contentType },
        });
        if (!response.ok) {
          const text = await safeReadText(response);
          throw new Error(`PUT ${key} returned ${String(response.status)}: ${text}`);
        }
      } catch (error) {
        throw new StorageWriteError(`Failed to write ${key}`, { cause: error });
      }
    },

    async delete(key: string): Promise<void> {
      const url = buildObjectUrl(config.endpoint, config.bucketName, key);
      try {
        const response = await aws.fetch(url, { method: 'DELETE' });
        // S3 delete returns 204 No Content on success; 404 also acceptable
        // (idempotent), but R2/MinIO return 204 even for missing keys.
        if (!response.ok && response.status !== 404) {
          const text = await safeReadText(response);
          throw new Error(`DELETE ${key} returned ${String(response.status)}: ${text}`);
        }
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

    async list(
      prefix: string,
      options?: { cursor?: string; limit?: number }
    ): Promise<{
      objects: { key: string; uploaded: Date; size: number }[];
      nextCursor?: string;
    }> {
      const limit = options?.limit ?? DEFAULT_LIST_LIMIT;
      const url = buildListUrl({
        endpoint: config.endpoint,
        bucket: config.bucketName,
        prefix,
        cursor: options?.cursor,
        limit,
      });
      try {
        const response = await aws.fetch(url, { method: 'GET' });
        if (!response.ok) {
          const text = await safeReadText(response);
          throw new Error(`LIST ${prefix} returned ${String(response.status)}: ${text}`);
        }
        const xml = await response.text();
        return parseListObjectsV2Response(xml);
      } catch (error) {
        throw new StorageReadError(`Failed to list under prefix ${prefix}`, { cause: error });
      }
    },
  };
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<unreadable body>';
  }
}

/**
 * Hand-rolled S3 ListObjectsV2 XML parser. The response shape is well-defined
 * and stable; we only extract `<Contents>` blocks (key, lastModified, size)
 * plus `<IsTruncated>` and `<NextContinuationToken>`. No XML parser dependency.
 */
function parseListObjectsV2Response(xml: string): {
  objects: { key: string; uploaded: Date; size: number }[];
  nextCursor?: string;
} {
  const objects: { key: string; uploaded: Date; size: number }[] = [];
  const contentsRegex = /<Contents>([\s\S]*?)<\/Contents>/g;
  let match: RegExpExecArray | null = contentsRegex.exec(xml);
  while (match !== null) {
    const block = match[1] ?? '';
    const key = extractTag(block, 'Key');
    const lastModified = extractTag(block, 'LastModified');
    const size = extractTag(block, 'Size');
    if (key !== undefined && lastModified !== undefined && size !== undefined) {
      objects.push({
        key,
        uploaded: new Date(lastModified),
        size: Number.parseInt(size, 10),
      });
    }
    match = contentsRegex.exec(xml);
  }
  const truncated = extractTag(xml, 'IsTruncated') === 'true';
  const nextContinuationToken = truncated ? extractTag(xml, 'NextContinuationToken') : undefined;
  return {
    objects,
    ...(nextContinuationToken !== undefined && { nextCursor: nextContinuationToken }),
  };
}

function extractTag(xml: string, tag: string): string | undefined {
  const regex = new RegExp(`<${tag}>([^<]*)</${tag}>`);
  return regex.exec(xml)?.[1];
}
