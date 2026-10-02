import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renameWithRetry, renameWithRetrySync } from '@hushbox/shared/atomic-rename';
import type { RenameDeps, RenameSyncDeps } from '@hushbox/shared/atomic-rename';

/**
 * The one way this package lands a file it must not let a reader see half of:
 * write beside the target, then rename onto it. The staging path is a sibling
 * because a rename is atomic only within a single filesystem.
 *
 * **The staging name is unrepeatable, and the process identifier alone is not
 * enough to make it so.** Two runs sharing this checkout need not share a
 * process-identifier space — identically-allocated containers on one host give
 * out the same numbers — so a name keyed on the identifier alone is a name two
 * writers can both choose, after which one overwrites the other's staging file
 * and the loser's rename finds nothing to move. The identifier stays because it
 * is what a human maps back to a process; the random half is what makes the
 * name unrepeatable. Version 4, so no clock reaches the name.
 *
 * **A mode belongs to the staging file, never to the target.** The rename is
 * what brings the target into being, so a file that already carries its mode
 * when it is moved is one no reader can meet at any other mode. Setting it
 * afterwards publishes the target at whatever the process umask allowed first —
 * a shorter half-written state than a truncated file, and the same class of
 * one. A caller that gives no mode gets the umask default, which is what an
 * ordinary write would have produced.
 *
 * **Accepted cost, recorded once here rather than at each caller:** an
 * unrepeatable name means a run hard-killed between the write and the rename
 * leaves a staging file no later run reuses by name. Reclaiming it would take a
 * sweep beside the target, and a sweep cannot tell a writer that died from a
 * live writer in another identity space — so it would delete a file a
 * neighbouring run is at that moment renaming into place, which is the failure
 * this module exists to prevent.
 *
 * **The disposition of a failure belongs to the caller, not here.** A write
 * this cannot land is raised, never swallowed: what a lost write costs differs
 * by target — a scheduling hint recomputes, a generated environment file
 * decides which stack the next command talks to — and a module that chose for
 * every caller would force the cheapest answer on the most expensive one.
 *
 * **Both forms are here because a caller cannot change its own.** A caller
 * already inside an asynchronous call chain cannot reach the synchronous form
 * without blocking the loop it runs on, and one inside a synchronous one cannot
 * await. They are the same choreography over the two filesystem interfaces, and
 * every guarantee above holds of each.
 */

/** A staged write that could not land, naming the target, the writer and the reason. */
export class StagedWriteFailed extends Error {
  constructor(target: string, writer: string, reason: string, options: { cause: unknown }) {
    super(
      `${path.basename(target)}: writer ${writer} could not write it back (${reason})`,
      options
    );
    this.name = 'StagedWriteFailed';
  }
}

/** What a caller may say about a write beyond where it goes and what it holds. */
interface StagedWriteControls {
  /**
   * The POSIX mode the target lands at. Omitted, the target lands at whatever
   * the process umask allows, exactly as an ordinary write would.
   */
  readonly mode?: number;
}

export type StagedWriteSyncOptions = RenameSyncDeps & StagedWriteControls;
export type StagedWriteOptions = RenameDeps & StagedWriteControls;

/** The staging path for one write, and the writer identity a failure names. */
function stagingFor(target: string): { readonly writer: string; readonly staging: string } {
  const writer = `${String(process.pid)}-${randomUUID()}`;
  return { writer, staging: `${target}.${writer}.tmp` };
}

/** The report a caller gets, carrying the failure that stopped the write as its cause. */
function writeFailure(target: string, writer: string, error: unknown): StagedWriteFailed {
  const { code } = error as NodeJS.ErrnoException;
  return new StagedWriteFailed(target, writer, code ?? 'unknown', { cause: error });
}

/**
 * `force` covers a staging file that was never created, but not a path that
 * cannot be reached at all — and a failure clearing up after a failed write
 * must not become the failure the clean-up exists to prevent.
 */
function discardStagingSync(staging: string): void {
  try {
    rmSync(staging, { force: true });
  } catch {
    // Unreachable is as good as gone: nothing here can act on the difference.
  }
}

/** {@link discardStagingSync} states what the guard is for. */
async function discardStaging(staging: string): Promise<void> {
  try {
    await rm(staging, { force: true });
  } catch {
    // Unreachable is as good as gone: nothing here can act on the difference.
  }
}

/** Writes `body` onto `target`, creating the directories the target needs. */
export function stagedWriteSync(
  target: string,
  body: string | Uint8Array,
  options: StagedWriteSyncOptions = {}
): void {
  const { writer, staging } = stagingFor(target);
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(staging, body);
    if (options.mode !== undefined) chmodSync(staging, options.mode);
    renameWithRetrySync(staging, target, options);
  } catch (error) {
    discardStagingSync(staging);
    throw writeFailure(target, writer, error);
  }
}

/** {@link stagedWriteSync} for a caller that cannot block the loop it runs on. */
export async function stagedWrite(
  target: string,
  body: string | Uint8Array,
  options: StagedWriteOptions = {}
): Promise<void> {
  const { writer, staging } = stagingFor(target);
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(staging, body);
    if (options.mode !== undefined) await chmod(staging, options.mode);
    await renameWithRetry(staging, target, options);
  } catch (error) {
    await discardStaging(staging);
    throw writeFailure(target, writer, error);
  }
}
