import { renameSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * The grace period a rename onto an occupied destination is given, spent one
 * doubling wait at a time.
 *
 * Windows fails the replacing rename with `EPERM` while another handle is open
 * on the destination, which a virus scanner, the search indexer or an editor
 * takes transiently on a file that was just written. Node closed that as
 * working-as-intended and named a grace-period retry as the answer, so the
 * whole defence is waiting the holder out. The bound is what keeps a genuine
 * denial — a read-only target, a destination another process owns for good —
 * a reported failure rather than a hang.
 */
export const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 320] as const;

/** Blocks this thread, which is the only wait a synchronous caller can take. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const isDenied = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'EPERM';

export interface RenameSyncDeps {
  readonly rename?: (from: string, to: string) => void;
  readonly sleep?: (ms: number) => void;
}

export interface RenameDeps {
  readonly rename?: (from: string, to: string) => Promise<void>;
  readonly sleep?: (ms: number) => Promise<unknown>;
}

/** {@link RENAME_RETRY_DELAYS_MS} states what the retry is defending against. */
export function renameWithRetrySync(from: string, to: string, deps: RenameSyncDeps = {}): void {
  const move = deps.rename ?? renameSync;
  const sleep = deps.sleep ?? sleepSync;
  for (const wait of RENAME_RETRY_DELAYS_MS) {
    try {
      move(from, to);
      return;
    } catch (error) {
      if (!isDenied(error)) throw error;
      sleep(wait);
    }
  }
  // The last attempt is unguarded on purpose: a denial that outlives the grace
  // period is the caller's to report, and swallowing it here would lose the
  // only evidence that anything went wrong.
  move(from, to);
}

/** {@link RENAME_RETRY_DELAYS_MS} states what the retry is defending against. */
export async function renameWithRetry(
  from: string,
  to: string,
  deps: RenameDeps = {}
): Promise<void> {
  const move = deps.rename ?? rename;
  const sleep = deps.sleep ?? delay;
  for (const wait of RENAME_RETRY_DELAYS_MS) {
    try {
      await move(from, to);
      return;
    } catch (error) {
      if (!isDenied(error)) throw error;
      await sleep(wait);
    }
  }
  await move(from, to);
}
