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
 * The files the stored hash covers. Outputs are hashed alongside inputs so the
 * sidecar certifies `outputs == f(inputs)` rather than the weaker `outputs were
 * once == f(inputs)`: an input-keyed hash cannot tell a hand-edited generated
 * file from a fresh one, and hand-editing generated files is the exact thing
 * every generated header forbids. Both the read and the write side go through
 * here so the two sets can never drift apart.
 */
function trackedFiles(inputs: readonly string[], outputs?: readonly string[]): readonly string[] {
  return outputs === undefined ? inputs : [...inputs, ...outputs];
}

/**
 * Return true when the stored hash at hashPath matches the current inputs and
 * outputs, and every output listed (if provided) still exists on disk. Returns
 * false if the hash file is missing, the inputs differ, an output has been
 * edited, or any expected output has been deleted. The HB_FORCE_REGENERATE env
 * var short-circuits to false.
 */
export function isUpToDate(
  hashPath: string,
  inputs: readonly string[],
  outputs?: readonly string[]
): boolean {
  if (process.env[FORCE_ENV]) return false;
  if (!existsSync(hashPath)) return false;
  if (outputs?.some((file) => !existsSync(file))) return false;
  const stored = readFileSync(hashPath, 'utf8').trim();
  return stored === hashInputs(trackedFiles(inputs, outputs));
}

/**
 * Store the hash of the current inputs and outputs at hashPath. Creates parent
 * dirs if needed. Call it only after the outputs have been written.
 */
export function writeHash(
  hashPath: string,
  inputs: readonly string[],
  outputs?: readonly string[]
): void {
  mkdirSync(path.dirname(hashPath), { recursive: true });
  writeFileSync(hashPath, `${hashInputs(trackedFiles(inputs, outputs))}\n`);
}

interface CacheOptions {
  /** Human-readable label used when logging cache hits. */
  readonly label: string;
  /** Path to the sidecar file that stores the previous inputs+outputs hash. */
  readonly hashPath: string;
  /** Files whose contents determine the output. Order matters. */
  readonly inputs: readonly string[];
  /** Optional: files fn writes. They must exist and be unedited for a cache hit. */
  readonly outputs?: readonly string[];
}

/**
 * Run fn only when the inputs' hash differs from the stored hash, or when any
 * expected output is missing or has been edited since it was generated. After a
 * successful run, persist the new hash.
 *
 * If any input file is missing, fall back to running fn unconditionally and
 * skip cache persistence. This keeps the cache robust for unit tests that run
 * generators against temporary directories without the full source tree.
 */
export function withCache(options: CacheOptions, function_: () => void): void {
  const { label, hashPath, inputs, outputs } = options;

  const allInputsExist = inputs.every((file) => existsSync(file));
  if (!allInputsExist) {
    function_();
    return;
  }

  if (isUpToDate(hashPath, inputs, outputs)) {
    // Progress, not data: a caller may pipe a generator's stdout (the skills
    // generator prints the paths pre-commit stages), so nothing here may land there.
    console.error(`✓ ${label} up to date — skipping`);
    return;
  }
  function_();
  writeHash(hashPath, inputs, outputs);
}
