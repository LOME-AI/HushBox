import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'smol-toml';
import { INPUTS_PREFIX } from '@hushbox/shared';
import {
  BACKUP_HOST,
  BackupEnvSchema,
  SOURCE_LABELS,
  renderRusticConfig,
  writeRusticConfig,
} from './config.js';
import type { BackupEnv, SourceCredentials } from './config.js';

const FIXTURE_ENV: BackupEnv = {
  repository: {
    endpoint: 'https://s3.us-west-004.backblazeb2.com',
    region: 'us-west-004',
    bucket: 'hushbox-backup',
    root: '/rustic',
  },
  r2: {
    endpoint: 'https://accountid.r2.cloudflarestorage.com',
    region: 'auto',
  },
  sourceBuckets: {
    media: 'hushbox-media',
    'app-builds': 'hushbox-app-builds',
    'model-weights': 'hushbox-model-weights',
  },
  dumpDir: 'backup-dump',
};

const FIXTURE_CREDENTIALS: SourceCredentials = {
  accessKeyId: 'fixture-access-key-id',
  secretAccessKey: 'fixture-secret-access-key',
};

interface RenderedSnapshot {
  readonly sources: readonly string[];
  readonly host: string;
  readonly label: string;
  readonly 'as-path': string;
  readonly iglobs?: readonly string[];
  readonly options?: Readonly<Record<string, string>>;
}

interface RenderedConfig {
  readonly repository: {
    readonly repository: string;
    readonly options: Readonly<Record<string, string>>;
  };
  readonly backup: { readonly snapshots: readonly RenderedSnapshot[] };
}

function render(): RenderedConfig {
  return parse(renderRusticConfig(FIXTURE_ENV, FIXTURE_CREDENTIALS)) as unknown as RenderedConfig;
}

function snapshotFor(label: string): RenderedSnapshot {
  const entry = render().backup.snapshots.find((candidate) => candidate.label === label);
  if (entry === undefined) throw new Error(`no rendered snapshot labelled ${label}`);
  return entry;
}

describe('SOURCE_LABELS', () => {
  it('names the three object sources and the dump, in backup order', () => {
    expect(SOURCE_LABELS).toEqual(['media', 'app-builds', 'model-weights', 'postgres']);
  });
});

describe('BACKUP_HOST', () => {
  it('is the fixed snapshot host, so an ephemeral runner name never enters retention grouping', () => {
    expect(BACKUP_HOST).toBe('hushbox-backup');
  });
});

describe('BackupEnvSchema', () => {
  it('accepts a fully populated backup environment', () => {
    expect(BackupEnvSchema.parse(FIXTURE_ENV)).toEqual(FIXTURE_ENV);
  });

  it('rejects an environment missing a source bucket', () => {
    const incomplete = {
      ...FIXTURE_ENV,
      sourceBuckets: {
        'app-builds': FIXTURE_ENV.sourceBuckets['app-builds'],
        'model-weights': FIXTURE_ENV.sourceBuckets['model-weights'],
      },
    };
    expect(BackupEnvSchema.safeParse(incomplete).success).toBe(false);
  });

  it('rejects an empty repository bucket rather than passing it to the CLI', () => {
    const blank = { ...FIXTURE_ENV, repository: { ...FIXTURE_ENV.repository, bucket: '' } };
    expect(BackupEnvSchema.safeParse(blank).success).toBe(false);
  });
});

describe('renderRusticConfig', () => {
  it('addresses the repository through the OpenDAL S3 backend', () => {
    const { repository } = render();
    expect(repository.repository).toBe('opendal:s3');
    expect(repository.options).toEqual({
      endpoint: 'https://s3.us-west-004.backblazeb2.com',
      region: 'us-west-004',
      bucket: 'hushbox-backup',
      root: '/rustic',
    });
  });

  it('renders one snapshot entry per source label, in order', () => {
    expect(render().backup.snapshots.map((entry) => entry.label)).toEqual([...SOURCE_LABELS]);
  });

  it('gives every snapshot the fixed host and a label-derived as-path', () => {
    for (const entry of render().backup.snapshots) {
      expect(entry.host).toBe(BACKUP_HOST);
      expect(entry['as-path']).toBe(`/${entry.label}`);
    }
  });

  it('points each object snapshot at its own R2 bucket with the source credentials', () => {
    expect(snapshotFor('media').sources).toEqual(['opendal:s3']);
    expect(snapshotFor('media').options).toEqual({
      endpoint: 'https://accountid.r2.cloudflarestorage.com',
      region: 'auto',
      bucket: 'hushbox-media',
      access_key_id: 'fixture-access-key-id',
      secret_access_key: 'fixture-secret-access-key',
    });
    expect(snapshotFor('app-builds').options?.['bucket']).toBe('hushbox-app-builds');
    expect(snapshotFor('model-weights').options?.['bucket']).toBe('hushbox-model-weights');
  });

  it('backs the postgres snapshot with the local dump directory and no S3 options', () => {
    const entry = snapshotFor('postgres');
    expect(entry.sources).toEqual(['backup-dump']);
    expect(entry.options).toBeUndefined();
  });

  it('excludes the staging prefix from the media snapshot and nothing else', () => {
    expect(snapshotFor('media').iglobs).toEqual([`!/${INPUTS_PREFIX}**`]);
  });

  it('leaves the other snapshots unfiltered', () => {
    for (const label of ['app-builds', 'model-weights', 'postgres']) {
      expect(snapshotFor(label).iglobs).toBeUndefined();
    }
  });

  it('derives the exclusion from the shared prefix rather than spelling it out', async () => {
    const source = await readFile(path.join(import.meta.dirname, 'config.ts'), 'utf8');
    expect(source).not.toContain(INPUTS_PREFIX);
  });

  it('renders the whole profile', () => {
    expect(renderRusticConfig(FIXTURE_ENV, FIXTURE_CREDENTIALS)).toMatchInlineSnapshot(`
      "[repository]
      repository = "opendal:s3"

      [repository.options]
      endpoint = "https://s3.us-west-004.backblazeb2.com"
      region = "us-west-004"
      bucket = "hushbox-backup"
      root = "/rustic"

      [[backup.snapshots]]
      sources = [ "opendal:s3" ]
      name = "media"
      host = "hushbox-backup"
      label = "media"
      as-path = "/media"
      iglobs = [ "!/inputs/**" ]

      [backup.snapshots.options]
      endpoint = "https://accountid.r2.cloudflarestorage.com"
      region = "auto"
      bucket = "hushbox-media"
      access_key_id = "fixture-access-key-id"
      secret_access_key = "fixture-secret-access-key"

      [[backup.snapshots]]
      sources = [ "opendal:s3" ]
      name = "app-builds"
      host = "hushbox-backup"
      label = "app-builds"
      as-path = "/app-builds"

      [backup.snapshots.options]
      endpoint = "https://accountid.r2.cloudflarestorage.com"
      region = "auto"
      bucket = "hushbox-app-builds"
      access_key_id = "fixture-access-key-id"
      secret_access_key = "fixture-secret-access-key"

      [[backup.snapshots]]
      sources = [ "opendal:s3" ]
      name = "model-weights"
      host = "hushbox-backup"
      label = "model-weights"
      as-path = "/model-weights"

      [backup.snapshots.options]
      endpoint = "https://accountid.r2.cloudflarestorage.com"
      region = "auto"
      bucket = "hushbox-model-weights"
      access_key_id = "fixture-access-key-id"
      secret_access_key = "fixture-secret-access-key"

      [[backup.snapshots]]
      sources = [ "backup-dump" ]
      name = "postgres"
      host = "hushbox-backup"
      label = "postgres"
      as-path = "/postgres"
      "
    `);
  });
});

describe('writeRusticConfig', () => {
  it('writes the profile to a fresh directory and removes it on cleanup', async () => {
    const toml = renderRusticConfig(FIXTURE_ENV, FIXTURE_CREDENTIALS);
    const written = await writeRusticConfig(toml);
    expect(await readFile(written.path, 'utf8')).toBe(toml);
    await written.cleanup();
    await expect(stat(written.path)).rejects.toThrow();
  });

  it('gives two calls separate directories', async () => {
    const first = await writeRusticConfig('# one');
    const second = await writeRusticConfig('# two');
    try {
      expect(path.dirname(first.path)).not.toBe(path.dirname(second.path));
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'writes the file readable only by its owner, since it carries the source credentials',
    async () => {
      const written = await writeRusticConfig(renderRusticConfig(FIXTURE_ENV, FIXTURE_CREDENTIALS));
      try {
        const stats = await stat(written.path);
        expect(stats.mode & 0o777).toBe(0o600);
      } finally {
        await written.cleanup();
      }
    }
  );

  it('is safe to clean up twice', async () => {
    const written = await writeRusticConfig('# once');
    await written.cleanup();
    await expect(written.cleanup()).resolves.toBeUndefined();
  });
});
