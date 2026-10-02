// Every package's vitest config merges this one, so the hook budget it declares
// is what a package that declares nothing gets. The runner's own default is
// sized for a host running one suite; this repository's own acceptance bar is
// many simultaneous runs, where a hook loses turns to the box rather than to
// anything being wrong.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfigFromFile } from 'vite';
import { defineConfig, mergeConfig } from 'vitest/config';
import { describe, expect, it } from 'vitest';

import { discoverWorkspaces } from '../../scripts/lib/cli/workspaces.ts';
import rootConfig from './vitest.config.ts';

// Vitest's documented default, printed by `vitest --help` beside the
// `--hookTimeout` flag. Named rather than inlined because it is the number the
// shared budget exists to leave behind.
const RUNNER_DEFAULT_HOOK_TIMEOUT_MS = 10_000;

describe('shared hook budget', () => {
  it('declares a budget instead of leaving hooks on the runner default', () => {
    expect(rootConfig.test.hookTimeout).toBeGreaterThan(RUNNER_DEFAULT_HOOK_TIMEOUT_MS);
  });

  // The property that lets a package delete nothing and restate nothing: a
  // package config declaring its own name, environment and case timeout still
  // carries the shared hook budget, because mergeConfig only replaces the keys
  // the package spells.
  it('survives into a package that declares its own test options', () => {
    const packageConfig = mergeConfig(
      rootConfig,
      defineConfig({
        test: { name: 'a-package', environment: 'node', testTimeout: 1000 },
      })
    );

    expect(packageConfig.test.hookTimeout).toBeGreaterThan(RUNNER_DEFAULT_HOOK_TIMEOUT_MS);
    expect(packageConfig.test.hookTimeout).toBe(rootConfig.test.hookTimeout);
  });
});

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '__test-fixtures-hook-budget__'
);

const VITEST_CLI = path.join(
  path.dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
  'vitest.mjs'
);

// Which of two numbers measures a hook, read off a real run rather than off the
// runner's documentation. Both numbers are handed in small so the corpus is
// quick; the mechanism they establish is scale-free, and it is the mechanism
// criterion the shared budget rests on — a budget a file declares for itself
// governs that file, so raising the shared floor takes nothing away from the
// files that deliberately sit above it.
describe('which budget measures a hook', () => {
  const handedInBudgetMs = 20;

  const run = spawnSync(
    process.execPath,
    [
      VITEST_CLI,
      'run',
      '--root',
      FIXTURE_DIR,
      '--config',
      path.join(FIXTURE_DIR, 'vitest.config.ts'),
      '--hookTimeout',
      String(handedInBudgetMs),
    ],
    { encoding: 'utf8', cwd: FIXTURE_DIR }
  );
  const output = `${run.stdout}${run.stderr}`;

  it('measures a hook that declares nothing against the handed-in budget', () => {
    expect(output).toContain(`Hook timed out in ${String(handedInBudgetMs)}ms`);
  });

  it('leaves a hook that declares its own budget on that budget', () => {
    expect(output).toMatch(/FAIL.*bare-hook\.test\.ts/);
    expect(output).not.toMatch(/FAIL.*own-budget\.test\.ts/);
  });
});

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// The arguments vitest hands vite's config loader, so what these cases read is
// what the runner itself would resolve rather than a re-implementation of it.
const CONFIG_ENV = { command: 'serve', mode: 'test' };

/**
 * Every workspace package holding a worker-pool config, derived from the
 * workspace rather than listed, so a project added later reaches these cases
 * with nothing here edited.
 */
const workerPoolConfigs = discoverWorkspaces(REPO_ROOT)
  .map((workspace) => path.join(REPO_ROOT, workspace.path, 'vitest.workers.config.ts'))
  .filter((file) => existsSync(file))
  .map((file) => ({ file, label: path.relative(REPO_ROOT, file) }));

// A worker-pool project cannot merge the shared config — its setup files run
// node-only code that workerd cannot execute — so it reaches the budget by
// importing it. Read off a real load of each config: an importer that stopped
// importing, or that spelled a number of its own, fails here.
describe('worker-pool projects', () => {
  it('are found by the workspace scan', () => {
    expect(workerPoolConfigs.length).toBeGreaterThan(0);
  });

  // One at a time: concurrent `loadConfigFromFile` calls hang the process.
  it.each(workerPoolConfigs)('$label carries the shared hook budget', async ({ file }) => {
    const loaded = await loadConfigFromFile(CONFIG_ENV, file, path.dirname(file));

    expect(loaded?.config.test?.hookTimeout).toBe(rootConfig.test.hookTimeout);
  });
});
