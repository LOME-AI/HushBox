/**
 * The privacy gate's blob reads.
 *
 * Blobs come from git, never the worktree — what is about to enter history is
 * what gets judged, and that includes the allowlist.
 */

import { execa } from 'execa';
import { parsePrivacyAllowlist, PRIVACY_ALLOWLIST_PATH } from './allowlist.js';
import { LIVE_RULE_NAMES, type TextBlobEntry } from './rules.js';
import type { PrivacyAllowlistEntry } from './allowlist.js';

export interface IndexEntry {
  readonly path: string;
  /** The blob's object id — a name with no grammar for git to reinterpret. */
  readonly objectId: string;
}

interface StagedEntry extends IndexEntry {
  readonly mode: string;
  readonly stage: string;
}

interface BlobSize extends IndexEntry {
  readonly size: number;
}

const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * `git ls-files --stage -z` writes `<mode> <object id> <stage>\t<path>` per
 * entry. The metadata is fixed-shape, so the first tab is the path boundary and
 * a tab inside a path stays in the path.
 */
/** Regular files and symlinks carry blobs; a gitlink's id names another repository's commit. */
const BLOB_MODES = new Set(['100644', '100755', '120000']);

export function parseIndexListing(stdout: string): IndexEntry[] {
  const staged = stdout
    .split('\0')
    .filter((record) => record.length > 0)
    .map((record) => {
      const tab = record.indexOf('\t');
      const [mode = '', objectId = '', stage = ''] = record.slice(0, tab).split(' ');
      const path = record.slice(tab + 1);
      if (tab === -1 || !OBJECT_ID.test(objectId)) {
        throw new Error(`git ls-files returned a record this gate cannot address: ${record}`);
      }
      // Nothing downstream needs this refusal now that blobs are addressed by
      // object id, but a tracked path carrying a newline is pathological and
      // worth stopping on rather than scanning around.
      if (path.includes('\n')) {
        const shown = path.replaceAll('\n', String.raw`\n`);
        throw new Error(`Refusing to scan: this tracked path contains a newline: ${shown}`);
      }
      return { path, objectId, mode, stage };
    })
    .filter((entry) => BLOB_MODES.has(entry.mode));
  return preferStageZero(staged);
}

/**
 * During an unresolved merge one path carries several staged entries. Scanning
 * all of them reports the same position once per stage and reads content from
 * sides the developer never wrote; the lowest stage present is one deterministic
 * answer, and stage zero — the resolved entry — outranks any conflict stage.
 */
function preferStageZero(staged: readonly StagedEntry[]): IndexEntry[] {
  const chosen = new Map<string, StagedEntry>();
  for (const entry of staged) {
    const held = chosen.get(entry.path);
    if (held === undefined || entry.stage < held.stage) chosen.set(entry.path, entry);
  }
  return [...chosen.values()].map((entry) => ({ path: entry.path, objectId: entry.objectId }));
}

async function listIndexEntries(repoRoot: string): Promise<IndexEntry[]> {
  const { stdout } = await execa('git', ['-C', repoRoot, 'ls-files', '--stage', '-z']);
  return parseIndexListing(stdout);
}

/**
 * The whole tracked tree is hundreds of megabytes of blobs; a batch is sized so
 * the gate's peak memory stays a function of the budget, not of the repository.
 */
const BATCH_BYTE_BUDGET = 16 * 1024 * 1024;

export function chunkBySizeBudget<T extends { readonly size: number }>(
  blobs: readonly T[],
  budget: number
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentSize = 0;
  for (const blob of blobs) {
    if (current.length > 0 && currentSize + blob.size > budget) {
      batches.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(blob);
    currentSize += blob.size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * A batch is addressed by object id, never by path. `:<path>` is a git
 * revision expression rather than a literal name: a tracked path beginning
 * `0:` parses as the stage form and resolves to a different blob, silently and
 * with no desync to notice. An object id has no grammar left to interpret.
 */
function objectIdSpecs(entries: readonly IndexEntry[]): string {
  return entries.map((entry) => `${entry.objectId}\0`).join('');
}

/**
 * A resolution reads `<object id> <type> <size>`; anything git could not resolve
 * reads `<spec> missing` or `<spec> ambiguous`. The verdict is taken from the
 * record's shape, because a path with two spaces and a numeric third token makes
 * an unresolved record parse as a plausible size and desynchronise the batch.
 */
function blobSizeOf(record: string | undefined, requested: string): number {
  const fields = String(record).split(' ');
  const [objectId = '', type = '', size = ''] = fields;
  if (fields.length !== 3 || !OBJECT_ID.test(objectId) || type !== 'blob' || !/^\d+$/.test(size)) {
    throw new TypeError(`git could not resolve a blob for ${requested}`);
  }
  return Number(size);
}

/** `git cat-file --batch-check` answers one record per spec, in order. */
export function parseBatchCheck(stdout: string, entries: readonly IndexEntry[]): BlobSize[] {
  const lines = stdout.split('\n');
  return entries.map((entry, index) => ({
    ...entry,
    size: blobSizeOf(lines[index], entry.path),
  }));
}

async function readBlobSizes(
  repoRoot: string,
  entries: readonly IndexEntry[]
): Promise<BlobSize[]> {
  const { stdout } = await execa('git', ['-C', repoRoot, 'cat-file', '--batch-check', '-z'], {
    input: objectIdSpecs(entries),
  });
  return parseBatchCheck(stdout, entries);
}

/**
 * Resolves each requested path to the object id the index holds for it. One
 * listing serves any number of paths, which also keeps the argument list off the
 * command line.
 */
async function resolveIndexEntries(
  repoRoot: string,
  paths: readonly string[]
): Promise<IndexEntry[]> {
  const entries = await listIndexEntries(repoRoot);
  const listed = new Map(entries.map((entry) => [entry.path, entry.objectId]));
  return paths.map((path) => {
    const objectId = listed.get(path);
    if (objectId === undefined) {
      throw new Error(`${path} is not in the git index`);
    }
    return { path, objectId };
  });
}

/**
 * Batched `git cat-file`: a subprocess per path costs minutes over a tree this
 * size, and one subprocess for every path exhausts memory.
 */
export async function readIndexBlobs(
  repoRoot: string,
  paths: readonly string[]
): Promise<TextBlobEntry[]> {
  return readBlobsByEntries(repoRoot, await resolveIndexEntries(repoRoot, paths));
}

/**
 * The same reader for blobs already named by object id — the push stage names
 * them that way, because the commits it judges are not the index. One reader
 * rather than one per stage: the batching, the framing and the record parsing
 * are where a second copy would silently drift.
 */
export async function readBlobsByEntries(
  repoRoot: string,
  entries: readonly IndexEntry[]
): Promise<TextBlobEntry[]> {
  if (entries.length === 0) return [];
  const sizes = await readBlobSizes(repoRoot, entries);
  const blobs: TextBlobEntry[] = [];
  for (const batch of chunkBySizeBudget(sizes, BATCH_BYTE_BUDGET)) {
    // Derived, not guessed: one oversized blob is legal, and a batch that
    // overruns execa's default cap is silently truncated into a parse failure.
    const batchBytes = batch.reduce((total, blob) => total + blob.size, 0);
    const { stdout } = await execa('git', ['-C', repoRoot, 'cat-file', '--batch', '-z'], {
      input: objectIdSpecs(batch),
      encoding: 'buffer',
      maxBuffer: batchBytes + batch.length * 128 + 1024,
    });
    // execa yields a Uint8Array under `encoding: 'buffer'`; the record framing
    // below needs Buffer's byte search and decoding.
    blobs.push(...parseBatchOutput(Buffer.from(stdout), batch));
  }
  return blobs;
}

/** Each `git cat-file` record is a header line, the payload, and a newline. */
export function parseBatchOutput(output: Buffer, entries: readonly IndexEntry[]): TextBlobEntry[] {
  const blobs: TextBlobEntry[] = [];
  let offset = 0;
  for (const entry of entries) {
    const headerEnd = output.indexOf('\n', offset);
    if (headerEnd === -1) {
      throw new Error(`git cat-file returned no record for ${entry.path}`);
    }
    const size = blobSizeOf(output.toString('utf8', offset, headerEnd), entry.path);
    const start = headerEnd + 1;
    blobs.push({ path: entry.path, bytes: output.subarray(start, start + size) });
    // Each record is header, payload, and a trailing newline git adds itself.
    offset = start + size + 1;
  }
  return blobs;
}

/**
 * The allowlist is read from git, exactly like the content it exempts. Reading
 * it from the worktree would let an unstaged edit exempt a staged violation,
 * with the exemption never entering history for a reviewer to see.
 */
export async function readAllowlistFromIndex(repoRoot: string): Promise<PrivacyAllowlistEntry[]> {
  // An allowlist absent from the index fails inside the blob reader, which names
  // the path; there is no second guard here to leave untested.
  const blobs = await readIndexBlobs(repoRoot, [PRIVACY_ALLOWLIST_PATH]);
  const source = Buffer.concat(blobs.map((blob) => Buffer.from(blob.bytes))).toString('utf8');
  return parsePrivacyAllowlist(source, LIVE_RULE_NAMES);
}
