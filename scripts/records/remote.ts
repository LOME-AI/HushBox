import type { Repositories } from '../configure-git-clone.js';

/** The records repository's clone URL. */
export function recordsRemote(repositories: Repositories): string {
  return `https://github.com/${repositories.recordsRepo}.git`;
}
