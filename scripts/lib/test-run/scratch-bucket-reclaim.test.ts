import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runTokenFor, scratchBucketName, scratchBucketPrefix } from '@hushbox/db/test-db';
import { RUN_CLAIM_ENV, registerRun } from '../claims/registry.js';
import { currentRunId, recordOwnedResource } from '../claims/ownership.js';
import {
  createScratchBucketStore,
  emptyBucket,
  objectStoreEndpointFrom,
  parseBucketNames,
  parseObjectKeys,
  reclaimScratchBuckets,
  requireScratchBucketStore,
} from './scratch-bucket-reclaim.js';
import type { ScratchBucketStore } from './scratch-bucket-reclaim.js';

const CHECKOUT = path.join(path.sep, 'checkout-under-test', '.git');
const LIVE_TOKEN = 'aaaa11';
const DEAD_TOKEN = 'bbbb22';
const STRANGER_TOKEN = 'cccc33';

/**
 * The run claim this file was invoked under. Registering a run inside a case
 * clears the variable on the way out, so a hook that puts back an empty string
 * leaves every later suite here — and everything else this worker goes on to
 * run — creating resources no claim names.
 */
const inheritedRunClaim = process.env[RUN_CLAIM_ENV];

afterAll(() => {
  // Empty string rather than absent: every reader treats an empty claim
  // variable as no claim, and a computed key cannot be deleted.
  expect(process.env[RUN_CLAIM_ENV]).toBe(inheritedRunClaim ?? '');
});

function fakeStore(buckets: string[]): ScratchBucketStore & { readonly removed: string[] } {
  const removed: string[] = [];
  return {
    removed,
    list: () => Promise.resolve([...buckets]),
    destroy: (bucket) => {
      removed.push(bucket);
      return Promise.resolve();
    },
  };
}

describe('destroying a bucket a concurrent pass already removed', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('succeeds when the bucket delete finds nothing left to delete', async () => {
    // The loser of two passes that both emptied the same bucket: its listing
    // succeeded, and the delete that follows arrives after the winner's.
    vi.stubGlobal(
      'fetch',
      vi.fn((input: Request) =>
        Promise.resolve(
          input.method === 'DELETE'
            ? new Response('<Error><Code>NoSuchBucket</Code></Error>', { status: 404 })
            : new Response('<ListBucketResult></ListBucketResult>', { status: 200 })
        )
      )
    );
    const store = createScratchBucketStore({
      endpoint: 'https://object-store.invalid',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
    });

    await expect(store.destroy(scratchBucketName(DEAD_TOKEN, 'one'))).resolves.toBeUndefined();
  });
});

describe('emptying a bucket that stays in use', () => {
  const ENDPOINT = {
    endpoint: 'https://object-store.invalid/',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A store holding `keys` in one bucket until each is deleted, recording every request. */
  function stubStore(keys: string[]): string[] {
    const requests: string[] = [];
    const held = new Set(keys);
    vi.stubGlobal(
      'fetch',
      vi.fn((input: Request) => {
        const url = new URL(input.url);
        requests.push(`${input.method} ${url.pathname}`);
        if (input.method === 'DELETE') {
          held.delete(decodeURIComponent(url.pathname.split('/').slice(2).join('/')));
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        const contents = [...held].map((key) => `<Contents><Key>${key}</Key></Contents>`);
        return Promise.resolve(
          new Response(`<ListBucketResult>${contents.join('')}</ListBucketResult>`)
        );
      })
    );
    return requests;
  }

  it('deletes every object the bucket holds', async () => {
    const requests = stubStore(['media/one.bin', 'two.bin']);

    await emptyBucket(ENDPOINT, 'hushbox-media-e2e');

    expect(requests).toEqual(
      expect.arrayContaining([
        'DELETE /hushbox-media-e2e/media/one.bin',
        'DELETE /hushbox-media-e2e/two.bin',
      ])
    );
  });

  it('leaves the bucket itself standing', async () => {
    const requests = stubStore(['one.bin']);

    await emptyBucket(ENDPOINT, 'hushbox-media-e2e');

    expect(requests).not.toContain('DELETE /hushbox-media-e2e');
  });

  it('treats a bucket that is not there as already empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('<Error/>', { status: 404 })))
    );

    await expect(emptyBucket(ENDPOINT, 'hushbox-media-e2e')).resolves.toBeUndefined();
  });
});

describe('the object store an environment names', () => {
  it('is read off the storage variables the env files carry', () => {
    expect(
      objectStoreEndpointFrom({
        R2_S3_ENDPOINT: 'http://localhost:9000',
        R2_ACCESS_KEY_ID: 'key',
        R2_SECRET_ACCESS_KEY: 'secret',
      })
    ).toEqual({ endpoint: 'http://localhost:9000', accessKeyId: 'key', secretAccessKey: 'secret' });
  });
});

describe('reclaimScratchBuckets', () => {
  let registryDir: string;

  beforeEach(async () => {
    registryDir = await mkdtemp(path.join(os.tmpdir(), 'hushbox-scratch-reclaim-'));
    process.env[RUN_CLAIM_ENV] = '';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    process.env[RUN_CLAIM_ENV] = inheritedRunClaim ?? '';
    await rm(registryDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /**
   * Makes the enclosing run's record unreadable in the form that needs no
   * corruption: a record a wider checkout wrote names a mode this one has never
   * heard of. The run behind it goes on holding its lock.
   */
  function damageOwnRecord(): string {
    const runDir = process.env[RUN_CLAIM_ENV] ?? '';
    const record = path.join(runDir, 'run.json');
    const written: unknown = JSON.parse(readFileSync(record, 'utf8'));
    writeFileSync(
      record,
      JSON.stringify({ ...(written as object), mode: 'a-mode-this-checkout-has-never-heard-of' })
    );
    return path.basename(runDir);
  }

  function run<T>(body: () => Promise<T>): Promise<T> {
    return registerRun(
      { command: 'pnpm test', mode: 'development', slot: 4, gitCommonDir: CHECKOUT, registryDir },
      body
    );
  }

  it('reclaims nothing and reports an empty pass when the store never holds still', async () => {
    let created = 0;
    const store: ScratchBucketStore & { readonly removed: string[] } = {
      removed: [],
      list: () =>
        Promise.resolve(
          Array.from({ length: created++ }, (_, n) => scratchBucketName(DEAD_TOKEN, String(n)))
        ),
      destroy: (bucket) => {
        store.removed.push(bucket);
        return Promise.resolve();
      },
    };

    const report = await reclaimScratchBuckets(store, { registryDir });

    expect(report).toEqual({ dropped: [], unowned: [] });
    expect(store.removed).toEqual([]);
  });

  it('leaves a bucket whose owning run still holds its claim', async () => {
    await run(async () => {
      await recordOwnedResource('bucket', scratchBucketPrefix(LIVE_TOKEN));
      const store = fakeStore([scratchBucketName(LIVE_TOKEN, 'one')]);

      const report = await reclaimScratchBuckets(store, { registryDir });

      expect(report.dropped).toEqual([]);
      expect(store.removed).toEqual([]);
    });
  });

  it('removes a bucket whose owning run died', async () => {
    await expect(
      run(async () => {
        await recordOwnedResource('bucket', scratchBucketPrefix(DEAD_TOKEN));
        throw new Error('killed');
      })
    ).rejects.toThrow('killed');

    const store = fakeStore([scratchBucketName(DEAD_TOKEN, 'one')]);

    const report = await reclaimScratchBuckets(store, { registryDir });

    expect(report.dropped).toEqual([scratchBucketName(DEAD_TOKEN, 'one')]);
    expect(store.removed).toEqual([scratchBucketName(DEAD_TOKEN, 'one')]);
  });

  /**
   * The run ended the way it meant to, so its record is gone and the only thing
   * left naming an owner is the run id the bucket carries in its own name.
   */
  it('removes a bucket of a run that ended and took its record with it', async () => {
    const ended = await run(() => Promise.resolve(currentRunId() ?? ''));
    const bucket = scratchBucketName(runTokenFor(ended), 'one');
    const store = fakeStore([bucket]);

    const report = await reclaimScratchBuckets(store, { registryDir });

    expect(report.dropped).toEqual([bucket]);
    expect(store.removed).toEqual([bucket]);
  });

  it('leaves a bucket standing whose named run is still holding its claim', async () => {
    await run(async () => {
      // Nothing is recorded here on purpose: the name is the whole attribution.
      const bucket = scratchBucketName(runTokenFor(currentRunId() ?? ''), 'one');
      const store = fakeStore([bucket]);

      const report = await reclaimScratchBuckets(store, { registryDir });

      expect(report.dropped).toEqual([]);
      expect(store.removed).toEqual([]);
    });
  });

  it('reports a bucket naming a run the registry never held and leaves it standing', async () => {
    const bucket = scratchBucketName(runTokenFor(crypto.randomUUID()), 'one');
    const store = fakeStore([bucket]);

    const report = await reclaimScratchBuckets(store, { registryDir });

    expect(report.unowned).toEqual([bucket]);
    expect(store.removed).toEqual([]);
  });

  it('reports a bucket of a run that ended before names carried a run id', async () => {
    await run(() => Promise.resolve());
    const store = fakeStore([scratchBucketName(STRANGER_TOKEN, 'one')]);

    const report = await reclaimScratchBuckets(store, { registryDir });

    expect(report.unowned).toEqual([scratchBucketName(STRANGER_TOKEN, 'one')]);
    expect(store.removed).toEqual([]);
  });

  it('reports a bucket no claim accounts for and leaves it standing', async () => {
    const store = fakeStore([scratchBucketName(STRANGER_TOKEN, 'one')]);

    const report = await reclaimScratchBuckets(store, { registryDir });

    expect(report.unowned).toEqual([scratchBucketName(STRANGER_TOKEN, 'one')]);
    expect(store.removed).toEqual([]);
  });

  it('reports a bucket named before buckets carried a run token', async () => {
    const store = fakeStore(['hushbox-scratch-0189a1f2c3d44e5f8a9b0c1d2e3f4a5b']);

    const report = await reclaimScratchBuckets(store, { registryDir });

    expect(report.unowned).toEqual(['hushbox-scratch-0189a1f2c3d44e5f8a9b0c1d2e3f4a5b']);
    expect(store.removed).toEqual([]);
  });

  it('reads the machine-wide registry when none is named', async () => {
    const store = fakeStore([]);

    const report = await reclaimScratchBuckets(store);

    expect(report).toEqual({ dropped: [], unowned: [] });
  });

  it("says a claim may exist and be unreadable while a live run's record could not be read", async () => {
    const warn = vi.spyOn(console, 'warn');
    const store = fakeStore([scratchBucketName(STRANGER_TOKEN, 'one')]);

    const runId = await run(async () => {
      const named = damageOwnRecord();
      await reclaimScratchBuckets(store, { registryDir });
      return named;
    });

    const line = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(line).not.toContain('no claim, live or expired');
    expect(line).toContain(runId);
  });

  it('names an unowned bucket on the console rather than passing it in silence', async () => {
    const warn = vi.spyOn(console, 'warn');
    const store = fakeStore([scratchBucketName(STRANGER_TOKEN, 'one')]);

    await reclaimScratchBuckets(store, { registryDir });

    expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).toContain(STRANGER_TOKEN);
  });
});

describe('the S3 bodies a reclaim pass reads', () => {
  it('reads bucket names past the owner block that precedes them', () => {
    const xml =
      '<ListAllMyBucketsResult><Owner><ID>minio</ID><DisplayName>minio</DisplayName></Owner>' +
      '<Buckets><Bucket><Name>hushbox-media</Name><CreationDate>x</CreationDate></Bucket>' +
      '<Bucket><Name>hushbox-scratch-aaaa11-one</Name></Bucket></Buckets></ListAllMyBucketsResult>';

    expect(parseBucketNames(xml)).toEqual(['hushbox-media', 'hushbox-scratch-aaaa11-one']);
  });

  it('reads no name from a body that lists no bucket', () => {
    expect(parseBucketNames('<ListAllMyBucketsResult><Buckets/></ListAllMyBucketsResult>')).toEqual(
      []
    );
  });

  it('skips a bucket entry carrying no name', () => {
    expect(
      parseBucketNames('<Buckets><Bucket><CreationDate>x</CreationDate></Bucket></Buckets>')
    ).toEqual([]);
  });

  it('skips a listing entry carrying no key', () => {
    expect(
      parseObjectKeys('<ListBucketResult><Contents><Size>1</Size></Contents></ListBucketResult>')
    ).toEqual([]);
  });

  it('reads every object key a listing page carries', () => {
    const xml =
      '<ListBucketResult><Contents><Key>a/b.bin</Key><Size>1</Size></Contents>' +
      '<Contents><Key>c.bin</Key></Contents></ListBucketResult>';

    expect(parseObjectKeys(xml)).toEqual(['a/b.bin', 'c.bin']);
  });
});

describe('requireScratchBucketStore', () => {
  it('refuses to build a store from an environment that carries no endpoint', () => {
    expect(() => requireScratchBucketStore({})).toThrow('R2_S3_ENDPOINT');
  });

  it('refuses to build a store from an environment that carries no credentials', () => {
    expect(() => requireScratchBucketStore({ R2_S3_ENDPOINT: 'http://storage.invalid' })).toThrow(
      'R2_ACCESS_KEY_ID'
    );
  });

  it('refuses a variable present but empty, which carries no more than an absent one', () => {
    expect(() => requireScratchBucketStore({ R2_S3_ENDPOINT: '' })).toThrow('R2_S3_ENDPOINT');
  });
});
