import path from 'node:path';
import { execa } from 'execa';
import { canonicalPath } from '../canonical-path.js';

/**
 * Git common directory of the repository `dir` sits in, or null when the
 * directory is gone or is not a checkout at all. Not a swallowed failure: a
 * recorded working directory that no longer resolves is the ordinary input this
 * answers "unknown" for, and an unknown owner is never reaped.
 *
 * Two worktrees of one clone share a common directory and a different clone of
 * the same repository has its own, so comparing common directories is what
 * tells a sibling clone's stack apart from an orphan.
 *
 * Canonical, because this value is what a run claim records as its checkout's
 * identity and every one of those comparisons is a string comparison. Git
 * resolves the question itself — it prints a relative answer for a main
 * checkout — so anchoring that answer to the caller's own spelling is what
 * would hand one checkout two identities on a machine whose checkout is
 * reached through a symlink.
 */
export async function resolveGitCommonDir(dir: string): Promise<string | null> {
  let stdout: string;
  try {
    ({ stdout } = await execa('git', ['-C', dir, 'rev-parse', '--git-common-dir']));
  } catch {
    return null;
  }
  const printed = stdout.trim();
  if (!printed) return null;
  // git prints ".git" for a main worktree and an absolute path for a linked one.
  return canonicalPath(path.resolve(dir, printed));
}
