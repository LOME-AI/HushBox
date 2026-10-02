import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalPath } from './canonical-path.js';

/**
 * Every path the walk has to try before it gives up, from the input down to the
 * filesystem root — derived rather than listed, so a fixture moved to another
 * depth needs nothing here changed.
 */
function ancestorsToRoot(from: string): string[] {
  const walked = [from];
  for (let head = from; path.dirname(head) !== head; head = path.dirname(head)) {
    walked.push(path.dirname(head));
  }
  return walked;
}

describe('canonicalPath', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'hushbox-canonical-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('gives one spelling to a directory reached through a symlinked ancestor', () => {
    const real = path.join(root, 'real');
    mkdirSync(path.join(real, 'checkout'), { recursive: true });
    symlinkSync(real, path.join(root, 'link'), 'dir');

    expect(canonicalPath(path.join(root, 'link', 'checkout'))).toBe(
      canonicalPath(path.join(real, 'checkout'))
    );
  });

  it('canonicalises the part of a path that exists when the leaf does not yet', () => {
    const real = path.join(root, 'real');
    mkdirSync(real, { recursive: true });
    symlinkSync(real, path.join(root, 'link'), 'dir');

    expect(canonicalPath(path.join(root, 'link', 'not-created-yet.lock'))).toBe(
      path.join(canonicalPath(real), 'not-created-yet.lock')
    );
  });

  it('makes a relative path absolute', () => {
    expect(path.isAbsolute(canonicalPath('some/relative/path'))).toBe(true);
  });

  it('resolves a path no part of which exists', () => {
    const absent = path.join(root, 'gone', 'deeper', 'still');
    rmSync(root, { recursive: true, force: true });

    expect(canonicalPath(absent)).toBe(path.resolve(absent));
  });

  it('walks past a segment whose parent is a file rather than a directory', () => {
    const file = path.join(root, 'plain-file');
    mkdirSync(root, { recursive: true });
    writeFileSync(file, '', 'utf8');

    expect(canonicalPath(path.join(file, 'below'))).toBe(path.join(canonicalPath(file), 'below'));
  });

  it('re-raises a resolution failure that is not an absent path', () => {
    // A pair of symbolic links naming each other is a path the filesystem
    // itself refuses: `realpathSync` answers ELOOP, which is neither of the two
    // absent-path codes the walk swallows. The error code is asserted because
    // it is the evidence the real resolver ran.
    const cycle = path.join(root, 'cycle');
    const partner = path.join(root, 'partner');
    symlinkSync(partner, cycle, 'dir');
    symlinkSync(cycle, partner, 'dir');

    let raised: NodeJS.ErrnoException | undefined;
    try {
      canonicalPath(cycle);
    } catch (error) {
      raised = error as NodeJS.ErrnoException;
    }

    expect(raised?.code).toBe('ELOOP');
  });

  it('stops at the filesystem root when no ancestor resolves', async () => {
    const absent = path.resolve(path.join(root, 'below'));
    const refused: string[] = [];

    // The terminating guard fires only when a resolution fails at the
    // filesystem root, which no real filesystem does, so this is the one case
    // that needs a resolver refusing every directory. Registering the stub is
    // not enough to reach the helper with it: the shared vitest setup file
    // instantiates this module (through the claim registry it provisions
    // databases with) before any test file's mock is registered, so the cached
    // instance keeps its real binding and a case written against `vi.mock`
    // alone asserts nothing about the code it names. Clearing the module
    // registry and importing again is what puts a fresh instance in front of
    // the stub; the recorded call list below is the evidence that it did.
    vi.doMock('node:fs', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:fs')>()),
      realpathSync: (target: string): string => {
        refused.push(target);
        const error: NodeJS.ErrnoException = new Error('every directory refuses to resolve');
        error.code = 'ENOENT';
        throw error;
      },
    }));
    vi.resetModules();

    try {
      const { canonicalPath: overARefusingResolver } = await import('./canonical-path.js');

      expect(overARefusingResolver(absent)).toBe(absent);
      expect(refused).toEqual(ancestorsToRoot(absent));
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });
});
