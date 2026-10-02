import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stringify } from 'smol-toml';
import { z } from 'zod';
import { INPUTS_PREFIX } from '@hushbox/shared';

/**
 * The snapshot host recorded for every source. A runner's own hostname is
 * random and new on each run, and retention groups snapshots by host, so a
 * borrowed hostname would put every run in a group of its own and the ladder
 * would keep all of them.
 */
export const BACKUP_HOST = 'hushbox-backup';

/** The buckets snapshotted straight from R2, in the order one run walks them. */
const OBJECT_LABELS = ['media', 'app-builds', 'model-weights'] as const;

/** The label of the local directory the database dump is written to. */
export const DUMP_LABEL = 'postgres';

/** Every snapshot label one backup run produces. */
export const SOURCE_LABELS = [...OBJECT_LABELS, DUMP_LABEL] as const;

type ObjectLabel = (typeof OBJECT_LABELS)[number];

const nonEmpty = z.string().min(1);

/**
 * Where a run reads from and writes to. Credentials are deliberately absent:
 * the repository password and its S3 key reach rustic as environment
 * variables, and the source key pair as arguments to the renderer, so neither
 * can be printed by anything that logs this object.
 */
export const BackupEnvSchema = z.object({
  repository: z.object({
    endpoint: nonEmpty,
    region: nonEmpty,
    bucket: nonEmpty,
    root: nonEmpty,
  }),
  r2: z.object({
    endpoint: nonEmpty,
    region: nonEmpty,
  }),
  sourceBuckets: z.object({
    media: nonEmpty,
    'app-builds': nonEmpty,
    'model-weights': nonEmpty,
  }),
  dumpDir: nonEmpty,
});

export type BackupEnv = z.infer<typeof BackupEnvSchema>;

/** The read-only R2 key pair the object sources are listed and read with. */
export interface SourceCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

interface SnapshotEntry {
  readonly sources: readonly string[];
  /**
   * What distinguishes this entry from its siblings.
   *
   * Load-bearing rather than decorative: every object source spells its source
   * as the same `opendal:s3`, and a `rustic backup` given no argument runs one
   * entry per distinct source. Measured against the pinned binary, three
   * unnamed entries differing only in their options produced a single snapshot
   * — the first — and the other two buckets were silently not backed up.
   */
  readonly name: string;
  readonly host: string;
  readonly label: string;
  readonly 'as-path': string;
  readonly iglobs?: readonly string[];
  readonly options?: Readonly<Record<string, string>>;
}

/**
 * The exclusion each object source carries, keyed by label. rustic matches a
 * remote object against `"/" + key`, so the pattern is root-anchored and only
 * a top-level prefix of that name matches. Built from the shared prefix the
 * media slice's key builders produce: the staging objects it names are
 * run-scoped, client-encrypted and expire within the hour, so a snapshot of
 * them would retain ciphertext the product has already dropped.
 */
const EXCLUSIONS: Partial<Record<ObjectLabel, readonly string[]>> = {
  media: [`!/${INPUTS_PREFIX}**`],
};

function objectSnapshot(
  label: ObjectLabel,
  env: BackupEnv,
  credentials: SourceCredentials
): SnapshotEntry {
  const excluded = EXCLUSIONS[label];
  return {
    sources: ['opendal:s3'],
    name: label,
    host: BACKUP_HOST,
    label,
    'as-path': `/${label}`,
    ...(excluded === undefined ? {} : { iglobs: excluded }),
    options: {
      endpoint: env.r2.endpoint,
      region: env.r2.region,
      bucket: env.sourceBuckets[label],
      access_key_id: credentials.accessKeyId,
      secret_access_key: credentials.secretAccessKey,
    },
  };
}

/**
 * The rustic profile for one run. rustic reads a source's S3 credentials only
 * from its config file — the `OPENDAL_*` environment route reaches the
 * repository alone — so the file this renders is the only place the read-only
 * R2 key can be handed over.
 */
export function renderRusticConfig(env: BackupEnv, credentials: SourceCredentials): string {
  const snapshots: SnapshotEntry[] = OBJECT_LABELS.map((label) =>
    objectSnapshot(label, env, credentials)
  );
  snapshots.push({
    sources: [env.dumpDir],
    name: DUMP_LABEL,
    host: BACKUP_HOST,
    label: DUMP_LABEL,
    'as-path': `/${DUMP_LABEL}`,
  });
  return stringify({
    repository: {
      repository: 'opendal:s3',
      options: {
        endpoint: env.repository.endpoint,
        region: env.repository.region,
        bucket: env.repository.bucket,
        root: env.repository.root,
      },
    },
    backup: { snapshots },
  });
}

/** A written profile and the removal of everything it was written into. */
export interface RusticConfigFile {
  readonly path: string;
  readonly cleanup: () => Promise<void>;
}

/**
 * Writes a profile to a directory of its own. The explicit `chmod` follows the
 * write because the creation mode is masked by the process umask, which is
 * whatever the invoking shell set it to.
 */
export async function writeRusticConfig(toml: string): Promise<RusticConfigFile> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hushbox-rustic-'));
  const file = path.join(directory, 'rustic.toml');
  await writeFile(file, toml, { mode: 0o600 });
  await chmod(file, 0o600);
  return {
    path: file,
    cleanup: async (): Promise<void> => {
      await rm(directory, { recursive: true, force: true });
    },
  };
}
