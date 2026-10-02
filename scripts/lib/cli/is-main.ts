import { fileURLToPath } from 'node:url';

import { canonicalPath } from '../canonical-path.ts';

/**
 * Tests whether a module is being executed as the main entry point.
 *
 * Both sides are canonicalised because they arrive by different routes: the
 * loader resolves a module URL through every symbolic link, while `argv[1]` is
 * the path as typed. A checkout reached through a link therefore gives one
 * file two spellings, and a raw comparison answers false for a command the
 * user did invoke — which every caller reads as "not the entry point" and
 * turns into an exit 0 that ran no body. Canonicalising through the shared
 * helper also handles the Windows separator the old `file://` concatenation
 * fell over, and inherits its failure: a path the filesystem refuses raises
 * rather than resolving to some other file's answer.
 */
export function isMainModule(importMetaUrl: string): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return canonicalPath(fileURLToPath(importMetaUrl)) === canonicalPath(argv1);
}
