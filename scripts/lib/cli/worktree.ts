import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { claimSlot } from '../claims/slot-claim.js';
import { portsFor, type ServiceKey } from '../stack/port-plan.js';

interface WorktreeConfig {
  isWorktree: boolean;
  name: string;
  slot: number;
  projectName: string;
  ports: Record<ServiceKey, number>;
}

/** What every compose project this repository starts is named after. */
const PROJECT_PREFIX = 'hushbox';

/**
 * The compose project a slot's stack runs under. Every checkout is named this
 * way, a main checkout included: two clones each have a main checkout, so a
 * name that skipped the slot would put both of them on one project.
 */
export function composeProjectName(slot: number): string {
  return `${PROJECT_PREFIX}-${String(slot)}`;
}

/**
 * Whether a running compose project is one of ours. The bare prefix is the name
 * a main checkout took before slots were claimed, and it is still out there on
 * machines that ran that scheme, so reclamation has to be able to see it.
 */
export function isComposeProjectOfThisRepo(projectName: string): boolean {
  return projectName === PROJECT_PREFIX || projectName.startsWith(`${PROJECT_PREFIX}-`);
}

interface Checkout {
  readonly isWorktree: boolean;
  readonly name: string;
  /**
   * Where git keeps this checkout's own directory. For a main checkout that is
   * `.git`; for a linked worktree it is `<git common dir>/worktrees/<name>`,
   * which git removes in the same act that drops the worktree from
   * `git worktree list`.
   */
  readonly gitDir: string;
}

function readCheckout(dir: string): Checkout {
  const gitPath = path.join(dir, '.git');

  if (statSync(gitPath).isDirectory()) {
    return { isWorktree: false, name: 'main', gitDir: gitPath };
  }

  // .git is a file — this is a worktree
  const content = readFileSync(gitPath, 'utf8').trim();
  const match = /^gitdir:\s+(.+)$/.exec(content);
  if (!match?.[1]) {
    throw new Error(`Invalid .git file: expected "gitdir: <path>", got "${content}"`);
  }

  const gitDir = path.resolve(dir, match[1]);
  return { isWorktree: true, name: path.basename(gitDir), gitDir };
}

/**
 * This checkout's place in the port plan: the slot it holds, the compose
 * project that slot's stack runs under, and the development band of ports it
 * allocates.
 *
 * The slot is claimed rather than derived from the checkout's name. A hash of
 * the name collides — and a collision is two stacks writing one database, one
 * bucket and one Redis keyspace with nothing to say so.
 */
export function getWorktreeConfig(rootDir?: string, registryDir?: string): WorktreeConfig {
  const dir = path.resolve(rootDir ?? process.cwd());
  const checkout = readCheckout(dir);
  const slot = claimSlot({ worktreePath: dir, gitDir: checkout.gitDir, registryDir });

  return {
    isWorktree: checkout.isWorktree,
    name: checkout.name,
    slot,
    projectName: composeProjectName(slot),
    ports: portsFor({ slot, mode: 'development' }),
  };
}
