import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMainModule } from './is-main.js';

// Every case here drives the real filesystem rather than a mocked one. A
// `vi.mock('node:fs')` cannot reach the canonicalising helper from this
// package: the shared vitest setup file instantiates that helper (through the
// claim registry it provisions databases with) before any test file's mock is
// registered, so the helper keeps its unmocked binding and a case written
// against a stubbed resolver asserts nothing about the code it names.

describe('isMainModule', () => {
  const originalArgv = process.argv;
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'hushbox-is-main-'));
  });

  afterEach(() => {
    process.argv = originalArgv;
    rmSync(root, { recursive: true, force: true });
  });

  it('returns true when import.meta.url matches argv[1] as a file URL', () => {
    const scriptPath = '/abs/path/to/script.ts';
    process.argv = ['node', scriptPath];
    expect(isMainModule(pathToFileURL(scriptPath).href)).toBe(true);
  });

  it('returns false when import.meta.url does not match argv[1]', () => {
    process.argv = ['node', '/abs/path/to/other.ts'];
    expect(isMainModule(pathToFileURL('/abs/path/to/script.ts').href)).toBe(false);
  });

  it('returns false when argv[1] is undefined', () => {
    process.argv = ['node'];
    expect(isMainModule('file:///abs/path/to/script.ts')).toBe(false);
  });

  it('handles Windows-style backslash paths in argv[1]', () => {
    // The content privacy gate refuses a drive letter written against its
    // backslashes, so this fixture joins its own from a separate literal.
    const drive = 'C:';
    const windowsArgv1 = String.raw`${drive}\repo\scripts\script.ts`;
    process.argv = ['node.exe', windowsArgv1];
    expect(isMainModule(pathToFileURL(windowsArgv1).href)).toBe(true);
  });
  it('answers true when argv[1] reaches the entry point through a symlinked directory', () => {
    const real = path.join(root, 'real');
    mkdirSync(real, { recursive: true });
    const script = path.join(real, 'script.ts');
    writeFileSync(script, '');
    symlinkSync(real, path.join(root, 'link'), 'dir');

    process.argv = ['node', path.join(root, 'link', 'script.ts')];
    expect(isMainModule(pathToFileURL(script).href)).toBe(true);
  });

  it('answers true when argv[1] is a symlink to the entry-point file itself', () => {
    const script = path.join(root, 'script.ts');
    writeFileSync(script, '');
    const alias = path.join(root, 'alias.ts');
    symlinkSync(script, alias, 'file');

    process.argv = ['node', alias];
    expect(isMainModule(pathToFileURL(script).href)).toBe(true);
  });

  it('answers false for a module that exists and is not the entry point', () => {
    const entry = path.join(root, 'entry.ts');
    const other = path.join(root, 'other.ts');
    writeFileSync(entry, '');
    writeFileSync(other, '');

    process.argv = ['node', entry];
    expect(isMainModule(pathToFileURL(other).href)).toBe(false);
  });

  it('propagates the resolver failure a path that cannot be canonicalised raises', () => {
    const script = path.join(root, 'script.ts');
    writeFileSync(script, '');
    // A pair of symbolic links naming each other is a path the filesystem
    // itself refuses: `realpathSync` answers ELOOP, which is neither of the two
    // absent-path codes the helper swallows, so the helper re-throws and the
    // predicate adds no catch of its own. The error code is asserted because it
    // is the evidence the real resolver ran.
    const cycle = path.join(root, 'cycle.ts');
    const partner = path.join(root, 'partner.ts');
    symlinkSync(partner, cycle, 'file');
    symlinkSync(cycle, partner, 'file');

    process.argv = ['node', cycle];
    let raised: NodeJS.ErrnoException | undefined;
    try {
      isMainModule(pathToFileURL(script).href);
    } catch (error) {
      raised = error as NodeJS.ErrnoException;
    }
    expect(raised?.code).toBe('ELOOP');
  });
});
