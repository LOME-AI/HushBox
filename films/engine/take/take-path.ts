import path from 'node:path';

/** Where a take path is read from: the working directory, and the films package root. */
interface TakeRoots {
  cwd: string;
  root: string;
}

function isInside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * A take's id, its POSIX path under the films package, from the path a person
 * typed: read from the working directory when it lands inside the package, and
 * from the package root otherwise, so `films/<film>/rounds/…` from the
 * repository and `<film>/rounds/…` both name the take.
 */
export function takeIdOf(argument: string, { cwd, root }: TakeRoots): string {
  const fromCwd = path.resolve(cwd, argument);
  const resolved = isInside(root, fromCwd) ? fromCwd : path.resolve(root, argument);
  return path.relative(root, resolved).split(path.sep).join('/');
}
