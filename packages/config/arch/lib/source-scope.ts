import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Project } from 'ts-morph';
import type { Dirent } from 'node:fs';

/**
 * The architecture layer's declared scope: which source trees the rules see.
 *
 * Scope is data here rather than a literal in the runner because it is an
 * assertion about the repository, not a runner detail — the colocated test
 * holds every workspace source tree to it, so a new package cannot slip past
 * the rules by simply existing.
 */

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(LIB_DIR, '..', '..', '..', '..');

/**
 * The workspace patterns the rules scan, written in the same form
 * `pnpm-workspace.yaml` uses. Every other pattern the manifest declares is a
 * {@link DEFERRED_WORKSPACES} entry: the colocated test reads the manifest and
 * fails on any pattern that is neither, so a workspace cannot escape the layer
 * by being added to the manifest alone.
 *
 * The manifest writes a workspace in one of two shapes, and the shape is what
 * decides the scanned tree — see {@link sourceGlobFor}.
 */
export const SCANNED_WORKSPACES: readonly string[] = [
  'ads',
  'apps/*',
  'e2e',
  'films',
  'ops',
  'packages/*',
  'scripts',
];

/** True for a pattern that enumerates sibling packages rather than naming one workspace. */
function isCollection(pattern: string): boolean {
  return pattern.endsWith('/*');
}

/** The directory a collection pattern enumerates. */
function collectionParent(pattern: string): string {
  return pattern.replace(/\/\*$/, '');
}

/**
 * The scanned glob for one workspace pattern.
 *
 * A collection (`apps/*`) enumerates packages that all carry the `src` layout,
 * so the scanned tree of each is its `src`; the narrowing is the layout, not a
 * shortcut, and `packages/config` — the one package with no `src` — is out by
 * a recorded {@link EXCLUDED_TREES} entry rather than by accident.
 *
 * A workspace the manifest names directly (`scripts`) is a single directory
 * with no such layout to lean on — `ads` has a `src` and keeps most of its
 * source outside it — so the workspace itself is the tree, taken whole under
 * the same rule {@link SOURCE_GLOBS} states.
 */
function sourceGlobFor(pattern: string): string {
  return isCollection(pattern) ? `${pattern}/src/**/*.{ts,tsx}` : `${pattern}/**/*.{ts,tsx}`;
}

/**
 * Workspace patterns held outside the rules' view, each with the reason it is
 * out. Deferral is a decision recorded here, never an omission — `ads` reached
 * this file by escaping both the globs and the invariant while looking like
 * neither a decision nor a bug.
 *
 * The registry is empty: every workspace the manifest names is scanned. It
 * stays empty rather than being deleted because the invariant it feeds is what
 * refuses a manifest pattern that is neither scanned nor recorded here.
 */
export const DEFERRED_WORKSPACES: Readonly<Record<string, string>> = {};

/** The directory each scanned collection pattern enumerates. */
export const WORKSPACE_PARENTS: readonly string[] = SCANNED_WORKSPACES.filter((pattern) =>
  isCollection(pattern)
).map((pattern) => collectionParent(pattern));

/**
 * Trees deliberately outside the rules' view, each with the reason it is out.
 * A tree named here is subtracted from {@link SOURCE_GLOBS} and exempted from
 * the coverage invariant; every other workspace source tree must be globbed
 * whole. Entries are repo-relative and may name a subtree.
 */
export const EXCLUDED_TREES: Readonly<Record<string, string>> = {
  'apps/api/src/slices/_template':
    'Scaffolding copied and renamed when a slice is created, not code that runs.',
  'packages/config/src':
    'The rules live here and their tests embed violating shapes as literal source text, so scanning this package would make the layer report its own fixtures. The directory does not exist; the entry keeps that a decision rather than an accident.',
};

/**
 * Directory names excluded wherever they appear, each with the reason it is
 * out. A `<workspace>/src` glob could never reach an install directory; a
 * workspace taken whole reaches its own, so the exclusion is stated here
 * rather than left to the glob's shape.
 */
export const EXCLUDED_DIRECTORIES: Readonly<Record<string, string>> = {
  node_modules: 'Installed dependencies, not repository source.',
};

/**
 * Scanned source globs. Both the workspace set and each tree are taken WHOLE
 * rather than enumerated: a list silently exempts whatever it does not name,
 * so a rule reports a scope it never inspected. That has already bitten twice
 * — `platform/**`, `adapters/**` and `jobs/**` once sat outside the api entry,
 * while `platform/dev` writes ledger legs and wallet state; and `packages/db`
 * was globbed only down to `schema/**` while its live table write and
 * transactions sat outside every rule. A rule that gates itself to a subtree
 * filters inside `check`; the glob's job is to withhold nothing.
 *
 * Which workspaces are in at all is {@link SCANNED_WORKSPACES}; the rest are
 * {@link DEFERRED_WORKSPACES}.
 */
export const SOURCE_GLOBS: readonly string[] = [
  ...SCANNED_WORKSPACES.map((pattern) => sourceGlobFor(pattern)),
  ...Object.keys(EXCLUDED_DIRECTORIES).map((directory) => `!**/${directory}/**`),
  ...Object.keys(EXCLUDED_TREES).map((tree) => `!${tree}/**`),
];

/**
 * Every scanned source tree that exists on disk, repo-relative: one per
 * package under a collection pattern, and the directory itself for a workspace
 * the manifest names outright. The same split {@link sourceGlobFor} makes, so
 * the coverage invariant inspects exactly what the globs claim to cover.
 */
export function discoverSourceTrees(repoRoot: string): string[] {
  return SCANNED_WORKSPACES.flatMap((pattern) =>
    isCollection(pattern)
      ? readdirSync(path.join(repoRoot, collectionParent(pattern)), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => path.posix.join(collectionParent(pattern), entry.name, 'src'))
      : [pattern]
  )
    .filter((tree) => existsSync(path.join(repoRoot, tree)))
    .toSorted((a, b) => a.localeCompare(b));
}

/** The workspace whose source tree the web-facing rules read. */
const WEB_WORKSPACE = 'apps/web';

/** The workspace whose source tree the E2E-facing rules read. */
const E2E_WORKSPACE = 'e2e';

/**
 * A workspace's source tree, taken from what the layer discovered rather than
 * written down at each rule that watches it.
 *
 * A literal root narrows in silence: `apps/web/src/hooks/` is a legal-looking
 * one-token edit that leaves the rest of a rule passing while most of the app
 * walks out of its scope, reporting nothing. Discovery cannot express that —
 * it returns one tree per workspace — so the only failure left is the
 * workspace itself going missing, which throws at import and takes every rule
 * with it. That trade is the point: a root that is wrong LOUDLY beats one that
 * is narrow quietly.
 *
 * WHERE the tree is has one answer for the whole layer. WHETHER a rule stands
 * over it, and on which side, stays that rule's own decision in its own
 * `isInScope` — this shares the fact, never the policy.
 *
 * The selector is exported beside the roots it resolves because the
 * missing-tree arm is reachable only from a list a test hands it: this
 * repository always has the trees.
 *
 * The workspace is matched WHOLE — a tree named `e2e` inside another workspace
 * is not the `e2e` workspace, and a `endsWith`/`includes` reading of the same
 * question would hand an E2E-facing rule a second tree in another workspace to
 * stand over.
 */
export function workspaceSourceTree(trees: readonly string[], workspace: string): string {
  const tree = trees.find(
    (candidate) => candidate === workspace || candidate.startsWith(`${workspace}/`)
  );
  if (tree === undefined) {
    throw new Error(
      `source-scope: the architecture layer discovered no source tree under ` +
        `'${workspace}', so no rule standing over that tree has a root. Either the ` +
        'workspace moved or was renamed, or it left the scanned scope declared in this ' +
        'module — which would take the whole tree out of every rule, not just the ones ' +
        'facing it.'
    );
  }
  return `${tree}/`;
}

/** {@link workspaceSourceTree} for the web workspace. */
export function webSourceTree(trees: readonly string[]): string {
  return workspaceSourceTree(trees, WEB_WORKSPACE);
}

/** The web root every web-facing rule reads, resolved once at import. */
export const WEB_SOURCE_TREE = webSourceTree(discoverSourceTrees(REPO_ROOT));

/** The E2E root every E2E-facing rule reads, resolved once at import. */
export const E2E_SOURCE_TREE = workspaceSourceTree(discoverSourceTrees(REPO_ROOT), E2E_WORKSPACE);

/** Manifest patterns that are neither scanned nor deferred — always empty. */
export function undeclaredWorkspaces(patterns: readonly string[]): string[] {
  const declared = new Set([...SCANNED_WORKSPACES, ...Object.keys(DEFERRED_WORKSPACES)]);
  return patterns.filter((pattern) => !declared.has(pattern));
}

/** True when `relativePath` sits inside a declared-excluded tree or directory. */
export function isExcluded(relativePath: string): boolean {
  const segments = new Set(relativePath.split('/'));
  return (
    Object.keys(EXCLUDED_DIRECTORIES).some((directory) => segments.has(directory)) ||
    Object.keys(EXCLUDED_TREES).some(
      (tree) => relativePath === tree || relativePath.startsWith(`${tree}/`)
    )
  );
}

/** {@link SOURCE_GLOBS} rooted at an absolute path, negations preserved. */
export function absoluteGlobs(repoRoot: string): string[] {
  return SOURCE_GLOBS.map((glob) =>
    glob.startsWith('!') ? '!' + path.join(repoRoot, glob.slice(1)) : path.join(repoRoot, glob)
  );
}

/**
 * The files the globs select, repo-relative and sorted. Resolution only — the
 * rules' project parses every one of these, which is seconds of work the
 * scope assertions have no use for.
 */
export function resolveScannedFiles(repoRoot: string): string[] {
  return new Project({ skipAddingFilesFromTsConfig: true })
    .getFileSystem()
    .globSync(absoluteGlobs(repoRoot))
    .map((file) => path.relative(repoRoot, file))
    .toSorted((a, b) => a.localeCompare(b));
}

/** The spelling of a TypeScript source file, the only thing the walk reports. */
const SOURCE_FILE = /\.tsx?$/;

/**
 * One directory the walk discovered inside the tree, read as an empty listing
 * when it is no longer there.
 *
 * A workspace taken whole reaches its own `node_modules`, where the module
 * optimizer writes a temporary directory and renames it away — so a directory
 * a parent listed moments ago can be gone by the time the walk descends into
 * it, and a whole-tree read fails the scan on that. Tolerance is why the walk
 * reads directory by directory rather than in one recursive read.
 *
 * The tolerance costs nothing it should keep: a directory that is gone holds
 * no files to report. It is narrowed by re-reading existence rather than by
 * the error's code, so a directory that IS still there and refused the read
 * — unreadable, or no longer a directory — fails the scan as it did before.
 */
function readWalkedDirectory(directory: string): Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (existsSync(directory)) {
      throw error;
    }
    return [];
  }
}

/** Collects the source files under one already-read directory listing. */
function collectSourceFiles(entries: readonly Dirent[], repoRoot: string, into: string[]): void {
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const child = path.join(entry.parentPath, entry.name);
      collectSourceFiles(readWalkedDirectory(child), repoRoot, into);
    } else if (entry.isFile() && SOURCE_FILE.test(entry.name)) {
      into.push(path.posix.join(path.relative(repoRoot, entry.parentPath), entry.name));
    }
  }
}

/**
 * Every TypeScript file under one source tree, repo-relative and sorted.
 *
 * The counterpart to {@link resolveScannedFiles}: what is on disk, against
 * what the globs select.
 *
 * The tree itself is read without the tolerance {@link readWalkedDirectory}
 * grants what it finds inside: `tree` is a declared workspace source tree, so
 * its absence is the declared scope having moved and must fail the scan rather
 * than shrink it in silence.
 *
 * The walk does not cross a symbolic link it finds inside the tree, so
 * neither a linked directory's contents nor a linked source file reaches what
 * it reports.
 */
export function sourceFilesUnder(repoRoot: string, tree: string): string[] {
  const root = path.join(repoRoot, tree);
  const files: string[] = [];
  collectSourceFiles(readdirSync(root, { withFileTypes: true }), repoRoot, files);
  return files.toSorted((a, b) => a.localeCompare(b));
}
