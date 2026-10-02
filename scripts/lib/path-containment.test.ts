import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { isOutsideRoot } from './path-containment.js';

describe('isOutsideRoot', () => {
  it('counts a sibling of the root as outside it', () => {
    expect(isOutsideRoot(path.posix, '/repo', '/scratch/fix')).toBe(true);
  });

  it('counts a path under the root as inside it', () => {
    expect(isOutsideRoot(path.posix, '/repo', '/repo/scripts')).toBe(false);
  });

  it('counts the root itself as inside it', () => {
    expect(isOutsideRoot(path.posix, '/repo', '/repo')).toBe(false);
  });

  it('counts a path under the root as inside it on Windows', () => {
    expect(isOutsideRoot(path.win32, 'C:/repo', 'C:/repo/scripts')).toBe(false);
  });

  // Injecting the `win32` flavour proves which branch the predicate selects
  // for a target on another drive. It is evidence about the selection, never
  // about how Windows itself behaves. The roots are forward-slashed, a
  // spelling `path.win32` and the Win32 API both take, because the
  // backslashed one is a shape the privacy gate reads as somebody's machine.
  it('counts a target on another Windows drive as outside the root', () => {
    expect(isOutsideRoot(path.win32, 'D:/repo', 'C:/scratch/fix')).toBe(true);
  });

  it('accepts the host path flavour', () => {
    expect(isOutsideRoot(path, path.join('repo'), path.join('repo', 'scripts'))).toBe(false);
  });
});
