/**
 * The privacy gate's working-tree enumeration and reader.
 *
 * Every other stage of this gate reads blobs out of git — the index, a pushed
 * range, a commit's tree — because what is about to enter history is what those
 * stages must judge. This one reads the files on disk instead: the state an
 * agent has just written and nobody has staged, which no git object holds yet
 * and no other stage can see.
 *
 * The enumeration is the whole risk here. This gate family has twice been
 * blinded through its listing rather than its rules, and a listing that
 * under-reports produces a clean verdict over bytes nobody examined. Nothing
 * downstream re-checks it, so every path git names is either read or skipped
 * for a reason stated here.
 */

import { lstatSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { chunkBySizeBudget } from './verify-content-privacy.js';
import type { TextBlobEntry } from './rules.js';

/** A worktree entry that carries bytes, sized by the lstat that classified it. */
interface WorktreeFile {
  readonly path: string;
  readonly size: number;
  /** A symlink's bytes are its target string, not the file it resolves to. */
  readonly link: boolean;
}

/**
 * How many bytes of file content one read pass pulls in at once. This bounds the
 * bytes in flight per read, not the total the caller ends up holding — every blob
 * asked for is returned, exactly as `readBlobsByEntries` returns them. A caller
 * wanting a total bound batches its own path set and discards each batch after
 * scanning it, the shape the sweep already uses.
 */
export const WORKTREE_BATCH_BYTE_BUDGET = 16 * 1024 * 1024;

/**
 * `git ls-files -z` frames each path with a NUL and quotes nothing, so a tab or
 * a space inside a path arrives with every byte intact.
 */
export function parseWorktreeListing(stdout: string): string[] {
  return stdout
    .split('\0')
    .filter((record) => record.length > 0)
    .map((record) => {
      // Parity with the index listing, which refuses the same shape: a path
      // carrying a newline forges a line in a report that prints one finding per
      // line, and scanning around it is a scope decision nobody made.
      if (record.includes('\n')) {
        const shown = record.replaceAll('\n', String.raw`\n`);
        throw new Error(`Refusing to scan: this worktree path contains a newline: ${shown}`);
      }
      return record;
    });
}

/**
 * Every path the working tree holds: tracked entries plus untracked files, with
 * ignored ones excluded by git's own exclude machinery rather than by a pattern
 * matcher of ours. `--deduplicate` collapses the duplicates a path carries while
 * a merge leaves it staged several times.
 */
export async function listWorktreePaths(repoRoot: string): Promise<string[]> {
  const { stdout } = await execa('git', [
    '-C',
    repoRoot,
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
    '--deduplicate',
  ]);
  return parseWorktreeListing(stdout);
}

/**
 * Whether git ignores the repo-relative path, by its own name or through one of
 * its parent directories. A path git refuses outright — outside the repository,
 * or reached through a symbolic link — exits with a fatal status and reads as
 * not ignored, so the caller resolves it as any other path and finds nothing.
 */
export async function isIgnoredPath(repoRoot: string, scope: string): Promise<boolean> {
  const { exitCode } = await execa('git', ['-C', repoRoot, 'check-ignore', '-q', '--', scope], {
    reject: false,
  });
  return exitCode === 0;
}

/**
 * The untracked files under the given repo-relative paths, ignored ones
 * included: naming a path is the caller's own scope decision, which no ignore
 * rule overrides. Tracked entries come from {@link listWorktreePaths}.
 */
export async function listUntrackedPathsUnder(
  repoRoot: string,
  scopes: readonly string[]
): Promise<string[]> {
  if (scopes.length === 0) return [];
  const { stdout } = await execa('git', [
    '-C',
    repoRoot,
    'ls-files',
    '-z',
    '--others',
    '--',
    ...scopes,
  ]);
  return parseWorktreeListing(stdout);
}

/**
 * The entry as the worktree holds it, or nothing when it holds no bytes to
 * read. `--cached` names every tracked path, including one deleted from the
 * worktree, and a submodule's gitlink is a directory on disk.
 */
function classifyEntry(repoRoot: string, filePath: string): WorktreeFile | undefined {
  // `throwIfNoEntry` over a catch: a deleted tracked path is an ordinary
  // worktree state rather than a failure, and the promises API can only say so
  // through an errno the caller must classify.
  const stats = lstatSync(path.resolve(repoRoot, filePath), { throwIfNoEntry: false });
  if (stats === undefined) return undefined;
  const link = stats.isSymbolicLink();
  if (!link && !stats.isFile()) return undefined;
  return { path: filePath, size: stats.size, link };
}

async function readEntry(repoRoot: string, file: WorktreeFile): Promise<TextBlobEntry> {
  const absolute = path.resolve(repoRoot, file.path);
  // A symlink is read as its target string, which is the byte sequence git
  // stores in a `120000` blob, so one link yields one finding at every stage.
  const bytes = file.link
    ? await fs.readlink(absolute, { encoding: 'buffer' })
    : await fs.readFile(absolute);
  return { path: file.path, bytes };
}

/** The gate's own chunker at this module's budget — one implementation, shared. */
export function batchWorktreeFiles(files: readonly WorktreeFile[]): WorktreeFile[][] {
  return chunkBySizeBudget(files, WORKTREE_BATCH_BYTE_BUDGET);
}

/**
 * The bytes behind the given worktree paths, in the order asked for, in the
 * shape the gate's own reader returns so `scanBlobs` consumes it unchanged.
 */
export async function readWorktreeBlobs(
  repoRoot: string,
  paths: readonly string[]
): Promise<TextBlobEntry[]> {
  const files = paths
    .map((filePath) => classifyEntry(repoRoot, filePath))
    .filter((file) => file !== undefined);
  const blobs: TextBlobEntry[] = [];
  for (const batch of batchWorktreeFiles(files)) {
    blobs.push(...(await Promise.all(batch.map(async (file) => readEntry(repoRoot, file)))));
  }
  return blobs;
}
