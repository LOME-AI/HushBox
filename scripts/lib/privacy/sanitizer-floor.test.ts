import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { sanitizerFloorFailure } from './sanitizer-floor.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

const workspaceDeclaring = (floor: string): string =>
  ['overrides:', '  kysely: ^0.28.17', `  dompurify: ${floor}`, '  yaml: ^2.9.0', ''].join('\n');

const lockfileResolving = (...versions: string[]): string =>
  ['packages:', ...versions.map((version) => `  dompurify@${version}:`), ''].join('\n');

function repoFile(name: string): string {
  return readFileSync(path.join(REPO_ROOT, name), 'utf8');
}

describe('sanitizerFloorFailure', () => {
  it('accepts a lockfile whose only copy sits at the declared floor', () => {
    expect(sanitizerFloorFailure(workspaceDeclaring('^3.4.14'), lockfileResolving('3.4.14'))).toBe(
      undefined
    );
  });

  it('accepts a copy above the declared floor', () => {
    expect(sanitizerFloorFailure(workspaceDeclaring('^3.4.14'), lockfileResolving('3.5.0'))).toBe(
      undefined
    );
  });

  it('reports a workspace file that declares no floor', () => {
    expect(
      sanitizerFloorFailure('overrides:\n  yaml: ^2.9.0\n', lockfileResolving('3.4.14'))
    ).toMatch(/declares no dompurify floor/u);
  });

  it('reports a lockfile that resolves no copy at all', () => {
    expect(sanitizerFloorFailure(workspaceDeclaring('^3.4.14'), 'packages:\n')).toMatch(
      /resolves no dompurify/u
    );
  });

  it('reports a copy below the declared floor', () => {
    expect(
      sanitizerFloorFailure(workspaceDeclaring('^3.4.14'), lockfileResolving('3.4.10'))
    ).toMatch(/3\.4\.10/u);
  });

  it('reports only the copy below the floor when a satisfying one also resolves', () => {
    expect(
      sanitizerFloorFailure(workspaceDeclaring('^3.4.14'), lockfileResolving('3.4.14', '3.4.9'))
    ).toMatch(/dompurify 3\.4\.9,/u);
  });

  it('names every copy below the floor, lowest first', () => {
    expect(
      sanitizerFloorFailure(
        workspaceDeclaring('^3.4.14'),
        lockfileResolving('3.4.10', '3.4.9', '3.4.10')
      )
    ).toMatch(/dompurify 3\.4\.9, 3\.4\.10,/u);
  });
});

describe('the repository as it stands', () => {
  it('resolves the sanitizer at or above the floor the workspace file declares', () => {
    expect(sanitizerFloorFailure(repoFile('pnpm-workspace.yaml'), repoFile('pnpm-lock.yaml'))).toBe(
      undefined
    );
  });
});
