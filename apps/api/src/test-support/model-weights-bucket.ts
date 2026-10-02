/**
 * The `MODEL_WEIGHTS` binding shape implemented over the local R2 emulator —
 * the same S3 seam the media storage adapter uses — so the model-artifact
 * route's streaming and header behavior is exercised against a real object
 * store rather than an in-memory stub.
 *
 * The emulator holds one bucket for every local suite, so the artifacts live
 * under the same `models/` key prefix production R2 uses; nothing here needs a
 * bucket of its own, and neither does `docker-compose.yml`.
 *
 * Lives here rather than beside the slice because a test-support module is
 * outside the single-writer and slice-boundary trees, which is what lets it
 * hold an infra client at all.
 */
import { AwsClient } from 'aws4fetch';
import type { ModelWeightsBucket } from '../slices/model-weights/index.js';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required for MODEL_WEIGHTS-backed tests`);
  }
  return value;
}

const objectUrl = (key: string): string =>
  `${requiredEnv('R2_S3_ENDPOINT')}/${requiredEnv('R2_BUCKET_MEDIA')}/${key}`;

const s3 = new AwsClient({
  accessKeyId: requiredEnv('R2_ACCESS_KEY_ID'),
  secretAccessKey: requiredEnv('R2_SECRET_ACCESS_KEY'),
  service: 's3',
  region: 'auto',
});

/** The binding as the route consumes it, reading through the emulator. */
export function minioModelWeightsBucket(): ModelWeightsBucket {
  return {
    get: async (key) => {
      const response = await s3.fetch(objectUrl(key), { method: 'GET' });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`minio GET failed: ${String(response.status)}`);
      return { body: response.body, size: Number(response.headers.get('content-length') ?? '0') };
    },
  };
}

/** Publishes one artifact, failing loudly rather than leaving a suite to 404. */
export async function publishArtifact(key: string, body: Uint8Array<ArrayBuffer>): Promise<void> {
  const response = await s3.fetch(objectUrl(key), { method: 'PUT', body });
  if (!response.ok) throw new Error(`minio PUT failed: ${String(response.status)}`);
}

/** Removes one artifact, so a slot's next file never reads this one's bytes. */
export async function unpublishArtifact(key: string): Promise<void> {
  await s3.fetch(objectUrl(key), { method: 'DELETE' });
}
