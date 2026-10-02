import { AwsClient } from 'aws4fetch';
import {
  SCRATCH_BUCKET_PREFIX,
  runIdFromToken,
  scratchBucketPrefix,
  scratchBucketRunToken,
} from '@hushbox/db/test-db';
import { reapPass, unownedFinding } from '../claims/ownership.js';
import { stateOfRunNamedResource } from './run-named-resource.js';
import type { Ownership, OwnershipState } from '../claims/ownership.js';

/**
 * Reclamation for the scratch buckets storage-touching suites create.
 *
 * These buckets are made and destroyed by raw S3 calls from inside the test
 * fixture, outside the compose project, so nothing else in the repo has ever
 * been able to reach them: a run killed while holding one orphaned the bucket
 * and its objects for good. This is that missing reclamation, keyed on the
 * owning run's claim rather than on the bucket's age — age cannot tell a live
 * suite's bucket from a dead one's, and a sweep that guessed wrong would delete
 * the fixtures out from under a running suite.
 *
 * A bucket names its owning run, and the run also records the prefix that name
 * gives it against its claim. Either can attribute the bucket and the two cover
 * different halves of a run's life, which `run-named-resource.ts` orders. A
 * bucket neither accounts for — including every bucket named before buckets
 * carried a run id — is reported and left standing.
 */

export interface ScratchBucketStore {
  /** Every scratch bucket the endpoint holds, whoever owns it. */
  list(): Promise<string[]>;
  /**
   * Empties and removes one bucket. Idempotent: a bucket that is already gone
   * is what the call was asking for, so removing one twice succeeds twice.
   */
  destroy(bucket: string): Promise<void>;
}

interface ScratchBucketReport {
  /** Buckets whose owning run is gone, and which this pass removed. */
  readonly dropped: string[];
  /** Buckets no claim accounts for. Reported and left standing. */
  readonly unowned: string[];
}

interface ReclaimOptions {
  /** Defaults to the machine-wide registry; a test points it elsewhere. */
  readonly registryDir?: string;
}

export function stateOfScratchBucket(bucket: string, ownership: Ownership): OwnershipState {
  const runToken = scratchBucketRunToken(bucket);
  if (runToken === undefined) return 'unowned';
  return stateOfRunNamedResource(
    ownership,
    'bucket',
    scratchBucketPrefix(runToken),
    runIdFromToken(runToken)
  );
}

function reportUnowned(names: readonly string[], ownership: Ownership): void {
  const finding = unownedFinding(ownership);
  for (const name of names) {
    console.warn(
      `scratch bucket ${name} is ${finding}. Classify everything with ` +
        `\`pnpm dev:clean --dry-run\`.`
    );
  }
}

export async function reclaimScratchBuckets(
  store: ScratchBucketStore,
  options: ReclaimOptions = {}
): Promise<ScratchBucketReport> {
  const report = await reapPass({
    what: 'scratch buckets',
    registryDir: options.registryDir,
    scan: () => store.list(),
    reap: async (present, ownership) => {
      const dropped: string[] = [];
      const unowned: string[] = [];

      for (const bucket of present) {
        const state = stateOfScratchBucket(bucket, ownership);
        if (state === 'owned-expired') {
          await store.destroy(bucket);
          dropped.push(bucket);
        } else if (state === 'unowned') {
          unowned.push(bucket);
        }
      }

      reportUnowned(unowned, ownership);
      return { dropped, unowned };
    },
  });

  // A skipped pass reclaimed nothing, which is the empty report: the skip
  // itself is already printed where it was decided.
  return report ?? { dropped: [], unowned: [] };
}

/** Where an S3-compatible object store answers, and the credentials it takes. */
export interface ObjectStoreEndpoint {
  readonly endpoint: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/**
 * The captures of every match, in order. A match array holds strings, so a
 * capture the pattern requires needs no presence check — and a check nothing
 * can fail is a branch no test can reach.
 */
function captures(xml: string, pattern: RegExp): string[] {
  return [...xml.matchAll(pattern)].flatMap((match) => match.slice(1));
}

/** Bucket names out of a `ListAllMyBuckets` body, ignoring the owner block around them. */
export function parseBucketNames(xml: string): string[] {
  return captures(xml, /<Bucket>[\S\s]*?<Name>([\S\s]*?)<\/Name>/g);
}

/** Object keys out of a `ListObjectsV2` body. */
export function parseObjectKeys(xml: string): string[] {
  return captures(xml, /<Contents>[\S\s]*?<Key>([\S\s]*?)<\/Key>/g);
}

/** A key is a path, so each segment is escaped and the separators are kept. */
function encodeKey(key: string): string {
  return key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/**
 * S3 says `404` for a bucket that is not there, and a bucket that is not there
 * is what a removal was asking for. Nothing serialises reclamation passes — one
 * runs per vitest process and those start concurrently — so two of them can
 * classify the same expired bucket and both remove it; the loser must see
 * already-done as done rather than fail the run it is housekeeping for.
 */
const ALREADY_GONE = 404;

function assertOk(response: Response, operation: string, bucket: string): void {
  if (!response.ok) {
    throw new Error(`scratch bucket ${operation} on ${bucket} returned ${String(response.status)}`);
  }
}

interface ObjectStoreClient {
  readonly aws: AwsClient;
  readonly endpoint: string;
}

function objectStoreClient(config: ObjectStoreEndpoint): ObjectStoreClient {
  return {
    endpoint: config.endpoint.replace(/\/+$/, ''),
    aws: new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: 's3',
      region: 'auto',
    }),
  };
}

/**
 * Deletes every object a bucket holds and leaves the bucket standing. Answers
 * whether the bucket was there at all: one that is not holds nothing, which is
 * what emptying it was asking for.
 */
async function emptyBucketWith(
  { aws, endpoint }: ObjectStoreClient,
  bucket: string
): Promise<boolean> {
  // Re-list from the start until empty: a delete invalidates any cursor,
  // and this way one loop handles a bucket of any size.
  for (;;) {
    const listing = await aws.fetch(`${endpoint}/${bucket}?list-type=2`);
    if (listing.status === ALREADY_GONE) return false;
    assertOk(listing, 'list objects', bucket);
    const keys = parseObjectKeys(await listing.text());
    if (keys.length === 0) return true;
    for (const key of keys) {
      assertOk(
        await aws.fetch(`${endpoint}/${bucket}/${encodeKey(key)}`, { method: 'DELETE' }),
        'delete object',
        bucket
      );
    }
  }
}

/** Empties one bucket of every object, keeping the bucket itself. */
export async function emptyBucket(config: ObjectStoreEndpoint, bucket: string): Promise<void> {
  await emptyBucketWith(objectStoreClient(config), bucket);
}

export function createScratchBucketStore(config: ObjectStoreEndpoint): ScratchBucketStore {
  const client = objectStoreClient(config);
  const { aws, endpoint } = client;

  return {
    list: async () => {
      const response = await aws.fetch(`${endpoint}/`);
      assertOk(response, 'list', 'the endpoint');
      return parseBucketNames(await response.text()).filter((name) =>
        name.startsWith(SCRATCH_BUCKET_PREFIX)
      );
    },
    destroy: async (bucket) => {
      if (!(await emptyBucketWith(client, bucket))) return;
      const removal = await aws.fetch(`${endpoint}/${bucket}`, { method: 'DELETE' });
      if (removal.status === ALREADY_GONE) return;
      assertOk(removal, 'delete', bucket);
    },
  };
}

function requireVariable(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `object store: ${name} is required — run through \`tsx scripts/with-env.ts\` ` +
        'or a pnpm script, which is what loads the env files'
    );
  }
  return value;
}

/** The object store an already-loaded environment names. */
export function objectStoreEndpointFrom(env: NodeJS.ProcessEnv): ObjectStoreEndpoint {
  return {
    endpoint: requireVariable(env, 'R2_S3_ENDPOINT'),
    accessKeyId: requireVariable(env, 'R2_ACCESS_KEY_ID'),
    secretAccessKey: requireVariable(env, 'R2_SECRET_ACCESS_KEY'),
  };
}

export function requireScratchBucketStore(env: NodeJS.ProcessEnv): ScratchBucketStore {
  return createScratchBucketStore(objectStoreEndpointFrom(env));
}
