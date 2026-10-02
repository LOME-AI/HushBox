import { existsSync } from 'node:fs';
import { execa } from 'execa';
import { isMainModule } from './lib/cli/is-main.js';
import { MEMORY_BUDGET_ENV, PLANNING_MEMORY_FRACTION, memoryBudgetKb } from './lib/pool/memory.js';
import { ensureGitleaks, gitleaksRangeScanArgs } from './lib/privacy/gitleaks.js';
import { withoutHostPaths } from './lib/privacy/host-paths.js';
import { readStdin } from './lib/cli/read-stdin.js';
import { resolvePushedRange, resolvePushedRefRanges } from './lib/cli/pushed-range.js';
import { save, type RecordsContext } from './records/operations.js';
import { overlayDirectory } from './records/overlay.js';

export interface Task {
  name: string;
  command: string;
  args: readonly string[];
  /** Fed to the task on stdin; a task without one inherits the hook's. */
  input?: string;
  /**
   * True for a task that sizes itself against a memory budget. Each such task
   * used to read the machine's free memory itself, so the two that run at once
   * both planned against the whole of it and together planned for twice what
   * exists. The hook now measures once and hands each its share.
   */
  budgeted?: boolean;
  /**
   * How long the runner waits, after signalling this task to stop, before
   * killing it outright. A task with an unwind longer than the process
   * library's five-second default sets its own; the default stands for the
   * rest.
   */
  forceKillAfterDelay?: number;
}

export const PARALLEL_TASKS: readonly Task[] = [
  { name: 'lint:duplication', command: 'pnpm', args: ['lint:duplication'] },
  { name: 'lint:unused', command: 'pnpm', args: ['lint:unused'] },
  { name: 'lint', command: 'pnpm', args: ['lint'], budgeted: true },
  { name: 'typecheck', command: 'pnpm', args: ['typecheck'], budgeted: true },
  { name: 'arch:check', command: 'pnpm', args: ['arch:check'] },
  { name: 'docket:validate', command: 'pnpm', args: ['docket', '--validate'] },
  { name: 'verify:licenses', command: 'pnpm', args: ['verify:licenses'] },
  { name: 'verify:doc-paths', command: 'pnpm', args: ['verify:doc-paths'] },
  { name: 'verify:design-tokens', command: 'pnpm', args: ['verify:design-tokens'] },
];

/**
 * Each budgeted task's share of one budget, split evenly among them. The
 * unbudgeted gates take what they take — they expose no concurrency to size —
 * so this closes the double-claim between the pools rather than accounting for
 * every byte of the phase.
 */
export function budgetShares(
  tasks: readonly Task[],
  totalKb?: number
): ReadonlyMap<string, number> {
  const budgeted = tasks.filter((task) => task.budgeted === true);
  if (totalKb === undefined || budgeted.length === 0) return new Map();
  const share = Math.floor(totalKb / budgeted.length);
  return new Map(budgeted.map((task) => [task.name, share]));
}

export const TEST_TASK: Task = { name: 'test', command: 'pnpm', args: ['test'] };

type Subprocess = ReturnType<typeof execa>;

function spawn(task: Task, budgetKb?: number): Subprocess {
  const share = budgetKb === undefined ? {} : { env: { [MEMORY_BUDGET_ENV]: String(budgetKb) } };
  const grace =
    task.forceKillAfterDelay === undefined ? {} : { forceKillAfterDelay: task.forceKillAfterDelay };
  if (task.input === undefined) {
    return execa(task.command, [...task.args], {
      stdio: 'inherit',
      reject: true,
      ...share,
      ...grace,
    });
  }
  // stdin is the task's input, so only the two output streams are inherited.
  return execa(task.command, [...task.args], {
    input: task.input,
    stdout: 'inherit',
    stderr: 'inherit',
    reject: true,
    ...share,
    ...grace,
  });
}

// Whether a sibling is still running is read off the runtime process rather
// than off the library's handle, which carries no exit state: reading it there
// answers `undefined` for every sibling, and a guard comparing that to `null`
// stops matching any of them — so nothing is killed and the run waits forever.
function killSiblings(subprocesses: readonly Subprocess[], except: Subprocess): void {
  for (const sp of subprocesses) {
    const { exitCode, killed } = sp.nodeChildProcess;
    if (sp !== except && exitCode === null && !killed) {
      sp.kill('SIGTERM');
    }
  }
}

export async function runParallel(tasks: readonly Task[], totalBudgetKb?: number): Promise<void> {
  const shares = budgetShares(tasks, totalBudgetKb);
  const subprocesses: Subprocess[] = tasks.map((t) => spawn(t, shares.get(t.name)));

  let firstError: Error | undefined;

  async function watch(sp: Subprocess): Promise<void> {
    try {
      await sp;
    } catch (error: unknown) {
      if (firstError !== undefined) return;
      firstError = error instanceof Error ? error : new Error(String(error));
      killSiblings(subprocesses, sp);
    }
  }

  await Promise.all(subprocesses.map((sp) => watch(sp)));

  if (firstError !== undefined) {
    throw firstError;
  }
}

/**
 * The test phase runs after the parallel block has exited, so it shares memory
 * with nothing and takes the whole budget rather than a share of it.
 */
export async function runSequential(task: Task, totalBudgetKb?: number): Promise<void> {
  await spawn(task, totalBudgetKb);
}

/**
 * Resolves the gitleaks scan task for this push, or null when there is nothing
 * to scan.
 */
export async function buildGitleaksTask(
  stdin: string,
  isTty: boolean,
  advertised: readonly string[]
): Promise<Task | null> {
  const range = resolvePushedRange(stdin, isTty, advertised);
  if (range === null) return null;
  const bin = await ensureGitleaks();
  return {
    name: 'gitleaks',
    command: bin,
    args: gitleaksRangeScanArgs(range.logOptions),
  };
}

/**
 * How long the runner leaves the tree scan to unwind before killing it. The
 * removal of a materialised tree of close to half a gigabyte has been measured
 * past the five seconds the process library allows by default, and a removal
 * cut short leaves the tree for good — nothing collects it. Waiting forever
 * would trade that bounded leak for an unbounded stall, so the window is
 * several times the slowest removal measured and still finite.
 */
const TREE_SCAN_UNWIND_GRACE_MS = 60_000;

/**
 * The secret scan of the tree each pushed ref publishes, one task per ref at
 * that ref's own tip.
 *
 * It is not a duplicate of the range scan beside it and neither replaces the
 * other: the range scan asks whether these commits introduce a secret, and the
 * tree scan asks whether the tree they publish holds one. They diverge for
 * anything that entered the tree outside the pushed range — a pull, a rebase, a
 * cherry-pick, a contributor's merge — and for a secret committed and removed
 * within the range, which reaches history but not the tip.
 *
 * A ref being deleted publishes no tree, so it yields no task.
 *
 * The scan owns the process it runs in, because it removes a materialised tree
 * of close to half a gigabyte in the unwind a termination signal starts, and
 * the runner sends that signal to every sibling the moment another check fails.
 * The `tsx` launcher relays the signal to a child and then kills it, so the
 * unwind never reaches the removal and the tree survives the push; loading the
 * TypeScript runtime into this process instead leaves the signal with the
 * script that handles it.
 */
export function buildTreeScanTasks(
  stdin: string,
  isTty: boolean,
  advertised: readonly string[]
): Task[] {
  return resolvePushedRefRanges(stdin, isTty, advertised).map(({ ref, tip }) => ({
    name: `gitleaks:tree ${ref}`,
    command: 'node',
    args: ['--import', 'tsx', 'scripts/gitleaks-scan.ts', '--revision', tip],
    forceKillAfterDelay: TREE_SCAN_UNWIND_GRACE_MS,
  }));
}

/**
 * The privacy gate, at its push stage. It is built for every push, including
 * one that only deletes a ref: its destination, tag and signing checks are
 * about the push itself rather than about the commits it carries, and a push
 * with no commits still has a destination.
 *
 * The ref lines go to it on stdin rather than as arguments, so the gate reads
 * git's own hook protocol and parses it through the one shared seam.
 */
export function buildPrivacyGateTask(stdin: string, remote: string, remoteUrl: string): Task {
  return {
    name: 'privacy-gate',
    command: 'tsx',
    args: ['scripts/privacy-gate.ts', 'push', remote, remoteUrl],
    input: stdin,
  };
}

/**
 * What this hook prints when the run fails. The runner reports a failure by
 * quoting the invocation back, and an invocation carries the push destination
 * — twice, on the gate's own command line — or an absolute binary path, so the
 * line goes through the same redaction the gate's refusals do. It is built here
 * rather than at the entry point because the entry point is the one region no
 * test observes.
 */
export function launcherFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `pre-push failed: ${withoutHostPaths(message)}`;
}

export interface RecordsBackup {
  /** The checkout's top level, where the records overlay's git directory sits when it exists. */
  readonly root: string;
  readonly save: (context: RecordsContext) => Promise<void>;
}

/**
 * Saves the records overlay, when the checkout has one. A failed save is a
 * warning rather than a failure: the records are a private backup beside the
 * push, so losing one save must not cost the push it rides on.
 */
export async function backUpRecords(records: RecordsBackup): Promise<void> {
  if (!existsSync(overlayDirectory(records.root))) return;
  try {
    await records.save({
      root: records.root,
      log: (line) => {
        console.log(line);
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `pre-push: the records were not saved (${withoutHostPaths(message)}); ` +
        'the push proceeds. Run pnpm records save to retry.'
    );
  }
}

/** git's pre-push arguments: the remote's name, then the URL it resolves to. */
export interface PushDestination {
  readonly remote: string;
  readonly remoteUrl: string;
}

export async function main(
  stdin: string,
  isTty: boolean,
  { remote, remoteUrl }: PushDestination,
  records: RecordsBackup
): Promise<void> {
  // This half deliberately asks the destination nothing. Only a new ref would
  // need asking, and the answer would have to be awaited *before* the parallel
  // set starts — a hanging destination would buy a full timeout of dead time
  // with no output, where the gate's own question runs inside the set beside
  // work that absorbs it. So a new ref costs this scan its exclusions, which
  // widens the range and never narrows it, and the gate remains the one that
  // asks and the one that refuses when it cannot.
  const gitleaksTask = await buildGitleaksTask(stdin, isTty, []);
  const parallelTasks = [
    ...PARALLEL_TASKS,
    ...(gitleaksTask ? [gitleaksTask] : []),
    ...buildTreeScanTasks(stdin, isTty, []),
    buildPrivacyGateTask(stdin, remote, remoteUrl),
  ];
  const totalBudgetKb = memoryBudgetKb(PLANNING_MEMORY_FRACTION);
  console.log(`Running in parallel: ${parallelTasks.map((t) => t.name).join(', ')}`);
  await runParallel(parallelTasks, totalBudgetKb);
  console.log('Static checks passed. Running tests...');
  await runSequential(TEST_TASK, totalBudgetKb);
  await backUpRecords(records);
}

/* v8 ignore start -- CLI entry point uses process.exit, exercised via husky */
const isMain = isMainModule(import.meta.url);
if (isMain) {
  void (async () => {
    try {
      const isTty = process.stdin.isTTY;
      const stdin = isTty ? '' : await readStdin();
      const [remote = '', remoteUrl = ''] = process.argv.slice(2);
      // The package manager runs this script from the checkout's top level.
      await main(stdin, isTty, { remote, remoteUrl }, { root: process.cwd(), save });
    } catch (error: unknown) {
      console.error(launcherFailure(error));
      process.exit(1);
    }
  })();
}
/* v8 ignore stop */
