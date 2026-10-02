import { realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * One absolute spelling per directory, for every path an ownership decision
 * stores, compares or looks up.
 *
 * A checkout reached through a symlink has two absolute spellings, and a claim
 * id is a string comparison: two spellings of one directory are two resources
 * to a registry, so one can be claimed while the other is swept. Resolving is
 * not enough — `path.resolve` removes `.`, `..` and relativity but keeps every
 * link in place — so this asks the filesystem which directory the path names.
 *
 * The path need not exist. A claim is taken on a lock file before anything
 * creates it, so the longest existing prefix is canonicalised and the rest is
 * re-appended; a path nothing on which exists is merely resolved, which is the
 * best answer available and the same one every caller would reach alone.
 */
export function canonicalPath(input: string): string {
  const absolute = path.resolve(input);
  const tail: string[] = [];
  let head = absolute;

  for (;;) {
    try {
      return path.join(realpathSync(head), ...tail);
    } catch (error) {
      // ENOTDIR belongs here beside ENOENT: a segment under a regular file is
      // as absent as one under nothing, and both are ordinary for a path whose
      // leaf has not been created yet.
      const { code } = error as NodeJS.ErrnoException;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = path.dirname(head);
      if (parent === head) return absolute;
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}
