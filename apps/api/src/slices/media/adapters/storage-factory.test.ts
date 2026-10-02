import { describe, expect, it } from 'vitest';
import { expectExposes } from '@hushbox/shared/test-assertions';
import {
  MEDIA_RECLAIM_STORAGE_NETWORK,
  NON_PROD_STORAGE_NETWORK,
  createR2StorageFromEnv,
  storageNetworkForEnv,
} from './storage-factory.js';
import type { Database } from '@hushbox/db';

// Construction never records evidence, so the db is untouched; a throwing stub
// proves it and keeps this a pure unit test.
const NO_DB = new Proxy(
  {},
  {
    get() {
      throw new Error('storage-factory unit test must not touch the database');
    },
  }
) as Database;

interface FactoryEnv {
  NODE_ENV: string;
  R2_S3_ENDPOINT?: string;
  R2_BUCKET_MEDIA?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
}

function fullEnv(overrides: Partial<FactoryEnv> = {}): FactoryEnv {
  return {
    NODE_ENV: 'development',
    R2_S3_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
    R2_BUCKET_MEDIA: 'media',
    R2_ACCESS_KEY_ID: 'key',
    R2_SECRET_ACCESS_KEY: 'secret',
    ...overrides,
  };
}

describe('createR2StorageFromEnv', () => {
  it.each([
    'R2_S3_ENDPOINT',
    'R2_BUCKET_MEDIA',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
  ] as const)('fails fast when %s is missing', (field) => {
    expect(() => createR2StorageFromEnv(fullEnv({ [field]: undefined }), NO_DB)).toThrow(field);
  });

  it('builds a Storage adapter when every binding is present', () => {
    expectExposes(createR2StorageFromEnv(fullEnv(), NO_DB), 'put', 'presignGet', 'delete');
  });

  it('builds one for a caller whose mode resolves no window at all', () => {
    // Characterization, not red-first: a production build that names no caller
    // passes no `network` through, which `exactOptionalPropertyTypes` would
    // refuse as an explicit `undefined`.
    expectExposes(
      createR2StorageFromEnv(fullEnv({ NODE_ENV: 'production' }), NO_DB),
      'put',
      'presignGet',
      'delete'
    );
  });
});

describe('storageNetworkForEnv', () => {
  it('widens the retry window in local development', () => {
    expect(storageNetworkForEnv({ NODE_ENV: 'development' })).toStrictEqual(
      NON_PROD_STORAGE_NETWORK
    );
  });

  it('widens the retry window in CI (non-production, CI set)', () => {
    expect(storageNetworkForEnv({ NODE_ENV: 'development', CI: 'true' })).toStrictEqual(
      NON_PROD_STORAGE_NETWORK
    );
  });

  it('injects a maxRetries and maxDelayMs wider than the fail-fast default', () => {
    // storage-r2's DEFAULT_NETWORK is maxRetries:2 / maxDelayMs:1000; the
    // non-prod window rides out a multi-second MinIO contention burst.
    expect(NON_PROD_STORAGE_NETWORK.maxRetries).toBe(8);
    expect(NON_PROD_STORAGE_NETWORK.maxDelayMs).toBe(5000);
  });

  it('returns undefined in production so DEFAULT_NETWORK (fail fast) stands', () => {
    expect(storageNetworkForEnv({ NODE_ENV: 'production' })).toBeUndefined();
  });
});

describe('storageNetworkForEnv for the deleted-account media reclaim sweep', () => {
  it('narrows the production window to a whole chunk of sequential deletes', () => {
    // The chunk the sweep runs is 25 deletes, each costing its per-attempt
    // timeout on every attempt when the store is degraded plus the two backoff
    // gaps the window inherits: three attempts of 1.8 seconds and under 0.3
    // seconds of backoff is under 5.7 seconds an object and under 142.5
    // seconds a chunk, inside the 150 the chunk loop leaves a chunk that
    // starts with a margin the timeouts alone would spend.
    expect(storageNetworkForEnv({ NODE_ENV: 'production' }, 'media-reclaim')).toStrictEqual({
      maxRetries: 2,
      timeoutMs: 1800,
    });
  });

  it('publishes that window as the envelope the adapter is built with', () => {
    // Cannot be red-first: before the envelope existed both sides of this
    // identity read `undefined`. It is what makes a measurement of
    // MEDIA_RECLAIM_STORAGE_NETWORK a measurement of what the sweep runs under.
    expect(storageNetworkForEnv({ NODE_ENV: 'production' }, 'media-reclaim')).toBe(
      MEDIA_RECLAIM_STORAGE_NETWORK
    );
  });

  it('keeps the non-production window outside production', () => {
    // Characterization, not red-first: the MinIO-contention window is what
    // this path already resolves outside production, and criterion of this
    // change is that it stays that way.
    expect(storageNetworkForEnv({ NODE_ENV: 'development' }, 'media-reclaim')).toStrictEqual(
      NON_PROD_STORAGE_NETWORK
    );
  });

  it('leaves a caller that names none on the resolution it has today', () => {
    // Characterization, not red-first: the chat conversation runtime and the
    // app composition root build storage with two arguments, and the reclaim
    // envelope must not reach either of them.
    expect(storageNetworkForEnv({ NODE_ENV: 'production' })).toBeUndefined();
    expect(storageNetworkForEnv({ NODE_ENV: 'development' })).toStrictEqual(
      NON_PROD_STORAGE_NETWORK
    );
  });
});
