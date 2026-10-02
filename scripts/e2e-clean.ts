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
 * name for Playwright's own cleanup.
 *
 * The run that renames a directory aside removes that aside before it returns,
 * so a run that exits cleanly leaves nothing behind — the same shape every other
 * reclaimed resource here has, where the creator drops its own. Removal is
 * best-effort, and the two leftovers it can produce are what the next run
 * clears: an aside whose files are still held open refuses to go, and a run
 * killed between the rename and the removal never reaches it.
 *
 * An aside its renaming run no longer owns is removed rather than reported,
 * unlike the stack resources the claim registry guards. Nothing ever reads an
 * aside, and the only actor that would retry its removal is the run that made
 * it — so once that run is gone, the choice is the next run or nobody. A live
 * run's aside is the one case spared, because that run removes it itself.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isMainModule } from './lib/cli/is-main.js';
import { readCommandLine, type CommandSpec } from './lib/cli/command-line.js';
import { runMain } from './lib/cli/run-main.js';
import { currentRunId, readOwnership } from './lib/claims/ownership.js';
import { ramPathsFor } from './lib/stack/ram-root.js';
import type { RamRootHost } from './lib/stack/ram-root.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

// The output directory's name, wherever it lives, and the stem of every aside
// minted beside it. Exported so the world auditor enumerates the same asides
// this file mints and removes.
export const DEFAULT_OUTPUT_DIR = 'test-results';

/**
 * Playwright's output directory for an E2E run of the checkout at
 * `checkoutRoot`: in its E2E RAM root on Linux, where closing a browser context
 * need not wait on a disk to take its trace, and the checkout's
 * `test-results/` everywhere else.
 */
export function e2eOutputDir(ramHost?: RamRootHost, checkoutRoot: string = REPO_ROOT): string {
  return (
    ramPathsFor(checkoutRoot, ramHost)?.testResults ?? path.join(checkoutRoot, DEFAULT_OUTPUT_DIR)
  );
}

// Suffix marking a directory renamed aside for deletion. Asides are siblings of
// the output dir (rename cannot cross filesystems) and are gitignored.
const PURGE_PREFIX = '.purge-';

// Separates the owning run from the index inside an aside name. A run id holds
// no dot, so the last one is the boundary — and an aside with no dot at all was
// named by a process holding no run claim.
const OWNER_SEPARATOR = '.';

// Playwright records the prior run's failed tests here for `--last-failed`, and
// reads it before its own output-dir cleanup. Carrying it across the reset keeps
// `e2e:failed` working; without it the rename would drop the file before
// Playwright's process starts.
const LAST_RUN_FILE = '.last-run.json';

export function isPurgeDirectory(base: string, name: string): boolean {
  return name.startsWith(`${base}${PURGE_PREFIX}`);
}

/**
 * The run that renamed an aside, or undefined for one renamed by a process
 * holding no run claim — which is every aside until a run claim reaches this
 * script. Nothing alive answers for those, so they are removable on sight.
 */
export function asideOwner(base: string, name: string): string | undefined {
  if (!isPurgeDirectory(base, name)) return undefined;
  const suffix = name.slice(`${base}${PURGE_PREFIX}`.length);
  const boundary = suffix.lastIndexOf(OWNER_SEPARATOR);
  if (boundary <= 0) return undefined;
  return suffix.slice(0, boundary);
}

function asideName(base: string, index: number, owner: string | null): string {
  const suffix = owner === null ? String(index) : `${owner}${OWNER_SEPARATOR}${String(index)}`;
  return `${base}${PURGE_PREFIX}${suffix}`;
}

export async function findFreeAsideName(parent: string, base: string): Promise<string> {
  const owner = currentRunId();
  const existing = new Set(await readdir(parent).catch(() => [] as string[]));
  let index = 0;
  while (existing.has(asideName(base, index, owner))) index += 1;
  return asideName(base, index, owner);
}

interface PurgeOptions {
  /** Defaults to the machine-wide registry; a test points it elsewhere. */
  readonly registryDir?: string;
}

/**
 * Removal is best-effort in both callers: a still-locked aside (rm rejects) must
 * not abort the run, and it goes on a later run once its handle closes.
 */
async function removeAside(parent: string, name: string): Promise<void> {
  await rm(path.join(parent, name), { recursive: true, force: true }).catch(() => undefined);
}

/** Clears what earlier runs left, sparing only an aside whose run is still alive. */
export async function purgeAsideDirectories(
  parent: string,
  base: string,
  options: PurgeOptions = {}
): Promise<void> {
  const entries = await readdir(parent).catch(() => [] as string[]);
  const asides = entries.filter((name) => isPurgeDirectory(base, name));
  if (asides.length === 0) return;

  const ownership = await readOwnership(options.registryDir);
  const removable = asides.filter((name) => {
    if (ownership.stateOfRun(asideOwner(base, name)) !== 'owned-live') return true;
    console.warn(
      `Leaving ${name} in place — the run that renamed it is still alive and removes its own`
    );
    return false;
  });

  await Promise.all(removable.map((name) => removeAside(parent, name)));
}

export async function resetOutputDir(outputDir: string, options: PurgeOptions = {}): Promise<void> {
  const resolved = path.resolve(outputDir);
  const parent = path.dirname(resolved);
  const base = path.basename(resolved);

  await purgeAsideDirectories(parent, base, options);

  if (!existsSync(resolved)) return;

  const lastRunPath = path.join(resolved, LAST_RUN_FILE);
  const lastRun = existsSync(lastRunPath) ? await readFile(lastRunPath, 'utf8') : undefined;

  const aside = await findFreeAsideName(parent, base);
  await rename(resolved, path.join(parent, aside));

  if (lastRun !== undefined) {
    await mkdir(resolved, { recursive: true });
    await writeFile(path.join(resolved, LAST_RUN_FILE), lastRun);
  }

  await removeAside(parent, aside);
}

export const COMMAND_LINE = {
  command: 'tsx scripts/e2e-clean.ts',
  summary: "Resets Playwright's output directory before an E2E run.",
  flags: [],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

/* v8 ignore start -- CLI entry point exercised via the root e2e scripts */
if (isMainModule(import.meta.url)) {
  await runMain(() => {
    if (readCommandLine(COMMAND_LINE, process.argv.slice(2)) === null) return;
    return resetOutputDir(e2eOutputDir());
  });
}
/* v8 ignore stop */
