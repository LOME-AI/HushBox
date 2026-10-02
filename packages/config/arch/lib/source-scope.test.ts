import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseWorkspaceYaml } from '../../../../scripts/lib/cli/workspaces.js';
import {
  DEFERRED_WORKSPACES,
  E2E_SOURCE_TREE,
  EXCLUDED_DIRECTORIES,
  EXCLUDED_TREES,
  REPO_ROOT,
  SCANNED_WORKSPACES,
  SOURCE_GLOBS,
  WEB_SOURCE_TREE,
  WORKSPACE_PARENTS,
  absoluteGlobs,
  discoverSourceTrees,
  isExcluded,
  resolveScannedFiles,
  sourceFilesUnder,
  undeclaredWorkspaces,
  webSourceTree,
  workspaceSourceTree,
} from './source-scope.js';
import type { Dirent } from 'node:fs';

interface WalkHooks {
  /**
   * Runs immediately before each directory read, which is the only moment a
   * test can make the filesystem move under a walk already in progress. The
   * read it precedes is the real one, so the failure the walk meets is the
   * kernel's answer to a directory that genuinely went away, never a stubbed
   * throw.
   */
  beforeDirectoryRead: ((directory: string) => void) | undefined;
}

/**
 * Hoisted above the imports: the module under test walks the repository at
 * import time, so a hook declared beside the tests is still in its temporal
 * dead zone when the first read goes through.
 */
const hooks = vi.hoisted((): WalkHooks => ({ beforeDirectoryRead: undefined }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readdirSync: (target: string, options: { withFileTypes: true }): Dirent[] => {
      hooks.beforeDirectoryRead?.(target);
      return actual.readdirSync(target, options);
    },
  };
});

/** Resolved once and shared; the globs span the whole repository. */
let scannedCache: Set<string> | undefined;

function scanned(): Set<string> {
  scannedCache ??= new Set(resolveScannedFiles(REPO_ROOT));
  return scannedCache;
}

/**
 * Trees that hold at least one source file the rules never see. Partial
 * coverage counts as uncovered: a tree globbed only down to `schema/**` or
 * `index.ts` reports as in-scope while the rest of it is invisible, which is
 * precisely the failure this asserts against.
 */
function uncoveredTrees(): string[] {
  const inProject = scanned();
  return discoverSourceTrees(REPO_ROOT).filter((tree) =>
    sourceFilesUnder(REPO_ROOT, tree).some((file) => !isExcluded(file) && !inProject.has(file))
  );
}

describe('source scope', () => {
  it('scans every workspace source tree that is not declared excluded', () => {
    expect(uncoveredTrees()).toEqual([]);
  });

  it('declares every workspace pattern the manifest names', () => {
    expect(undeclaredWorkspaces(parseWorkspaceYaml(REPO_ROOT))).toEqual([]);
  });

  it('flags a workspace pattern that is neither scanned nor deferred', () => {
    expect(undeclaredWorkspaces([...parseWorkspaceYaml(REPO_ROOT), 'unclaimed/*'])).toEqual([
      'unclaimed/*',
    ]);
  });

  it('declares no workspace pattern the manifest does not name', () => {
    const manifest = new Set(parseWorkspaceYaml(REPO_ROOT));

    for (const pattern of [...SCANNED_WORKSPACES, ...Object.keys(DEFERRED_WORKSPACES)]) {
      expect(manifest.has(pattern), pattern).toBe(true);
    }
  });

  it('defers no workspace pattern', () => {
    expect(Object.keys(DEFERRED_WORKSPACES)).toEqual([]);
  });

  it('declares no pattern both scanned and deferred', () => {
    const deferred = new Set(Object.keys(DEFERRED_WORKSPACES));

    expect(SCANNED_WORKSPACES.filter((pattern) => deferred.has(pattern))).toEqual([]);
  });

  it('gives a reason for every deferred workspace', () => {
    for (const [pattern, reason] of Object.entries(DEFERRED_WORKSPACES)) {
      expect(reason, pattern).not.toHaveLength(0);
    }
  });

  it('gives a reason for every excluded tree', () => {
    for (const [tree, reason] of Object.entries(EXCLUDED_TREES)) {
      expect(reason, tree).not.toHaveLength(0);
    }
  });

  it('scans no file from a declared-excluded tree', () => {
    expect([...scanned()].filter((file) => isExcluded(file))).toEqual([]);
  });

  it('scans no installed dependency', () => {
    expect([...scanned()].filter((file) => file.split('/').includes('node_modules'))).toEqual([]);
  });

  it('subtracts every excluded tree from the globs', () => {
    for (const tree of Object.keys(EXCLUDED_TREES)) {
      expect(SOURCE_GLOBS).toContain(`!${tree}/**`);
    }
  });

  it('globs a package collection at its src trees and a lone workspace directory whole', () => {
    expect(SOURCE_GLOBS).toContain('apps/*/src/**/*.{ts,tsx}');
    expect(SOURCE_GLOBS).toContain('e2e/**/*.{ts,tsx}');
  });

  it('subtracts every excluded directory from the globs, wherever it sits', () => {
    for (const directory of Object.keys(EXCLUDED_DIRECTORIES)) {
      expect(SOURCE_GLOBS).toContain(`!**/${directory}/**`);
    }
  });

  it('gives a reason for every excluded directory', () => {
    for (const [directory, reason] of Object.entries(EXCLUDED_DIRECTORIES)) {
      expect(reason, directory).not.toHaveLength(0);
    }
  });

  it('roots every glob at the repository, keeping negations negative', () => {
    expect(absoluteGlobs('/repo')).toEqual([
      '/repo/ads/**/*.{ts,tsx}',
      '/repo/apps/*/src/**/*.{ts,tsx}',
      '/repo/e2e/**/*.{ts,tsx}',
      '/repo/films/**/*.{ts,tsx}',
      '/repo/ops/**/*.{ts,tsx}',
      '/repo/packages/*/src/**/*.{ts,tsx}',
      '/repo/scripts/**/*.{ts,tsx}',
      ...Object.keys(EXCLUDED_DIRECTORIES).map((directory) => `!/repo/**/${directory}/**`),
      ...Object.keys(EXCLUDED_TREES).map((tree) => `!/repo/${tree}/**`),
    ]);
  });

  it('discovers a directly named workspace as a source tree in its own right', () => {
    const trees = discoverSourceTrees(REPO_ROOT);

    for (const workspace of SCANNED_WORKSPACES.filter((pattern) => !pattern.includes('*'))) {
      expect(trees, workspace).toContain(workspace);
    }
  });

  it('discovers only trees a scanned workspace declares', () => {
    for (const tree of discoverSourceTrees(REPO_ROOT)) {
      const [root, packageName, ...rest] = tree.split('/');
      const underCollection =
        WORKSPACE_PARENTS.includes(String(root)) &&
        packageName !== undefined &&
        rest.join('/') === 'src';

      expect(SCANNED_WORKSPACES.includes(tree) || underCollection, tree).toBe(true);
    }
  });

  it('treats a tree itself as excluded, not only its contents', () => {
    const [tree] = Object.keys(EXCLUDED_TREES);

    expect(isExcluded(String(tree))).toBe(true);
    expect(isExcluded(`${String(tree)}-sibling/file.ts`)).toBe(false);
  });

  it('excludes a declared directory at any depth, matching whole segments only', () => {
    const [directory] = Object.keys(EXCLUDED_DIRECTORIES);

    expect(isExcluded(`e2e/helpers/${String(directory)}/pkg/index.ts`)).toBe(true);
    expect(isExcluded(`e2e/helpers/${String(directory)}-sibling/index.ts`)).toBe(false);
  });
});

describe('the web source tree', () => {
  it('selects the tree the layer discovered for the web workspace', () => {
    expect(webSourceTree(['apps/api/src', 'apps/web/src', 'packages/shared/src'])).toBe(
      'apps/web/src/'
    );
  });

  it('takes the workspace whole when the layer discovers it without a src layout', () => {
    expect(webSourceTree(['apps/api/src', 'apps/web'])).toBe('apps/web/');
  });

  it('throws rather than narrowing to a shorter tree when the layer discovered none', () => {
    expect(() => webSourceTree(['apps/api/src', 'packages/shared/src'])).toThrow(
      /discovered no source tree under 'apps\/web'/
    );
  });

  it('resolves to the tree this repository declares, so the derivation is live', () => {
    expect(WEB_SOURCE_TREE).toBe('apps/web/src/');
  });
});

describe('the e2e source tree', () => {
  it('selects the tree the layer discovered for the e2e workspace', () => {
    expect(workspaceSourceTree(['apps/web/src', 'e2e', 'scripts'], 'e2e')).toBe('e2e/');
  });

  it('refuses a tree that merely ends in the workspace name', () => {
    expect(() => workspaceSourceTree(['scripts/e2e'], 'e2e')).toThrow(
      /discovered no source tree under 'e2e'/
    );
  });

  it('resolves to the tree this repository declares, so the derivation is live', () => {
    expect(E2E_SOURCE_TREE).toBe('e2e/');
  });
});

describe('the source-tree walk', () => {
  const TREE = 'tree';
  let fixtureRoot: string;
  let treeRoot: string;

  beforeEach(() => {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), 'source-scope-walk-'));
    treeRoot = path.join(fixtureRoot, TREE);
    for (const branch of ['one', 'two', 'three']) {
      mkdirSync(path.join(treeRoot, branch), { recursive: true });
      writeFileSync(path.join(treeRoot, branch, 'source.ts'), '');
    }
  });

  afterEach(() => {
    hooks.beforeDirectoryRead = undefined;
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  /** The branch the walk descends into first, so the rest are walked after it. */
  function firstBranch(): string {
    const entry = readdirSync(treeRoot, { withFileTypes: true }).find((candidate) =>
      candidate.isDirectory()
    );
    if (entry === undefined) {
      throw new Error('the fixture tree holds no branch for the walk to lose');
    }
    return entry.name;
  }

  it('reports every surviving file when a directory vanishes as the walk reaches it', () => {
    const intact = sourceFilesUnder(fixtureRoot, TREE);
    const doomed = firstBranch();
    hooks.beforeDirectoryRead = (directory) => {
      if (directory === path.join(treeRoot, doomed)) {
        rmSync(directory, { recursive: true, force: true });
      }
    };

    expect(sourceFilesUnder(fixtureRoot, TREE)).toEqual(
      intact.filter((file) => file !== path.posix.join(TREE, doomed, 'source.ts'))
    );
  });

  it('fails on a directory that is still there and refused the read', () => {
    const doomed = firstBranch();
    hooks.beforeDirectoryRead = (directory) => {
      if (directory === path.join(treeRoot, doomed)) {
        rmSync(directory, { recursive: true, force: true });
        writeFileSync(directory, '');
      }
    };

    expect(() => sourceFilesUnder(fixtureRoot, TREE)).toThrow();
  });

  it('fails on a declared source tree that is not there at all', () => {
    expect(() => sourceFilesUnder(fixtureRoot, 'absent')).toThrow();
  });
});
