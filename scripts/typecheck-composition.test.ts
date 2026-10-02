import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { getWorkspacePaths } from './lib/cli/workspaces.js';
import { manifestScripts } from './lib/root-manifest.js';
import { DECLARATION_END } from './run-checks.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

const RUNNER = 'run-checks.ts';

/**
 * Directories known to compose their typecheck through the shared runner today.
 * The sweep finds them on its own; this is the non-vacuity floor. Without it, a
 * discovery bug — a workspace pattern that stops expanding, a renamed manifest
 * key — narrows the swept set and the case "closes every composed declaration,
 * so an appended argument is refused rather than run" passes over nothing.
 */
const KNOWN_COMPOSED: readonly string[] = ['.', 'apps/web', 'apps/marketing'];

function typecheckScript(directory: string): string | undefined {
  return manifestScripts(path.join(directory, 'package.json'))['typecheck'];
}

const SWEPT_DIRECTORIES = ['.', ...getWorkspacePaths(REPO_ROOT)];

const COMPOSED_DIRECTORIES = SWEPT_DIRECTORIES.filter((directory) =>
  (typecheckScript(directory) ?? '').includes(RUNNER)
);

describe('composed typecheck scripts', () => {
  it('sweeps the workspace and still reaches every package known to compose its typecheck', () => {
    const missing = KNOWN_COMPOSED.filter((directory) => !COMPOSED_DIRECTORIES.includes(directory));

    expect(
      missing,
      `workspace discovery no longer reaches ${missing.join(', ')}, so the terminator assertion below sweeps less than it claims`
    ).toEqual([]);
  });

  it('closes every composed declaration, so an appended argument is refused rather than run', () => {
    const unterminated = COMPOSED_DIRECTORIES.filter(
      (directory) => !(typecheckScript(directory) ?? '').trimEnd().endsWith(DECLARATION_END)
    );

    expect(
      unterminated,
      `${unterminated.join(', ')}: the "typecheck" script composes lanes through scripts/${RUNNER} but does not close the declaration with "${DECLARATION_END}". A package manager appends a caller's arguments to the end of the whole script line, so they land on whichever lane is written last — a direct compiler invocation, which rejects them only after every earlier lane has run. Closing the declaration makes the run refuse them first, naming the lane to put them on.`
    ).toEqual([]);
  });
});
