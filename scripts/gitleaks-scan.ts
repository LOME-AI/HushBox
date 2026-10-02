/**
 * The secret scan over the tree a revision publishes, shared by the pre-push
 * hook and the untrusted CI phase.
 *
 * The trusted phase runs the vendor's Action, which authenticates with an
 * organisation licence — a repository secret, and therefore a credential a fork
 * pull request must never reference. This runs the same pinned scanner binary
 * directly instead, so an untrusted run is still scanned without a secret being
 * named anywhere on its path.
 *
 * It scans a tree materialised out of git objects rather than the checkout it
 * runs in, so the file set is git's own answer at scan time: ignored and
 * untracked bytes are excluded by construction rather than by an exclusion list
 * that would have to be kept agreeing with `.gitignore`. It is also the tree
 * being published rather than the one on disk, so an uncommitted edit neither
 * hides a secret a push carries nor refuses a push that carries none.
 */
import { readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { isMainModule } from './lib/cli/is-main.js';
import { readCommandLine, type CommandSpec } from './lib/cli/command-line.js';
import { runMain } from './lib/cli/run-main.js';
import { withScratchDirectory } from './lib/scratch-directory.js';
import { withoutHostPaths } from './lib/privacy/host-paths.js';
import { ensureGitleaks, runGitleaks } from './lib/privacy/gitleaks.js';

/**
 * The target is `.`, and the scanner is run from inside the tree. gitleaks
 * resolves its configuration from the target path and reports findings relative
 * to it, so an absolute target stops every path-anchored allowlist in
 * `.gitleaks.toml` from matching and the scan reports hundreds of already-exempt
 * lines. Nothing in its output says which spelling it was given.
 */
export const GITLEAKS_SCAN_ARGS = ['dir', '.', '--redact', '--no-banner'] as const;

/** The revision scanned when a caller names none: the checkout's own tip. */
export const DEFAULT_SCAN_REVISION = 'HEAD';

const SCRATCH_PREFIX = 'hushbox-gitleaks-tree-';

/**
 * How long a materialised tree must have gone untouched before the next run
 * reclaims it. A tree's modification time stops advancing the moment its
 * extraction finishes, so under a far shorter window a scan that is merely
 * wedged is indistinguishable from one that was abandoned — and a scan whose
 * tree is taken out from under it reports fewer findings than that tree
 * carries, which is this gate failing open.
 */
export const ABANDONED_AFTER_MS = 60 * 60 * 1000;

/**
 * Removes the trees earlier runs abandoned, before this run materialises its
 * own: a run killed while its own removal was still running leaves close to
 * half a gigabyte that nothing else ever collects.
 *
 * A tree that cannot be removed — a permission, another account's file, a
 * second scan reclaiming the same one — is left where it is, because a gate
 * that refuses to run because it could not tidy up is worse than the bytes it
 * did not reclaim.
 */
async function reclaimAbandonedTrees(): Promise<void> {
  const temporaryLocation = os.tmpdir();
  const abandonedBefore = Date.now() - ABANDONED_AFTER_MS;
  let names: string[];
  try {
    names = await readdir(temporaryLocation);
  } catch {
    // Unlistable is as good as empty: this run's own materialisation fails next
    // if the location is really gone.
    return;
  }
  for (const name of names) {
    if (!name.startsWith(SCRATCH_PREFIX)) continue;
    const tree = path.join(temporaryLocation, name);
    try {
      const { mtimeMs } = await stat(tree);
      if (mtimeMs < abandonedBefore) await rm(tree, { recursive: true, force: true });
    } catch {
      // Left standing, and the trees behind it are still reclaimed.
    }
  }
}

/**
 * The signals that end this scan while its work is still running: the pre-push
 * runner sends SIGTERM to every sibling the moment another check fails, and an
 * interrupted hook sends SIGINT. Both are ordinary, so both are taken here.
 */
const TERMINATION_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/** A run's termination hookup: the signal to cancel on, and the way to unhook it. */
export interface Termination {
  readonly signal: AbortSignal;
  readonly release: () => void;
}

/**
 * Turns a termination signal into an abort, so the scan ends through its own
 * unwind rather than through node's default death. The materialised tree is
 * close to half a gigabyte and every process the run spawned is still working:
 * killed outright, node never reaches the removal and the extraction keeps
 * filling a directory nothing will ever collect. Aborting instead cancels the
 * subprocesses and lets the scratch directory's removal run.
 *
 * Every spawn this scan makes therefore sets `cleanup: false`: the process
 * library's own exit hook re-raises the signal it handled, killing node in the
 * middle of that unwind, and cancelling already ends the same subprocesses.
 */
export function abortOnTermination(): Termination {
  const controller = new AbortController();
  const abort = (): void => {
    controller.abort(new Error('the scan was terminated'));
  };
  for (const name of TERMINATION_SIGNALS) process.once(name, abort);
  return {
    signal: controller.signal,
    release: (): void => {
      for (const name of TERMINATION_SIGNALS) process.off(name, abort);
    },
  };
}

/** As much of the finished `git archive` as a failure message reads. */
interface ArchiveResult {
  readonly exitCode?: number;
  readonly stderr: string;
}

/**
 * Why the materialisation failed, in git's own words where git is what failed:
 * `fatal: not a valid object name`, and the revision it could not resolve.
 * Where git succeeded the reason is the extraction's, whatever git printed on
 * its way — a warning about a broken ref is not why `tar` then exited 2 — so
 * both statuses are reported instead.
 *
 * Nothing inherits git's standard error, so it is read off the finished process
 * rather than off the failure the process library raises — that failure is
 * raised by the extraction, which quotes `tar` and the directory it was writing
 * to, attributing the break to the wrong tool and printing a temporary path
 * that on Windows names the account the work happened on.
 */
function materialisationFailure(archived: ArchiveResult, extractionStatus?: number): string {
  const said = archived.stderr.trim();
  return said === '' || archived.exitCode === 0
    ? `git exited ${String(archived.exitCode)} and the extraction exited ${String(extractionStatus)}`
    : withoutHostPaths(said);
}

/**
 * Writes the revision's tree into `into`. `git archive` is the reader because
 * it only reads the object store; `git worktree add` would write git state into
 * the repository to answer the same question.
 *
 * The archive's standard output is never collected: the process library caps
 * what it gathers from a stream, and this archive is far past that cap, so
 * buffering cuts the pipe mid-stream and the extraction fails on a truncated
 * archive rather than on anything about the tree. Its standard error is
 * collected, because nothing inherits it and it is where git says what it could
 * not resolve.
 */
async function extractTree(
  repoRoot: string,
  revision: string,
  into: string,
  cancelSignal: AbortSignal
): Promise<void> {
  const archive = execa('git', ['-C', repoRoot, 'archive', '--format=tar', revision], {
    buffer: { stdout: false },
    cancelSignal,
    cleanup: false,
    reject: false,
  });
  const extraction = await archive.pipe('tar', ['-xf', '-', '-C', into], {
    buffer: false,
    cancelSignal,
    cleanup: false,
    reject: false,
  });
  const archived = await archive;
  if (archived.exitCode === 0 && extraction.exitCode === 0) return;
  if (cancelSignal.aborted) throw new Error(`the scan of revision ${revision} was terminated`);
  throw new Error(
    `cannot materialise revision ${revision}: ${materialisationFailure(archived, extraction.exitCode)}`
  );
}

export async function runGitleaksScan(
  repoRoot: string,
  revision: string = DEFAULT_SCAN_REVISION
): Promise<number> {
  const termination = abortOnTermination();
  try {
    await reclaimAbandonedTrees();
    return await withScratchDirectory(SCRATCH_PREFIX, async (tree) => {
      await extractTree(repoRoot, revision, tree, termination.signal);
      return runGitleaks(GITLEAKS_SCAN_ARGS, {
        ensure: ensureGitleaks,
        exec: (bin, args) =>
          execa(bin, [...args], {
            cwd: tree,
            stdio: 'inherit',
            reject: false,
            cancelSignal: termination.signal,
            cleanup: false,
          }),
      });
    });
  } finally {
    termination.release();
  }
}

export const COMMAND_LINE = {
  command: 'pnpm gitleaks:scan',
  summary: 'Scans the tree git holds at a revision for secrets.',
  flags: [
    {
      flag: '--revision',
      kind: 'value',
      summary: 'Scan this revision’s tree instead of the checkout’s tip.',
      placeholder: '<revision>',
    },
  ],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

/* v8 ignore start -- CLI entry point, exercised through CI */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    const line = readCommandLine(COMMAND_LINE, process.argv.slice(2));
    if (line === null) return;
    return runGitleaksScan(process.cwd(), line.flags['--revision'] ?? DEFAULT_SCAN_REVISION);
  });
}
/* v8 ignore stop */
