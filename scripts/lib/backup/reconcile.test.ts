import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { AwsClient } from 'aws4fetch';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { INPUTS_PREFIX } from '@hushbox/shared';
import { expectExposes } from '@hushbox/shared/test-assertions';

import {
  createRusticRunner,
  ReconcileMismatchError,
  parseListPage,
  runnerFor,
  SpotCheckMismatchError,
  digestOfCommand,
  jsonOfCommand,
  digestOfStream,
  excludedPrefixFor,
  formatSummary,
  listBucket,
  readRepoInfo,
  readSnapshotTotals,
  reconcile,
  selectNewestSnapshot,
  snapshotObjectKeys,
  spotCheckObject,
  writeStepSummary,
} from './reconcile.js';
import type { RusticRunner } from './reconcile.js';

const CLIENT = new AwsClient({
  accessKeyId: 'fixture-access-key-id',
  secretAccessKey: 'fixture-secret-access-key',
  service: 's3',
  region: 'auto',
});

const BUCKET = { endpoint: 'https://accountid.r2.cloudflarestorage.com', name: 'hushbox-media' };

/** One `<Contents>` block per entry, in the shape S3 and R2 both answer with. */
function listingXml(entries: readonly { key: string; size: number }[], nextToken?: string): string {
  const contents = entries
    .map(
      ({ key, size }) =>
        `<Contents><Key>${key}</Key><Size>${String(size)}</Size>` +
        `<ETag>&quot;d41d8cd9&quot;</ETag></Contents>`
    )
    .join('');
  const truncation =
    nextToken === undefined
      ? '<IsTruncated>false</IsTruncated>'
      : `<IsTruncated>true</IsTruncated><NextContinuationToken>${nextToken}</NextContinuationToken>`;
  return `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>${contents}${truncation}</ListBucketResult>`;
}

function respondWith(...bodies: readonly string[]): ReturnType<typeof vi.fn> {
  const queue = [...bodies];
  return vi.fn(() => {
    const body = queue.shift();
    if (body === undefined) throw new Error('the test stub was called more times than it answers');
    return Promise.resolve(new Response(body, { status: 200 }));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listBucket', () => {
  it('totals the count and the bytes of one page', async () => {
    vi.stubGlobal(
      'fetch',
      respondWith(
        listingXml([
          { key: 'a1b2c3d4', size: 4096 },
          { key: 'f6e5d4c3', size: 8192 },
        ])
      )
    );

    await expect(listBucket(CLIENT, BUCKET)).resolves.toStrictEqual({ count: 2, bytes: 12_288 });
  });

  it('follows the continuation token until the listing is complete', async () => {
    const fetchImpl = respondWith(
      listingXml([{ key: 'a1b2c3d4', size: 4096 }], 'page-two-token'),
      listingXml([{ key: 'f6e5d4c3', size: 8192 }])
    );
    vi.stubGlobal('fetch', fetchImpl);

    await expect(listBucket(CLIENT, BUCKET)).resolves.toStrictEqual({ count: 2, bytes: 12_288 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((fetchImpl.mock.calls[1]?.[0] as Request).url).toContain(
      'continuation-token=page-two-token'
    );
  });

  it('leaves out the keys under the excluded prefix', async () => {
    vi.stubGlobal(
      'fetch',
      respondWith(
        listingXml([
          { key: 'a1b2c3d4', size: 4096 },
          { key: 'inputs/staged', size: 1024 },
        ])
      )
    );

    await expect(listBucket(CLIENT, BUCKET, 'inputs/')).resolves.toStrictEqual({
      count: 1,
      bytes: 4096,
    });
  });

  it('fails the run when the store refuses the listing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('denied', { status: 403 })))
    );

    await expect(listBucket(CLIENT, BUCKET)).rejects.toThrow('403');
  });
});

/**
 * The captured output of one real `rustic snapshots --json` run: four labels,
 * `media` twice, the newer of the two taken under the exclusion so that it
 * holds one file fewer than the older. Only the instants and the recorded
 * command line were rewritten in it, and only to keep a clock reading and a
 * machine's paths out of the repository.
 */
async function snapshotsFixture(): Promise<unknown> {
  return JSON.parse(
    await readFile(new URL('fixtures/rustic-snapshots.json', import.meta.url), 'utf8')
  ) as unknown;
}

/** What the fixture's newest `media` snapshot recorded. */
const MEDIA_NEWEST = { count: 2, bytes: 12_288 };
const APP_BUILDS = { count: 1, bytes: 2048 };
const MODEL_WEIGHTS = { count: 1, bytes: 16_384 };

function runnerReturning(output: unknown): RusticRunner {
  return {
    json: vi.fn(() => Promise.resolve(output)),
    digest: vi.fn(() => Promise.resolve(digestOf(new Uint8Array()))),
  };
}

const BUCKETS = {
  media: 'hushbox-media',
  'app-builds': 'hushbox-app-builds',
  'model-weights': 'hushbox-model-weights',
} as const;

/** Answers each bucket's listing with the entries that bucket is given. */
function listingsByBucket(
  entries: Readonly<Record<string, readonly { key: string; size: number }[]>>
): ReturnType<typeof vi.fn> {
  return vi.fn((request: Request) => {
    const bucket = Object.keys(entries).find((name) => request.url.includes(name));
    if (bucket === undefined)
      throw new Error(`the test stub answers no listing for ${request.url}`);
    return Promise.resolve(new Response(listingXml(entries[bucket] ?? []), { status: 200 }));
  });
}

const MATCHING_LISTINGS = {
  'hushbox-media': [
    { key: 'a1b2c3d4e5f6', size: 4096 },
    { key: 'f6e5d4c3b2a1', size: 8192 },
    { key: 'inputs/staged-object', size: 1024 },
  ],
  'hushbox-app-builds': [{ key: '9f8e7d6c', size: 2048 }],
  'hushbox-model-weights': [{ key: '0a1b2c3d', size: 16_384 }],
} as const;

function reconcileOptions(runner: RusticRunner): Parameters<typeof reconcile>[0] {
  return {
    rusticPath: 'rustic',
    configPath: 'rustic.toml',
    client: CLIENT,
    endpoint: BUCKET.endpoint,
    buckets: BUCKETS,
    runner,
  };
}

describe('selectNewestSnapshot', () => {
  it('reads the totals and the id of the newest snapshot carrying the label', async () => {
    const newest = selectNewestSnapshot(await snapshotsFixture(), 'media');

    expect(newest).toStrictEqual({ ...MEDIA_NEWEST, id: newest.id });
    expect(newest.id).toMatch(/^7b3f4c4f/);
  });

  it('chooses by the recorded instant rather than by position in the output', async () => {
    const captured = (await snapshotsFixture()) as { snapshots: unknown[] }[];
    const reversed = captured.map((group) => ({
      ...group,
      snapshots: group.snapshots.toReversed(),
    }));

    const newest = selectNewestSnapshot(reversed, 'media');

    expect(newest).toStrictEqual({ ...MEDIA_NEWEST, id: newest.id });
    expect(newest.id).toMatch(/^7b3f4c4f/);
  });

  it('fails on a snapshot whose recorded instant cannot be read', async () => {
    const captured = (await snapshotsFixture()) as {
      snapshots: { time: string; label: string }[];
    }[];
    const firstGroup = captured[0];
    const firstSnapshot = firstGroup?.snapshots[0];
    if (firstGroup === undefined || firstSnapshot === undefined) {
      throw new Error('the captured listing holds no snapshot');
    }
    firstSnapshot.time = 'the day before yesterday';

    expect(() => selectNewestSnapshot(captured, firstGroup.snapshots[0]?.label ?? '')).toThrow(
      'no readable time'
    );
  });

  it('fails when no snapshot carries the label', async () => {
    const captured = await snapshotsFixture();

    expect(() => selectNewestSnapshot(captured, 'app-icons')).toThrow('app-icons');
  });
});

describe('readSnapshotTotals', () => {
  it('asks rustic for the snapshot listing and returns the newest of the label', async () => {
    const runner = runnerReturning(await snapshotsFixture());

    const totals = await readSnapshotTotals('rustic', 'rustic.toml', 'model-weights', runner);

    expect(totals).toStrictEqual({ ...MODEL_WEIGHTS, id: totals.id });
    expect(totals.id).toMatch(/^61172851/);
    expect(runner.json).toHaveBeenCalledWith(['snapshots', '--json']);
  });
});

describe('excludedPrefixFor', () => {
  it('excludes the staging prefix from the media bucket and nothing from the others', () => {
    expect(excludedPrefixFor('media')).toBe(INPUTS_PREFIX);
    expect(excludedPrefixFor('app-builds')).toBeUndefined();
    expect(excludedPrefixFor('model-weights')).toBeUndefined();
  });
});

describe('reconcile', () => {
  it('agrees on every object label when each bucket lists what its snapshot took', async () => {
    vi.stubGlobal('fetch', listingsByBucket(MATCHING_LISTINGS));

    const results = await reconcile(reconcileOptions(runnerReturning(await snapshotsFixture())));

    expect(results.map((result) => result.label)).toStrictEqual([
      'media',
      'app-builds',
      'model-weights',
    ]);
    expect(results.map((result) => result.totals)).toStrictEqual([
      MEDIA_NEWEST,
      APP_BUILDS,
      MODEL_WEIGHTS,
    ]);
  });

  it('leaves the staging prefix out of the bucket side, as the snapshot leaves it out', async () => {
    vi.stubGlobal(
      'fetch',
      listingsByBucket({
        ...MATCHING_LISTINGS,
        'hushbox-media': [
          ...MATCHING_LISTINGS['hushbox-media'],
          { key: `${INPUTS_PREFIX}second-staged-object`, size: 64 },
        ],
      })
    );

    const results = await reconcile(reconcileOptions(runnerReturning(await snapshotsFixture())));

    expect(results[0]?.totals).toStrictEqual(MEDIA_NEWEST);
  });

  it('fails, naming the label and both counts, when the bucket holds an object the snapshot missed', async () => {
    vi.stubGlobal(
      'fetch',
      listingsByBucket({
        ...MATCHING_LISTINGS,
        'hushbox-app-builds': [
          ...MATCHING_LISTINGS['hushbox-app-builds'],
          { key: '1122334455', size: 512 },
        ],
      })
    );

    await expect(
      reconcile(reconcileOptions(runnerReturning(await snapshotsFixture())))
    ).rejects.toThrow(ReconcileMismatchError);
  });

  it('names the label and both figures in the mismatch it throws', async () => {
    vi.stubGlobal(
      'fetch',
      listingsByBucket({
        ...MATCHING_LISTINGS,
        'hushbox-model-weights': [{ key: '0a1b2c3d', size: 8192 }],
      })
    );

    const failure = await reconcile(
      reconcileOptions(runnerReturning(await snapshotsFixture()))
    ).catch((error: unknown) => error);

    expect(String(failure)).toContain('model-weights');
    expect(String(failure)).toContain('16384');
    expect(String(failure)).toContain('8192');
  });
});

/** The captured output of one real `rustic ls <snapshot> --json` run. */
async function lsFixture(name: string): Promise<string[]> {
  return JSON.parse(
    await readFile(new URL(`fixtures/${name}`, import.meta.url), 'utf8')
  ) as string[];
}

function digestOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface SpotCheckRunner extends RusticRunner {
  /** The arguments of every dump, so a test can read which object was drawn. */
  readonly dumped: string[][];
}

/** A runner that answers the snapshot listing, the object listing and one dump. */
function spotCheckRunner(
  snapshots: unknown,
  paths: readonly string[],
  bytes: Uint8Array
): SpotCheckRunner {
  const dumped: string[][] = [];
  return {
    json: (args) => Promise.resolve(args[0] === 'snapshots' ? snapshots : paths),
    digest: (args) => {
      dumped.push([...args]);
      return Promise.resolve(digestOf(bytes));
    },
    dumped,
  };
}

const SPOT_CHECK_TARGET = {
  rusticPath: 'rustic',
  configPath: 'rustic.toml',
  client: CLIENT,
  label: 'media',
  bucket: BUCKET,
  excludePrefix: INPUTS_PREFIX,
} as const;

const SNAPSHOT_BYTES = new TextEncoder().encode('the bytes the snapshot restored');
const LIVE_BYTES = new TextEncoder().encode('the bytes the live object holds');

describe('snapshotObjectKeys', () => {
  it('keeps the objects of a captured listing and drops its directories', async () => {
    expect(
      snapshotObjectKeys(await lsFixture('rustic-ls-media.json'), 'media', INPUTS_PREFIX)
    ).toStrictEqual(['a1b2c3d4e5f6', 'f6e5d4c3b2a1']);
  });

  it('drops every path some other path is nested under', () => {
    const paths = ['media', 'media/2026', 'media/2026/09', 'media/2026/09/a1b2c3d4'];

    expect(snapshotObjectKeys(paths, 'media')).toStrictEqual(['2026/09/a1b2c3d4']);
  });

  it('holds nothing for a snapshot that took no object', async () => {
    expect(snapshotObjectKeys(await lsFixture('rustic-ls-empty.json'), 'app-builds')).toStrictEqual(
      []
    );
  });
});

describe('spotCheckObject', () => {
  it('passes when the restored bytes hash to what the live object hashes to', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(SNAPSHOT_BYTES, { status: 200 })))
    );

    await expect(
      spotCheckObject({
        ...SPOT_CHECK_TARGET,
        runner: spotCheckRunner(
          await snapshotsFixture(),
          await lsFixture('rustic-ls-media.json'),
          SNAPSHOT_BYTES
        ),
        random: () => 0,
      })
    ).resolves.toStrictEqual({ label: 'media', status: 'passed' });
  });

  it('reaches every candidate object as the random draw moves', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(SNAPSHOT_BYTES, { status: 200 })))
    );
    const drawn: string[] = [];
    for (const draw of [0, 0.99]) {
      const runner = spotCheckRunner(
        await snapshotsFixture(),
        await lsFixture('rustic-ls-media.json'),
        SNAPSHOT_BYTES
      );
      await spotCheckObject({ ...SPOT_CHECK_TARGET, runner, random: () => draw });
      drawn.push(String(runner.dumped[0]?.[1]));
    }

    expect(drawn).toStrictEqual([
      expect.stringContaining('media/a1b2c3d4e5f6'),
      expect.stringContaining('media/f6e5d4c3b2a1'),
    ]);
  });

  it('draws with the platform randomness when the caller pins none', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(SNAPSHOT_BYTES, { status: 200 })))
    );

    await expect(
      spotCheckObject({
        ...SPOT_CHECK_TARGET,
        runner: spotCheckRunner(
          await snapshotsFixture(),
          ['media', 'media/a1b2c3d4e5f6'],
          SNAPSHOT_BYTES
        ),
      })
    ).resolves.toStrictEqual({ label: 'media', status: 'passed' });
  });

  it('fails with both digests, and with neither the key nor a byte of either object', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(LIVE_BYTES, { status: 200 })))
    );

    const failure = await spotCheckObject({
      ...SPOT_CHECK_TARGET,
      runner: spotCheckRunner(
        await snapshotsFixture(),
        await lsFixture('rustic-ls-media.json'),
        SNAPSHOT_BYTES
      ),
      random: () => 0,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SpotCheckMismatchError);
    const message = String(failure);
    expect(message).toContain(digestOf(SNAPSHOT_BYTES));
    expect(message).toContain(digestOf(LIVE_BYTES));
    expect(message).toContain('media');
    expect(message).not.toContain('a1b2c3d4e5f6');
    expect(message).not.toContain('the bytes');
  });

  it('skips an object the store no longer holds, which a deletion since the snapshot leaves', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('', { status: 404 })))
    );

    const check = await spotCheckObject({
      ...SPOT_CHECK_TARGET,
      runner: spotCheckRunner(
        await snapshotsFixture(),
        await lsFixture('rustic-ls-media.json'),
        SNAPSHOT_BYTES
      ),
      random: () => 0,
    });

    expect(check.status).toBe('skipped');
    expect(check.reason).toContain('deleted');
  });

  it('skips a snapshot that took no object', async () => {
    const check = await spotCheckObject({
      rusticPath: 'rustic',
      configPath: 'rustic.toml',
      client: CLIENT,
      label: 'app-builds',
      bucket: BUCKET,
      runner: spotCheckRunner(
        await snapshotsFixture(),
        await lsFixture('rustic-ls-empty.json'),
        SNAPSHOT_BYTES
      ),
      random: () => 0,
    });

    expect(check).toStrictEqual({
      label: 'app-builds',
      status: 'skipped',
      reason: 'the snapshot holds no object',
    });
  });

  it('fails the run when the store refuses the read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('denied', { status: 403 })))
    );

    await expect(
      spotCheckObject({
        ...SPOT_CHECK_TARGET,
        runner: spotCheckRunner(
          await snapshotsFixture(),
          await lsFixture('rustic-ls-media.json'),
          SNAPSHOT_BYTES
        ),
        random: () => 0,
      })
    ).rejects.toThrow('403');
  });

  it('reads the live object as a stream rather than holding it whole', async () => {
    const response = new Response(new Response(SNAPSHOT_BYTES).body, { status: 200 });
    Object.defineProperty(response, 'arrayBuffer', {
      value: (): never => {
        throw new Error('an object of up to a quarter gigabyte must not be buffered');
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response))
    );

    await expect(
      spotCheckObject({
        ...SPOT_CHECK_TARGET,
        runner: spotCheckRunner(
          await snapshotsFixture(),
          await lsFixture('rustic-ls-media.json'),
          SNAPSHOT_BYTES
        ),
        random: () => 0,
      })
    ).resolves.toStrictEqual({ label: 'media', status: 'passed' });
  });

  it('fails the run when the store answers a read with no body at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 200 })))
    );

    await expect(
      spotCheckObject({
        ...SPOT_CHECK_TARGET,
        runner: spotCheckRunner(
          await snapshotsFixture(),
          await lsFixture('rustic-ls-media.json'),
          SNAPSHOT_BYTES
        ),
        random: () => 0,
      })
    ).rejects.toThrow('no body');
  });
});

describe('readRepoInfo', () => {
  it('reads the logical and the stored size of a captured repository report', async () => {
    const captured = JSON.parse(
      await readFile(new URL('fixtures/rustic-repoinfo.json', import.meta.url), 'utf8')
    ) as unknown;
    const runner = runnerReturning(captured);

    // The four sources hold 32275 bytes of file content between them, which is
    // what the data blobs unpack to; the trees carry the rest.
    await expect(readRepoInfo('rustic', 'rustic.toml', runner)).resolves.toStrictEqual({
      logicalBytes: 36_975,
      storedBytes: 35_333,
    });
    expect(runner.json).toHaveBeenCalledWith(['repoinfo', '--json']);
  });
});

describe('formatSummary', () => {
  const SPOT_CHECKS = [
    { label: 'media', status: 'passed' },
    { label: 'app-builds', status: 'passed' },
    { label: 'model-weights', status: 'skipped', reason: 'the snapshot holds no object' },
  ] as const;

  it('states the sizes, the ratio, the checks and the drill on one line', () => {
    const line = formatSummary({
      logicalBytes: 16_119,
      storedBytes: 14_891,
      reconciled: true,
      spotChecks: SPOT_CHECKS,
      drillPassed: true,
    });

    expect(line).not.toContain('\n');
    expect(line).toContain('16119');
    expect(line).toContain('14891');
    expect(line).toContain('0.92');
    expect(line).toContain('2 passed');
    expect(line).toContain('1 skipped');
    expect(line).toContain('drill passed');
  });

  it('says the drill did not run on an hour that runs none', () => {
    const line = formatSummary({
      logicalBytes: 16_119,
      storedBytes: 14_891,
      reconciled: true,
      spotChecks: SPOT_CHECKS,
    });

    expect(line).toContain('drill not run');
  });

  it('says so when the objects were not reconciled', () => {
    const line = formatSummary({
      logicalBytes: 0,
      storedBytes: 0,
      reconciled: false,
      spotChecks: [],
      drillPassed: false,
    });

    expect(line).toContain('not reconciled');
    expect(line).toContain('drill failed');
  });
});

describe('writeStepSummary', () => {
  it('appends the line to the file the runner names', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'hushbox-summary-'));
    const file = path.join(directory, 'summary.md');
    vi.stubEnv('GITHUB_STEP_SUMMARY', file);

    try {
      writeStepSummary('- backup: one line');

      await expect(readFile(file, 'utf8')).resolves.toBe('- backup: one line\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  });

  it('prints the line when the variable is absent', () => {
    const named = process.env['GITHUB_STEP_SUMMARY'];
    delete process.env['GITHUB_STEP_SUMMARY'];
    const printed = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      writeStepSummary('- backup: one line');

      expect(printed).toHaveBeenCalledWith('- backup: one line\n');
    } finally {
      printed.mockRestore();
      if (named !== undefined) process.env['GITHUB_STEP_SUMMARY'] = named;
    }
  });

  it('prints the line when the variable is empty', () => {
    vi.stubEnv('GITHUB_STEP_SUMMARY', '');
    const printed = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      writeStepSummary('- backup: one line');

      expect(printed).toHaveBeenCalledWith('- backup: one line\n');
    } finally {
      printed.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});

describe('parseListPage', () => {
  it('refuses a Contents block that names no Size, rather than undercounting the bucket', () => {
    expect(() =>
      parseListPage('<ListBucketResult><Contents><Key>a1b2c3d4</Key></Contents></ListBucketResult>')
    ).toThrow('no Key or no Size');
  });

  it('refuses a Size that is not a whole number of bytes', () => {
    expect(() =>
      parseListPage(
        '<ListBucketResult><Contents><Key>a1b2c3d4</Key><Size>many</Size></Contents></ListBucketResult>'
      )
    ).toThrow('not a whole number');
  });

  it('ends the walk when a truncated page names no continuation token', () => {
    expect(
      parseListPage('<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>')
    ).toStrictEqual({ count: 0, bytes: 0, nextToken: undefined });
  });
});

describe('runnerFor', () => {
  it('takes the runner it is given', () => {
    const given = runnerReturning([]);

    expect(runnerFor('rustic', 'rustic.toml', given)).toBe(given);
  });

  it('builds one over the binary and the profile when it is given none', () => {
    expectExposes(runnerFor('rustic', 'rustic.toml'), 'json', 'digest');
  });
});

describe('digestOfStream', () => {
  it('hashes the chunks of a stream as the one document they make', async () => {
    const halves = Readable.from([
      new TextEncoder().encode('the first half of '),
      new TextEncoder().encode('one restored object'),
    ]);

    await expect(digestOfStream(halves)).resolves.toBe(
      digestOf(new TextEncoder().encode('the first half of one restored object'))
    );
  });

  it('hashes a stream that carries no bytes, which a zero-byte object is', async () => {
    await expect(digestOfStream(Readable.from([]))).resolves.toBe(digestOf(new Uint8Array()));
  });
});

/**
 * A megabyte at a time, past both sizes that matter: the 100,000,000-byte
 * ceiling the subprocess library buffers stdout at by default, and the largest
 * object the model-weights bucket holds today. A single media object may reach
 * `MAX_MEDIA_OBJECT_BYTES`, larger again — the streamed hash has no size bound
 * at all, and this only has to be past the bound it replaced.
 */
const BLOCK_BYTES = 1_048_576;
const BLOCKS_PAST_THE_BUFFER_CEILING = 160;

/** A program that writes that many blocks to stdout, honouring backpressure. */
const WRITE_BLOCKS = [
  `const block = Buffer.alloc(${String(BLOCK_BYTES)}, 7);`,
  `let written = 0;`,
  `const pump = () => {`,
  `  while (written < ${String(BLOCKS_PAST_THE_BUFFER_CEILING)}) {`,
  `    written += 1;`,
  `    if (!process.stdout.write(block)) { process.stdout.once('drain', pump); return; }`,
  `  }`,
  `};`,
  `pump();`,
].join('\n');

describe('digestOfCommand', () => {
  it('hashes an output larger than the subprocess library will buffer', async () => {
    const expected = createHash('sha256');
    const block = Buffer.alloc(BLOCK_BYTES, 7);
    for (let written = 0; written < BLOCKS_PAST_THE_BUFFER_CEILING; written += 1) {
      expected.update(block);
    }

    await expect(digestOfCommand(process.execPath, ['-e', WRITE_BLOCKS])).resolves.toBe(
      expected.digest('hex')
    );
  }, 120_000);

  it('names neither the arguments nor the output of a command that fails', async () => {
    const failure = await digestOfCommand(process.execPath, [
      '-e',
      'process.stdout.write("a1b2c3d4e5f6"); process.exit(3);',
    ]).catch((error: unknown) => error);

    const message = String(failure);
    expect(message).toContain('3');
    expect(message).not.toContain('a1b2c3d4e5f6');
    expect(message).not.toContain(process.execPath);
    expect(message).not.toContain('-e');
  });

  it('fails rather than waits when the command is not there to run', async () => {
    const missing = path.join(tmpdir(), 'hushbox-no-such-rustic');

    await expect(digestOfCommand(missing, ['dump', 'a1b2c3d4e5f6'])).rejects.toThrow(
      'the command did not start'
    );
  });
});

/** Stands in for a media key: long, opaque, and the thing that must not leak. */
const KEYLIKE = 'media/a1b2c3d4e5f6-fixture-object-key';

/**
 * The leading run of the key. The assertions read this rather than the whole
 * key because the runtime's own parse failure quotes only the first characters
 * of what it could not read — ten characters of a key is still a key leaked,
 * and a whole-key assertion would pass over it.
 */
const KEY_HEAD = KEYLIKE.slice(0, 10);

/** A node program that writes a listing carrying that key, then does `tail`. */
function writesListing(tail: string): string {
  return `process.stdout.write(JSON.stringify(['media', ${JSON.stringify(KEYLIKE)}])); ${tail}`;
}

/**
 * What the failure states on its own. The negative needles below go to
 * {@link everythingAbout}; a positive one belongs here, because the stack that
 * function folds in carries the paths of the files the call ran through, so a
 * short needle can be satisfied by a module path rather than by anything this
 * code wrote.
 */
function messageOf(failure: unknown): string {
  return (failure as Error).message;
}

/** Everything a reader of the failure can see: message, stack, own properties. */
function everythingAbout(failure: unknown): string {
  const error = failure as Error;
  return [
    error.message,
    error.stack ?? '',
    JSON.stringify(error, Object.getOwnPropertyNames(error)),
  ].join('\n');
}

describe('jsonOfCommand', () => {
  it('parses the document a command writes', async () => {
    await expect(
      jsonOfCommand({
        command: process.execPath,
        args: ['-e', 'process.stdout.write(JSON.stringify({ ok: 1 }));'],
        subcommand: 'repoinfo',
      })
    ).resolves.toEqual({ ok: 1 });
  });

  it('names neither the listing nor the executable of a command that fails', async () => {
    const failure = await jsonOfCommand({
      command: process.execPath,
      args: ['-e', writesListing('process.exit(1);')],
      subcommand: 'ls',
    }).catch((error: unknown) => error);

    const seen = everythingAbout(failure);
    expect(seen).not.toContain(KEY_HEAD);
    expect(seen).not.toContain(process.execPath);
    expect((failure as Error).cause).toBeUndefined();
    expect(messageOf(failure)).toContain("reading 'ls'");
    expect(messageOf(failure)).toContain('exit code 1');
  });

  it('names neither the listing nor the executable when the output passes the ceiling', async () => {
    const failure = await jsonOfCommand({
      command: process.execPath,
      args: ['-e', writesListing('')],
      subcommand: 'ls',
      limit: 8,
    }).catch((error: unknown) => error);

    const seen = everythingAbout(failure);
    expect(seen).not.toContain(KEY_HEAD);
    expect(seen).not.toContain(process.execPath);
    expect((failure as Error).cause).toBeUndefined();
    expect(messageOf(failure)).toContain("reading 'ls'");
    expect(messageOf(failure)).toContain('the output passes the ceiling');
  });

  it('names neither the listing nor the executable when the output is not a document', async () => {
    const failure = await jsonOfCommand({
      command: process.execPath,
      args: ['-e', `process.stdout.write(${JSON.stringify(KEYLIKE)});`],
      subcommand: 'ls',
    }).catch((error: unknown) => error);

    const seen = everythingAbout(failure);
    expect(seen).not.toContain(KEY_HEAD);
    expect((failure as Error).cause).toBeUndefined();
    expect(messageOf(failure)).toContain("reading 'ls'");
    expect(messageOf(failure)).toContain('the output is not a document');
  });
});

/** Shaped like a rustic snapshot id: the argument the listing call carries. */
const SNAPSHOT_ID = '3a7f1c9e5b2d48069acf13e5b7d20984c6ff31ab5d7e0c92a41b8f63de205714';

describe('createRusticRunner', () => {
  it('names the subcommand of a listing that fails and no other part of the call', async () => {
    const missing = path.join(tmpdir(), 'hushbox-no-such-rustic');
    const runner = createRusticRunner(missing, 'backup-profile.toml');

    const failure = await runner
      .json(['ls', SNAPSHOT_ID, '--json'])
      .catch((error: unknown) => error);

    const seen = everythingAbout(failure);
    expect(messageOf(failure)).toContain("reading 'ls'");
    expect(messageOf(failure)).toContain('the command did not start');
    expect(seen).not.toContain(SNAPSHOT_ID);
    expect(seen).not.toContain('backup-profile.toml');
    expect(seen).not.toContain(missing);
  });

  it('says so when the call carries no subcommand to name', async () => {
    const missing = path.join(tmpdir(), 'hushbox-no-such-rustic');

    const failure = await createRusticRunner(missing, 'backup-profile.toml')
      .json([])
      .catch((error: unknown) => error);

    expect(everythingAbout(failure)).toContain('no subcommand');
  });
});
