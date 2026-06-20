/**
 * Resets Playwright's output directory before an E2E run.
 *
 * Playwright clears `test-results/` at the start of every run by recursively
 * removing it. That removal aborts the whole run (a fatal global error, before
 * any test is collected) when a leaked browser/worker still holds a trace file
 * open across runs: on FUSE the unlinked-but-open file lingers as `.fuse_hidden*`
 * and `rmdir` fails ENOTEMPTY; on Windows the lock surfaces as EBUSY/EPERM.
 *
 * Renaming the directory always succeeds even while a child file is held open,
 * so this runs first and moves the existing output dir aside, leaving a clean
 * name for Playwright's own cleanup. Asides are deleted best-effort; a still-
 * locked one is harmless and gets removed on a later run once its handle closes.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isMainModule } from './lib/is-main.js';
import { runMain } from './lib/run-main.js';

// Playwright's default `outputDir`, relative to the repo root.
const DEFAULT_OUTPUT_DIR = 'test-results';

// Suffix marking a directory renamed aside for deletion. Asides are siblings of
// the output dir (rename cannot cross filesystems) and are gitignored.
const PURGE_PREFIX = '.purge-';

// Playwright records the prior run's failed tests here for `--last-failed`, and
// reads it before its own output-dir cleanup. Carrying it across the reset keeps
// `e2e:failed` working; without it the rename would drop the file before
// Playwright's process starts.
const LAST_RUN_FILE = '.last-run.json';

export function isPurgeDirectory(base: string, name: string): boolean {
  return name.startsWith(`${base}${PURGE_PREFIX}`);
}

export async function findFreeAsideName(parent: string, base: string): Promise<string> {
  const existing = new Set(await readdir(parent).catch(() => [] as string[]));
  let index = 0;
  while (existing.has(`${base}${PURGE_PREFIX}${String(index)}`)) index += 1;
  return `${base}${PURGE_PREFIX}${String(index)}`;
}

export async function purgeAsideDirectories(parent: string, base: string): Promise<void> {
  const entries = await readdir(parent).catch(() => [] as string[]);
  // allSettled, not all: a still-locked aside (rm rejects) must not abort the
  // run — it gets removed on a later run once its handle closes.
  await Promise.allSettled(
    entries
      .filter((name) => isPurgeDirectory(base, name))
      .map((name) => rm(path.join(parent, name), { recursive: true, force: true }))
  );
}

export async function resetOutputDir(outputDir: string = DEFAULT_OUTPUT_DIR): Promise<void> {
  const resolved = path.resolve(outputDir);
  const parent = path.dirname(resolved);
  const base = path.basename(resolved);

  if (existsSync(resolved)) {
    const lastRunPath = path.join(resolved, LAST_RUN_FILE);
    const lastRun = existsSync(lastRunPath) ? await readFile(lastRunPath, 'utf8') : undefined;

    const aside = path.join(parent, await findFreeAsideName(parent, base));
    await rename(resolved, aside);

    if (lastRun !== undefined) {
      await mkdir(resolved, { recursive: true });
      await writeFile(path.join(resolved, LAST_RUN_FILE), lastRun);
    }
  }

  await purgeAsideDirectories(parent, base);
}

/* v8 ignore start -- CLI entry point exercised via the root e2e scripts */
if (isMainModule(import.meta.url)) {
  await runMain(() => resetOutputDir());
}
/* v8 ignore stop */
