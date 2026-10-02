import { describe, it, expect, vi } from 'vitest';
import { ensureStackBucketsReady, type BucketReadyDeps } from './minio-bucket-ready.js';

const BUCKETS = ['hushbox-media-e2e', 'hushbox-backup-dev', 'hushbox-app-builds-dev'];

function deps(overrides: Partial<BucketReadyDeps>): BucketReadyDeps {
  return {
    buckets: BUCKETS,
    probeBucket: vi.fn().mockResolvedValue(true),
    runBucketSetup: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('ensureStackBucketsReady', () => {
  it('resolves without running setup when every bucket already exists', async () => {
    const probeBucket = vi.fn().mockResolvedValue(true);
    const runBucketSetup = vi.fn(async () => {});

    await ensureStackBucketsReady(deps({ probeBucket, runBucketSetup }));

    expect(probeBucket).toHaveBeenCalledTimes(BUCKETS.length);
    expect(runBucketSetup).not.toHaveBeenCalled();
  });

  it('runs setup when a bucket other than the first is the missing one', async () => {
    const created = new Set(BUCKETS.slice(0, -1));
    const probeBucket = vi.fn((bucket: string) => Promise.resolve(created.has(bucket)));
    const runBucketSetup = vi.fn(() => {
      for (const bucket of BUCKETS) created.add(bucket);
      return Promise.resolve();
    });

    await ensureStackBucketsReady(deps({ probeBucket, runBucketSetup }));

    expect(runBucketSetup).toHaveBeenCalledTimes(1);
    expect(probeBucket).toHaveBeenCalledWith(BUCKETS.at(-1));
  });

  it('fails loud naming every bucket still missing after setup', async () => {
    const probeBucket = vi.fn((bucket: string) => Promise.resolve(bucket === BUCKETS[0]));
    const runBucketSetup = vi.fn(() => Promise.resolve());

    const failure = ensureStackBucketsReady(deps({ probeBucket, runBucketSetup }));

    await expect(failure).rejects.toThrow(`${String(BUCKETS[1])}, ${String(BUCKETS[2])}`);
    expect(runBucketSetup).toHaveBeenCalledTimes(1);
  });

  it('propagates a setup failure instead of masking it', async () => {
    const probeBucket = vi.fn().mockResolvedValue(false);
    const runBucketSetup = vi.fn().mockRejectedValue(new Error('mc mb exploded'));

    await expect(ensureStackBucketsReady(deps({ probeBucket, runBucketSetup }))).rejects.toThrow(
      'mc mb exploded'
    );
    // The re-probe never runs when setup itself failed — the setup error is the
    // truth; one pass over the buckets is all that happened.
    expect(probeBucket).toHaveBeenCalledTimes(BUCKETS.length);
  });
});
