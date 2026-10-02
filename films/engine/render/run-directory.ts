import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { thenCleanUp } from './cleanup.js';
import {
  RunOwnerError,
  ownerAlive,
  parseRunOwner,
  runDirectoryPrefix,
  startToken,
  systemReads,
} from './run-owner.js';

import type { LoadedFilm } from './films.driver.js';
import type { OwnerReads } from './run-owner.js';

async function readOwnToken(reads: OwnerReads): Promise<string> {
  const token = await startToken(process.pid, reads);
  if (token === null) {
    throw new RunOwnerError(`this process, ${String(process.pid)}, has no start to read`);
  }
  return token;
}

/**
 * Removes each run directory in `parent` whose owner no longer runs: the
 * directory a killed run left. A directory whose name records no owner is not
 * a run directory and is left as it is.
 */
async function removeDeadRuns(parent: string, reads: OwnerReads): Promise<void> {
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    const owner = entry.isDirectory() ? parseRunOwner(entry.name) : null;
    if (owner !== null && !(await ownerAlive(owner, reads))) {
      rmSync(path.join(parent, entry.name), { recursive: true, force: true });
    }
  }
}

/**
 * Runs `use` on a new directory in `parent` that no other run is handed, and
 * removes it once `use` settles. Its name records this process's id and start,
 * and every run made in `parent` first removes the run directories there whose
 * owner no longer runs, so a killed run's directory goes with the next run.
 */
export async function withRunDirectoryIn<T>(
  parent: string,
  use: (run: string) => Promise<T>,
  reads: OwnerReads = systemReads
): Promise<T> {
  const prefix = runDirectoryPrefix(process.pid, await readOwnToken(reads));
  mkdirSync(parent, { recursive: true });
  await removeDeadRuns(parent, reads);
  const run = mkdtempSync(path.join(parent, prefix));
  return thenCleanUp(
    async () => use(run),
    () => {
      rmSync(run, { recursive: true, force: true });
      return Promise.resolve();
    }
  );
}

/** {@link withRunDirectoryIn} the piece's `out/`. */
export async function withRunDirectory<T>(
  film: Pick<LoadedFilm, 'id' | 'outDir'>,
  use: (run: string) => Promise<T>
): Promise<T> {
  return withRunDirectoryIn(film.outDir, use);
}

/**
 * Writes `bytes` to `target` through a run directory beside it and one rename,
 * so a reader sees the earlier file or this one, never part of one.
 */
export async function publishFile(target: string, bytes: Uint8Array): Promise<string> {
  return withRunDirectoryIn(path.dirname(target), (run) => {
    const staged = path.join(run, path.basename(target));
    writeFileSync(staged, bytes);
    renameSync(staged, target);
    return Promise.resolve(target);
  });
}

/**
 * Moves a finished MP4 to the piece's published `out/<film-id>.mp4` in one
 * rename, replacing any earlier one, and returns that path. The rename is
 * atomic because a run's directory sits under the same `out/`.
 */
export function publishVideo(film: Pick<LoadedFilm, 'id' | 'outDir'>, file: string): string {
  const published = path.join(film.outDir, `${film.id}.mp4`);
  renameSync(file, published);
  return published;
}
