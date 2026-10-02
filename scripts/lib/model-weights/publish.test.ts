import { describe, it, expect, vi } from 'vitest';
import {
  artifactCachePath,
  artifactObjectPath,
  artifactSetFingerprint,
  modelWeightsArtifacts,
  ttsArtifacts,
} from './manifest.js';
import {
  classifyHeadStatus,
  createRemoteProbe,
  emptyStoreNotice,
  humanBytes,
  publishToR2,
  readRemoteProbeConfig,
  seedLocalStore,
} from './publish.js';
import type { ProbeResult, PublishDeps, SeedDeps, SignedFetch } from './publish.js';

const ARTIFACTS = modelWeightsArtifacts();
const OBJECT_PATHS = ARTIFACTS.map((artifact) => artifactObjectPath(artifact));

interface Recorded {
  readonly downloaded: string[];
  readonly uploaded: string[];
  readonly reported: string[];
}

function recorder(): Recorded {
  return { downloaded: [], uploaded: [], reported: [] };
}

/** Deps over a cache that already holds every artifact at its declared size. */
function publishDeps(
  log: Recorded,
  probe: (objectPath: string) => ProbeResult,
  overrides: Partial<PublishDeps> = {}
): PublishDeps {
  return {
    probe: (objectPath) => Promise.resolve(probe(objectPath)),
    cachedBytes: (filePath) =>
      Promise.resolve(
        ARTIFACTS.find((artifact) => artifactCachePath('/cache', artifact) === filePath)?.bytes ??
          null
      ),
    download: (_url, filePath) => {
      log.downloaded.push(filePath);
      return Promise.resolve();
    },
    upload: (objectPath) => {
      log.uploaded.push(objectPath);
      return Promise.resolve();
    },
    report: (message) => log.reported.push(message),
    ...overrides,
  };
}

function seedDeps(log: Recorded, overrides: Partial<SeedDeps> = {}): SeedDeps {
  const { cachedBytes, download, upload, report } = publishDeps(log, () => ({ kind: 'absent' }));
  return {
    cachedBytes,
    download,
    upload,
    report,
    readReceipt: () => Promise.resolve(null),
    writeReceipt: () => Promise.resolve(),
    ...overrides,
  };
}

describe('publishing to the production store', () => {
  it('uploads every object when the store holds none of them', async () => {
    const log = recorder();
    await publishToR2(
      '/cache',
      publishDeps(log, () => ({ kind: 'absent' }))
    );

    expect(log.uploaded).toEqual(OBJECT_PATHS);
  });

  it('uploads nothing when every object is already published', async () => {
    const log = recorder();
    await publishToR2(
      '/cache',
      publishDeps(log, () => ({ kind: 'present' }))
    );

    expect(log.uploaded).toEqual([]);
  });

  it('downloads nothing when every object is already published', async () => {
    const log = recorder();
    await publishToR2(
      '/cache',
      publishDeps(log, () => ({ kind: 'present' }))
    );

    expect(log.downloaded).toEqual([]);
  });

  it('uploads only the objects the store is missing', async () => {
    const log = recorder();
    const missing = OBJECT_PATHS[3];
    await publishToR2(
      '/cache',
      publishDeps(log, (objectPath) =>
        objectPath === missing ? { kind: 'absent' } : { kind: 'present' }
      )
    );

    expect(log.uploaded).toEqual([missing]);
  });

  it('refuses to upload when a probe cannot say whether the object exists', async () => {
    const log = recorder();

    await expect(
      publishToR2(
        '/cache',
        publishDeps(log, (objectPath) =>
          objectPath === OBJECT_PATHS[0]
            ? { kind: 'unknown', detail: 'A request to the Cloudflare API failed.' }
            : { kind: 'absent' }
        )
      )
    ).rejects.toThrow('A request to the Cloudflare API failed.');
  });

  it('uploads nothing at all once a probe is unreadable, rather than the objects it could read', async () => {
    const log = recorder();

    await expect(
      publishToR2(
        '/cache',
        publishDeps(log, (objectPath) =>
          objectPath === OBJECT_PATHS[2]
            ? { kind: 'unknown', detail: 'network' }
            : { kind: 'absent' }
        )
      )
    ).rejects.toThrow();

    expect(log.uploaded).toEqual([]);
  });

  it('downloads only the artifact the cache does not hold', async () => {
    const log = recorder();
    const third = ARTIFACTS[2];
    if (third === undefined) throw new Error('the artifact set is too small for this case');
    const absent = artifactCachePath('/cache', third);
    const held = new Set(
      ARTIFACTS.map((artifact) => artifactCachePath('/cache', artifact)).filter(
        (filePath) => filePath !== absent
      )
    );
    await publishToR2(
      '/cache',
      publishDeps(log, () => ({ kind: 'absent' }), {
        cachedBytes: (filePath) => {
          const bytes =
            ARTIFACTS.find((artifact) => artifactCachePath('/cache', artifact) === filePath)
              ?.bytes ?? null;
          return Promise.resolve(held.has(filePath) ? bytes : null);
        },
        download: (_url, filePath) => {
          log.downloaded.push(filePath);
          held.add(filePath);
          return Promise.resolve();
        },
      })
    );

    expect(log.downloaded).toEqual([absent]);
  });

  it('refuses to publish an artifact that downloaded short', async () => {
    const log = recorder();

    await expect(
      publishToR2(
        '/cache',
        publishDeps(log, () => ({ kind: 'absent' }), {
          cachedBytes: () => Promise.resolve(7),
        })
      )
    ).rejects.toThrow('expected');
  });
});

describe('seeding the local store', () => {
  it('uploads every object when nothing records a previous seed', async () => {
    const log = recorder();
    await seedLocalStore('/cache', seedDeps(log));

    expect(log.uploaded).toEqual(OBJECT_PATHS);
  });

  it('records what it seeded so the next run can recognise it', async () => {
    const writeReceipt = vi.fn<(fingerprint: string) => Promise<void>>().mockResolvedValue();
    await seedLocalStore('/cache', seedDeps(recorder(), { writeReceipt }));

    expect(writeReceipt).toHaveBeenCalledWith(artifactSetFingerprint(ARTIFACTS));
  });

  it('uploads nothing when the recorded seed matches the artifact set', async () => {
    const log = recorder();
    await seedLocalStore(
      '/cache',
      seedDeps(log, { readReceipt: () => Promise.resolve(artifactSetFingerprint(ARTIFACTS)) })
    );

    expect(log.uploaded).toEqual([]);
  });

  it('re-seeds when the recorded seed describes a different artifact set', async () => {
    const log = recorder();
    await seedLocalStore('/cache', seedDeps(log, { readReceipt: () => Promise.resolve('stale') }));

    expect(log.uploaded).toEqual(OBJECT_PATHS);
  });

  it('signs nothing and reaches no network, since a local seed has no remote store to probe', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      await seedLocalStore('/cache', seedDeps(recorder()));

      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('records nothing when an upload fails, so the next run retries', async () => {
    const writeReceipt = vi.fn<(fingerprint: string) => Promise<void>>().mockResolvedValue();

    await expect(
      seedLocalStore(
        '/cache',
        seedDeps(recorder(), {
          upload: () => Promise.reject(new Error('wrangler exited 1')),
          writeReceipt,
        })
      )
    ).rejects.toThrow('wrangler exited 1');

    expect(writeReceipt).not.toHaveBeenCalled();
  });

  it('seeds only the given subset when one is passed, not the full artifact set', async () => {
    const log = recorder();
    const subset = ttsArtifacts();

    await seedLocalStore('/cache', seedDeps(log), subset);

    expect(log.uploaded).toEqual(subset.map((artifact) => artifactObjectPath(artifact)));
    expect(log.uploaded).not.toEqual(OBJECT_PATHS);
  });

  it('fingerprints and records the given subset, not the full artifact set', async () => {
    const writeReceipt = vi.fn<(fingerprint: string) => Promise<void>>().mockResolvedValue();
    const subset = ttsArtifacts();

    await seedLocalStore('/cache', seedDeps(recorder(), { writeReceipt }), subset);

    expect(writeReceipt).toHaveBeenCalledWith(artifactSetFingerprint(subset));
  });
});

describe('the notice a developer gets when the local store stays empty', () => {
  it('carries the cause it was given', () => {
    expect(emptyStoreNotice('getaddrinfo ENOTFOUND huggingface.co')).toContain(
      'getaddrinfo ENOTFOUND huggingface.co'
    );
  });

  it('names the command that repairs it', () => {
    expect(emptyStoreNotice('offline')).toContain('pnpm weights:seed');
  });

  it('says the feature degrades silently, so nothing else will report it', () => {
    expect(emptyStoreNotice('offline')).toMatch(/silent/i);
  });

  it('holds its shape against a cause that arrives as several lines', () => {
    const lines = emptyStoreNotice('first line\n\n  second line').split('\n');

    expect(lines.filter((line) => line.startsWith('  cause:'))).toEqual([
      '  cause:  first line second line',
    ]);
  });

  it('keeps a coloured cause readable, since the tools it quotes write escapes', () => {
    expect(emptyStoreNotice('\u001B[31mred\u001B[0m')).toContain('  cause:  red');
  });
});

describe('reading what an S3 head request answered', () => {
  it('reads a 200 as the object being there', () => {
    expect(classifyHeadStatus(200)).toEqual({ kind: 'present' });
  });

  it('reads a 404 as the object being absent', () => {
    expect(classifyHeadStatus(404)).toEqual({ kind: 'absent' });
  });

  it('reads a refused request as unreadable rather than as absent', () => {
    expect(classifyHeadStatus(403)).toEqual({ kind: 'unknown', detail: 'HTTP 403' });
  });

  it('reads a store-side failure as unreadable rather than as absent', () => {
    expect(classifyHeadStatus(500).kind).toBe('unknown');
  });

  it('reads a redirect as unreadable, since it neither found nor missed the object', () => {
    expect(classifyHeadStatus(301).kind).toBe('unknown');
  });
});

describe('probing the production store over the S3 API', () => {
  const CONFIG = {
    accountId: 'account-under-test',
    accessKeyId: 'key-under-test',
    secretAccessKey: 'secret-under-test',
  };

  interface Issued {
    readonly url: string;
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
  }

  function recordingFetch(status: number): {
    readonly issued: Issued[];
    readonly fetchImpl: SignedFetch;
  } {
    const issued: Issued[] = [];
    return {
      issued,
      fetchImpl: (url, init) => {
        issued.push({ url, method: init.method, headers: init.headers });
        return Promise.resolve({ status });
      },
    };
  }

  it('asks for metadata rather than the object body', async () => {
    const { issued, fetchImpl } = recordingFetch(200);
    await createRemoteProbe(CONFIG, fetchImpl)(OBJECT_PATHS[0] ?? '');

    expect(issued.map((request) => request.method)).toEqual(['HEAD']);
  });

  it('addresses the bucket and key on the account’s own S3 endpoint', async () => {
    const objectPath = OBJECT_PATHS[0] ?? '';
    const { issued, fetchImpl } = recordingFetch(200);
    await createRemoteProbe(CONFIG, fetchImpl)(objectPath);

    expect(issued[0]?.url).toBe(
      `https://account-under-test.r2.cloudflarestorage.com/${objectPath}`
    );
  });

  it('signs the request, since the bucket answers nothing unsigned', async () => {
    const { issued, fetchImpl } = recordingFetch(200);
    await createRemoteProbe(CONFIG, fetchImpl)(OBJECT_PATHS[0] ?? '');

    expect(issued[0]?.headers['authorization']).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it('reads what the store answered', async () => {
    const { fetchImpl } = recordingFetch(404);

    expect(await createRemoteProbe(CONFIG, fetchImpl)(OBJECT_PATHS[0] ?? '')).toEqual({
      kind: 'absent',
    });
  });

  it('reads a network failure as unreadable rather than as absent', async () => {
    const probe = createRemoteProbe(CONFIG, () =>
      Promise.reject(new Error('getaddrinfo ENOTFOUND account.r2.cloudflarestorage.com'))
    );

    expect(await probe(OBJECT_PATHS[0] ?? '')).toEqual({
      kind: 'unknown',
      detail: 'getaddrinfo ENOTFOUND account.r2.cloudflarestorage.com',
    });
  });

  it('reads a signing failure as unreadable, and issues no request at all', async () => {
    const { issued, fetchImpl } = recordingFetch(200);
    const probe = createRemoteProbe({ ...CONFIG, accountId: 'not a host name' }, fetchImpl);
    const result = await probe(OBJECT_PATHS[0] ?? '');

    expect(result.kind).toBe('unknown');
    expect(issued).toEqual([]);
  });
});

describe('the credentials a remote publish reads before it starts', () => {
  const FULL = {
    CLOUDFLARE_ACCOUNT_ID: 'account-under-test',
    R2_ACCESS_KEY_ID: 'key-under-test',
    R2_SECRET_ACCESS_KEY: 'secret-under-test',
  };

  it('reads all three from the environment', () => {
    expect(readRemoteProbeConfig(FULL)).toEqual({
      accountId: 'account-under-test',
      accessKeyId: 'key-under-test',
      secretAccessKey: 'secret-under-test',
    });
  });

  it('names every missing variable at once, rather than the first one only', () => {
    expect(() => readRemoteProbeConfig({})).toThrow(
      /CLOUDFLARE_ACCOUNT_ID.*R2_ACCESS_KEY_ID.*R2_SECRET_ACCESS_KEY/s
    );
  });

  it('treats an empty value as missing, which is what an unset secret expands to', () => {
    expect(() => readRemoteProbeConfig({ ...FULL, R2_SECRET_ACCESS_KEY: '' })).toThrow(
      'R2_SECRET_ACCESS_KEY'
    );
  });
});

describe('rendering an artifact size for a human', () => {
  it('reads a large artifact in megabytes', () => {
    expect(humanBytes(135_658_354)).toBe('136 MB');
  });

  it('reads a small artifact in kilobytes rather than as zero megabytes', () => {
    expect(humanBytes(3794)).toBe('4 KB');
  });

  it('reads a sub-kilobyte artifact in bytes rather than as zero kilobytes', () => {
    expect(humanBytes(132)).toBe('132 B');
  });
});
