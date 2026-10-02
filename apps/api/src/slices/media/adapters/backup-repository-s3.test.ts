import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOUR_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import {
  createBackupRepositoryReader,
  createBackupRepositoryReaderFromEnv,
} from './backup-repository-s3.js';
import type { BackupRepositoryConfig, BackupRepositoryEnv } from './backup-repository-s3.js';

const NOW = new Date(TEST_DAY_START + 12 * HOUR_MS);

function config(overrides: Partial<BackupRepositoryConfig> = {}): BackupRepositoryConfig {
  return {
    endpoint: 'https://s3.example-region.backblazeb2.com',
    region: 'example-region',
    bucket: 'hushbox-backup',
    repositoryRoot: 'repository',
    accessKeyId: 'unit-test-key',
    secretAccessKey: 'unit-test-secret',
    ...overrides,
  };
}

function listing(objects: { key: string; iso: string }[], nextToken?: string): string {
  const contents = objects
    .map(
      (object) =>
        `<Contents><Key>${object.key}</Key><LastModified>${object.iso}</LastModified><Size>1</Size></Contents>`
    )
    .join('');
  const truncated =
    nextToken === undefined
      ? '<IsTruncated>false</IsTruncated>'
      : `<IsTruncated>true</IsTruncated><NextContinuationToken>${nextToken}</NextContinuationToken>`;
  return `<ListBucketResult>${contents}${truncated}</ListBucketResult>`;
}

function lifecycle(days: number): string {
  return `<LifecycleConfiguration><Rule><ID>expire</ID><Filter><Prefix>repository/</Prefix></Filter><Status>Enabled</Status><NoncurrentVersionExpiration><NoncurrentDays>${String(days)}</NoncurrentDays></NoncurrentVersionExpiration></Rule></LifecycleConfiguration>`;
}

function requestUrls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map((call) => (call[0] as Request).url);
}

describe('createBackupRepositoryReader config validation', () => {
  it.each(['endpoint', 'region', 'bucket', 'accessKeyId', 'secretAccessKey'] as const)(
    'throws when %s is empty',
    (field) => {
      expect(() => createBackupRepositoryReader(config({ [field]: '' }))).toThrow(field);
    }
  );

  it('states the repository prefix it addresses, closed with a separator', () => {
    expect(createBackupRepositoryReader(config()).repositoryPrefix).toBe('repository/');
  });

  it('accepts an empty repository root, which addresses the whole bucket', () => {
    expect(createBackupRepositoryReader(config({ repositoryRoot: '' })).repositoryPrefix).toBe('');
  });
});

describe('newestSnapshotAt', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists the snapshot prefix inside the repository root', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(listing([]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const listed = await createBackupRepositoryReader(config()).newestSnapshotAt();
    expect(listed.isOk()).toBe(true);

    const url = new URL(requestUrls(fetchMock)[0] ?? '');
    expect(url.origin + url.pathname).toBe(
      'https://s3.example-region.backblazeb2.com/hushbox-backup'
    );
    expect(url.searchParams.get('list-type')).toBe('2');
    expect(url.searchParams.get('prefix')).toBe('repository/snapshots/');
  });

  it('returns the newest LastModified across the listing', async () => {
    const body = listing([
      { key: 'repository/snapshots/a', iso: isoAt(TEST_DAY_START) },
      { key: 'repository/snapshots/b', iso: isoAt(TEST_DAY_START + 5 * HOUR_MS) },
      { key: 'repository/snapshots/c', iso: isoAt(TEST_DAY_START + 2 * HOUR_MS) },
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })));

    const result = await createBackupRepositoryReader(config()).newestSnapshotAt();

    expect(result._unsafeUnwrap()).toEqual(new Date(TEST_DAY_START + 5 * HOUR_MS));
  });

  it('returns nothing when the repository holds no snapshot', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(listing([]), { status: 200 })));

    const result = await createBackupRepositoryReader(config()).newestSnapshotAt();

    expect(result._unsafeUnwrap()).toBeNull();
  });

  it('follows the continuation token so a truncated listing cannot hide the newest', async () => {
    const first = listing([{ key: 'repository/snapshots/a', iso: isoAt(TEST_DAY_START) }], 'more');
    const second = listing([
      { key: 'repository/snapshots/b', iso: isoAt(TEST_DAY_START + 9 * HOUR_MS) },
    ]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(first, { status: 200 }))
      .mockResolvedValueOnce(new Response(second, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await createBackupRepositoryReader(config()).newestSnapshotAt();

    expect(result._unsafeUnwrap()).toEqual(new Date(TEST_DAY_START + 9 * HOUR_MS));
    expect(new URL(requestUrls(fetchMock)[1] ?? '').searchParams.get('continuation-token')).toBe(
      'more'
    );
  });

  it('turns a refused listing into an error result rather than a throw', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('denied', { status: 403 })));

    const result = await createBackupRepositoryReader(config()).newestSnapshotAt();

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('turns a transport failure into an error result rather than a throw', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket closed')));

    const result = await createBackupRepositoryReader(config()).newestSnapshotAt();

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('carries no response body into the error it reports', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('<Error><Key>secret-key-name</Key></Error>', { status: 403 })
        )
    );

    const result = await createBackupRepositoryReader(config()).newestSnapshotAt();

    expect(JSON.stringify(result._unsafeUnwrapErr())).not.toContain('secret-key-name');
  });
});

describe('lifecycleRules', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks the bucket for its lifecycle configuration', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(lifecycle(30), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const read = await createBackupRepositoryReader(config()).lifecycleRules();
    expect(read.isOk()).toBe(true);

    const url = new URL(requestUrls(fetchMock)[0] ?? '');
    expect(url.origin + url.pathname).toBe(
      'https://s3.example-region.backblazeb2.com/hushbox-backup'
    );
    expect(url.searchParams.has('lifecycle')).toBe(true);
  });

  it('returns the rules the configuration carries', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(lifecycle(30), { status: 200 })));

    const result = await createBackupRepositoryReader(config()).lifecycleRules();

    expect(result._unsafeUnwrap()).toEqual([{ prefix: 'repository/', noncurrentDays: 30 }]);
  });

  it('reads a bucket with no lifecycle configuration as no rules', async () => {
    const body = '<Error><Code>NoSuchLifecycleConfiguration</Code></Error>';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 404 })));

    const result = await createBackupRepositoryReader(config()).lifecycleRules();

    expect(result._unsafeUnwrap()).toEqual([]);
  });

  it('never reads a missing bucket as a bucket with no rules', async () => {
    const body = '<Error><Code>NoSuchBucket</Code></Error>';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 404 })));

    const result = await createBackupRepositoryReader(config()).lifecycleRules();

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('turns a refused read into an error result rather than a throw', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('denied', { status: 403 })));

    const result = await createBackupRepositoryReader(config()).lifecycleRules();

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('turns an unparseable configuration into an error result rather than a throw', async () => {
    const body = lifecycle(30).replace('30', 'soon');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })));

    const result = await createBackupRepositoryReader(config()).lifecycleRules();

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('listObjectVersions', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function versionsBody(keys: { key: string; iso: string }[], tail: string): string {
    const entries = keys
      .map(
        (entry) =>
          `<Version><Key>${entry.key}</Key><VersionId>v</VersionId><LastModified>${entry.iso}</LastModified></Version>`
      )
      .join('');
    return `<ListVersionsResult>${entries}${tail}</ListVersionsResult>`;
  }

  it('lists versions under the repository prefix, not the snapshots prefix', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(versionsBody([], '<IsTruncated>false</IsTruncated>'), { status: 200 })
      );
    vi.stubGlobal('fetch', fetchMock);

    const listed = await createBackupRepositoryReader(config()).listObjectVersions();
    expect(listed.isOk()).toBe(true);

    const url = new URL(requestUrls(fetchMock)[0] ?? '');
    expect(url.searchParams.has('versions')).toBe(true);
    expect(url.searchParams.get('prefix')).toBe('repository/');
  });

  it('reads the entries and the continuation the store returned', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          versionsBody(
            [{ key: 'repository/data/aa', iso: isoAt(TEST_DAY_START) }],
            '<IsTruncated>true</IsTruncated><NextKeyMarker>repository/data/aa</NextKeyMarker><NextVersionIdMarker>v9</NextVersionIdMarker>'
          ),
          { status: 200 }
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    const listed = await createBackupRepositoryReader(config()).listObjectVersions();

    expect(listed._unsafeUnwrap()).toEqual({
      versions: [{ key: 'repository/data/aa', lastModified: new Date(TEST_DAY_START) }],
      nextCursor: { keyMarker: 'repository/data/aa', versionIdMarker: 'v9' },
    });
  });

  it('resumes from both markers, so a key split across pages is not skipped', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(versionsBody([], '<IsTruncated>false</IsTruncated>'), { status: 200 })
      );
    vi.stubGlobal('fetch', fetchMock);

    const listed = await createBackupRepositoryReader(config()).listObjectVersions({
      keyMarker: 'repository/data/aa',
      versionIdMarker: 'v9',
    });
    expect(listed.isOk()).toBe(true);

    const url = new URL(requestUrls(fetchMock)[0] ?? '');
    expect(url.searchParams.get('key-marker')).toBe('repository/data/aa');
    expect(url.searchParams.get('version-id-marker')).toBe('v9');
  });

  it('sends no version-id marker when the cursor carries none', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(versionsBody([], '<IsTruncated>false</IsTruncated>'), { status: 200 })
      );
    vi.stubGlobal('fetch', fetchMock);

    const listed = await createBackupRepositoryReader(config()).listObjectVersions({
      keyMarker: 'repository/a',
    });
    expect(listed.isOk()).toBe(true);

    const url = new URL(requestUrls(fetchMock)[0] ?? '');
    expect(url.searchParams.has('version-id-marker')).toBe(false);
  });

  it('fails on a refused listing rather than reporting an empty one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('denied', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);

    const listed = await createBackupRepositoryReader(config()).listObjectVersions();

    expect(listed.isErr()).toBe(true);
  });

  it('carries the status and nothing the store wrote into the failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response('<Error><Key>secret-object-key</Key></Error>', { status: 403 })
      );
    vi.stubGlobal('fetch', fetchMock);

    const listed = await createBackupRepositoryReader(config()).listObjectVersions();

    expect(JSON.stringify(listed._unsafeUnwrapErr())).not.toContain('secret-object-key');
  });
});

describe('createBackupRepositoryReaderFromEnv', () => {
  function env(overrides: Partial<BackupRepositoryEnv> = {}): BackupRepositoryEnv {
    return {
      NODE_ENV: 'production',
      BACKUP_B2_S3_ENDPOINT: 'https://s3.example-region.backblazeb2.com',
      BACKUP_B2_REGION: 'example-region',
      BACKUP_B2_BUCKET: 'hushbox-backup',
      BACKUP_REPO_ROOT: 'repository',
      BACKUP_B2_AUDITOR_KEY_ID: 'auditor-key-id',
      BACKUP_B2_AUDITOR_KEY: 'auditor-key',
      ...overrides,
    };
  }

  it('builds a reader from the bindings', () => {
    expect(() => createBackupRepositoryReaderFromEnv(env(), () => NOW)).not.toThrow();
  });

  it.each([
    'BACKUP_B2_S3_ENDPOINT',
    'BACKUP_B2_REGION',
    'BACKUP_B2_BUCKET',
    'BACKUP_REPO_ROOT',
    'BACKUP_B2_AUDITOR_KEY_ID',
    'BACKUP_B2_AUDITOR_KEY',
  ] as const)('fails fast naming %s when it is missing', (binding) => {
    expect(() =>
      createBackupRepositoryReaderFromEnv(env({ [binding]: undefined }), () => NOW)
    ).toThrow(binding);
  });

  it('binds the fake reader outside production, where no backup has been written', async () => {
    const reader = createBackupRepositoryReaderFromEnv({ NODE_ENV: 'development' }, () => NOW);

    const result = await reader.newestSnapshotAt();

    expect(result._unsafeUnwrap()).toEqual(NOW);
  });

  it('never falls back to the fake in production, where a missing binding must be loud', () => {
    expect(() =>
      createBackupRepositoryReaderFromEnv({ NODE_ENV: 'production' }, () => NOW)
    ).toThrow('BACKUP_B2_S3_ENDPOINT');
  });
});
