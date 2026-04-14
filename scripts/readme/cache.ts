import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const FORCE_ENV = 'HB_FORCE_REGENERATE';

/**
 * Compute a deterministic SHA-256 hash of the given files' paths and content.
 * Order matters (swapping two files changes the hash) and content matters
 * (modifying any file changes the hash). Null bytes separate path from content
 * and between files so no concatenation ambiguity is possible.
 */
export function hashInputs(filePaths: readonly string[]): string {
  const hasher = createHash('sha256');
  for (const filePath of filePaths) {
    hasher.update(filePath);
    hasher.update('\0');
    hasher.update(readFileSync(filePath));
    hasher.update('\0');
  }
  return hasher.digest('hex');
}

/**
 * Return true when the stored hash at hashPath matches the current inputs AND
 * every output listed (if provided) still exists on disk. Returns false if the
 * hash file is missing, the inputs differ, or any expected output has been
 * deleted. The HB_FORCE_REGENERATE env var short-circuits to false.
 */
export function isUpToDate(
  hashPath: string,
  inputs: readonly string[],
  outputs?: readonly string[],
): boolean {
  if (process.env[FORCE_ENV]) return false;
  if (!existsSync(hashPath)) return false;
  if (outputs && outputs.some((file) => !existsSync(file))) return false;
  const stored = readFileSync(hashPath, 'utf8').trim();
  return stored === hashInputs(inputs);
}

/** Store the hash of current inputs at hashPath. Creates parent dirs if needed. */
export function writeHash(hashPath: string, inputs: readonly string[]): void {
  mkdirSync(path.dirname(hashPath), { recursive: true });
  writeFileSync(hashPath, `${hashInputs(inputs)}\n`);
}

export interface CacheOptions {
  /** Human-readable label used when logging cache hits. */
  readonly label: string;
  /** Path to the sidecar file that stores the previous inputs hash. */
  readonly hashPath: string;
  /** Files whose contents determine the output. Order matters. */
  readonly inputs: readonly string[];
  /** Optional: output files that must exist for a cache hit to count. */
  readonly outputs?: readonly string[];
}

/**
 * Run fn only when the inputs' hash differs from the stored hash, or when any
 * expected output is missing. After a successful run, persist the new hash.
 *
 * If any input file is missing, fall back to running fn unconditionally and
 * skip cache persistence. This keeps the cache robust for unit tests that run
 * generators against temporary directories without the full source tree.
 */
export function withCache(options: CacheOptions, fn: () => void): void {
  const { label, hashPath, inputs, outputs } = options;

  const allInputsExist = inputs.every((file) => existsSync(file));
  if (!allInputsExist) {
    fn();
    return;
  }

  if (isUpToDate(hashPath, inputs, outputs)) {
    console.log(`✓ ${label} up to date — skipping`);
    return;
  }
  fn();
  writeHash(hashPath, inputs);
}
