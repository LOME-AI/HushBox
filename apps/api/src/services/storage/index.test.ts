import { describe, it, expect, vi } from 'vitest';

// aws4fetch needs a class-shaped mock because vitest v4 requires function/class
// implementations — same shape the real.test.ts uses.
const signMock = vi.fn();
vi.mock('aws4fetch', () => ({
  AwsClient: class MockAwsClient {
    sign = signMock;
  },
}));

const { getMediaStorage } = await import('./index.js');

interface FakeBucket {
  put: () => Promise<void>;
  get: () => Promise<null>;
  delete: () => Promise<void>;
}

function fakeBucket(): FakeBucket {
  return {
    put: () => Promise.resolve(),
    get: () => Promise.resolve(null),
    delete: () => Promise.resolve(),
  };
}

describe('getMediaStorage', () => {
  it('returns a mock storage in local development', () => {
    const storage = getMediaStorage({ NODE_ENV: 'development' });
    expect(storage.isMock).toBe(true);
  });

  it('returns a mock storage in test mode', () => {
    const storage = getMediaStorage({ NODE_ENV: 'test' });
    expect(storage.isMock).toBe(true);
  });

  it('returns a mock storage in E2E mode', () => {
    const storage = getMediaStorage({ NODE_ENV: 'development', E2E: 'true' });
    expect(storage.isMock).toBe(true);
  });

  it('returns a mock storage in development even when real R2 config is present', () => {
    const storage = getMediaStorage({
      NODE_ENV: 'development',
      MEDIA_BUCKET: fakeBucket() as never,
      R2_S3_ENDPOINT: 'https://abc.r2.cloudflarestorage.com',
      R2_ACCESS_KEY_ID: 'k',
      R2_SECRET_ACCESS_KEY: 's',
      R2_BUCKET_MEDIA: 'b',
    });
    expect(storage.isMock).toBe(true);
  });

  it('returns a real storage in CI when fully configured', () => {
    const storage = getMediaStorage({
      NODE_ENV: 'development',
      CI: 'true',
      MEDIA_BUCKET: fakeBucket() as never,
      R2_S3_ENDPOINT: 'https://abc.r2.cloudflarestorage.com',
      R2_ACCESS_KEY_ID: 'k',
      R2_SECRET_ACCESS_KEY: 's',
      R2_BUCKET_MEDIA: 'b',
    });
    expect(storage.isMock).toBe(false);
  });

  it('returns a real storage in production when fully configured', () => {
    const storage = getMediaStorage({
      NODE_ENV: 'production',
      MEDIA_BUCKET: fakeBucket() as never,
      R2_S3_ENDPOINT: 'https://abc.r2.cloudflarestorage.com',
      R2_ACCESS_KEY_ID: 'k',
      R2_SECRET_ACCESS_KEY: 's',
      R2_BUCKET_MEDIA: 'b',
    });
    expect(storage.isMock).toBe(false);
  });

  it('throws in production when MEDIA_BUCKET is missing', () => {
    expect(() =>
      getMediaStorage({
        NODE_ENV: 'production',
        R2_S3_ENDPOINT: 'https://abc.r2.cloudflarestorage.com',
        R2_ACCESS_KEY_ID: 'k',
        R2_SECRET_ACCESS_KEY: 's',
        R2_BUCKET_MEDIA: 'b',
      })
    ).toThrow(/MEDIA_BUCKET/);
  });

  it('throws in CI when R2 credentials are missing', () => {
    expect(() =>
      getMediaStorage({
        NODE_ENV: 'development',
        CI: 'true',
        MEDIA_BUCKET: fakeBucket() as never,
        R2_S3_ENDPOINT: 'https://abc.r2.cloudflarestorage.com',
        R2_BUCKET_MEDIA: 'b',
      })
    ).toThrow(/R2_ACCESS_KEY_ID/);
  });
});
