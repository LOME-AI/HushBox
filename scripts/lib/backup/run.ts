import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AwsClient } from 'aws4fetch';

import { execa } from 'execa';
import { BACKUP_LIFECYCLE_NONCURRENT_DAYS, PRIVACY_SECTIONS } from '@hushbox/shared';

import { renderRusticConfig, writeRusticConfig } from './config.js';
import { runRestoreDrill } from './drill.js';
import { POSTGRES_IMAGE, dumpDatabase } from './postgres.js';
import {
  excludedPrefixFor,
  formatSummary,
  readRepoInfo,
  reconcile,
  spotCheckObject,
  writeStepSummary,
} from './reconcile.js';
import { ensureRustic } from './rustic-binary.js';
import type { BackupEnv, RusticConfigFile, SourceCredentials } from './config.js';
import type { DrillResult, RestoreDrillOptions } from './drill.js';
import type { DumpDatabaseOptions, DumpManifest } from './postgres.js';
import type {
  LabelReconciliation,
  ReconcileOptions,
  RepoSizes,
  RunSummary,
  SpotCheck,
  SpotCheckOptions,
} from './reconcile.js';
import type { LegalSection } from '@hushbox/shared';

/**
 * One backup run: what it reads, how long what it writes is kept, and the
 * arithmetic that proves the second answer stays inside the promise the privacy
 * policy publishes.
 */

/** The variable each field of a run's configuration arrives in. */
export const BACKUP_VARIABLES = {
  repositoryEndpoint: 'BACKUP_B2_S3_ENDPOINT',
  repositoryRegion: 'BACKUP_B2_REGION',
  repositoryBucket: 'BACKUP_B2_BUCKET',
  repositoryRoot: 'BACKUP_REPO_ROOT',
  repositoryKeyId: 'BACKUP_B2_KEY_ID',
  repositoryKey: 'BACKUP_B2_KEY', // gitleaks:allow -- the variable's name, never a value read from it
  // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- a variable's name, not a value
  repositoryPassword: 'BACKUP_REPOSITORY_PASSWORD', // gitleaks:allow -- the variable's name, never a value read from it
  sourceEndpoint: 'BACKUP_R2_S3_ENDPOINT',
  sourceRegion: 'BACKUP_R2_REGION',
  sourceKeyId: 'BACKUP_R2_ACCESS_KEY_ID',
  sourceKey: 'BACKUP_R2_SECRET_ACCESS_KEY', // gitleaks:allow -- the variable's name, never a value read from it
  mediaBucket: 'BACKUP_SOURCE_BUCKET_MEDIA',
  appBuildsBucket: 'BACKUP_SOURCE_BUCKET_APP_BUILDS',
  modelWeightsBucket: 'BACKUP_SOURCE_BUCKET_MODEL_WEIGHTS',
  databaseUrl: 'BACKUP_DATABASE_URL',
  snapshotDatabaseUrl: 'BACKUP_SNAPSHOT_DATABASE_URL',
} as const;

/**
 * Everything a run needs, and nothing it computes for itself. The dump
 * directory is deliberately absent: it belongs to the run rather than to the
 * environment, so {@link BackupEnv} is built from these fields and that path.
 */
export interface BackupSettings {
  readonly repository: BackupEnv['repository'];
  readonly r2: BackupEnv['r2'];
  readonly sourceBuckets: BackupEnv['sourceBuckets'];
  /** Reads the object sources; the file the renderer writes is its only home. */
  readonly sourceCredentials: SourceCredentials;
  /** Writes the repository; reaches rustic as `OPENDAL_*` and never as an argument. */
  readonly repositoryCredentials: SourceCredentials;
  readonly repositoryPassword: string;
  /** The connection `pg_dump` makes; on Neon the direct, unpooled endpoint. */
  readonly databaseUrl: string;
  /** The connection the session exporting the dump's snapshot makes. */
  readonly snapshotDatabaseUrl: string;
}

/** Every variable of a run's configuration that carries no value, sorted. */
function missingVariables(env: NodeJS.ProcessEnv): string[] {
  return Object.values(BACKUP_VARIABLES)
    .filter((name) => {
      const value = env[name];
      return value === undefined || value === '';
    })
    .toSorted((left, right) => left.localeCompare(right));
}

/**
 * A run's configuration, or a refusal naming every variable that carries no
 * value. Names and never values: half of these are credentials, and the refusal
 * is bound for a workflow log.
 */
export function readBackupSettings(env: NodeJS.ProcessEnv): BackupSettings {
  const read = (name: string): string => {
    const value = env[name];
    if (value === undefined || value === '') {
      throw new Error(
        `readBackupSettings: the backup environment is incomplete — ${missingVariables(env).join(', ')}`
      );
    }
    return value;
  };
  return {
    repository: {
      endpoint: read(BACKUP_VARIABLES.repositoryEndpoint),
      region: read(BACKUP_VARIABLES.repositoryRegion),
      bucket: read(BACKUP_VARIABLES.repositoryBucket),
      root: read(BACKUP_VARIABLES.repositoryRoot),
    },
    r2: {
      endpoint: read(BACKUP_VARIABLES.sourceEndpoint),
      region: read(BACKUP_VARIABLES.sourceRegion),
    },
    sourceBuckets: {
      media: read(BACKUP_VARIABLES.mediaBucket),
      'app-builds': read(BACKUP_VARIABLES.appBuildsBucket),
      'model-weights': read(BACKUP_VARIABLES.modelWeightsBucket),
    },
    sourceCredentials: {
      accessKeyId: read(BACKUP_VARIABLES.sourceKeyId),
      secretAccessKey: read(BACKUP_VARIABLES.sourceKey),
    },
    repositoryCredentials: {
      accessKeyId: read(BACKUP_VARIABLES.repositoryKeyId),
      secretAccessKey: read(BACKUP_VARIABLES.repositoryKey),
    },
    repositoryPassword: read(BACKUP_VARIABLES.repositoryPassword),
    databaseUrl: read(BACKUP_VARIABLES.databaseUrl),
    snapshotDatabaseUrl: read(BACKUP_VARIABLES.snapshotDatabaseUrl),
  };
}

/**
 * How many snapshots of each tier survive a `forget`. No monthly tier: one
 * monthly snapshot alone outlives the published ceiling.
 */
export const RETENTION_LADDER = {
  'keep-last': 1,
  'keep-hourly': 48,
  'keep-daily': 30,
  'keep-weekly': 7,
} as const;

export type RetentionLadder = Readonly<Record<keyof typeof RETENTION_LADDER, number>>;

/** Days between two runs that prune; the ladder drops a reference sooner. */
export const PRUNE_CADENCE_DAYS = 1;

/**
 * Days a pack marked for deletion survives the mark, and the value the flag
 * below carries. Stated rather than left to rustic's own default, which is a
 * number this repository does not control: an upstream bump would move a term
 * of the ceiling the privacy policy publishes with nothing here changing.
 */
export const KEEP_DELETE_CEILING_DAYS = 1;

/**
 * What a prune is allowed to leave behind, what it is allowed to rewrite, and
 * how long it leaves a marked pack standing.
 *
 * All three depart from rustic's defaults (`5%`, `10%` and 23 hours) and all
 * three are terms of the ceiling. A tolerated share of unused data means a pack
 * holding a deleted object's blobs may never be repacked, so the object
 * survives with no bound at all; a repack budget means one prune reclaims only
 * part of what it marked, so reclamation converges over runs and each step
 * costs a day; and the delete delay is added to the sum whether or not the run
 * states it. Nothing else in the system can observe these values — no auditor
 * sees a flag — which is why {@link retentionCeilingDays} refuses to state a
 * number unless they are what they are here.
 */
export const PRUNE_RECLAMATION = {
  'max-unused': '0',
  'max-repack': 'unlimited',
  'keep-delete': `${String(KEEP_DELETE_CEILING_DAYS)}d`,
} as const;

export type PruneReclamation = Readonly<Record<keyof typeof PRUNE_RECLAMATION, string>>;

const DAYS_PER_WEEK = 7;
const HOURS_PER_DAY = 24;

export function forgetArguments(ladder: RetentionLadder = RETENTION_LADDER): string[] {
  return [
    'forget',
    ...Object.entries(ladder).flatMap(([tier, count]) => [`--${tier}`, String(count)]),
  ];
}

export function pruneArguments(reclamation: PruneReclamation = PRUNE_RECLAMATION): string[] {
  return ['prune', ...Object.entries(reclamation).flatMap(([flag, limit]) => [`--${flag}`, limit])];
}

/**
 * The age of the oldest snapshot a ladder keeps: the longest reach of any tier,
 * since a tier keeping N of a period reaches back N of those periods.
 */
export function oldestRetainedSnapshotDays(ladder: RetentionLadder): number {
  return Math.max(
    0,
    ladder['keep-hourly'] / HOURS_PER_DAY,
    ladder['keep-daily'],
    ladder['keep-weekly'] * DAYS_PER_WEEK
  );
}

/**
 * The worst-case age of an object that has been deleted from its bucket: the
 * four stages of the deletion chain added up.
 *
 * `forget` drops the last reference to it once every snapshot holding it has
 * aged past the ladder; the next daily prune removes the data; the store turns
 * that removal into a hidden version, because the key this repository is
 * written with holds no destroy capability; and the bucket's lifecycle rule is
 * the only thing that erases anything.
 *
 * It refuses rather than returns whenever prune is left free to leave data
 * behind, because with either budget in force the sum below is not a bound: an
 * untouched pack is retained indefinitely, and a budgeted repack turns one
 * reclamation into an unknown number of daily convergence steps.
 */
export function retentionCeilingDays(
  reclamation: PruneReclamation = PRUNE_RECLAMATION,
  ladder: RetentionLadder = RETENTION_LADDER
): number {
  if (reclamation['max-unused'] !== '0') {
    throw new Error(
      `retentionCeilingDays: prune tolerates ${reclamation['max-unused']} of unused data, so a deleted object has no bounded age`
    );
  }
  if (reclamation['max-repack'] !== 'unlimited') {
    throw new Error(
      `retentionCeilingDays: prune repacks under a budget of ${reclamation['max-repack']}, so reclamation takes an unknown number of runs to complete`
    );
  }
  if (reclamation['keep-delete'] !== PRUNE_RECLAMATION['keep-delete']) {
    throw new Error(
      `retentionCeilingDays: prune leaves a marked pack standing for ${reclamation['keep-delete']}, which is not the ${PRUNE_RECLAMATION['keep-delete']} the sum below counts`
    );
  }
  return (
    oldestRetainedSnapshotDays(ladder) +
    PRUNE_CADENCE_DAYS +
    KEEP_DELETE_CEILING_DAYS +
    BACKUP_LIFECYCLE_NONCURRENT_DAYS
  );
}

/** The section of the privacy policy carrying the retention commitments. */
const RETENTION_SECTION_ID = 'data-retention';

/**
 * The bound the published commitment states, in days.
 *
 * Read from the policy rather than restated here: the whole point of comparing
 * it against {@link retentionCeilingDays} is that neither side can be changed
 * without the other, and a number written twice is a number that can drift. A
 * commitment that no longer states a bound is a refusal, never a default —
 * defaulting would leave the comparison passing over a promise that is gone.
 */
export function publishedRetentionCeilingDays(
  sections: readonly LegalSection[] = PRIVACY_SECTIONS
): number {
  const bounds = new Set(
    sections
      .filter((section) => section.id === RETENTION_SECTION_ID)
      .flatMap((section) => [section.simplyPut, ...section.points])
      .filter((point) => point.includes('backup'))
      .flatMap((point) => [...point.matchAll(/(?:up to|within) (\d+) days/g)])
      .map(([, days]) => Number(days))
  );
  const [only] = [...bounds];
  if (only === undefined || bounds.size > 1) {
    throw new Error(
      `publishedRetentionCeilingDays: the privacy policy states no published bound in days on how long a backup holds deleted data (found ${String(bounds.size)})`
    );
  }
  return only;
}

/**
 * The hour of the day whose run does the work that grows with the database.
 * Three, matching `daily-retention` in `apps/api/src/composition/cron-schedules.ts`,
 * so the two heavy daily passes sit together rather than in two places nobody
 * can name.
 */
export const DRILL_HOUR_UTC = 3;

/** Whether this run is the day's designated one, by the hour it started at. */
export function isDesignatedDailyRun(hourUtc: number): boolean {
  return hourUtc === DRILL_HOUR_UTC;
}

/**
 * Whether this run restores the dump and proves it.
 *
 * Daily rather than hourly because the drill is the one step whose runtime
 * grows with the database; the structural and cryptographic checks stay on
 * every run. A run somebody asked for by hand always drills, because asking for
 * one by hand is what somebody does when they want the proof now.
 */
export function shouldRunDrill(hourUtc: number, dispatched: boolean): boolean {
  return dispatched || isDesignatedDailyRun(hourUtc);
}

/**
 * The fraction of the repository this run reads and re-hashes. It rotates with
 * the hour, so a day of hourly runs reads every pack exactly once.
 */
export function readDataSubset(hourUtc: number): string {
  return `${String(hourUtc + 1)}/${String(HOURS_PER_DAY)}`;
}

/** The instant's hour of the day in UTC, which is what the rotations key off. */
export function currentHourUtc(nowMs: number): number {
  return new Date(nowMs).getUTCHours();
}

/**
 * Every seam the pipeline reaches the outside world through, so its sequencing
 * and every argument list it builds are proved without a repository, a database
 * or a container.
 */
export interface BackupDependencies {
  readonly ensureRustic: () => Promise<string>;
  /** Whether the repository exists: its own configuration object answers. */
  readonly repositoryProvisioned: (settings: BackupSettings) => Promise<boolean>;
  readonly dumpDatabase: (options: DumpDatabaseOptions) => Promise<DumpManifest>;
  readonly writeConfig: (toml: string) => Promise<RusticConfigFile>;
  /** One rustic invocation. Nothing secret is ever in `args`. */
  readonly rustic: (
    rusticPath: string,
    configPath: string,
    args: readonly string[]
  ) => Promise<void>;
  readonly reconcile: (options: ReconcileOptions) => Promise<readonly LabelReconciliation[]>;
  readonly spotCheck: (options: SpotCheckOptions) => Promise<SpotCheck>;
  readonly runDrill: (options: RestoreDrillOptions) => Promise<DrillResult>;
  readonly readRepoInfo: (rusticPath: string, configPath: string) => Promise<RepoSizes>;
  readonly writeSummary: (line: string) => void;
  readonly createClient: (credentials: SourceCredentials, region: string) => AwsClient;
}

/** Ceiling on any one rustic invocation; a hung one fails the run. */
export const RUSTIC_RUNTIME_LIMIT_MS = 60 * 60_000;

/** How a rustic invocation ended, with nothing it wrote. */
export interface RusticOutcome {
  readonly exitCode: number | undefined;
  readonly timedOut: boolean;
}

/**
 * How a failed rustic invocation is reported, or nothing for one that
 * succeeded: the subcommand and the exit status, and nothing the child wrote.
 * rustic prints the repository address, the source addresses and every path it
 * walked, and a subprocess library's own error appends whatever it captured.
 */
export function rusticFailureMessage(
  args: readonly string[],
  outcome: RusticOutcome
): string | undefined {
  if (outcome.exitCode === 0) return undefined;
  const subcommand = args[0] ?? 'no subcommand';
  if (outcome.timedOut) {
    return `runBackup: rustic ${subcommand} ran past its limit of ${String(RUSTIC_RUNTIME_LIMIT_MS)} ms and was killed`;
  }
  return outcome.exitCode === undefined
    ? `runBackup: rustic ${subcommand} reached no exit status`
    : `runBackup: rustic ${subcommand} exited ${String(outcome.exitCode)}`;
}

/** The status an object store answers for a key it holds nothing at. */
const NOT_FOUND = 404;

/**
 * Where a repository keeps its own configuration. rustic writes this object
 * when the repository is created and reads it before every other command, so
 * holding it is what makes an address a repository rather than a bucket.
 */
export function repositoryConfigUrl(repository: BackupEnv['repository']): string {
  return `${repository.endpoint.replace(/\/+$/, '')}/${repository.bucket}/${repository.root}/config`;
}

/* v8 ignore start -- the seams onto rustic, Docker, Postgres and object storage */

async function runRusticCommand(
  rusticPath: string,
  configPath: string,
  args: readonly string[]
): Promise<void> {
  const { exitCode, timedOut } = await execa(rusticPath, ['--use-profile', configPath, ...args], {
    timeout: RUSTIC_RUNTIME_LIMIT_MS,
    reject: false,
    stdio: 'ignore',
  });
  const failure = rusticFailureMessage(args, { exitCode, timedOut });
  if (failure !== undefined) throw new Error(failure);
}

async function repositoryHoldsConfig(settings: BackupSettings): Promise<boolean> {
  const client = new AwsClient({
    accessKeyId: settings.repositoryCredentials.accessKeyId,
    secretAccessKey: settings.repositoryCredentials.secretAccessKey,
    service: 's3',
    region: settings.repository.region,
  });
  const response = await client.fetch(repositoryConfigUrl(settings.repository), { method: 'HEAD' });
  if (response.status === NOT_FOUND) return false;
  if (!response.ok) {
    throw new Error(
      `runBackup: the object store answered ${String(response.status)} for the repository's configuration`
    );
  }
  return true;
}

const productionDependencies: BackupDependencies = {
  ensureRustic: () => ensureRustic(),
  repositoryProvisioned: repositoryHoldsConfig,
  dumpDatabase,
  writeConfig: writeRusticConfig,
  rustic: runRusticCommand,
  reconcile,
  spotCheck: spotCheckObject,
  runDrill: runRestoreDrill,
  readRepoInfo,
  writeSummary: writeStepSummary,
  createClient: (credentials, region) =>
    new AwsClient({
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      service: 's3',
      region,
    }),
};
/* v8 ignore stop */

/** The variables rustic reads its repository credentials and password from. */
const RUSTIC_ENVIRONMENT = {
  // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- a variable's name, not a value
  RUSTIC_PASSWORD: 'RUSTIC_PASSWORD',
  OPENDAL_ACCESS_KEY_ID: 'OPENDAL_ACCESS_KEY_ID',
  OPENDAL_SECRET_ACCESS_KEY: 'OPENDAL_SECRET_ACCESS_KEY',
} as const;

export interface RunBackupOptions {
  readonly settings: BackupSettings;
  /** The hour the run started at, in UTC; what the rotations key off. */
  readonly hourUtc: number;
  /** Whether a person asked for this run rather than the schedule. */
  readonly dispatched: boolean;
  /** The draw the spot checks pick their object with; a test pins it. */
  readonly random?: () => number;
}

/**
 * Puts the repository's password and key pair where rustic reads them, and
 * takes them back out however the run ends.
 *
 * The process environment rather than an argument or an option, because every
 * rustic invocation in a run is issued by a different module — the reconciler,
 * the spot check and the drill each build their own — and a credential passed
 * through three call sites is a credential three call sites can print.
 */
function withRusticEnvironment(settings: BackupSettings): () => void {
  const previous = Object.fromEntries(
    Object.keys(RUSTIC_ENVIRONMENT).map((name) => [name, process.env[name]])
  );
  process.env[RUSTIC_ENVIRONMENT.RUSTIC_PASSWORD] = settings.repositoryPassword;
  process.env[RUSTIC_ENVIRONMENT.OPENDAL_ACCESS_KEY_ID] =
    settings.repositoryCredentials.accessKeyId;
  process.env[RUSTIC_ENVIRONMENT.OPENDAL_SECRET_ACCESS_KEY] =
    settings.repositoryCredentials.secretAccessKey;
  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  };
}

/** The directories one run occupies inside its own work directory. */
const DUMP_DIRECTORY_NAME = 'dump';
const DRILL_DIRECTORY_NAME = 'drill';

/**
 * One whole backup cycle, against a repository somebody has already created.
 *
 * A run that finds none refuses rather than making one, and the refusal names
 * the address it found nothing at, because that is an operator's missing
 * provisioning step and not a fault in the cycle.
 */
export async function runBackup(
  options: RunBackupOptions,
  deps: BackupDependencies = productionDependencies
): Promise<RunSummary> {
  const { settings } = options;
  const restoreRusticEnvironment = withRusticEnvironment(settings);
  try {
    if (!(await deps.repositoryProvisioned(settings))) {
      throw new Error(
        `runBackup: ${settings.repository.bucket}/${settings.repository.root} holds no repository — it is not provisioned. Provision the production repository by dispatching .github/workflows/backup.yml with its \`provision\` input, which keeps its credentials in the environment that already holds them. Against a local stack, \`pnpm backup --provision\`. A scheduled run never creates one.`
      );
    }
    return await backupInto(options, deps);
  } finally {
    restoreRusticEnvironment();
  }
}

/**
 * The cycle itself, entered only once the repository is known to exist.
 *
 * The order is not arbitrary. The dump has to exist before the profile naming
 * it is rendered; every snapshot has to be written before anything reads one;
 * reconciliation and the spot checks have to pass before a `forget` drops a
 * reference to an older snapshot, so a run that found a gap leaves the previous
 * good snapshots reachable. The drill and the prune run once a day because they
 * are the two steps whose cost grows with the data, and the read-data check
 * takes a rotating twenty-fourth so a day of runs reads the whole repository.
 *
 * The work directory holds a plaintext dump of every account for as long as the
 * run lasts, and the profile holds the object sources' key pair, so both are
 * removed however the run ends.
 */
async function backupInto(
  options: RunBackupOptions,
  deps: BackupDependencies
): Promise<RunSummary> {
  const { settings, hourUtc, dispatched } = options;
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hushbox-backup-'));
  try {
    const rusticPath = await deps.ensureRustic();
    const dumpDir = path.join(workDir, DUMP_DIRECTORY_NAME);
    await deps.dumpDatabase({
      databaseUrl: settings.databaseUrl,
      snapshotUrl: settings.snapshotDatabaseUrl,
      outDir: dumpDir,
      image: POSTGRES_IMAGE,
    });

    const env: BackupEnv = {
      repository: settings.repository,
      r2: settings.r2,
      sourceBuckets: settings.sourceBuckets,
      dumpDir,
    };
    const config = await deps.writeConfig(renderRusticConfig(env, settings.sourceCredentials));
    try {
      // No init flag, and no creation of any kind: two runs that both find no
      // repository each write a configuration with a master key of their own,
      // and from then on every command — theirs and every later run's — is
      // refused by the key that lost, so the corpus is unreadable rather than
      // merely incomplete. Measured twice against the pinned binary. Creating
      // the repository is {@link provisionRepository}, run once by hand.
      await deps.rustic(rusticPath, config.path, ['backup']);

      const client = deps.createClient(settings.sourceCredentials, settings.r2.region);
      await deps.reconcile({
        rusticPath,
        configPath: config.path,
        client,
        endpoint: settings.r2.endpoint,
        buckets: settings.sourceBuckets,
      });

      const spotChecks: SpotCheck[] = [];
      for (const [label, name] of Object.entries(settings.sourceBuckets)) {
        const excluded = excludedPrefixFor(label);
        spotChecks.push(
          await deps.spotCheck({
            rusticPath,
            configPath: config.path,
            client,
            label,
            bucket: { endpoint: settings.r2.endpoint, name },
            ...(excluded === undefined ? {} : { excludePrefix: excluded }),
            ...(options.random === undefined ? {} : { random: options.random }),
          })
        );
      }

      const drilled = shouldRunDrill(hourUtc, dispatched)
        ? await deps.runDrill({
            rusticPath,
            configPath: config.path,
            image: POSTGRES_IMAGE,
            workDir: path.join(workDir, DRILL_DIRECTORY_NAME),
          })
        : undefined;

      await deps.rustic(rusticPath, config.path, [
        'check',
        '--read-data',
        '--read-data-subset',
        readDataSubset(hourUtc),
      ]);
      await deps.rustic(rusticPath, config.path, forgetArguments());
      if (isDesignatedDailyRun(hourUtc)) {
        await deps.rustic(rusticPath, config.path, pruneArguments());
      }

      const sizes = await deps.readRepoInfo(rusticPath, config.path);
      const summary: RunSummary = {
        ...sizes,
        reconciled: true,
        spotChecks,
        ...(drilled === undefined ? {} : { drillPassed: drilled.passed }),
      };
      deps.writeSummary(formatSummary(summary));
      return summary;
    } finally {
      await config.cleanup();
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Creates the repository every later run writes into. One explicit act, run by
 * hand before the first scheduled run, in the class of creating the bucket and
 * minting the keys.
 *
 * Deliberately not something a run does for itself: see the backup step in
 * {@link runBackup} for what two runs racing to create one costs. `rustic init`
 * refuses a repository that already exists, and that refusal is the whole
 * safety of running this twice.
 */
export async function provisionRepository(
  settings: BackupSettings,
  deps: BackupDependencies = productionDependencies
): Promise<void> {
  const restoreRusticEnvironment = withRusticEnvironment(settings);
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hushbox-backup-'));
  try {
    const rusticPath = await deps.ensureRustic();
    const env: BackupEnv = {
      repository: settings.repository,
      r2: settings.r2,
      sourceBuckets: settings.sourceBuckets,
      dumpDir: path.join(workDir, DUMP_DIRECTORY_NAME),
    };
    const config = await deps.writeConfig(renderRusticConfig(env, settings.sourceCredentials));
    try {
      await deps.rustic(rusticPath, config.path, ['init']);
    } finally {
      await config.cleanup();
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
    restoreRusticEnvironment();
  }
}
