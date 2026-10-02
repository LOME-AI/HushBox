import path from 'node:path';
import { ClaimHeldError, claim } from '../claims/claim.js';

/**
 * Elects the one run allowed to write the build cache, so concurrent runs
 * cannot leave a corrupt archive in it.
 *
 * The task runner writes an archive straight to its final path with no
 * write-then-rename, so two runs storing the same task hash at the same time
 * can leave one truncated. Two zero-length archives standing in this
 * checkout's cache are what that looks like when it happens.
 *
 * A truncated entry is survivable rather than wrong — established by
 * truncating archives at every fraction of their length and running the task
 * against them: each came back `cache miss, executing`, the task ran, and the
 * entry was rewritten. So the cost of a corrupt entry is a miss, never a wrong
 * verdict, and the seat exists to stop paying that cost rather than to stop
 * being wrong.
 *
 * The seat is taken without waiting and without refusing. Both are the same
 * mistake at one remove: a run that queues behind another run's whole build,
 * and a run that exits rather than run beside one, have each been blocked by a
 * neighbour rather than isolated from it. Losing costs a run nothing it can
 * feel — the loser still reads every entry in the cache, and gives up only the
 * writing of new ones, which the next run that holds the seat does instead.
 *
 * There is no clock anywhere in the election. The seat is an advisory lock the
 * kernel releases when its holder's last descriptor closes, so a run killed
 * mid-build frees it instantly and leaves nothing for a later run to time out.
 */

/** The variable the task runner reads to decide what each cache may be used for. */
export const TURBO_CACHE_VARIABLE = 'TURBO_CACHE';

/**
 * What the seat is called wherever a claim is named. It is also how a refusal
 * raised by the seat is told from one raised by the body inside it — see
 * {@link asElectedCacheWriter}.
 */
const SEAT_NAME = 'build cache writer';

/**
 * What a run that did not take the seat may do with the local cache: read every
 * entry, write none.
 */
export const READ_ONLY_LOCAL_CACHE = 'local:r';

/**
 * The file whose advisory lock is the seat.
 *
 * It sits beside the cache it governs, because the cache is per-checkout and so
 * is the corruption: two runs in different checkouts write different archives
 * and cannot truncate each other's. Being under an ignored directory is what
 * keeps it out of every task's hash — a lock file the runner hashed would move
 * every hash each time a run took the seat.
 */
export function cacheWriterLockPath(rootDir: string): string {
  return path.join(rootDir, '.turbo', 'cache-writer.lock');
}

interface CacheWriterInit {
  /** The repository root, which is where the cache and its seat live. */
  readonly rootDir: string;
  /** How this run names itself to anything reading the seat. */
  readonly command: string;
  /**
   * The environment the task runner will be started with. Defaults to this
   * process's, which is what a child inherits.
   */
  readonly env?: NodeJS.ProcessEnv;
}

/** Runs `body` with the cache mode set, and gives the variable back after. */
async function withCacheMode<T>(
  env: NodeJS.ProcessEnv,
  mode: string | undefined,
  body: () => Promise<T>
): Promise<T> {
  const found = env[TURBO_CACHE_VARIABLE];
  if (mode === undefined) Reflect.deleteProperty(env, TURBO_CACHE_VARIABLE);
  else env[TURBO_CACHE_VARIABLE] = mode;
  try {
    return await body();
  } finally {
    if (found === undefined) Reflect.deleteProperty(env, TURBO_CACHE_VARIABLE);
    else env[TURBO_CACHE_VARIABLE] = found;
  }
}

/**
 * Runs `body` as the elected cache writer where the seat was free, and against
 * a read-only cache where another run holds it. Never waits, never refuses.
 *
 * The winner has the variable removed rather than set: a run holding the seat
 * is a run the runner should treat exactly as it treated every run before the
 * seat existed, and removing it is the only spelling that says that whatever
 * an outer run left behind.
 */
export async function asElectedCacheWriter<T>(
  init: CacheWriterInit,
  body: () => Promise<T>
): Promise<T> {
  const env = init.env ?? process.env;
  const seat = { name: SEAT_NAME, lockPath: cacheWriterLockPath(init.rootDir) };
  const holder = `${init.command} (pid ${String(process.pid)})`;

  // A refusal is read by the resource it names rather than by its type, because
  // the body raises the same type: a build refuses to run beside another build,
  // and the lease it refuses on is one of the built outputs. Taking the type
  // alone would swallow that refusal and run the build a second time.
  try {
    return await claim(seat, { onHeld: 'refuse', holder }, () =>
      withCacheMode(env, undefined, body)
    );
  } catch (error) {
    if (!(error instanceof ClaimHeldError) || error.resource !== SEAT_NAME) throw error;
  }

  return withCacheMode(env, READ_ONLY_LOCAL_CACHE, body);
}
