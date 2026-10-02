#!/usr/bin/env tsx
/**
 * The gate lane for the skill tree's own `node:test` files.
 *
 * `.claude/skills/**` sits outside every workspace glob, so no vitest project,
 * no ESLint config and no typecheck reaches it; without this lane those tests
 * run only when a human types `node --test` and can never red on their own.
 *
 * The population is bound as a pattern rather than a file list: a test added
 * under any skill is picked up without editing anything here.
 */
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';

import { isMainModule } from './lib/cli/is-main.js';
import { readCommandLine, type CommandSpec } from './lib/cli/command-line.js';
import { runMain } from './lib/cli/run-main.js';

/** Where the skill tree lives, repo-root-relative. */
const SKILLS_DIRECTORY = path.posix.join('.claude', 'skills');

/** The extensions node's test runner loads: `js`, `cjs`, `mjs` and their TypeScript spellings. */
const TEST_EXTENSION = /\.[cm]?[jt]s$/;

/**
 * The file names node's own default test convention recognises: `test` itself,
 * a `test-` prefix, and a `test` suffix behind any of `-`, `_` or `.`.
 */
const TEST_BASENAME = /^(?:test|test-.+|.+[-_.]test)\.[cm]?[jt]s$/;

/** The directory name under which node treats every loadable file as a test. */
const TEST_DIRECTORY = 'test';

/**
 * Directories node's own discovery never walks into: dependency trees, and
 * hidden ones — which is what keeps a generated cache under the skill tree out
 * of the population without naming it.
 */
function isSkippedDirectory(name: string): boolean {
  return name === 'node_modules' || name.startsWith('.');
}

/**
 * Whether a path under the skill tree is a test, decided the way `node --test`
 * decides it for itself. Binding to node's convention rather than to a suffix
 * of this repository's own is what keeps a test named the way node documents
 * from loading fine and never running: the population this lane gates and the
 * population a human gets from `node --test` are the same set.
 */
function isSkillTest(relative: string): boolean {
  const directories = relative.split('/').slice(0, -1);
  const name = relative.slice(relative.lastIndexOf('/') + 1);
  if (directories.some((directory) => isSkippedDirectory(directory))) {
    return false;
  }
  return (
    TEST_BASENAME.test(name) || (directories.includes(TEST_DIRECTORY) && TEST_EXTENSION.test(name))
  );
}

/**
 * Every skill test in the repository, repo-root-relative and sorted, so the
 * runner is handed the same list in the same order on every machine.
 *
 * A repository with no skill tree yields no tests rather than throwing: an
 * empty population is a legal state, and this lane passes over it.
 */
export function discoverSkillTests(repoRoot: string): string[] {
  const skillsRoot = path.join(repoRoot, SKILLS_DIRECTORY);
  if (!existsSync(skillsRoot)) {
    return [];
  }
  return readdirSync(skillsRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(skillsRoot, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')
    )
    .filter((relative) => isSkillTest(relative))
    .map((relative) => path.posix.join(SKILLS_DIRECTORY, relative))
    .toSorted((left, right) => left.localeCompare(right));
}

/** The lane's verdict: the runner's exit code, or success over an empty population. */
export async function runSkillTests(
  files: readonly string[],
  run: (files: readonly string[]) => Promise<number>
): Promise<number> {
  if (files.length === 0) {
    console.warn('[test-skills] no skill test files found; nothing to run.');
    return 0;
  }
  return run(files);
}

export const COMMAND_LINE = {
  command: 'pnpm test:skills',
  summary: "Runs the skill tree's own node:test files.",
  flags: [],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

/* v8 ignore start -- process orchestration exercised by the repo's own gate runs */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    if (readCommandLine(COMMAND_LINE, process.argv.slice(2)) === null) return;
    const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    return runSkillTests(discoverSkillTests(repoRoot), async (files) => {
      const result = await execa('node', ['--test', ...files], {
        cwd: repoRoot,
        stdio: 'inherit',
        reject: false,
      });
      return typeof result.exitCode === 'number' ? result.exitCode : 1;
    });
  });
}
/* v8 ignore stop */
