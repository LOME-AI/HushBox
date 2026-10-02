/**
 * The working tree around a checkout: whether anything already stands where the
 * checkout would write, which folders it is about to create, and how to take
 * back what it wrote without touching anything that was there before it.
 */
import { lstatSync, readdirSync, rmdirSync, unlinkSync, type Stats } from 'node:fs';
import path from 'node:path';

/** What stands at `relative` under `root`, without following a final symbolic link. */
export function entryAt(root: string, relative: string): Stats | undefined {
  try {
    return lstatSync(path.join(root, ...relative.split('/')));
  } catch (error) {
    // ENOTDIR: a file stands where a folder on the path would be, so nothing is there.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
}

function ancestors(file: string): string[] {
  const parts = file.split('/').slice(0, -1);
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
}

/**
 * The first path a checkout of `files` would have to replace: anything at all at
 * one of `files`, or anything but a folder where a folder above one would be.
 */
export function firstOccupied(root: string, files: readonly string[]): string | undefined {
  for (const file of files) {
    for (const directory of ancestors(file)) {
      if (entryAt(root, directory)?.isDirectory() === false) return directory;
    }
    if (entryAt(root, file) !== undefined) return file;
  }
  return undefined;
}

/** The folders above `files` that nothing stands at, deepest first. */
export function absentDirectories(root: string, files: readonly string[]): string[] {
  const directories = new Set(files.flatMap((file) => ancestors(file)));
  return [...directories]
    .filter((directory) => entryAt(root, directory) === undefined)
    .toSorted((a, b) => b.split('/').length - a.split('/').length);
}

/** Removes each of `files` that stands as anything but a folder, then each of `directories` left empty. */
export function removePaths(
  root: string,
  files: readonly string[],
  directories: readonly string[]
): void {
  for (const file of files) {
    if (entryAt(root, file)?.isDirectory() === false) {
      unlinkSync(path.join(root, ...file.split('/')));
    }
  }
  for (const directory of directories) {
    const full = path.join(root, ...directory.split('/'));
    if (entryAt(root, directory)?.isDirectory() === true && readdirSync(full).length === 0) {
      rmdirSync(full);
    }
  }
}
