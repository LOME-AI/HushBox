import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ClaimHeldError, claim } from '../../../scripts/lib/claims/claim.ts';
import type { ClaimResource } from '../../../scripts/lib/claims/claim.ts';

/**
 * A cross-process mutex over one file, held as an OS advisory lock on a sibling
 * lock file through the repository's claim primitive. An in-process promise
 * queue cannot serialize the console's dev server against the agent CLI, which
 * run as separate processes against the same audit directory: each would read,
 * merge into its own stale copy and re-emit the whole frontmatter, so two
 * writers touching *different* fields still lose each other's write while both
 * report success.
 *
 * Liveness is a kernel fact here and is inferred from no clock. This lock was
 * once an exclusive-create file reclaimed once its modification time passed a
 * fixed window, which is wrong in both directions: a holder frozen by `SIGSTOP`
 * restamps nothing, so its file aged out and a second writer took a lock it
 * still held; and a holder killed outright left a file that read fresh for the
 * whole window, so every writer was refused until the window passed. An
 * advisory lock answers both immediately, because the kernel drops it with the
 * descriptor and a stopped process keeps it.
 *
 * The clock that remains decides nothing about the holder: it bounds how long a
 * writer queues behind a holder it *knows* is alive before refusing, which is
 * what the console's retryable refusal and the CLI's retry are built on.
 */

/** How long a writer waits for a live holder before giving up loudly. */
const TIMEOUT_MS = 5000;
const RETRY_MS = 25;

/** What the lock file is named after the file it guards. */
const LOCK_SUFFIX = '.lock';

/**
 * Stamped into the lock file by the primitive, so a human looking at a lock
 * nobody expected learns which process to go and find.
 */
const HOLDER = `docket writer (pid ${String(process.pid)})`;

interface LockOptions {
  readonly timeoutMs?: number;
  readonly retryMs?: number;
}

type Ran<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

/**
 * Raised instead of proceeding unlocked. A caller turns it into a refusal the
 * user sees; the one thing it must never become is a write.
 */
export class LockUnavailableError extends Error {
  constructor(lockPath: string) {
    super(`${lockPath} is held by another writer`);
    this.name = 'LockUnavailableError';
  }
}

async function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * One attempt at the lock: how `run` ended, or `null` when a live holder has it.
 *
 * The body's failure comes back as a value so that everything thrown out of the
 * claim is the claim's own — `run` is caller code and may raise anything, the
 * primitive's own refusal included.
 */
async function attempt<T>(resource: ClaimResource, run: () => Promise<T>): Promise<Ran<T> | null> {
  try {
    return await claim(resource, { onHeld: 'refuse', holder: HOLDER }, async () => {
      try {
        return { ok: true, value: await run() } as const;
      } catch (error) {
        return { ok: false, error } as const;
      }
    });
  } catch (error) {
    if (!(error instanceof ClaimHeldError)) throw error;
    return null;
  }
}

export async function withLockFile<T>(
  lockPath: string,
  run: () => Promise<T>,
  options: LockOptions = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const retryMs = options.retryMs ?? RETRY_MS;
  // The primitive creates the directory its claim file sits in, which suits a
  // claim naming a resource but not a lock that sits beside the finding it
  // guards: a missing directory there means the audit is gone, and the caller
  // reports that as unreadable rather than being handed a fresh empty one.
  await fs.access(path.dirname(lockPath));

  const resource: ClaimResource = { name: path.basename(lockPath, LOCK_SUFFIX), lockPath };
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const ran = await attempt(resource, run);
    if (ran !== null) {
      if (!ran.ok) throw ran.error;
      return ran.value;
    }
    if (Date.now() >= deadline) throw new LockUnavailableError(lockPath);
    await delay(retryMs);
  }
}
