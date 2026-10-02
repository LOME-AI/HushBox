import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

import { ENV_MODE_VARIABLE } from './lib/stack/stack-mode.js';

import {
  CONFIG_FILE,
  KNOWN_PACKAGE_CONFIGS,
  TurboTaskShape,
  packageConfigFiles,
  tasksIn,
  type TurboTask,
} from './turbo-configs.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/** The build task as one config declares it, or `undefined` where it declares none. */
function buildTask(file: string): TurboTask | undefined {
  return tasksIn(file)['build'];
}

/**
 * The list a task receives under one key: its own where it declares one, the
 * root task's otherwise. A package-level list replaces the root's rather than
 * extending it, so those are the only two possibilities — and that replacement
 * is what the per-config cases turn on. It takes the two tasks rather than the
 * two paths so a case can hand it a task no config on disk declares.
 */
function listReceivedBy(
  task: TurboTask | undefined,
  rootTask: TurboTask | undefined,
  key: 'env' | 'inputs'
): readonly string[] {
  return task?.[key] ?? rootTask?.[key] ?? [];
}

/**
 * The root build's inputs that reach outside the package running the task.
 * `$TURBO_ROOT$` is the only anchor that does: every other glob resolves
 * against the package directory.
 */
function rootAnchoredBuildInputs(): readonly string[] {
  return (buildTask(CONFIG_FILE)?.inputs ?? []).filter((entry) =>
    entry.startsWith('$TURBO_ROOT$/')
  );
}

describe('the task-runner task shape', () => {
  // One case per key a suite reading this shape declares a rule about. A key
  // dropped from the shape stops being typed rather than stops parsing, so the
  // suite that needed it would read `undefined` and pass over nothing; these
  // are what fails instead.
  it('reads the environment list a task hashes into its cache key', () => {
    expect(TurboTaskShape.parse({ env: ['HB_ENV_MODE'] }).env).toEqual(['HB_ENV_MODE']);
  });

  it('reads the input globs a task hashes', () => {
    expect(TurboTaskShape.parse({ inputs: ['$TURBO_DEFAULT$'] }).inputs).toEqual([
      '$TURBO_DEFAULT$',
    ]);
  });

  it('reads the output globs a task archives', () => {
    expect(TurboTaskShape.parse({ outputs: ['dist/**'] }).outputs).toEqual(['dist/**']);
  });

  it('keeps a key it does not model, which every task carries some of', () => {
    expect(TurboTaskShape.parse({ dependsOn: ['^build'] })).toHaveProperty('dependsOn', ['^build']);
  });
});

describe('package-level config discovery', () => {
  it('finds a config at all, without which every case here passes over nothing', () => {
    expect(packageConfigFiles()).not.toEqual([]);
  });

  it('names only files that exist', () => {
    expect(packageConfigFiles().filter((file) => !existsSync(path.join(REPO_ROOT, file)))).toEqual(
      []
    );
  });

  it('names each config under the workspace that declares it', () => {
    expect(packageConfigFiles().filter((file) => !file.endsWith(`/${CONFIG_FILE}`))).toEqual([]);
  });

  it('leaves out the repository root config, which overrides nothing', () => {
    expect(packageConfigFiles()).not.toContain(CONFIG_FILE);
  });
});

describe('reading a config', () => {
  it('returns the task table the named config declares', () => {
    expect(Object.keys(tasksIn(CONFIG_FILE))).toContain('build');
  });
});

describe('the build cache key every package config inherits or replaces', () => {
  it('declares the generated env files root-anchored in the root build task, where they are written', () => {
    expect(buildTask(CONFIG_FILE)?.inputs ?? []).toContain('$TURBO_ROOT$/.env*');
  });

  it('names the stack-mode variable in the root build task, which every build reads', () => {
    // Under the task runner's strict env mode a variable the build task names
    // nowhere is stripped, so without this entry a build loads the default
    // stack's env files whatever stack asked for it and bakes that stack's API
    // address into the site, with every gate still green.
    expect(buildTask(CONFIG_FILE)?.env ?? []).toContain(ENV_MODE_VARIABLE);
  });

  it('finds the package-level configs that exist today, without which the per-config cases have no subjects', () => {
    expect(packageConfigFiles()).toEqual(expect.arrayContaining([...KNOWN_PACKAGE_CONFIGS]));
  });

  it('finds root-anchored inputs on the root build, without which the per-config input case passes over nothing', () => {
    expect(rootAnchoredBuildInputs()).not.toEqual([]);
  });

  it('finds a config that replaces the build inputs, which is the replacement the per-config input case is about', () => {
    expect(
      packageConfigFiles().filter((file) => buildTask(file)?.inputs !== undefined)
    ).not.toEqual([]);
  });

  it('gives a build its own env list in place of the root list, without which the per-config env case cannot fail', () => {
    // A config declaring no env list receives the root's, which names the
    // variable — so only a replacing list exercises the rule, and this subject
    // is built rather than read for that reason.
    expect(
      listReceivedBy({ env: ['A_DIFFERENT_VARIABLE'] }, { env: [ENV_MODE_VARIABLE] }, 'env')
    ).toEqual(['A_DIFFERENT_VARIABLE']);
  });

  describe.each(packageConfigFiles())('%s', (file) => {
    it('leaves its build the stack-mode variable rather than replacing the list without it', () => {
      expect(listReceivedBy(buildTask(file), buildTask(CONFIG_FILE), 'env')).toContain(
        ENV_MODE_VARIABLE
      );
    });

    it('keeps the root build inputs that reach outside the package', () => {
      // A build bakes the generated env files, and they are written at the
      // repository root — so an unanchored `.env*` in the replacing list
      // matches nothing, and the build hashes no env file at all.
      const received = listReceivedBy(buildTask(file), buildTask(CONFIG_FILE), 'inputs');
      expect(rootAnchoredBuildInputs().filter((entry) => !received.includes(entry))).toEqual([]);
    });
  });
});
