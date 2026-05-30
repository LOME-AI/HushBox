import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * sha256 hex of a single file's contents. Used for cheap "did the file
 * change?" checks against pnpm-lock.yaml, env.config.ts, etc.
 */
export async function fileFingerprint(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
}

export type FileFilter = (relativePath: string) => boolean;

export interface TreeFingerprintOptions {
  /** Returning `false` skips the file from the hash. Defaults to: include everything. */
  filter?: FileFilter;
}

const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.turbo', 'coverage']);

/**
 * Order-stable sha256 over `<relative-path>:<sha256(content)>\n` lines for every
 * file under `dir` whose relative path passes the filter. Filenames are sorted
 * so two clones produce identical output regardless of FS enumeration order.
 *
 * Directories named in SKIPPED_DIRS are always skipped — they're build/install
 * artifacts that would otherwise dominate the hash.
 */
export async function treeFingerprint(
  dir: string,
  options: TreeFingerprintOptions = {}
): Promise<string> {
  const files = await collectFiles(dir, dir, options.filter);
  files.sort((a, b) => a.relative.localeCompare(b.relative));
  const root = createHash('sha256');
  for (const file of files) {
    const content = await readFile(file.absolute);
    const fileHash = createHash('sha256').update(content).digest('hex');
    root.update(`${file.relative}:${fileHash}\n`);
  }
  return root.digest('hex');
}

interface FileEntry {
  absolute: string;
  relative: string;
}

function maybeAcceptFile(
  root: string,
  absolute: string,
  filter: FileFilter | undefined,
  out: FileEntry[]
): void {
  // Always use forward slashes in the relative path so hashes are identical
  // on Windows and POSIX checkouts.
  const relative = path.relative(root, absolute).split(path.sep).join('/');
  if (filter && !filter(relative)) return;
  out.push({ absolute, relative });
}

async function collectFiles(root: string, dir: string, filter?: FileFilter): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      out.push(...(await collectFiles(root, absolute, filter)));
      continue;
    }
    if (!entry.isFile()) continue;
    maybeAcceptFile(root, absolute, filter, out);
  }
  return out;
}

/**
 * sha256 hex over an ordered list of opaque strings, with an unambiguous
 * separator so `['ab','c']` and `['a','bc']` hash to different values. Used to
 * combine sub-fingerprints (deps, env, schema, seed) into one composite hash.
 */
export function composeFingerprint(parts: readonly string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    // length-prefix every part so concatenation can't reshape into a different
    // input. `\0` as a delimiter is safe — sha256-hex parts never contain it.
    hash.update(`${String(part.length)}\0${part}\0`);
  }
  return hash.digest('hex');
}
