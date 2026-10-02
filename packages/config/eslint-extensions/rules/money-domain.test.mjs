// What the derivation does when a module it was handed cannot be read.
//
// The unreadable-input shapes this file covers are reachable from the vocabulary
// list alone — a renamed or deleted module leaves a path the program never
// loads, and a module that declares nothing at top level is a script rather than
// a module and has no symbol. No such input is a lint finding: the derivation
// gates the vocabulary list, so an unreadable input means the gate cannot answer
// at all, and the fail-fast outcome is an error naming the file rather than a
// checker crash whose message names nothing.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { withScratchDirectory } from '../../../../scripts/lib/scratch-directory.ts';
import { moneyModuleExports } from './money-domain.mjs';

const FIXTURE_PREFIX = 'hushbox-money-domain-unreadable-';

/**
 * Runs one test against a fresh fixture tree, staged outside the repository.
 *
 * A fixture tree beside this file is a directory every repo-wide scanner
 * enumerates, so one that exists between a test's setup and its teardown is
 * read as repository source or crashes the scan listing it. Location is what
 * closes that, not timing. Both shapes the suite needs are staged up front: the
 * script-only module on disk, and the absent one by never writing it.
 * @param {(shapes: { absent: string, scriptOnly: string }) => void} body
 * @returns {() => Promise<void>}
 */
function withFixtureTree(body) {
  return () =>
    withScratchDirectory(FIXTURE_PREFIX, (fixtureDir) => {
      const scriptOnly = path.join(fixtureDir, 'script-only.ts');
      // No import and no export: a global script, which the checker gives no
      // module symbol.
      writeFileSync(scriptOnly, 'const unexported = 1;\n');
      body({ absent: path.join(fixtureDir, 'never-written.ts'), scriptOnly });
      return Promise.resolve();
    });
}

describe('a module the derivation cannot read', () => {
  it(
    'names the file the program never loaded',
    withFixtureTree(({ absent }) => {
      expect(() => moneyModuleExports([absent])).toThrow(absent);
    })
  );

  it(
    'names the file that declares no module',
    withFixtureTree(({ scriptOnly }) => {
      expect(() => moneyModuleExports([scriptOnly])).toThrow(scriptOnly);
    })
  );
});
