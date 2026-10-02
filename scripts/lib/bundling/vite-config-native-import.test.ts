/**
 * Every Vite config in this repository imports under plain Node, with nothing
 * inferring extensions or stripping types for it beyond what Node itself does.
 *
 * Vite's own native-config-compat checker is the obvious thing to assert and is
 * deliberately not what this asserts: it flags a relative specifier that carries
 * no extension or resolves to a directory index, and is blind to a `.js`
 * specifier naming a TypeScript file and to TypeScript syntax Node's strip-only
 * mode cannot execute. A plain-Node import subsumes the checker — an
 * extensionless specifier fails one too — and cannot drift away from the
 * property, because it is the property.
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverWorkspaces } from '../cli/workspaces.ts';
import { withScratchDirectory } from '../scratch-directory.ts';

const CONFIG_FILE_NAME = 'vite.config.ts';

/**
 * The Vite configs this repository ships, derived from workspace membership so
 * that an app added after this file was written is covered the day it appears.
 *
 * One bound: a config counts only at a workspace package root, which is what
 * keeps a test corpus such as
 * `packages/config/__test-fixtures-coverage-globs__/vite.config.ts` out. A
 * workspace loading its config from a subdirectory would be invisible here.
 */
function viteConfigPaths(repoRoot: string): string[] {
  return discoverWorkspaces(repoRoot)
    .map((workspace) => `${workspace.path}/${CONFIG_FILE_NAME}`)
    .filter((configPath) => existsSync(path.join(repoRoot, configPath)));
}

/**
 * Import `configPath` in a child `node` process and report how it failed, or
 * `undefined` when it imported cleanly.
 *
 * A child process rather than an `import()` here: inside a vitest worker the
 * specifier resolves through Vite, which is the resolution this check is not
 * about. `NODE_OPTIONS` is cleared for the same reason — a loader inherited
 * from whatever wrapped the run would resolve specifiers Node alone cannot.
 */
function importFailureInChild(repoRoot: string, configPath: string): string | undefined {
  const target = pathToFileURL(path.join(repoRoot, configPath)).href;
  const probe =
    `import(${JSON.stringify(target)}).then(undefined, (error) => { ` +
    `console.error(error && error.stack ? error.stack : String(error)); ` +
    `process.exitCode = 1; });`;
  const child = spawnSync(process.execPath, ['-e', probe], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  if (child.status === 0) return undefined;
  return [
    `${configPath} does not import in a plain \`node\` process, so every tool that ` +
      `loads it without a bundler's resolver refuses it. Reproduce from the repository ` +
      `root with: node -e "import('./${configPath}')"`,
    child.stderr.trim() || `the child exited with status ${String(child.status)}`,
  ].join('\n\n');
}

/** A miniature repository: one workspace app whose config is `configSource`. */
async function writeWorkspaceRepo(root: string, configSource: string): Promise<void> {
  await fs.writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
  const app = path.join(root, 'apps', 'newborn');
  await fs.mkdir(path.join(app, 'fixtures'), { recursive: true });
  await fs.writeFile(path.join(app, 'package.json'), '{ "name": "@probe/newborn" }\n');
  await fs.writeFile(path.join(app, CONFIG_FILE_NAME), configSource);
  await fs.writeFile(path.join(app, 'fixtures', CONFIG_FILE_NAME), 'export default {};\n');
}

const LOADS = 'export default {};\n';
const NAMES_A_MISSING_FILE = "import './absent-neighbour.ts';\nexport default {};\n";

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const REPO_CONFIGS = viteConfigPaths(REPO_ROOT);

describe('vite config derivation', () => {
  it('finds the config of a workspace that did not exist when this test was written', async () => {
    await withScratchDirectory('vite-config-derivation-', async (root) => {
      await writeWorkspaceRepo(root, LOADS);
      expect(viteConfigPaths(root)).toContain('apps/newborn/vite.config.ts');
    });
  });

  it('leaves out a config that no workspace root carries', async () => {
    await withScratchDirectory('vite-config-derivation-', async (root) => {
      await writeWorkspaceRepo(root, LOADS);
      expect(viteConfigPaths(root)).not.toContain('apps/newborn/fixtures/vite.config.ts');
    });
  });
});

describe('a config that does not import', () => {
  it('is reported by name, with the child process error reproduced', async () => {
    await withScratchDirectory('vite-config-broken-', async (root) => {
      await writeWorkspaceRepo(root, NAMES_A_MISSING_FILE);

      const failures = viteConfigPaths(root)
        .map((configPath) => importFailureInChild(root, configPath))
        .filter((failure) => failure !== undefined);

      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain('apps/newborn/vite.config.ts');
      expect(failures[0]).toContain('ERR_MODULE_NOT_FOUND');
    });
  });
});

describe('every vite config this repository ships', () => {
  // A derivation that collapsed to nothing would register no cases below, and
  // the suite would report a pass having imported nothing at all.
  it('is a derivation that finds at least one config', () => {
    expect(REPO_CONFIGS.length).toBeGreaterThan(0);
  });

  it.each(REPO_CONFIGS)('imports in a plain node process: %s', (configPath) => {
    expect(importFailureInChild(REPO_ROOT, configPath)).toBeUndefined();
  });
});
