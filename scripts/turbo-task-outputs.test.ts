import { describe, it, expect } from 'vitest';

import { coverageDirectory } from './run-package-tests.js';
import {
  CONFIG_FILE,
  KNOWN_PACKAGE_CONFIGS,
  packageConfigFiles,
  tasksIn,
} from './turbo-configs.js';

/**
 * The configs that exist today: the shared package-level floor, plus the root
 * config, which `configFiles` adds unconditionally rather than discovering.
 */
const KNOWN_CONFIGS: readonly string[] = [CONFIG_FILE, ...KNOWN_PACKAGE_CONFIGS];

/**
 * Where one tree's run coverage directories sit, relative to that tree — read
 * from the runner that creates them rather than spelled again here, so a move
 * carries this rule with it.
 */
const COVERAGE_ROOT = coverageDirectory('.');

/** Every task runner config: the repository's own, and each workspace override. */
function configFiles(): string[] {
  return [CONFIG_FILE, ...packageConfigFiles()];
}

/** Every declared task, keyed `<config>#<task>`, with the globs it archives. */
function taskOutputs(): Record<string, readonly string[]> {
  return Object.fromEntries(
    configFiles().flatMap((file) =>
      Object.entries(tasksIn(file)).map(
        ([task, shape]) => [`${file}#${task}`, shape.outputs ?? []] as const
      )
    )
  );
}

/**
 * Whether an output glob archives anything under `dir`. A glob's literal prefix
 * is what it is rooted at — everything past the first `*` matches at any depth,
 * so a prefix at, above or inside `dir` reaches it. `$TURBO_ROOT$` anchors an
 * entry at the repository root, where the batch coordinator keeps its own
 * coverage; a `!` entry excludes rather than archives.
 */
function archives(entry: string, dir: string): boolean {
  if (entry.startsWith('!')) return false;
  const rooted = entry.replace(/^\$TURBO_ROOT\$\//, '');
  const literal = rooted.split('*')[0] ?? '';
  const base = literal.replace(/^\.\//, '').replace(/\/+$/, '');
  return base === '' || base === dir || base.startsWith(`${dir}/`) || dir.startsWith(`${base}/`);
}

const outputsByTask = taskOutputs();

describe('turbo task outputs', () => {
  it('finds the root config and every workspace override', () => {
    expect(configFiles()).toEqual(expect.arrayContaining([...KNOWN_CONFIGS]));
  });

  it('finds the test task, which is what the rule below is about', () => {
    expect(Object.keys(outputsByTask)).toContain(`${CONFIG_FILE}#test`);
  });

  describe.each(Object.entries(outputsByTask))('%s', (_task, outputs) => {
    it('archives nothing under the directory a run writes its coverage into', () => {
      // A run's coverage directory is named after the claim the run holds and
      // removed when that run ends, so there is never a version of it worth
      // archiving. Declared as an output, the only thing the cache can still do
      // with it is restore one run's directory into a checkout another run is
      // live in — the same foreign-resource defect the per-run naming exists to
      // remove, arriving by way of the cache instead.
      expect(outputs.filter((entry) => archives(entry, COVERAGE_ROOT))).toEqual([]);
    });
  });
});
