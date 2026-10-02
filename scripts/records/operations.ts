/**
 * The four records subcommands. Each one writes the overlay alone: the main
 * repository is only read, for the ignore rules that decide which files are
 * records, and its index, refs and config are never written.
 */
import { existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git, overlayArguments, overlayDirectory, overlayGit, runGit } from './overlay.js';
import { listRecordFiles } from './record-files.js';

const MAIN_REF = 'refs/heads/main';

/** Lets a push update `origin/main`, which is what `status` compares against. */
const TRACKING_REFSPEC = '+refs/heads/*:refs/remotes/origin/*';

export interface RecordsContext {
  /** The main repository's top level, which the overlay shares as its work tree. */
  readonly root: string;
  readonly log: (line: string) => void;
}

export interface RemoteContext extends RecordsContext {
  readonly remote: string;
}

function requireOverlay(root: string): void {
  if (!existsSync(overlayDirectory(root))) {
    throw new Error(
      `records: ${root} has no .records.git; run pnpm records init to start the overlay ` +
        'or pnpm records restore to fetch an existing one'
    );
  }
}

function refuseExistingOverlay(root: string, command: string): void {
  if (existsSync(overlayDirectory(root))) {
    throw new Error(`records: ${command} refused: ${overlayDirectory(root)} already exists`);
  }
}

async function hasMain(root: string): Promise<boolean> {
  const result = await runGit(root, [
    ...overlayArguments(root),
    'rev-parse',
    '--verify',
    '--quiet',
    MAIN_REF,
  ]);
  return result.exitCode === 0;
}

async function hasStagedChanges(root: string): Promise<boolean> {
  const staged = await overlayGit(
    root,
    ['diff', '--cached', '--name-only', '-z'],
    'read the staged changes'
  );
  return staged !== '';
}

/** The current UTC day, `YYYY-MM-DD`: the only clock reading a records commit carries. */
function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

async function commit(root: string): Promise<void> {
  const day = utcDay();
  const stamp = `${day}T00:00:00+0000`;
  await overlayGit(root, ['commit', '--quiet', '--message', `Records ${day}`], 'commit', {
    env: { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp },
  });
}

/**
 * Stages every record file and every deletion of a tracked one, commits when
 * anything is staged, and pushes `main` to `origin`. An overlay that has never
 * committed has no `main` to push, so it pushes nothing.
 */
export async function save({ root, log }: RecordsContext): Promise<void> {
  requireOverlay(root);
  await overlayGit(root, ['add', '--update'], 'stage the tracked records');
  const added = await listRecordFiles(root, overlayDirectory(root));
  if (added.length > 0) {
    await overlayGit(
      root,
      ['--literal-pathspecs', 'add', '--force', '--pathspec-from-file=-', '--pathspec-file-nul'],
      'stage the new records',
      { input: added.join('\0') }
    );
  }
  if (await hasStagedChanges(root)) {
    await commit(root);
  } else {
    log('records: nothing to save');
  }
  if (await hasMain(root)) {
    await overlayGit(root, ['push', '--quiet', 'origin', 'main'], 'push');
  }
}

/** One porcelain entry's verdict: what `save` would do to the file it names. */
function changeOf(code: string): string {
  if (code.includes('D')) return 'deleted';
  if (code.startsWith('A')) return 'added';
  return 'modified';
}

/** The path a status line names, after its one-word verdict. */
function pathOf(line: string): string {
  return line.slice(line.indexOf(' ') + 1);
}

async function aheadCount(root: string): Promise<number> {
  if (!(await hasMain(root))) return 0;
  return Number(
    await overlayGit(root, ['rev-list', '--count', MAIN_REF, '--not', '--remotes=origin'])
  );
}

/** Prints what `save` would add, change or delete, then whether `main` is ahead of `origin/main`. */
export async function status({ root, log }: RecordsContext): Promise<void> {
  requireOverlay(root);
  const porcelain = await overlayGit(root, [
    'status',
    '--porcelain',
    '-z',
    '--no-renames',
    '--untracked-files=no',
  ]);
  const tracked = porcelain
    .split('\0')
    .filter((entry) => entry !== '')
    .map((entry) => `${changeOf(entry.slice(0, 2))} ${entry.slice(3)}`);
  const untracked = await listRecordFiles(root, overlayDirectory(root));
  const added = untracked.map((file) => `added ${file}`);
  for (const line of [...tracked, ...added].toSorted((a, b) =>
    pathOf(a).localeCompare(pathOf(b))
  )) {
    log(line);
  }
  const ahead = await aheadCount(root);
  log(
    ahead === 0
      ? 'records: main is not ahead of origin/main'
      : `records: main is ${String(ahead)} commit(s) ahead of origin/main`
  );
}

/** Creates the overlay with `remote` as its origin, then saves. */
export async function init({ root, log, remote }: RemoteContext): Promise<void> {
  refuseExistingOverlay(root, 'init');
  await git(root, ['init', '--bare', '--quiet', overlayDirectory(root)], 'create the overlay');
  await overlayGit(root, ['symbolic-ref', 'HEAD', MAIN_REF]);
  await overlayGit(root, ['config', 'status.showUntrackedFiles', 'no']);
  await overlayGit(root, ['remote', 'add', 'origin', remote]);
  await save({ root, log });
}

/** The record files present in the working tree, read against an empty index. */
async function presentRecordFiles(root: string): Promise<string[]> {
  const scratch = mkdtempSync(path.join(tmpdir(), 'records-scan-'));
  try {
    await git(root, ['init', '--bare', '--quiet', scratch], 'create a scratch repository');
    return await listRecordFiles(root, scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Clones `remote` into a git directory beside the checkout, checks `main` out
 * over the working tree, and only then moves that directory into place as the
 * overlay; any failure removes it, so a failed restore leaves no overlay. The
 * overlay's view of the record roots is all ignored, and git overwrites ignored
 * files by default, so the checkout is told not to: a local file of any kind at
 * a path the remote holds refuses the restore. Refused too while any record
 * file exists, which the user saves with init instead.
 */
export async function restore({ root, log, remote }: RemoteContext): Promise<void> {
  refuseExistingOverlay(root, 'restore');
  const present = await presentRecordFiles(root);
  if (present.length > 0) {
    throw new Error(
      `records: restore refused: ${String(present.length)} record file(s) already exist, ` +
        `among them ${present[0] ?? ''}; save them with pnpm records init instead`
    );
  }
  const staging = mkdtempSync(path.join(path.dirname(root), `.${path.basename(root)}-records-`));
  try {
    const stagingGit = (args: readonly string[], step?: string): Promise<string> =>
      git(root, [`--git-dir=${staging}`, `--work-tree=${root}`, ...args], step ?? args.join(' '));
    await git(root, ['clone', '--bare', '--quiet', remote, staging], 'clone');
    await stagingGit(['config', 'status.showUntrackedFiles', 'no']);
    await stagingGit(['config', 'remote.origin.fetch', TRACKING_REFSPEC]);
    await stagingGit(['checkout', '--quiet', '--no-overwrite-ignore', 'main'], 'check out main');
    await stagingGit(['update-ref', 'refs/remotes/origin/main', MAIN_REF]);
    renameSync(staging, overlayDirectory(root));
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  log(`records: restored main from ${remote}`);
}
