import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { discoverSkillTests, runSkillTests } from './test-skills.js';
import { manifestScripts, turboRunTargets } from './lib/root-manifest.js';
import { tasksIn } from './turbo-configs.js';

const roots: string[] = [];

/** A throwaway repository root whose skill tree holds exactly the given files. */
function repoWith(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hb-skill-tests-'));
  roots.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('discoverSkillTests', () => {
  it('finds every skill test in the tree, however deeply a skill nests it', () => {
    const root = repoWith({
      '.claude/skills/one/checks.test.mjs': '',
      '.claude/skills/two/scripts/engines/detect.test.mjs': '',
    });

    expect(discoverSkillTests(root)).toEqual([
      '.claude/skills/one/checks.test.mjs',
      '.claude/skills/two/scripts/engines/detect.test.mjs',
    ]);
  });

  it('finds a skill test spelled with any extension node itself would load', () => {
    const root = repoWith({
      '.claude/skills/one/a.test.js': '',
      '.claude/skills/one/b.test.cjs': '',
      '.claude/skills/one/c.test.mjs': '',
      '.claude/skills/one/d.test.ts': '',
      '.claude/skills/one/e.test.cts': '',
      '.claude/skills/one/f.test.mts': '',
    });

    expect(discoverSkillTests(root)).toEqual([
      '.claude/skills/one/a.test.js',
      '.claude/skills/one/b.test.cjs',
      '.claude/skills/one/c.test.mjs',
      '.claude/skills/one/d.test.ts',
      '.claude/skills/one/e.test.cts',
      '.claude/skills/one/f.test.mts',
    ]);
  });

  it('finds a skill test spelled with any of the name forms node recognises', () => {
    const root = repoWith({
      '.claude/skills/one/test.mjs': '',
      '.claude/skills/one/test-thing.mjs': '',
      '.claude/skills/one/thing-test.mjs': '',
      '.claude/skills/one/thing_test.mjs': '',
    });

    expect(discoverSkillTests(root)).toEqual([
      '.claude/skills/one/test-thing.mjs',
      '.claude/skills/one/test.mjs',
      '.claude/skills/one/thing_test.mjs',
      '.claude/skills/one/thing-test.mjs',
    ]);
  });

  it('finds a skill test placed in a directory node treats as a test directory', () => {
    const root = repoWith({ '.claude/skills/one/test/anything.mjs': '' });

    expect(discoverSkillTests(root)).toEqual(['.claude/skills/one/test/anything.mjs']);
  });

  it('leaves a test out of the population when node would not walk into its directory', () => {
    const root = repoWith({
      '.claude/skills/one/kept.test.mjs': '',
      '.claude/skills/one/node_modules/dependency/dropped.test.mjs': '',
      '.claude/skills/.generated/dropped.test.mjs': '',
    });

    expect(discoverSkillTests(root)).toEqual(['.claude/skills/one/kept.test.mjs']);
  });

  it('leaves a file node would not run out of the population', () => {
    const root = repoWith({
      '.claude/skills/one/checks.mjs': '',
      '.claude/skills/one/atest.mjs': '',
      '.claude/skills/one/checks.test.jsx': '',
      '.claude/skills/one/test-fixtures/component.mjs': '',
      '.claude/skills/one/test/notes.md': '',
    });

    expect(discoverSkillTests(root)).toEqual([]);
  });

  it('returns an empty population for a skill tree holding no test', () => {
    const root = repoWith({ '.claude/skills/one/SKILL.md': '' });

    expect(discoverSkillTests(root)).toEqual([]);
  });

  it('returns an empty population for a repository with no skill tree', () => {
    const root = repoWith({ 'package.json': '{}' });

    expect(discoverSkillTests(root)).toEqual([]);
  });
});

describe('runSkillTests', () => {
  it('succeeds without running anything when the population is empty', async () => {
    const run = vi.fn<(files: readonly string[]) => Promise<number>>();

    await expect(runSkillTests([], run)).resolves.toBe(0);
    expect(run).not.toHaveBeenCalled();
  });

  it('hands the whole population to the runner', async () => {
    const run = vi.fn<(files: readonly string[]) => Promise<number>>().mockResolvedValue(0);

    await expect(runSkillTests(['a.test.mjs', 'b.test.mjs'], run)).resolves.toBe(0);
    expect(run).toHaveBeenCalledWith(['a.test.mjs', 'b.test.mjs']);
  });

  it('fails with the runner exit code when a skill test fails', async () => {
    const run = vi.fn<(files: readonly string[]) => Promise<number>>().mockResolvedValue(1);

    await expect(runSkillTests(['a.test.mjs'], run)).resolves.toBe(1);
  });
});

/**
 * The name the three wiring points have to agree on. Each case below reads its
 * subject out of the file that declares it and asks whether this name is in
 * what it declares, so an unrelated edit to the same line — a flag added to
 * another lane, a reordering, a renamed sibling — moves nothing these cases
 * look at.
 */
const SKILLS_TASK = 'test:skills';

describe('the skills lane wiring', () => {
  it('is a task the root test script runs', () => {
    expect(
      turboRunTargets(manifestScripts('package.json')['test'] ?? ''),
      `the root "test" script no longer runs the ${SKILLS_TASK} task, so the skill tree's own tests are back to running only when a human types them`
    ).toContain(SKILLS_TASK);
  });

  it('is a task this package declares', () => {
    expect(
      Object.keys(tasksIn('scripts/turbo.json')),
      `scripts/turbo.json no longer declares ${SKILLS_TASK}, so turbo has no inputs for it and cannot tell a skill-tree edit from an unrelated one`
    ).toContain(SKILLS_TASK);
  });

  it('is a script this package carries', () => {
    expect(
      Object.keys(manifestScripts('scripts/package.json')),
      `this package no longer carries a ${SKILLS_TASK} script, so the task turbo runs resolves to nothing`
    ).toContain(SKILLS_TASK);
  });
});
