/**
 * The inbound sync: public `main` → staging `main`.
 *
 * A contributor's pull request merges natively on the public repository, which
 * is what preserves the merged badge and the contribution credit. That merge
 * lands on public alone, so staging has to be brought back over it or the next
 * outbound mirror refuses everything as a non-fast-forward.
 *
 * Divergence is the ordinary case rather than the broken one. The merge
 * queue's alignment gate guarantees only that staging held the *previous*
 * public head; a maintainer who pushed since means the queue's new commit is
 * no descendant of staging. So this fast-forwards where it can and mints a
 * merge where it cannot — never a rebase, which would rewrite commits public
 * has already published, and never a force.
 *
 * A merge it mints is a commit like any other, so it is stamped at day
 * resolution through the same rewrite the commit hooks use. Publication that
 * hid the maintainer's clock while disclosing the bot's would be no publication
 * privacy at all.
 */
import { execa } from 'execa';
import { normalizeHeadCommitDate, type NormalizeOutcome } from '../normalize-commit-date.js';
import { isMainModule } from '../lib/cli/is-main.js';
import { readCommandLine, type CommandSpec } from '../lib/cli/command-line.js';
import { runMain } from '../lib/cli/run-main.js';
import { readRepositories } from '../configure-git-clone.js';
import { syncBotToken } from '../lib/publication/sync-bot-credential.js';
import {
  MAIN,
  SYNC_BOT_IDENTITY,
  branchHead,
  fetchRemoteBranch,
  git,
  isAncestor,
  pushBranch,
  redactCredentials,
} from '../lib/publication/git.js';

/** Named so a reader of staging's history can see which direction a merge came from. */
const MERGE_MESSAGE = 'Merge public main into staging';

/**
 * The scratch ref the merge is built on. Deliberately not `main`: this clone's
 * `main` is where public's trunk is read from, so building on it would leave a
 * later read of the trunk answering with staging's head instead — a second run
 * on the same checkout would then call an unsynced public commit already
 * carried. Nothing pushes this ref; only the commit it lands on travels.
 */
const MERGE_BRANCH = 'inbound-merge';

/**
 * The stamping is load-bearing rather than cosmetic: a merge left at its
 * original resolution carries the runner's clock, and the next mirror
 * publishes it. Anything but a commit that now reads at day resolution — the
 * rewrite refusing, or a HEAD it declined to touch — stops the sync before it
 * pushes.
 */
export function assertStamped(outcome: NormalizeOutcome): void {
  if (outcome.status === 'normalized' || outcome.status === 'conforming') return;
  throw new Error(`The merge commit could not be stamped at day resolution: ${outcome.status}`);
}

interface InboundRequest {
  /** A clone of public, checked out with a clean work tree. */
  readonly cwd: string;
  /** The staging repository's git URL, carrying the bot credential. */
  readonly stagingUrl: string;
}

export type InboundOutcome =
  | { status: 'already-contained'; sha: string }
  | { status: 'fast-forwarded'; sha: string }
  | { status: 'merged'; sha: string }
  | { status: 'conflicted' }
  /** Git would not start the merge at all; `reason` is what it said, redacted. */
  | { status: 'declined'; reason: string }
  /** `stagingHead` is where staging stood when this run read it. */
  | { status: 'rejected'; stagingHead: string };

/**
 * Whether a merge is actually under way. Git exits non-zero both for a merge it
 * started and could not finish and for one it declined to start, and `merge
 * --abort` fails on the second — so the distinction has to be read from the
 * repository rather than inferred from the exit code.
 */
async function isMergeInProgress(cwd: string): Promise<boolean> {
  const result = await execa('git', ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], {
    cwd,
    reject: false,
  });
  return result.exitCode === 0;
}

type MergeResult =
  | { status: 'merged'; sha: string }
  | { status: 'conflicted' }
  | { status: 'declined'; reason: string };

/**
 * Builds the merge commit, or reports why there is none. A conflicted merge is
 * abandoned rather than half-resolved: a machine picking sides in someone
 * else's conflict is how the two repositories would silently stop matching.
 */
async function mergeOnto(
  cwd: string,
  stagingHead: string,
  publicCommit: string
): Promise<MergeResult> {
  await git(cwd, ['checkout', '--quiet', '-B', MERGE_BRANCH, stagingHead]);
  const merge = await execa(
    'git',
    [
      '-c',
      `user.name=${SYNC_BOT_IDENTITY.name}`,
      '-c',
      `user.email=${SYNC_BOT_IDENTITY.email}`,
      'merge',
      '--no-ff',
      '--no-edit',
      '-m',
      MERGE_MESSAGE,
      publicCommit,
    ],
    { cwd, reject: false }
  );
  if (merge.exitCode !== 0) {
    if (!(await isMergeInProgress(cwd))) {
      return { status: 'declined', reason: redactCredentials(merge.stderr.trim()) };
    }
    await git(cwd, ['merge', '--abort']);
    return { status: 'conflicted' };
  }
  assertStamped(await normalizeHeadCommitDate(cwd));
  return { status: 'merged', sha: await git(cwd, ['rev-parse', 'HEAD']) };
}

export async function syncInbound(request: InboundRequest): Promise<InboundOutcome> {
  // Public's trunk by name, never the checkout's own head: a dispatch can start
  // this run from any ref, and carrying that ref's tip into staging would carry
  // work the queue never landed on public `main`.
  const publicCommit = await branchHead(request.cwd, MAIN);
  const stagingHead = await fetchRemoteBranch(request.cwd, request.stagingUrl, MAIN);
  if (await isAncestor(request.cwd, publicCommit, stagingHead)) {
    return { status: 'already-contained', sha: stagingHead };
  }

  if (await isAncestor(request.cwd, stagingHead, publicCommit)) {
    return (await pushBranch(request.cwd, request.stagingUrl, publicCommit, MAIN)) === 'rejected'
      ? { status: 'rejected', stagingHead }
      : { status: 'fast-forwarded', sha: publicCommit };
  }

  const merge = await mergeOnto(request.cwd, stagingHead, publicCommit);
  if (merge.status !== 'merged') return merge;

  if ((await pushBranch(request.cwd, request.stagingUrl, merge.sha, MAIN)) === 'rejected') {
    return { status: 'rejected', stagingHead };
  }
  return { status: 'merged', sha: merge.sha };
}

/** The outcomes a human has to act on. */
export function isInboundFailure(outcome: InboundOutcome): boolean {
  return (
    outcome.status === 'conflicted' ||
    outcome.status === 'declined' ||
    outcome.status === 'rejected'
  );
}

export function describeInboundOutcome(outcome: InboundOutcome): string {
  if (outcome.status === 'already-contained') {
    return `Staging ${MAIN} already carries the public commit at ${outcome.sha}; nothing to sync.`;
  }
  if (outcome.status === 'fast-forwarded') {
    return `Fast-forwarded staging ${MAIN} to ${outcome.sha}.`;
  }
  if (outcome.status === 'merged') {
    return `Merged public ${MAIN} into staging ${MAIN} at ${outcome.sha}.`;
  }
  if (outcome.status === 'conflicted') {
    return (
      `Public ${MAIN} conflicts with staging ${MAIN}. The merge was abandoned and nothing was ` +
      'pushed. Resolve it in a staging clone and push, then re-run this sync.'
    );
  }
  if (outcome.status === 'declined') {
    return (
      `Git would not merge public ${MAIN} into staging ${MAIN} at all: ${outcome.reason}. ` +
      'Nothing was pushed. The two repositories are not the pair this topology assumes; ' +
      'establish that before re-running this sync.'
    );
  }
  return (
    `Staging ${MAIN} refused the push; it stood at ${outcome.stagingHead} when this run read it ` +
    'and has moved since. Re-run this sync.'
  );
}

export const COMMAND_LINE = {
  command: 'tsx scripts/publication/sync-inbound.ts',
  summary: "Syncs the public repository's trunk into staging.",
  flags: [],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

/* v8 ignore start -- CLI entry point, exercised through CI */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    if (readCommandLine(COMMAND_LINE, process.argv.slice(2)) === null) return;
    const repositories = await readRepositories();
    const token = await syncBotToken(
      'The inbound sync',
      repositories.publicRepo,
      process.env,
      fetch
    );
    const outcome = await syncInbound({
      cwd: process.cwd(),
      stagingUrl: `https://x-access-token:${token}@github.com/${repositories.stagingRepo}.git`,
    });
    const line = describeInboundOutcome(outcome);
    if (isInboundFailure(outcome)) {
      console.error(line);
      return 1;
    }
    console.log(line);
    return 0;
  });
}
/* v8 ignore stop */
