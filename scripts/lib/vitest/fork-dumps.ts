/**
 * Where a fork writes its own V8 coverage dump, agreed between the host
 * provider that publishes the location and the fork module that writes there.
 *
 * The location is a directory inside the run's coverage reports directory,
 * which is what makes a killed run's dumps reclaimable: the reports directory
 * is keyed to the run's claim, and the coverage reclaim already removes the
 * whole directory of a run whose claim is gone. Dumps written anywhere else
 * are attributable to no run, so nothing can ever tell one that is still being
 * read from one whose run died — which is how weeks of them accumulate.
 *
 * Deliberately free of node builtins: the fork module loads this inside a test
 * file's own module registry, where `node:fs` and `node:path` may be replaced
 * by `vi.mock` factories, and it reaches the real ones through a native
 * `require` of its own. A module with no builtin to capture cannot be caught
 * by that.
 */

/** Carries the published root from the host process to every fork it spawns. */
export const FORK_DUMP_ROOT_ENV = 'HB_COVERAGE_FORK_DUMP_ROOT';

/** The reports-directory segment the per-fork directories sit under. */
export const FORK_DUMP_DIRECTORY = 'fork-dumps';

/**
 * The root the host published, or a refusal. A fork that cannot find it has no
 * reclaimable place to write, and inventing one is what this replaced.
 */
export function requireForkDumpRoot(env: Readonly<NodeJS.ProcessEnv>): string {
  const root = env[FORK_DUMP_ROOT_ENV];
  if (root === undefined || root === '') {
    throw new Error(
      `coverage fork dump: ${FORK_DUMP_ROOT_ENV} names no directory, so this fork has nowhere ` +
        'reclaimable to write its coverage dump. The host coverage provider publishes it; a ' +
        'fork reaching here was started outside one.'
    );
  }
  return root;
}

/**
 * One fork's directory name. A random component besides the pid because a long
 * run spawns thousands of short-lived forks and the OS recycles pids: a
 * pid-keyed name lets a later fork overwrite an earlier fork's still-unread
 * dump, after which two bookkeeping entries point at one file and the second
 * read finds it already consumed.
 */
export function forkDumpDirectoryName(pid: number, unique: string): string {
  return `cov-${String(pid)}-${unique}`;
}
