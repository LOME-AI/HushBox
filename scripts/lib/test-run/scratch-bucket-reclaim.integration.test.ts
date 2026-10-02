import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import path from 'node:path';
import { AwsClient } from 'aws4fetch';
import { runTokenFor, scratchBucketName, scratchBucketPrefix } from '@hushbox/db/test-db';
import { RUN_CLAIM_ENV, registerRun } from '../claims/registry.js';
import { recordOwnedResource } from '../claims/ownership.js';
import { withScratchDirectory } from '../scratch-directory.js';
import {
  createScratchBucketStore,
  reclaimScratchBuckets,
  requireScratchBucketStore,
} from './scratch-bucket-reclaim.js';

/**
 * The three states against the real object store. Every bucket this touches is
 * one it created under a token it minted, and the reclaim runs against a
 * registry directory of its own — so a concurrent run's buckets are unowned to
 * it, which is the state it must leave standing.
 */

const CHECKOUT = path.join(path.sep, 'checkout-under-test', '.git');

function endpoint(): string {
  const value = process.env['R2_S3_ENDPOINT'];
  if (value === undefined || value === '') throw new Error('R2_S3_ENDPOINT is required');
  return value.replace(/\/+$/, '');
}

function client(): AwsClient {
  return new AwsClient({
    accessKeyId: process.env['R2_ACCESS_KEY_ID'] ?? '',
    secretAccessKey: process.env['R2_SECRET_ACCESS_KEY'] ?? '',
    service: 's3',
    region: 'auto',
  });
}

async function createBucket(bucket: string): Promise<void> {
  const response = await client().fetch(`${endpoint()}/${bucket}`, { method: 'PUT' });
  if (!response.ok) throw new Error(`create ${bucket} returned ${String(response.status)}`);
}

async function putObject(bucket: string, key: string): Promise<void> {
  const response = await client().fetch(`${endpoint()}/${bucket}/${key}`, {
    method: 'PUT',
    body: 'contents',
  });
  if (!response.ok) throw new Error(`put ${key} returned ${String(response.status)}`);
}

async function bucketExists(bucket: string): Promise<boolean> {
  const response = await client().fetch(`${endpoint()}/${bucket}?list-type=2`);
  return response.ok;
}

describe('reclaiming scratch buckets against the real object store', () => {
  beforeEach(() => {
    // The invocation running this suite is itself a registered run, and it
    // stamps its run directory into the environment every child inherits. Left
    // in place, `registerRun` below adopts that run instead of registering in
    // the scratch registry, and these cases read the machine-wide registry
    // every other process on this machine is writing.
    vi.stubEnv(RUN_CLAIM_ENV, '');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    // Ahead of the mock restoration, because anything that throws there would
    // otherwise skip it. The runner restores stubs before each test and never
    // after the last one, so the claim this file blanks in setup outlives the
    // file without this.
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function withRegistry<T>(body: (registryDir: string) => Promise<T>): Promise<T> {
    return withScratchDirectory('hushbox-scratch-live-', body);
  }

  function asRun<T>(registryDir: string, body: () => Promise<T>): Promise<T> {
    return registerRun(
      { command: 'pnpm test', mode: 'development', slot: 4, gitCommonDir: CHECKOUT, registryDir },
      body
    );
  }

  it('fails loudly when the store cannot be listed', async () => {
    const store = createScratchBucketStore({
      endpoint: `${endpoint()}/not-a-bucket-anything-holds`,
      accessKeyId: process.env['R2_ACCESS_KEY_ID'] ?? '',
      secretAccessKey: process.env['R2_SECRET_ACCESS_KEY'] ?? '',
    });

    await expect(store.list()).rejects.toThrow('list');
  });

  it('treats a bucket that is already gone as removed, so two passes can both reclaim it', async () => {
    const store = requireScratchBucketStore(process.env);

    await expect(
      store.destroy(scratchBucketName(runTokenFor(crypto.randomUUID()), 'absent'))
    ).resolves.toBeUndefined();
  });

  it('removes only the bucket whose owning run died', async () => {
    const store = requireScratchBucketStore(process.env);
    const tokens = {
      live: runTokenFor(crypto.randomUUID()),
      dead: runTokenFor(crypto.randomUUID()),
      stranger: runTokenFor(crypto.randomUUID()),
    };
    const buckets = {
      live: scratchBucketName(tokens.live, 'one'),
      dead: scratchBucketName(tokens.dead, 'one'),
      stranger: scratchBucketName(tokens.stranger, 'one'),
    };

    await withRegistry(async (registryDir) => {
      await expect(
        asRun(registryDir, async () => {
          await recordOwnedResource('bucket', scratchBucketPrefix(tokens.dead));
          throw new Error('killed');
        })
      ).rejects.toThrow('killed');

      for (const bucket of Object.values(buckets)) await createBucket(bucket);
      // The dead run's bucket is not empty, which is what a bucket delete refuses.
      await putObject(buckets.dead, 'left/behind.bin');

      try {
        await asRun(registryDir, async () => {
          await recordOwnedResource('bucket', scratchBucketPrefix(tokens.live));

          const report = await reclaimScratchBuckets(store, { registryDir });

          expect(report.dropped).toContain(buckets.dead);
          expect(report.dropped).not.toContain(buckets.live);
          expect(report.unowned).toContain(buckets.stranger);
        });

        expect(await bucketExists(buckets.dead)).toBe(false);
        expect(await bucketExists(buckets.live)).toBe(true);
        expect(await bucketExists(buckets.stranger)).toBe(true);
      } finally {
        for (const bucket of [buckets.live, buckets.stranger]) {
          if (await bucketExists(bucket)) await store.destroy(bucket);
        }
      }
    });
  });
});
