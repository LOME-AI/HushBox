import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pathToFileURL } from 'node:url';
import { isMainModule } from './is-main.js';

describe('isMainModule', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.argv = originalArgv;
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
    const windowsArgv1 = String.raw`C:\Users\dev\repo\scripts\script.ts`;
    process.argv = ['node.exe', windowsArgv1];
    expect(isMainModule(pathToFileURL(windowsArgv1).href)).toBe(true);
  });
});
