import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StorageReadError, StorageWriteError } from './types.js';

const signMock = vi.fn();
const awsClientConstructor = vi.fn();
vi.mock('aws4fetch', () => ({
  AwsClient: class MockAwsClient {
    constructor(options: unknown) {
      awsClientConstructor(options);
    }
    sign = signMock;
  },
}));

// Import after mock declaration so the mock is applied.
const { createRealMediaStorage } = await import('./real.js');

import type { R2BucketBinding } from '../../types.js';

interface FakeBucket {
  put: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

function createFakeBucket(): FakeBucket {
  return {
    put: vi.fn(() => Promise.resolve()),
    get: vi.fn(() => Promise.resolve(null)),
    delete: vi.fn(() => Promise.resolve()),
  };
}

function bucketAsBinding(bucket: FakeBucket): R2BucketBinding {
  return bucket as unknown as R2BucketBinding;
}

function baseEnv(bucket: FakeBucket): {
  MEDIA_BUCKET: R2BucketBinding;
  R2_S3_ENDPOINT: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET_MEDIA: string;
} {
  return {
    MEDIA_BUCKET: bucketAsBinding(bucket),
    R2_S3_ENDPOINT: 'https://abc.r2.cloudflarestorage.com',
    R2_ACCESS_KEY_ID: 'test-access-id',
    R2_SECRET_ACCESS_KEY: 'test-secret',
    R2_BUCKET_MEDIA: 'hushbox-media',
  };
}

describe('createRealMediaStorage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('fail-fast config validation', () => {
    it('throws when MEDIA_BUCKET binding is missing', () => {
      const env = baseEnv(createFakeBucket());
      // @ts-expect-error - testing missing binding
      delete env.MEDIA_BUCKET;
      expect(() => createRealMediaStorage(env)).toThrow(/MEDIA_BUCKET/);
    });

    it('throws when R2_S3_ENDPOINT is missing', () => {
      const env = baseEnv(createFakeBucket());
      // @ts-expect-error - testing missing env var
      delete env.R2_S3_ENDPOINT;
      expect(() => createRealMediaStorage(env)).toThrow(/R2_S3_ENDPOINT/);
    });

    it('throws when R2_ACCESS_KEY_ID is missing', () => {
      const env = baseEnv(createFakeBucket());
      // @ts-expect-error - testing missing env var
      delete env.R2_ACCESS_KEY_ID;
      expect(() => createRealMediaStorage(env)).toThrow(/R2_ACCESS_KEY_ID/);
    });

    it('throws when R2_SECRET_ACCESS_KEY is missing', () => {
      const env = baseEnv(createFakeBucket());
      // @ts-expect-error - testing missing env var
      delete env.R2_SECRET_ACCESS_KEY;
      expect(() => createRealMediaStorage(env)).toThrow(/R2_SECRET_ACCESS_KEY/);
    });

    it('throws when R2_BUCKET_MEDIA is missing', () => {
      const env = baseEnv(createFakeBucket());
      // @ts-expect-error - testing missing env var
      delete env.R2_BUCKET_MEDIA;
      expect(() => createRealMediaStorage(env)).toThrow(/R2_BUCKET_MEDIA/);
    });

    it('returns a storage with isMock=false when fully configured', () => {
      const storage = createRealMediaStorage(baseEnv(createFakeBucket()));
      expect(storage.isMock).toBe(false);
    });

    it('constructs an AwsClient with the provided credentials', () => {
      createRealMediaStorage(baseEnv(createFakeBucket()));
      expect(awsClientConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          accessKeyId: 'test-access-id',
          secretAccessKey: 'test-secret',
          service: 's3',
          region: 'auto',
        })
      );
    });
  });

  describe('put', () => {
    it('calls MEDIA_BUCKET.put with key, bytes and httpMetadata.contentType', async () => {
      const bucket = createFakeBucket();
      const storage = createRealMediaStorage(baseEnv(bucket));
      const bytes = new Uint8Array([1, 2, 3]);

      await storage.put('media/c/m/i.enc', bytes, 'application/octet-stream');

      expect(bucket.put).toHaveBeenCalledWith('media/c/m/i.enc', bytes, {
        httpMetadata: { contentType: 'application/octet-stream' },
      });
    });

    it('throws StorageWriteError when the binding rejects', async () => {
      const bucket = createFakeBucket();
      bucket.put.mockRejectedValueOnce(new Error('R2 boom'));
      const storage = createRealMediaStorage(baseEnv(bucket));

      await expect(
        storage.put('k', new Uint8Array([1]), 'application/octet-stream')
      ).rejects.toBeInstanceOf(StorageWriteError);
    });
  });

  describe('delete', () => {
    it('calls MEDIA_BUCKET.delete with the key', async () => {
      const bucket = createFakeBucket();
      const storage = createRealMediaStorage(baseEnv(bucket));

      await storage.delete('media/c/m/i.enc');

      expect(bucket.delete).toHaveBeenCalledWith('media/c/m/i.enc');
    });

    it('throws StorageWriteError when the binding rejects', async () => {
      const bucket = createFakeBucket();
      bucket.delete.mockRejectedValueOnce(new Error('R2 boom'));
      const storage = createRealMediaStorage(baseEnv(bucket));

      await expect(storage.delete('k')).rejects.toBeInstanceOf(StorageWriteError);
    });
  });

  describe('mintDownloadUrl', () => {
    it('signs a GET to {endpoint}/{bucket}/{key} with signQuery=true', async () => {
      const signedUrl = 'https://abc.r2.cloudflarestorage.com/hushbox-media/k?X-Amz-Signature=xyz';
      signMock.mockResolvedValueOnce(new Request(signedUrl));
      const storage = createRealMediaStorage(baseEnv(createFakeBucket()));

      const { url } = await storage.mintDownloadUrl({ key: 'media/c/m/i.enc' });

      expect(signMock).toHaveBeenCalledTimes(1);
      const [inputUrl, init] = signMock.mock.calls[0] ?? [];
      expect(typeof inputUrl).toBe('string');
      expect(inputUrl as string).toContain(
        'https://abc.r2.cloudflarestorage.com/hushbox-media/media%2Fc%2Fm%2Fi.enc'
      );
      expect((inputUrl as string).includes('X-Amz-Expires=')).toBe(true);
      expect((init as Record<string, unknown>)['method']).toBe('GET');
      expect((init as { aws: { signQuery: boolean } }).aws.signQuery).toBe(true);
      expect(url).toBe(signedUrl);
    });

    it('uses the default TTL when expiresInSec is omitted', async () => {
      signMock.mockResolvedValueOnce(new Request('https://s/x'));
      const storage = createRealMediaStorage(baseEnv(createFakeBucket()));

      await storage.mintDownloadUrl({ key: 'k' });
      const inputUrl = signMock.mock.calls[0]?.[0] as string;
      expect(inputUrl).toContain('X-Amz-Expires=300');
    });

    it('honors expiresInSec when provided', async () => {
      signMock.mockResolvedValueOnce(new Request('https://s/x'));
      const storage = createRealMediaStorage(baseEnv(createFakeBucket()));

      await storage.mintDownloadUrl({ key: 'k', expiresInSec: 60 });
      const inputUrl = signMock.mock.calls[0]?.[0] as string;
      expect(inputUrl).toContain('X-Amz-Expires=60');
    });

    it('returns an ISO-8601 expiresAt timestamp roughly TTL from now', async () => {
      signMock.mockResolvedValueOnce(new Request('https://s/x'));
      const storage = createRealMediaStorage(baseEnv(createFakeBucket()));

      const before = Date.now();
      const { expiresAt } = await storage.mintDownloadUrl({ key: 'k', expiresInSec: 60 });
      const after = Date.now();
      const expiryMs = new Date(expiresAt).getTime();

      expect(expiryMs).toBeGreaterThanOrEqual(before + 60_000);
      expect(expiryMs).toBeLessThanOrEqual(after + 60_000 + 1000);
    });

    it('throws StorageReadError when signing fails', async () => {
      signMock.mockRejectedValueOnce(new Error('signing failed'));
      const storage = createRealMediaStorage(baseEnv(createFakeBucket()));

      await expect(storage.mintDownloadUrl({ key: 'k' })).rejects.toBeInstanceOf(StorageReadError);
    });
  });
});
