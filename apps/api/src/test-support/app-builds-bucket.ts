/**
 * The APP_BUILDS binding shape implemented over the local R2 emulator — the
 * same S3 seam the media storage adapter uses — so the OTA download route's
 * streaming and header behavior is exercised against a real object store
 * rather than an in-memory stub.
 *
 * Lives here because two suites need one bucket: the download suite, which
 * proves the route's own response, and the CORS-grant pin, which reads the
 * cross-origin decision off that same live response.
 */
import { AwsClient } from 'aws4fetch';
import type { AppBuildsBucket } from '../slices/updates/index.js';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required for APP_BUILDS-backed tests`);
  }
  return value;
}

const ENDPOINT = requiredEnv('R2_S3_ENDPOINT');
const BUCKET = requiredEnv('R2_BUCKET_MEDIA');

export const appBuildsS3 = new AwsClient({
  accessKeyId: requiredEnv('R2_ACCESS_KEY_ID'),
  secretAccessKey: requiredEnv('R2_SECRET_ACCESS_KEY'),
  service: 's3',
  region: 'auto',
});

export function appBuildObjectUrl(key: string): string {
  return `${ENDPOINT}/${BUCKET}/${key}`;
}

export function minioBuildsBucket(): AppBuildsBucket {
  return {
    get: async (key) => {
      const response = await appBuildsS3.fetch(appBuildObjectUrl(key), { method: 'GET' });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`minio GET failed: ${String(response.status)}`);
      const size = Number(response.headers.get('content-length') ?? '0');
      return { body: response.body, size };
    },
  };
}
