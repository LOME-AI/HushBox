/**
 * The four records subcommands. Each one writes the overlay alone: the main
 * repository is read for the ignore rules that decide which files are records,
 * its git directory lends restore a staging place, and its index, refs and
 * config are never written.
 */
import { existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { absentDirectories, firstOccupied, removePaths } from './new-paths.js';
import { git, overlayArguments, overlayDirectory, overlayGit, runGit } from './overlay.js';
import { listRecordFiles } from './record-files.js';
import { atStep, duringStep } from './step.js';
import { treeFiles, unchangedFiles, type TreeFile } from './tree-files.js';

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
export async function presentRecordFiles(root: string): Promise<string[]> {
  const scratch = mkdtempSync(path.join(tmpdir(), 'records-scan-'));
  try {
    await git(root, ['init', '--bare', '--quiet', scratch], 'create a scratch repository');
    return await listRecordFiles(root, scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Where restore builds the overlay before moving it into place: inside the main
 * repository's git directory, which no `git add` reaches, so the staged copy is
 * never in the working tree or beside it, and the next restore clears whatever
 * a restore that died left there. In a linked worktree that directory is the
 * worktree's own, under the main checkout's `.git`, and can sit on another
 * filesystem than the working tree; the move into place then fails, and the
 * restore is undone like any other failure.
 */
async function stagingDirectory(root: string): Promise<string> {
  const relative = await git(
    root,
    ['rev-parse', '--git-path', 'records-restore'],
    'find the staging place'
  );
  return path.resolve(root, relative);
}

/** What a checkout that has begun wrote, as far as it can be told from what was there before. */
interface Checkout {
  readonly files: readonly TreeFile[];
  /** The folders above those files that did not exist before the checkout, deepest first. */
  readonly directories: readonly string[];
}

/**
 * Takes back a checkout that began: each file it names that still holds the
 * tree's bytes, then each folder it created that is left empty. A file whose
 * bytes differ was written by someone else and stays.
 */
async function undoCheckout(
  root: string,
  gitArguments: readonly string[],
  checkout: Checkout
): Promise<void> {
  const written = await unchangedFiles(root, gitArguments, checkout.files);
  removePaths(root, written, checkout.directories);
}

/**
 * Clones `remote` into a staging git directory, checks `main` out over the
 * working tree, and only then moves that directory into place as the overlay.
 * Refused while any record file exists, which the user saves with init instead,
 * and while anything at all stands at a path the remote's tree names. The
 * checkout is also told not to overwrite ignored files, which is all the record
 * roots are to the overlay, so a file that appears there after the check still
 * stops it. Any failure from the checkout on removes the files that hold the
 * tree's bytes and the folders the checkout created, then the staging
 * directory, so a failed restore leaves no overlay and the working tree as it
 * was.
 */
export async function restore({ root, log, remote }: RemoteContext): Promise<void> {
  refuseExistingOverlay(root, 'restore');
  const present = await duringStep('scan the record files', () => presentRecordFiles(root));
  if (present.length > 0) {
    throw new Error(
      `records: restore refused: ${String(present.length)} record file(s) already exist, ` +
        `among them ${present[0] ?? ''}; save them with pnpm records init instead`
    );
  }
  const staging = await stagingDirectory(root);
  const stagingArguments = [`--git-dir=${staging}`, `--work-tree=${root}`];
  const stagingGit = (args: readonly string[], step?: string): Promise<string> =>
    git(root, [...stagingArguments, ...args], step ?? args.join(' '));
  atStep('clear the staging place', () => {
    rmSync(staging, { recursive: true, force: true });
  });
  let checkout: Checkout | undefined;
  try {
    await git(root, ['clone', '--bare', '--quiet', remote, staging], 'clone');
    await stagingGit(['config', 'status.showUntrackedFiles', 'no']);
    await stagingGit(['config', 'remote.origin.fetch', TRACKING_REFSPEC]);
    const files = treeFiles(
      await stagingGit(['ls-tree', '-r', '-z', MAIN_REF], 'read the records tree')
    );
    const paths = files.map((file) => file.path);
    const occupied = atStep('read the working tree', () => firstOccupied(root, paths));
    if (occupied !== undefined) {
      throw new Error(
        `records: restore refused: ${occupied} already exists where the remote holds a record; ` +
          'move it aside and run restore again'
      );
    }
    checkout = {
      files,
      directories: atStep('read the working tree', () => absentDirectories(root, paths)),
    };
    await stagingGit(['checkout', '--quiet', '--no-overwrite-ignore', 'main'], 'check out main');
    await stagingGit(['update-ref', 'refs/remotes/origin/main', MAIN_REF]);
    atStep('move the overlay into place', () => {
      renameSync(staging, overlayDirectory(root));
    });
  } catch (error) {
    const begun = checkout;
    await duringStep('undo the failed restore', async () => {
      if (begun !== undefined) await undoCheckout(root, stagingArguments, begun);
      rmSync(staging, { recursive: true, force: true });
    });
    throw error;
  }
  log(`records: restored main from ${remote}`);
}
