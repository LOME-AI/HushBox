/**
 * The record files of a checkout: files under a records-block pattern that no
 * other ignore rule of the checkout excludes. Git does every match; this module
 * only arranges which rules git reads.
 *
 * The candidates are the untracked files the block's patterns match. Which of
 * them another rule excludes is asked of a shadow: a scratch work tree holding
 * only the checkout's ignore files — the root one with the block removed — and
 * a scratch git directory holding the main repository's exclude file, with the
 * main repository's case folding and user exclude file. Git reads every rule
 * there at its own precedence, so an exclude-file or nested rule naming a
 * record root still excludes it, and a nested re-inclusion still re-includes.
 *
 * Rejected: re-including the block's directories from the command line over
 * the real tree. Git ranks command-line rules above every ignore file and
 * exclude file, so the re-inclusion also overrode the exclude file and nested
 * files the definition says still exclude.
 */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git, gitResult } from './overlay.js';
import { recordPatterns, withoutRecordsBlock } from './patterns.js';

const GLOB_CHARACTERS = /[*?[\\]/u;

/** The directory a pattern cannot match outside of, as a pathspec. */
function literalPrefix(pattern: string): string {
  const unanchored = pattern.replace(/^\//u, '');
  const glob = unanchored.search(GLOB_CHARACTERS);
  const literal = glob === -1 ? unanchored : unanchored.slice(0, glob);
  const prefix = literal.slice(0, literal.lastIndexOf('/') + 1);
  return prefix === '' ? '.' : prefix;
}

function entries(output: string): string[] {
  return output.split('\0').filter((entry) => entry !== '');
}

/** One config value of the main repository, or undefined when nothing sets it. */
async function mainConfig(root: string, args: readonly string[]): Promise<string | undefined> {
  // git config exits 1 for a key nothing sets.
  const result = await gitResult(root, ['config', ...args], 'read the main repository config', {
    accepted: [0, 1],
  });
  return result.exitCode === 0 ? result.stdout : undefined;
}

/** Every directory above `file`, root excluded, as root-relative paths. */
function ancestors(file: string): string[] {
  const parts = file.split('/').slice(0, -1);
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
}

/** Copies the checkout's ignore files that can bear on `candidates` into `tree`. */
function copyIgnoreFiles(root: string, tree: string, candidates: readonly string[]): void {
  const gitignore = readFileSync(path.join(root, '.gitignore'), 'utf8');
  writeFileSync(path.join(tree, '.gitignore'), withoutRecordsBlock(gitignore));
  const directories = new Set(candidates.flatMap((file) => ancestors(file)));
  for (const directory of directories) {
    const source = path.join(root, ...directory.split('/'), '.gitignore');
    // git reads no ignore file that is a symbolic link, so neither does the shadow.
    if (!lstatSync(source, { throwIfNoEntry: false })?.isFile()) continue;
    const target = path.join(tree, ...directory.split('/'));
    mkdirSync(target, { recursive: true });
    copyFileSync(source, path.join(target, '.gitignore'));
  }
}

/** The candidates some rule other than the block excludes. */
async function excludedElsewhere(
  root: string,
  candidates: readonly string[],
  ignoreCase: string
): Promise<Set<string>> {
  const shadow = mkdtempSync(path.join(tmpdir(), 'records-shadow-'));
  try {
    const shadowGit = path.join(shadow, 'git');
    const tree = path.join(shadow, 'tree');
    mkdirSync(tree);
    await git(shadow, ['init', '--bare', '--quiet', shadowGit], 'create the shadow repository');
    const excludeFile = path.resolve(
      root,
      await git(root, ['rev-parse', '--git-path', 'info/exclude'], 'find the exclude file')
    );
    // git init makes info/ only from its template, which a user's config may leave empty.
    mkdirSync(path.join(shadowGit, 'info'), { recursive: true });
    writeFileSync(
      path.join(shadowGit, 'info', 'exclude'),
      existsSync(excludeFile) ? readFileSync(excludeFile) : ''
    );
    copyIgnoreFiles(root, tree, candidates);
    const userExcludes = await mainConfig(root, ['--path', '--get', 'core.excludesFile']);
    // check-ignore exits 1 when it excludes none of the paths it was given.
    const result = await gitResult(
      tree,
      [
        '-c',
        `core.ignoreCase=${ignoreCase}`,
        ...(userExcludes === undefined
          ? []
          : ['-c', `core.excludesFile=${path.resolve(root, userExcludes)}`]),
        `--git-dir=${shadowGit}`,
        `--work-tree=${tree}`,
        'check-ignore',
        '--no-index',
        '--stdin',
        '-z',
      ],
      'check the other ignore rules',
      { input: candidates.join('\0'), accepted: [0, 1] }
    );
    return new Set(entries(result.stdout));
  } finally {
    rmSync(shadow, { recursive: true, force: true });
  }
}

/**
 * The record files `gitDirectory`'s index does not hold, as root-relative paths
 * in git's order. `gitDirectory` is the overlay, or any empty repository when
 * the question is which record files exist at all.
 */
export async function listRecordFiles(root: string, gitDirectory: string): Promise<string[]> {
  const patterns = recordPatterns(readFileSync(path.join(root, '.gitignore'), 'utf8'));
  const pathspecs = ['--', ...new Set(patterns.map((pattern) => literalPrefix(pattern)))];
  const ignoreCase =
    (await mainConfig(root, ['--type=bool', '--get', 'core.ignoreCase'])) ?? 'false';
  const candidates = entries(
    await git(
      root,
      [
        '-c',
        `core.ignoreCase=${ignoreCase}`,
        // A pathspec matches case exactly whatever core.ignoreCase says.
        ...(ignoreCase === 'true' ? ['--icase-pathspecs'] : []),
        `--git-dir=${gitDirectory}`,
        `--work-tree=${root}`,
        'ls-files',
        '-z',
        '--others',
        '--ignored',
        ...patterns.map((pattern) => `--exclude=${pattern}`),
        ...pathspecs,
      ],
      'list the files under the record patterns'
    )
  );
  if (candidates.length === 0) return [];
  const excluded = await excludedElsewhere(root, candidates, ignoreCase);
  return candidates.filter((file) => !excluded.has(file));
}
