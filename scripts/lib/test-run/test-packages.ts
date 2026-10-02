import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Explicit-URL runtime import: wherever this module is loaded by Node's own
// loader rather than through a transform that rewrites specifiers, a `.js`
// specifier resolves literally and finds no such file next to
// `../cli/workspaces.ts` — the constraint `packages/config/vitest.config.ts`
// states in full.
const { discoverWorkspaces } = (await import(
  new URL('../cli/workspaces.ts', import.meta.url).href
)) as typeof import('../cli/workspaces.js');

/**
 * The test-package roster, derived from the workspace instead of maintained by
 * hand: a package participates in the test run iff its manifest has a `test`
 * script. The consolidated vitest config, the batch coordinator, and the
 * per-package client all consume this one derivation, so a new package with a
 * `test` script joins every layer with no list to update.
 */
export interface TestPackage {
  /** Full manifest name, e.g. `@hushbox/api`. */
  readonly name: string;
  /** Repo-root-relative directory. */
  readonly dir: string;
  /** The package's vitest config filename. */
  readonly configFile: string;
  /** Whether the package carries a workers-pool suite (`test:workers`). */
  readonly hasWorkersSuite: boolean;
}

/**
 * A package's vitest config filename. `vitest.package.config.ts` wins when it
 * exists: a package whose `vitest.config.ts` is itself the shared base other
 * packages import (packages/config) keeps its own project config under the
 * alternate name.
 */
export function packageVitestConfigFile(packageDir: string): string {
  return existsSync(path.join(packageDir, 'vitest.package.config.ts'))
    ? 'vitest.package.config.ts'
    : 'vitest.config.ts';
}

interface Manifest {
  readonly name?: string;
  readonly scripts?: Record<string, string>;
}

export function discoverTestPackages(repoRoot: string): TestPackage[] {
  const packages: TestPackage[] = [];
  for (const workspace of discoverWorkspaces(repoRoot)) {
    const packageDir = path.join(repoRoot, workspace.path);
    const manifest = JSON.parse(
      readFileSync(path.join(packageDir, 'package.json'), 'utf8')
    ) as Manifest;
    if (typeof manifest.scripts?.['test'] !== 'string' || manifest.name === undefined) {
      continue;
    }
    packages.push({
      name: manifest.name,
      dir: workspace.path,
      configFile: packageVitestConfigFile(packageDir),
      hasWorkersSuite: typeof manifest.scripts['test:workers'] === 'string',
    });
  }
  return packages;
}
