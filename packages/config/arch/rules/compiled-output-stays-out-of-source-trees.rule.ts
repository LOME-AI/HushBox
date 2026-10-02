import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { REPO_ROOT } from '../lib/source-scope.js';
import type { FileSystemHost, RuntimeDirEntry } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * No compiler output sits beside the TypeScript source it was emitted from.
 *
 * A `.js` or `.d.ts` written next to its own `.ts` is preferred over that
 * source by module resolution, and it matches any glob that selects files by
 * their shape. So the file that runs, and the file that is measured, is the
 * compiler's copy rather than the one a developer edits — and because such a
 * file is never tracked, nothing that reads version control shows it. It
 * surfaces only when some tool walks it and fails in a way that reads as a
 * defect in unrelated code.
 *
 * WHY A DETECTOR RATHER THAN AN IGNORE. An ignore has to be written once per
 * tool, and the next tool has none. It also cannot be stated: excluding a `.js`
 * beside a `.ts` would exclude this repository's genuine JavaScript sources
 * too, and no glob language expresses "only when a same-named `.ts` sits next
 * to it". Worst, it leaves the condition present but invisible — the file goes
 * on winning module resolution for everything that resolves rather than globs.
 *
 * WHY THIS LAYER. The question is a structural fact about the whole tree —
 * which files sit beside which — and this layer is where those are asserted.
 * It cannot live in the lint or test layers, because those are instruments the
 * condition corrupts: a detector inside one reports after the damage it was
 * meant to name, or not at all. A rule whose subject is the tree rather than a
 * slice, reading whole workspaces off the project's file system instead of its
 * parsed sources, is the standing shape here —
 * `packages/config/arch/rules/imports-declared-in-manifest.rule.ts` is the
 * precedent and states why that scope belongs to the rule rather than to the
 * layer.
 *
 * WHAT SEPARATES AN ARTIFACT FROM A COMMITTED GENERATED FILE: version control.
 * A generated file the repository commits is a tracked, reviewable part of the
 * tree whatever wrote it; an emitted artifact is by nature untracked. That one
 * test also spares every genuine JavaScript and module source, since none of
 * them carries a same-named TypeScript sibling in the first place.
 *
 * SCOPE. The whole repository, less the directories git is already told to
 * ignore. Deriving the exclusions from the ignore rules rather than listing
 * build directories here is what keeps them from going stale: a new output
 * directory is ignored the day it is added, and `node_modules` — where
 * same-named source-and-emit pairs are ordinary and none of them is ours — is
 * ignored by construction. A file-level ignore is deliberately NOT honoured:
 * an artifact somebody has taught git to hide is exactly the case this rule
 * exists to surface. A symbolic link is neither read as a directory nor
 * reported as a file, so nothing behind one reaches the walk — the same bound
 * `lib/source-scope.ts`'s walk states for itself.
 */

/** The TypeScript spellings that emit; declarations are excluded below. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'] as const;

type SourceExtension = (typeof SOURCE_EXTENSIONS)[number];

/**
 * What the compiler can write for each source spelling, derived from its own
 * output rule rather than from the shapes this repository has been bitten by:
 * a JavaScript module (`jsx` preserved for the TSX spelling) and a declaration,
 * each with the source map that accompanies it.
 */
const EMITTED_EXTENSIONS: Readonly<Record<SourceExtension, readonly string[]>> = {
  '.ts': ['.js', '.d.ts'],
  '.tsx': ['.js', '.jsx', '.d.ts'],
  '.mts': ['.mjs', '.d.mts'],
  '.cts': ['.cjs', '.d.cts'],
};

/** Git's own store, which no ignore rule names because git never reports it. */
const GIT_DIRECTORY = '.git';

/** What one walk carries down the tree, so the recursion takes the directory alone. */
interface Walk {
  readonly fileSystem: FileSystemHost;
  readonly repoRoot: string;
  readonly pruned: ReadonlySet<string>;
  readonly found: Set<string>;
}

/**
 * The source spelling a path carries, or `null` when it carries none. A
 * declaration is not a source here: it has no emit of its own, and reading it
 * as one would look for a `.js` beside a `.d.ts`.
 */
function sourceExtensionOf(filePath: string): SourceExtension | null {
  for (const extension of SOURCE_EXTENSIONS) {
    if (!filePath.endsWith(extension)) continue;
    return filePath.slice(0, -extension.length).endsWith('.d') ? null : extension;
  }
  return null;
}

/** Every path the compiler could have written beside one source. */
function emittedSiblingsOf(sourcePath: string, extension: SourceExtension): string[] {
  const stem = sourcePath.slice(0, -extension.length);
  return EMITTED_EXTENSIONS[extension].flatMap((emitted) => [
    stem + emitted,
    `${stem + emitted}.map`,
  ]);
}

/** One NUL-framed `git ls-files` listing, as the paths it names. */
function gitPaths(repoRoot: string, listing: readonly string[]): string[] {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- git is a standard tool wherever this repo is checked out
  const stdout = execFileSync('git', ['-C', repoRoot, 'ls-files', '-z', ...listing], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout.split('\0').filter((record) => record.length > 0);
}

/**
 * One directory the walk discovered, read as an empty listing when it is no
 * longer there. Concurrent work in a checkout creates and removes scratch
 * directories continuously, so a directory a parent listed moments ago can be
 * gone by the time the walk descends into it. Narrowed by re-reading existence
 * rather than by the error, so a directory that IS still there and refused the
 * read fails the scan.
 */
function readWalkedDirectory(fileSystem: FileSystemHost, directory: string): RuntimeDirEntry[] {
  try {
    return fileSystem.readDirSync(directory);
  } catch (error) {
    if (fileSystem.directoryExistsSync(directory)) throw error;
    return [];
  }
}

/** Adds every file under one directory to the walk, less the pruned subtrees. */
function collectFiles(walk: Walk, directory: string): void {
  for (const entry of readWalkedDirectory(walk.fileSystem, directory)) {
    const relative = path.relative(walk.repoRoot, entry.name).split(path.sep).join(path.posix.sep);
    if (entry.isDirectory) {
      if (walk.pruned.has(relative) || path.basename(entry.name) === GIT_DIRECTORY) continue;
      collectFiles(walk, entry.name);
    } else if (entry.isFile) {
      walk.found.add(relative);
    }
  }
}

/** The repo-relative directories git reports as wholly ignored. */
function prunedDirectories(repoRoot: string): Set<string> {
  const ignored = gitPaths(repoRoot, [
    '--others',
    '--directory',
    '--ignored',
    '--exclude-standard',
  ]);
  return new Set(ignored.filter((entry) => entry.endsWith('/')).map((entry) => entry.slice(0, -1)));
}

function messageFor(emitted: string, source: string): string {
  return (
    `${emitted} is compiler output for ${source} and is untracked. An emitted file ` +
    'beside its own source wins module resolution over that source and matches ' +
    "anything selecting files by their shape, so tools read the compiler's copy " +
    'where the source was meant to be read and report the result as a defect in ' +
    'unrelated code. Delete it, then give whatever wrote it an output directory ' +
    'outside the source tree.'
  );
}

const rule: ArchRule = {
  name: 'compiled-output-stays-out-of-source-trees',
  check(project) {
    const walk: Walk = {
      fileSystem: project.getFileSystem(),
      repoRoot: REPO_ROOT,
      pruned: prunedDirectories(REPO_ROOT),
      found: new Set<string>(),
    };
    collectFiles(walk, REPO_ROOT);
    const tracked = new Set(gitPaths(REPO_ROOT, ['--cached']));

    const violations: ArchViolation[] = [];
    for (const file of walk.found) {
      const extension = sourceExtensionOf(file);
      if (extension === null) continue;
      for (const emitted of emittedSiblingsOf(file, extension)) {
        if (!walk.found.has(emitted) || tracked.has(emitted)) continue;
        violations.push({ file: emitted, line: 1, message: messageFor(emitted, file) });
      }
    }
    return violations.toSorted((a, b) => a.file.localeCompare(b.file));
  },
};

export default rule;
