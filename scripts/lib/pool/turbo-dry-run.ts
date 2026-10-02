import path from 'node:path';

/**
 * Parse a `turbo <task> --dry-run=json` report into the packages whose task
 * would execute. The dry run is a planning oracle only — each later filtered
 * or batched execution re-hashes for itself, so a file changing between the
 * dry run and execution costs a wasted slot, never a wrong cache entry.
 */

interface DryRunTask {
  readonly taskId?: string;
  readonly package?: string;
  readonly directory?: string;
  readonly command?: string;
  readonly cache?: { readonly status?: string };
}

/** turbo's sentinel for a task kept in the graph with no matching script. */
const NONEXISTENT_COMMAND = '<NONEXISTENT>';

interface ParseTaskRunsOptions {
  /** Include cache hits too — the full runnable set, e.g. under `--force`. */
  readonly includeCacheHits?: boolean;
}

/** Package name → absolute package directory, for the named turbo task. */
export function parseTaskRuns(
  dryRunJson: string,
  repoRoot: string,
  taskName: string,
  options: ParseTaskRunsOptions = {}
): Map<string, string> {
  const parsed = JSON.parse(dryRunJson) as { tasks?: readonly DryRunTask[] };
  const runs = new Map<string, string>();
  for (const task of parsed.tasks ?? []) {
    if (!isRunnable(task, taskName)) continue;
    if (options.includeCacheHits === true || task.cache?.status !== 'HIT') {
      runs.set(task.package ?? '', path.resolve(repoRoot, task.directory ?? '.'));
    }
  }
  return runs;
}

function isRunnable(task: DryRunTask, taskName: string): boolean {
  return (
    task.taskId?.endsWith(`#${taskName}`) === true &&
    task.package !== undefined &&
    // A package with no such script stays in turbo's graph as a task that
    // executes nothing; it has nothing to run or replay.
    task.command !== NONEXISTENT_COMMAND
  );
}
