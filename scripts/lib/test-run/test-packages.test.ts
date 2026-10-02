import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { discoverWorkspaces } from '../cli/workspaces.js';
import { discoverTestPackages } from './test-packages.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');

/**
 * The workspace members deliberately outside the test run.
 *
 * A member earns a place here by being driven by a runner other than vitest, so
 * that declaring no `test` script is its design rather than an omission: the
 * end-to-end package is driven by the browser runner. The assertion over this
 * list is an equality, so a member that gains a `test` script reddens the list
 * rather than outliving its reason in silence.
 */
const OUTSIDE_THE_TEST_RUN: readonly string[] = ['@hushbox/e2e'];

interface FixtureMember {
  readonly directory: string;
  readonly manifest: Readonly<Record<string, unknown>>;
}

const fixtureRoots: string[] = [];

afterAll(() => {
  for (const root of fixtureRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A throwaway workspace root whose `packages/*` glob holds the given manifests. */
function fixtureWorkspace(members: readonly FixtureMember[]): string {
  const root = mkdtempSync(path.join(tmpdir(), 'hushbox-workspace-'));
  fixtureRoots.push(root);
  writeFileSync(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
  for (const member of members) {
    const directory = path.join(root, 'packages', member.directory);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'package.json'), JSON.stringify(member.manifest));
  }
  return root;
}

/**
 * Workspace members {@link discoverTestPackages} leaves out, sorted.
 *
 * Membership of the test run is derived from a manifest's `test` script, so a
 * package without one reaches nothing that consumes that derivation, and its
 * absence raises no signal of its own.
 */
function packagesOutsideTheTestRun(repoRoot: string): string[] {
  const inRun = new Set(discoverTestPackages(repoRoot).map((package_) => package_.name));
  return discoverWorkspaces(repoRoot)
    .map((workspace) => workspace.fullName)
    .filter((name) => !inRun.has(name))
    .toSorted((left, right) => left.localeCompare(right));
}

describe('the test-package roster against workspace membership', () => {
  it('names a workspace member whose manifest declares no test script', () => {
    const root = fixtureWorkspace([
      { directory: 'tested', manifest: { name: '@fixture/tested', scripts: { test: 'vitest' } } },
      { directory: 'untested', manifest: { name: '@fixture/untested', scripts: { build: 'tsc' } } },
    ]);

    expect(packagesOutsideTheTestRun(root)).toEqual(['@fixture/untested']);
  });

  it('holds every workspace package but the ones named outside the run', () => {
    expect(
      packagesOutsideTheTestRun(REPO_ROOT),
      `a workspace package declares no \`test\` script, so it is in no vitest project, no batch and no coverage gate, and its absence raises nothing. Either give it a \`test\` script or add it to OUTSIDE_THE_TEST_RUN with the reason it is driven by another runner. Exempt today: ${JSON.stringify(OUTSIDE_THE_TEST_RUN)}`
    ).toEqual([...OUTSIDE_THE_TEST_RUN]);
  });
});
