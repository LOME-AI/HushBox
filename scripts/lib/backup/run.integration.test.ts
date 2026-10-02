/**
 * The whole backup design, executed.
 *
 * Every module before this one was written against research rather than against
 * a running store, so this is where the design is either true or not: rustic's
 * object-storage source against the local S3 emulator standing in for R2, its
 * object-storage repository standing in for Backblaze B2, the staging-prefix
 * exclusion, the reconciliation, the spot restores, the drill, the retention
 * ladder, the deduplication, and two runs overlapping the way a delayed hourly
 * schedule makes them overlap.
 *
 * The sources are buckets of this run's own rather than the stack's, because
 * reconciliation compares a snapshot against a listing taken moments later and
 * every other suite on this stack is writing to the stack's media bucket while
 * this one runs. They carry the harness's scratch-bucket prefix, so a run that
 * dies leaves buckets the next run's sweep can attribute and reclaim.
 */

import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AwsClient } from 'aws4fetch';
import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { RUN_TOKEN_VARIABLE, mintScratchBucketId, scratchBucketName } from '@hushbox/db/test-db';
import { INPUTS_PREFIX } from '@hushbox/shared';

import { renderRusticConfig, writeRusticConfig } from './config.js';
import { createRusticRunner, readSnapshotTotals, snapshotObjectKeys } from './reconcile.js';
import { BACKUP_VARIABLES } from './run.js';
import { ensureRustic } from './rustic-binary.js';
import type { RusticConfigFile } from './config.js';
import type { RusticRunner } from './reconcile.js';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`backup/run integration: ${name} is required`);
  }
  return value;
}

const REPOSITORY_ROOT = 'repository';
const ENDPOINT = required(BACKUP_VARIABLES.sourceEndpoint).replace(/\/+$/, '');
const REGION = required(BACKUP_VARIABLES.sourceRegion);

/** One run of the orchestrator is a dump, four snapshots, a drill and a check. */
const RUN_TIMEOUT_MS = 900_000;

/**
 * Incompressible, so what a snapshot reports storing is what the objects
 * actually cost, and large enough that a re-store would be unmissable in the
 * repository as well as in the snapshot's own account of itself.
 */
const MEDIA_OBJECT_BYTES = 4 * 1024 * 1024;

const REPOSITORY_ROOT_URL = fileURLToPath(new URL('../../..', import.meta.url));

const aws = new AwsClient({
  accessKeyId: required(BACKUP_VARIABLES.sourceKeyId),
  secretAccessKey: required(BACKUP_VARIABLES.sourceKey),
  service: 's3',
  region: REGION,
});

const runToken = required(RUN_TOKEN_VARIABLE);

/**
 * The run token names the run that owns these buckets, which is what lets a
 * later sweep reclaim them; the minted id distinguishes each bucket and each
 * instance of this file, so two copies running at once — or a retry — collide
 * on nothing. The id comes from the harness rather than from here because the
 * room left for it is what is left of an object store's name length after a
 * run token, and only the harness knows how long a token is.
 */
const buckets = {
  repository: scratchBucketName(runToken, mintScratchBucketId()),
  media: scratchBucketName(runToken, mintScratchBucketId()),
  appBuilds: scratchBucketName(runToken, mintScratchBucketId()),
  modelWeights: scratchBucketName(runToken, mintScratchBucketId()),
  /** Stays empty: the bucket a run meets when nobody has provisioned one. */
  unprovisioned: scratchBucketName(runToken, mintScratchBucketId()),
};

/** The labels whose data a second run must add nothing for. */
const OBJECT_LABELS = ['media', 'app-builds', 'model-weights'] as const;

/**
 * What a snapshot says its own run stored. `data_blobs` is the criterion's
 * subject directly — a repeat run that re-stored an object, whole or in part,
 * cannot report zero of them — and `files_unmodified` says the objects were
 * seen and recognised rather than missed.
 */
const SnapshotSummarySchema = z.object({
  label: z.string(),
  time: z.string(),
  summary: z.object({
    files_new: z.int().nonnegative(),
    files_unmodified: z.int().nonnegative(),
    data_blobs: z.int().nonnegative(),
    data_added: z.int().nonnegative(),
  }),
});
const SnapshotGroupsSchema = z.array(z.object({ snapshots: z.array(SnapshotSummarySchema) }));

type SnapshotSummary = z.infer<typeof SnapshotSummarySchema>;

/** One label's summary, or a failure naming the label that has no snapshot. */
function summaryFor(
  summaries: Map<string, SnapshotSummary['summary']>,
  label: string
): SnapshotSummary['summary'] {
  const summary = summaries.get(label);
  if (summary === undefined) {
    throw new Error(`backup/run integration: no snapshot carries the label '${label}'`);
  }
  return summary;
}

/** The newest snapshot of each label, by the instant it records. */
async function newestSummaries(): Promise<Map<string, SnapshotSummary['summary']>> {
  const groups = SnapshotGroupsSchema.parse(await runner.json(['snapshots', '--json']));
  const newest = new Map<string, SnapshotSummary>();
  for (const snapshot of groups.flatMap((group) => group.snapshots)) {
    const held = newest.get(snapshot.label);
    if (held === undefined || Date.parse(held.time) < Date.parse(snapshot.time)) {
      newest.set(snapshot.label, snapshot);
    }
  }
  return new Map([...newest].map(([label, snapshot]) => [label, snapshot.summary]));
}

/** The staging object the media snapshot must not hold. */
const STAGED_KEY = `${INPUTS_PREFIX}staged-object.bin`;
const DURABLE_KEYS = ['durable-object.bin', 'nested/durable-object.bin'];

/**
 * The password this run's repository is locked with. Distinct and random so
 * the capture assertions below are about this value and not about a word that
 * could appear in a log for another reason.
 */
const REPOSITORY_PASSWORD = `injected-repository-secret-${randomBytes(8).toString('hex')}`;

let mediaBytes = 0;
let profile: RusticConfigFile | undefined;
let configPath = '';
let rusticPath = '';
let runner: RusticRunner;
let summaryFile = '';
let workRoot = '';

function object(bucket: string, key = ''): string {
  const suffix =
    key === ''
      ? ''
      : `/${key
          .split('/')
          .map((segment) => encodeURIComponent(segment))
          .join('/')}`;
  return `${ENDPOINT}/${encodeURIComponent(bucket)}${suffix}`;
}

async function send(method: string, url: string, body?: BodyInit): Promise<Response> {
  const response = await aws.fetch(url, body === undefined ? { method } : { method, body });
  if (!response.ok && response.status !== 204) {
    throw new Error(`backup/run integration: ${method} answered ${String(response.status)}`);
  }
  return response;
}

async function emptyAndRemove(bucket: string): Promise<void> {
  let token: string | undefined;
  do {
    const base = `${object(bucket)}?list-type=2`;
    const listed = await aws.fetch(
      token === undefined ? base : `${base}&continuation-token=${encodeURIComponent(token)}`
    );
    if (!listed.ok) return;
    const xml = await listed.text();
    for (const [, key] of xml.matchAll(/<Key>([\S\s]*?)<\/Key>/g)) {
      await send('DELETE', object(bucket, key ?? ''));
    }
    token = xml.includes('<IsTruncated>true</IsTruncated>')
      ? /<NextContinuationToken>([\S\s]*?)<\/NextContinuationToken>/.exec(xml)?.[1]
      : undefined;
  } while (token !== undefined);
  await send('DELETE', object(bucket));
}

/**
 * The child's environment: this run's own buckets and repository, the
 * connection the driver holds, and a job summary file to read the run's one
 * reported line back out of.
 */
function childEnvironment(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const driver = new URL(required('DATABASE_URL'));
  const direct = new URL(required('MIGRATION_DATABASE_URL'));
  direct.pathname = driver.pathname;
  return {
    ...process.env,
    [BACKUP_VARIABLES.repositoryBucket]: buckets.repository,
    [BACKUP_VARIABLES.repositoryRoot]: REPOSITORY_ROOT,
    [BACKUP_VARIABLES.repositoryEndpoint]: ENDPOINT,
    [BACKUP_VARIABLES.repositoryRegion]: REGION,
    [BACKUP_VARIABLES.repositoryPassword]: REPOSITORY_PASSWORD,
    [BACKUP_VARIABLES.mediaBucket]: buckets.media,
    [BACKUP_VARIABLES.appBuildsBucket]: buckets.appBuilds,
    [BACKUP_VARIABLES.modelWeightsBucket]: buckets.modelWeights,
    [BACKUP_VARIABLES.databaseUrl]: direct.toString(),
    [BACKUP_VARIABLES.snapshotDatabaseUrl]: driver.toString(),
    GITHUB_STEP_SUMMARY: summaryFile,
    ...overrides,
  };
}

interface Capture {
  readonly exitCode: number | undefined;
  readonly output: string;
}

/** One `scripts/backup.ts`, exactly as `pnpm backup` runs it past its wrapper. */
async function backup(
  args: readonly string[] = [],
  summary = summaryFile,
  overrides: Record<string, string> = {}
): Promise<Capture> {
  const result = await execa(
    process.execPath,
    ['--import', 'tsx', path.join('scripts', 'backup.ts'), ...args],
    {
      cwd: REPOSITORY_ROOT_URL,
      env: childEnvironment({ GITHUB_STEP_SUMMARY: summary, ...overrides }),
      reject: false,
      timeout: RUN_TIMEOUT_MS,
    }
  );
  return { exitCode: result.exitCode, output: `${result.stdout}\n${result.stderr}` };
}

/**
 * Every key a bucket holds, for a bucket small enough to list in one page.
 *
 * Through {@link send}, so a listing the store refuses fails the test rather
 * than reading as an empty bucket.
 */
async function keysIn(bucket: string): Promise<string[]> {
  const listed = await send('GET', `${object(bucket)}?list-type=2`);
  const xml = await listed.text();
  return [...xml.matchAll(/<Key>([\S\s]*?)<\/Key>/g)].map(([, key]) => key ?? '');
}

beforeAll(async () => {
  rusticPath = await ensureRustic();
  workRoot = await mkdtemp(path.join(os.tmpdir(), 'hb-backup-it-'));
  summaryFile = path.join(workRoot, 'summary.md');

  for (const bucket of Object.values(buckets)) await send('PUT', object(bucket));
  const durable = DURABLE_KEYS.map(() => randomBytes(MEDIA_OBJECT_BYTES / DURABLE_KEYS.length));
  for (const [index, key] of DURABLE_KEYS.entries()) {
    const body = durable[index] ?? new Uint8Array();
    mediaBytes += body.byteLength;
    await send('PUT', object(buckets.media, key), body);
  }
  await send('PUT', object(buckets.media, STAGED_KEY), randomBytes(1024));
  await send('PUT', object(buckets.appBuilds, 'build.bin'), randomBytes(2048));
  await send('PUT', object(buckets.modelWeights, 'weights.bin'), randomBytes(2048));

  // The reader below opens the same repository the child writes, so it needs
  // the same password and key pair; the child takes its own from its
  // environment and never from here.
  process.env['RUSTIC_PASSWORD'] = REPOSITORY_PASSWORD;
  process.env['OPENDAL_ACCESS_KEY_ID'] = required(BACKUP_VARIABLES.sourceKeyId);
  process.env['OPENDAL_SECRET_ACCESS_KEY'] = required(BACKUP_VARIABLES.sourceKey);
  profile = await writeRusticConfig(
    renderRusticConfig(
      {
        repository: {
          endpoint: ENDPOINT,
          region: REGION,
          bucket: buckets.repository,
          root: REPOSITORY_ROOT,
        },
        r2: { endpoint: ENDPOINT, region: REGION },
        sourceBuckets: {
          media: buckets.media,
          'app-builds': buckets.appBuilds,
          'model-weights': buckets.modelWeights,
        },
        dumpDir: path.join(workRoot, 'unused'),
      },
      {
        accessKeyId: required(BACKUP_VARIABLES.sourceKeyId),
        secretAccessKey: required(BACKUP_VARIABLES.sourceKey),
      }
    )
  );
  configPath = profile.path;
  runner = createRusticRunner(rusticPath, configPath);

  // The repository is created once, by hand, exactly as the runbook has an
  // operator create it — no run makes one, and every test below runs against
  // the repository this call created.
  const provisioned = await backup(['--provision']);
  if (provisioned.exitCode !== 0) {
    throw new Error(`backup/run integration: provisioning exited ${String(provisioned.exitCode)}`);
  }
}, RUN_TIMEOUT_MS);

afterAll(async () => {
  // Undefined whenever the setup above failed part way, which is exactly when
  // the buckets below still need removing: a teardown that assumed the profile
  // exists would throw here and leave them standing.
  await profile?.cleanup();
  for (const bucket of Object.values(buckets)) await emptyAndRemove(bucket);
  await rm(workRoot, { recursive: true, force: true });
  delete process.env['RUSTIC_PASSWORD'];
  delete process.env['OPENDAL_ACCESS_KEY_ID'];
  delete process.env['OPENDAL_SECRET_ACCESS_KEY'];
}, RUN_TIMEOUT_MS);

describe('one backup run against the local object store and database', () => {
  it(
    'writes a snapshot per source, leaves the staging prefix out, drills, and reports one line',
    async () => {
      const first = await backup(['--dispatched']);
      expect(first.exitCode, first.output).toBe(0);

      const grouped = await runner.json(['snapshots', '--json']);
      const labels = (grouped as { snapshots: { label: string }[] }[])
        .flatMap((group) => group.snapshots)
        .map((snapshot) => snapshot.label)
        .toSorted((left, right) => left.localeCompare(right));
      expect(labels).toEqual(['app-builds', 'media', 'model-weights', 'postgres']);

      const media = await readSnapshotTotals(rusticPath, configPath, 'media', runner);
      expect(media.count).toBe(DURABLE_KEYS.length);
      expect(media.bytes).toBe(mediaBytes);

      const paths = (await runner.json(['ls', media.id, '--json'])) as string[];
      const byName = (left: string, right: string): number => left.localeCompare(right);
      expect(snapshotObjectKeys(paths, 'media').toSorted(byName)).toEqual(
        DURABLE_KEYS.toSorted(byName)
      );
      expect(paths.join(' ')).not.toContain(STAGED_KEY);

      const reported = await readFile(summaryFile, 'utf8');
      expect(reported).toMatch(/^- backup: logical \d+ bytes, stored \d+ bytes/m);
      expect(reported).toContain('objects reconciled');
      expect(reported).toContain('drill passed');
    },
    RUN_TIMEOUT_MS
  );

  it(
    'stores the objects once however many runs snapshot them',
    async () => {
      const first = await newestSummaries();

      const second = await backup();
      expect(second.exitCode, second.output).toBe(0);

      // Not a bound on how much the repository grew: each run's dump is
      // legitimately new content, so repository growth admits megabytes and
      // says nothing about the objects. What a re-store cannot hide from is
      // the snapshot's own account of the blobs it added.
      const repeated = await newestSummaries();
      for (const label of OBJECT_LABELS) {
        const before = summaryFor(first, label);
        expect(summaryFor(repeated, label), label).toEqual({
          files_new: 0,
          files_unmodified: before.files_new + before.files_unmodified,
          data_blobs: 0,
          data_added: 0,
        });
      }
      expect(summaryFor(repeated, 'media').files_unmodified).toBe(DURABLE_KEYS.length);
      // The same run's dump did add data, so the zeros above are a second run
      // that stored nothing new for the objects rather than one that did
      // nothing at all.
      expect(summaryFor(repeated, 'postgres').data_blobs).toBeGreaterThan(0);
    },
    RUN_TIMEOUT_MS
  );

  it(
    'prints no credential, connection or dump path of its own',
    async () => {
      const captured = await backup([], path.join(workRoot, 'capture.md'));

      expect(captured.exitCode, captured.output).toBe(0);
      expect(captured.output).not.toContain(REPOSITORY_PASSWORD);
      expect(captured.output).not.toContain(required(BACKUP_VARIABLES.sourceKey));
      expect(captured.output).not.toMatch(/postgres(?:ql)?:\/\//);
      expect(captured.output).not.toContain(path.join(os.tmpdir(), 'hushbox-backup-'));
    },
    RUN_TIMEOUT_MS
  );

  it(
    'refuses a repository nobody has provisioned, twice over at once, and creates nothing',
    async () => {
      const cold = { [BACKUP_VARIABLES.repositoryBucket]: buckets.unprovisioned };
      const [left, right] = await Promise.all([
        backup([], path.join(workRoot, 'cold-left.md'), cold),
        backup([], path.join(workRoot, 'cold-right.md'), cold),
      ]);

      expect(left.exitCode).not.toBe(0);
      expect(right.exitCode).not.toBe(0);
      for (const refused of [left, right]) {
        expect(refused.output).toContain(buckets.unprovisioned);
        expect(refused.output).toContain('not provisioned');
        expect(refused.output).not.toContain(REPOSITORY_PASSWORD);
      }
      expect(await keysIn(buckets.unprovisioned)).toEqual([]);
    },
    RUN_TIMEOUT_MS
  );

  it(
    'lets two runs overlap, and both finish',
    async () => {
      const [left, right] = await Promise.all([
        backup([], path.join(workRoot, 'left.md')),
        backup([], path.join(workRoot, 'right.md')),
      ]);

      expect(left.exitCode, left.output).toBe(0);
      expect(right.exitCode, right.output).toBe(0);
      expect(await readFile(path.join(workRoot, 'left.md'), 'utf8')).toContain('- backup:');
      expect(await readFile(path.join(workRoot, 'right.md'), 'utf8')).toContain('- backup:');
    },
    RUN_TIMEOUT_MS
  );
});
