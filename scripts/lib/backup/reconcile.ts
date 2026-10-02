import { constants as bufferConstants } from 'node:buffer';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';

import { execa } from 'execa';
import { z } from 'zod';

import { INPUTS_PREFIX } from '@hushbox/shared';

import type { BackupEnv } from './config.js';
import type { AwsClient } from 'aws4fetch';

/**
 * The run's proof that the snapshots hold the buckets: an independent listing
 * of every source bucket, compared against what the snapshot says it took, and
 * one object per bucket restored and re-hashed against the live original.
 *
 * The two halves answer different questions and neither replaces the other.
 * rustic decides what to re-read from a listing's sizes and modification times,
 * so a listing it never saw is a gap only a second, independent listing can
 * find; and counts and bytes can agree while the stored bytes differ, which
 * only a restore-and-compare can catch.
 */

/** Where a bucket is, since the signer holds a credential and no address. */
export interface BucketLocation {
  readonly endpoint: string;
  readonly name: string;
}

/** What one side of the comparison contributes. */
export interface BucketTotals {
  readonly count: number;
  readonly bytes: number;
}

interface ListingPage extends BucketTotals {
  readonly nextToken: string | undefined;
}

/** `<Contents>` blocks, each read for the two fields the comparison needs. */
const CONTENTS_BLOCK = /<Contents>[\S\s]*?<\/Contents>/g;
const KEY_TAG = /<Key>([\S\s]*?)<\/Key>/;
const SIZE_TAG = /<Size>([\S\s]*?)<\/Size>/;
const TRUNCATED_MARK = '<IsTruncated>true</IsTruncated>';
const NEXT_TOKEN_TAG = /<NextContinuationToken>([\S\s]*?)<\/NextContinuationToken>/;

/**
 * One page of a `ListObjectsV2` body, already netted of the excluded prefix.
 *
 * A block missing either field is a malformed answer rather than an object of
 * unknown size: dropping it would understate the bucket and turn a real gap
 * into a match, which is the one failure this whole comparison exists to catch.
 */
function readContentsBlock(block: string): { key: string; size: number } {
  const key = KEY_TAG.exec(block)?.[1];
  const size = SIZE_TAG.exec(block)?.[1];
  if (key === undefined || size === undefined) {
    throw new TypeError('listBucket: a Contents block names no Key or no Size');
  }
  const sizeBytes = Number.parseInt(size, 10);
  if (!Number.isSafeInteger(sizeBytes)) {
    throw new TypeError('listBucket: a Contents block gives a Size that is not a whole number');
  }
  return { key, size: sizeBytes };
}

export function parseListPage(xml: string, excludePrefix?: string): ListingPage {
  let count = 0;
  let bytes = 0;
  for (const [block] of xml.matchAll(CONTENTS_BLOCK)) {
    const object = readContentsBlock(block);
    if (excludePrefix !== undefined && object.key.startsWith(excludePrefix)) continue;
    count += 1;
    bytes += object.size;
  }
  const truncated = xml.includes(TRUNCATED_MARK);
  return { count, bytes, nextToken: truncated ? NEXT_TOKEN_TAG.exec(xml)?.[1] : undefined };
}

/**
 * Counts and measures a bucket straight from the store, walking every page.
 *
 * The count is of objects the snapshot is expected to hold, so the excluded
 * prefix is dropped here exactly as the snapshot's own glob drops it — both
 * sides read the one shared constant, so neither can be narrowed alone.
 */
export async function listBucket(
  client: AwsClient,
  bucket: BucketLocation,
  excludePrefix?: string
): Promise<BucketTotals> {
  const base = `${bucket.endpoint.replace(/\/+$/, '')}/${bucket.name}?list-type=2`;
  let count = 0;
  let bytes = 0;
  let token: string | undefined;
  do {
    const url =
      token === undefined ? base : `${base}&continuation-token=${encodeURIComponent(token)}`;
    const response = await client.fetch(url);
    if (!response.ok) {
      throw new Error(
        `listBucket: the store answered ${String(response.status)} listing '${bucket.name}'`
      );
    }
    const page = parseListPage(await response.text(), excludePrefix);
    count += page.count;
    bytes += page.bytes;
    token = page.nextToken;
  } while (token !== undefined);
  return { count, bytes };
}

/**
 * The prefix a label's objects are excluded by, or nothing when the whole
 * bucket is taken. The one entry is the media bucket's staging prefix, and it
 * reads the same constant the snapshot's own glob is built from, so the two
 * sides of the comparison cannot be narrowed apart.
 */
export function excludedPrefixFor(label: string): string | undefined {
  return label === 'media' ? INPUTS_PREFIX : undefined;
}

/** How rustic is asked a question, so a test can answer without a repository. */
export interface RusticRunner {
  /** Arguments after the profile; stdout parsed as JSON. */
  json(args: readonly string[]): Promise<unknown>;
  /**
   * Arguments after the profile; the SHA-256 of stdout, taken as it arrives.
   *
   * The digest and not the bytes, because the one caller restores a whole
   * object of a user's and a single object is allowed to reach
   * `MAX_MEDIA_OBJECT_BYTES` — far past what any subprocess library will hold
   * in one buffer, and past what this process should hold at all.
   */
  digest(args: readonly string[]): Promise<string>;
}

/**
 * SHA-256 over a stream, one chunk resident at a time.
 *
 * Both sides of the spot check run through this, so neither a restored object
 * nor the live object it is compared against is ever held whole.
 */
export async function digestOfStream(source: AsyncIterable<Uint8Array>): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of source) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

/**
 * Whatever a failed subprocess is willing to say about how it ended. A command
 * that never started carries no exit code at all, which is the shape a missing
 * binary arrives in — a different repair from a command that ran and failed,
 * so the two are reported as different classes.
 */
const ExitedSchema = z.object({ exitCode: z.number() });

/**
 * The flag a subprocess library raises when it stopped reading at the ceiling.
 * It reports that failure with a zero exit code, which is what the child really
 * exited with and says nothing about the ceiling, so the class has to be read
 * off the flag; and it has to be read, because hitting the ceiling is the one
 * failure here that calls for a different design rather than a repair.
 */
const OverCeilingSchema = z.object({ isMaxBuffer: z.literal(true) });

function exitStatusOf(error: unknown): string {
  const exited = ExitedSchema.safeParse(error);
  return exited.success ? `exit code ${String(exited.data.exitCode)}` : 'the command did not start';
}

/**
 * The SHA-256 of a command's stdout, hashed as the command writes it.
 *
 * The failure carries the exit status and nothing else: the arguments of the
 * one call this serves name an object of a user's, and a subprocess library's
 * own error prints the whole command line it ran.
 */
export async function digestOfCommand(command: string, args: readonly string[]): Promise<string> {
  const subprocess = execa(command, args, { buffer: false });
  try {
    const [digest] = await Promise.all([digestOfStream(subprocess.stdout), subprocess]);
    return digest;
  } catch (error) {
    throw new Error(`digestOfCommand: reading a command's output failed, ${exitStatusOf(error)}`);
  }
}

/**
 * The ceiling on an answer that has to be read whole. A snapshot listing grows
 * with the object count and `JSON.parse` cannot be given a document in pieces,
 * so the ceiling is the largest string the runtime can hold rather than the
 * smaller default the subprocess library would otherwise stop at; past it the
 * run fails instead of parsing a truncated listing.
 */
const JSON_OUTPUT_LIMIT_BYTES = bufferConstants.MAX_STRING_LENGTH;

export interface JsonCommandOptions {
  readonly command: string;
  readonly args: readonly string[];
  /** The rustic subcommand, the only part of the call safe to name. */
  readonly subcommand: string;
  /** The ceiling on stdout; a test lowers it to reach the over-ceiling path. */
  readonly limit?: number;
}

/**
 * A command's stdout parsed as JSON, read whole because a document cannot be
 * parsed in pieces.
 *
 * The failure carries the subcommand and the failure's class and nothing else.
 * The one listing this serves is a bucket's whole set of object keys, and every
 * error on the path prints the output it choked on: a subprocess library's own
 * error appends captured stdout and stderr, and `JSON.parse` quotes the text it
 * could not read. The class is the only diagnostic this leaves a reader of a
 * run's log, and it has to name the failure on its own, because the exit status
 * cannot tell the failures that exit zero apart from a clean run.
 */
export async function jsonOfCommand(options: JsonCommandOptions): Promise<unknown> {
  const { command, args, subcommand } = options;
  const failed = (why: string): Error =>
    new Error(`jsonOfCommand: reading '${subcommand}' as JSON failed, ${why}`);

  let stdout: string;
  try {
    ({ stdout } = await execa(command, args, {
      maxBuffer: options.limit ?? JSON_OUTPUT_LIMIT_BYTES,
    }));
  } catch (error) {
    throw failed(
      OverCeilingSchema.safeParse(error).success
        ? 'the output passes the ceiling'
        : exitStatusOf(error)
    );
  }

  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw failed('the output is not a document');
  }
}

/** The runner given, or one built for this repository and profile. */
export function runnerFor(
  rusticPath: string,
  configPath: string,
  runner?: RusticRunner
): RusticRunner {
  return runner ?? createRusticRunner(rusticPath, configPath);
}

export function createRusticRunner(rusticPath: string, configPath: string): RusticRunner {
  const profile = ['--use-profile', configPath];
  return {
    json: (args) =>
      jsonOfCommand({
        command: rusticPath,
        args: [...profile, ...args],
        subcommand: args[0] ?? 'no subcommand',
      }),
    /* v8 ignore next -- the streaming seam, exercised by the backup run itself */
    digest: (args) => digestOfCommand(rusticPath, [...profile, ...args]),
  };
}

/**
 * The fields of `rustic snapshots --json` this run reads. The output is grouped
 * — by host, label and path, which is rustic's default — so the snapshots sit
 * one level in.
 */
const SnapshotSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  time: z.string(),
  summary: z.object({
    total_files_processed: z.int().nonnegative(),
    total_bytes_processed: z.int().nonnegative(),
  }),
});

const SnapshotGroupsSchema = z.array(z.object({ snapshots: z.array(SnapshotSchema) }));

/** A snapshot's own account of what it took, and which snapshot said so. */
export interface SnapshotTotals extends BucketTotals {
  readonly id: string;
}

/**
 * The newest snapshot carrying the label, chosen by the instant it records
 * rather than by where it sits in the output: the recorded instant carries the
 * writer's UTC offset, so the values are compared as instants and never as text.
 */
function instantOf(snapshot: z.infer<typeof SnapshotSchema>): number {
  const at = Date.parse(snapshot.time);
  if (Number.isNaN(at)) {
    throw new TypeError(
      `selectNewestSnapshot: '${snapshot.label}' has a snapshot with no readable time`
    );
  }
  return at;
}

export function selectNewestSnapshot(output: unknown, label: string): SnapshotTotals {
  const [newest] = SnapshotGroupsSchema.parse(output)
    .flatMap((group) => group.snapshots)
    .filter((snapshot) => snapshot.label === label)
    .map((snapshot) => ({ snapshot, at: instantOf(snapshot) }))
    .toSorted((left, right) => right.at - left.at);
  if (newest === undefined) {
    throw new Error(`selectNewestSnapshot: no snapshot carries the label '${label}'`);
  }
  return {
    id: newest.snapshot.id,
    count: newest.snapshot.summary.total_files_processed,
    bytes: newest.snapshot.summary.total_bytes_processed,
  };
}

/** What the newest snapshot of a label says it holds. */
export async function readSnapshotTotals(
  rusticPath: string,
  configPath: string,
  label: string,
  runner?: RusticRunner
): Promise<SnapshotTotals> {
  const rustic = runnerFor(rusticPath, configPath, runner);
  return selectNewestSnapshot(await rustic.json(['snapshots', '--json']), label);
}

/**
 * A snapshot and its bucket disagreeing on what was taken. Counts and bytes are
 * the whole message: no key, and nothing read out of an object.
 */
export class ReconcileMismatchError extends Error {
  constructor(
    readonly label: string,
    readonly snapshot: BucketTotals,
    readonly bucket: BucketTotals
  ) {
    super(
      `reconcile: '${label}' snapshot holds ${String(snapshot.count)} objects and ` +
        `${String(snapshot.bytes)} bytes; its bucket lists ${String(bucket.count)} objects and ` +
        `${String(bucket.bytes)} bytes`
    );
    this.name = 'ReconcileMismatchError';
  }
}

export interface ReconcileOptions {
  readonly rusticPath: string;
  readonly configPath: string;
  readonly client: AwsClient;
  /** The S3 endpoint every source bucket is addressed on. */
  readonly endpoint: string;
  /**
   * The object buckets by label, which is what decides the labels walked. The
   * type is the configured source set, so every source bucket is reconciled and
   * the dump's label cannot be passed as though it were a bucket.
   */
  readonly buckets: BackupEnv['sourceBuckets'];
  readonly runner?: RusticRunner;
}

/** One label's agreed figures, and the snapshot they were agreed against. */
export interface LabelReconciliation {
  readonly label: string;
  readonly snapshotId: string;
  readonly totals: BucketTotals;
}

/**
 * Proves every object snapshot against a listing of its bucket taken here, and
 * fails the run at the first label whose two sides disagree.
 *
 * The labels are the keys of the bucket map rather than a list written again
 * here: a source added to the configuration is reconciled by having been added,
 * and no dump label can be walked as though it were a bucket.
 */
export async function reconcile(
  options: ReconcileOptions
): Promise<readonly LabelReconciliation[]> {
  const { rusticPath, configPath, client, endpoint, buckets, runner } = options;
  const reconciled: LabelReconciliation[] = [];
  for (const [label, name] of Object.entries(buckets)) {
    const snapshot = await readSnapshotTotals(rusticPath, configPath, label, runner);
    const listed = await listBucket(client, { endpoint, name }, excludedPrefixFor(label));
    if (snapshot.count !== listed.count || snapshot.bytes !== listed.bytes) {
      throw new ReconcileMismatchError(label, snapshot, listed);
    }
    reconciled.push({ label, snapshotId: snapshot.id, totals: listed });
  }
  return reconciled;
}

/** The paths of `rustic ls <snapshot> --json`. */
const SnapshotPathsSchema = z.array(z.string());

/**
 * The object keys a snapshot holds, relative to the label its tree is rooted
 * at, out of the paths rustic lists.
 *
 * A listing names directories beside files and says which is which nowhere, so
 * a path another path is nested under is a directory and is dropped; the
 * ancestors of every path are collected in one pass, because a listing holds
 * one entry per object and comparing each entry against every other would grow
 * with the square of the bucket. What
 * survives that and is not itself excluded is an object: an excluded subtree
 * can leave its own directory node behind with every child gone, which is why
 * the exclusion is applied on this side too and not only to the bucket.
 */
export function snapshotObjectKeys(
  paths: readonly string[],
  label: string,
  excludePrefix?: string
): string[] {
  const root = `${label}/`;
  const directories = new Set<string>();
  for (const candidate of paths) {
    for (let cut = candidate.indexOf('/'); cut !== -1; cut = candidate.indexOf('/', cut + 1)) {
      directories.add(candidate.slice(0, cut));
    }
  }
  return paths
    .filter((candidate) => !directories.has(candidate))
    .filter((candidate) => candidate.startsWith(root))
    .map((candidate) => candidate.slice(root.length))
    .filter(
      (key) =>
        key !== '' &&
        // `${key}/` and not `key`, so that the emptied directory node an
        // excluded subtree leaves behind is excluded by the same prefix its
        // children were.
        (excludePrefix === undefined || !`${key}/`.startsWith(excludePrefix))
    );
}

/** What one bucket's spot check produced. */
export interface SpotCheck {
  readonly label: string;
  readonly status: 'passed' | 'skipped';
  /** Why nothing was compared. Present only on a skip. */
  readonly reason?: string;
}

/**
 * Stored bytes that are no longer the bytes they were taken from. The label and
 * the two digests are the whole message: a digest names nothing about an object
 * but whether it changed, while a key names a user's object and the bytes are
 * that user's content.
 */
export class SpotCheckMismatchError extends Error {
  constructor(
    readonly label: string,
    readonly restoredDigest: string,
    readonly liveDigest: string
  ) {
    super(
      `spotCheckObject: '${label}' restored an object hashing to ${restoredDigest}, ` +
        `while the live object hashes to ${liveDigest}`
    );
    this.name = 'SpotCheckMismatchError';
  }
}

/** A key is a path, so each segment is escaped and the separators are kept. */
function objectUrl(bucket: BucketLocation, key: string): string {
  const segments = key.split('/').map((segment) => encodeURIComponent(segment));
  return `${bucket.endpoint.replace(/\/+$/, '')}/${bucket.name}/${segments.join('/')}`;
}

/** S3 says this for an object that is not there, which a deletion leaves. */
const NOT_FOUND = 404;

export interface SpotCheckOptions {
  readonly rusticPath: string;
  readonly configPath: string;
  readonly client: AwsClient;
  readonly label: string;
  readonly bucket: BucketLocation;
  /** Keys under this prefix are neither snapshotted nor drawn. */
  readonly excludePrefix?: string;
  readonly runner?: RusticRunner;
  /** The draw that picks the object; a test pins it. */
  readonly random?: () => number;
}

/**
 * Restores one object of a snapshot and proves its bytes are still the bytes
 * the bucket holds.
 *
 * This is the only check in the run that compares content: reconciliation
 * compares a snapshot's own account of a bucket against the bucket, and the
 * repository's read-data check proves stored bytes are intact against what was
 * stored — neither can see stored bytes that were never the source's.
 *
 * A live object that is gone is a pass of a different question: keys are uuid
 * and objects are never rewritten, so an object present at the snapshot and
 * absent now was deleted in between, which is the product working. It is
 * recorded as skipped, and never retried against a second key, because a run
 * that kept drawing until it found a live object would quietly stop being a
 * uniform sample.
 */
export async function spotCheckObject(options: SpotCheckOptions): Promise<SpotCheck> {
  const { rusticPath, configPath, client, label, bucket, excludePrefix } = options;
  const runner = runnerFor(rusticPath, configPath, options.runner);
  const draw = options.random ?? Math.random;

  const snapshot = await readSnapshotTotals(rusticPath, configPath, label, runner);
  const paths = SnapshotPathsSchema.parse(await runner.json(['ls', snapshot.id, '--json']));
  const keys = snapshotObjectKeys(paths, label, excludePrefix);
  const key = keys[Math.min(Math.floor(draw() * keys.length), keys.length - 1)];
  if (key === undefined) {
    return { label, status: 'skipped', reason: 'the snapshot holds no object' };
  }

  const restoredDigest = await runner.digest(['dump', `${snapshot.id}:${label}/${key}`]);
  const live = await client.fetch(objectUrl(bucket, key));
  if (live.status === NOT_FOUND) {
    return { label, status: 'skipped', reason: 'the object was deleted after the snapshot' };
  }
  if (!live.ok) {
    throw new Error(
      `spotCheckObject: the store answered ${String(live.status)} reading an object of '${label}'`
    );
  }
  if (live.body === null) {
    throw new Error(`spotCheckObject: the store read an object of '${label}' with no body`);
  }

  const liveDigest = await digestOfStream(live.body);
  if (restoredDigest !== liveDigest) {
    throw new SpotCheckMismatchError(label, restoredDigest, liveDigest);
  }
  return { label, status: 'passed' };
}

/**
 * The blob table of `rustic repoinfo --json`: per blob type, the size the data
 * has unpacked and the size it occupies in packs. Blobs already marked for
 * deletion are reported separately and are deliberately not read here — the
 * summary states what the repository holds, not what a prune has yet to drop.
 */
const RepoInfoSchema = z.object({
  index: z.object({
    blobs: z.array(z.object({ size: z.int().nonnegative(), data_size: z.int().nonnegative() })),
  }),
});

/** What the repository holds, before and after deduplication and compression. */
export interface RepoSizes {
  readonly logicalBytes: number;
  readonly storedBytes: number;
}

export async function readRepoInfo(
  rusticPath: string,
  configPath: string,
  runner?: RusticRunner
): Promise<RepoSizes> {
  const rustic = runnerFor(rusticPath, configPath, runner);
  const { index } = RepoInfoSchema.parse(await rustic.json(['repoinfo', '--json']));
  let logicalBytes = 0;
  let storedBytes = 0;
  for (const blob of index.blobs) {
    logicalBytes += blob.data_size;
    storedBytes += blob.size;
  }
  return { logicalBytes, storedBytes };
}

export interface RunSummary extends RepoSizes {
  readonly reconciled: boolean;
  readonly spotChecks: readonly SpotCheck[];
  /** Absent on the hours that run no drill. */
  readonly drillPassed?: boolean;
}

function drillPhrase(passed: boolean | undefined): string {
  if (passed === undefined) return 'drill not run';
  return passed ? 'drill passed' : 'drill failed';
}

/**
 * The one line a run reports. Counts and byte totals only: a bucket name, a
 * key or a path would each say something about the data to whoever reads a
 * workflow's summary.
 */
export function formatSummary(summary: RunSummary): string {
  const { logicalBytes, storedBytes, reconciled, spotChecks } = summary;
  const ratio = logicalBytes === 0 ? 0 : storedBytes / logicalBytes;
  const passed = spotChecks.filter((check) => check.status === 'passed').length;
  const skipped = spotChecks.length - passed;
  return (
    `- backup: logical ${String(logicalBytes)} bytes, stored ${String(storedBytes)} bytes, ` +
    `ratio ${ratio.toFixed(2)}; objects ${reconciled ? 'reconciled' : 'not reconciled'}; ` +
    `spot checks ${String(passed)} passed, ${String(skipped)} skipped; ` +
    drillPhrase(summary.drillPassed)
  );
}

/**
 * Puts the line where the run's reader will find it: the job summary under
 * Actions, and stdout anywhere else.
 */
export function writeStepSummary(line: string): void {
  const summaryFile = process.env['GITHUB_STEP_SUMMARY'];
  if (summaryFile === undefined || summaryFile === '') {
    process.stdout.write(`${line}\n`);
    return;
  }
  appendFileSync(summaryFile, `${line}\n`);
}
