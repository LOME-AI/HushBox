/**
 * The git half of the publication topology: the operations the sync bot
 * performs against the two repositories, and nothing else.
 *
 * Every write here is a fast-forward or it does not happen. Public `main` is
 * append-only by ruleset, and the ruleset is the second line rather than the
 * first — a mirror that reached for `--force` on a divergence would be asking
 * to overwrite work someone else published. So the ancestry question is asked
 * before the push, and the remote's own non-fast-forward rejection is left in
 * place behind it for the case where the head moved between the two.
 *
 * Ancestry is answered by git rather than by a comparison endpoint because
 * these callers already hold a full clone; the endpoint exists for the merge
 * queue's gate, which does not.
 *
 * The bot reaches a remote through a URL carrying its installation token, so
 * no failure here is allowed to surface a command line or a transport message
 * unredacted: a workflow log is world-readable on the public repository.
 */
import { execa, type Result } from 'execa';

/**
 * The identity on any commit this automation mints. Derived from the sync
 * app's own name rather than from a person: a merge the bot performs discloses
 * nothing about who was at a keyboard, because nobody was.
 */
export const SYNC_BOT_IDENTITY = {
  name: 'hushbox-sync[bot]',
  email: 'hushbox-sync[bot]@users.noreply.github.com',
} as const;

/** The one branch either repository publishes. */
export const MAIN = 'main';

/** Where a ref lives, spelled in full so no local branch of the same name can shadow it. */
const branchRef = (branch: string): string => `refs/heads/${branch}`;

/**
 * Masks the userinfo of every URL in a string. A token reaches git inside the
 * remote URL, and git quotes that URL back in transport errors.
 */
export function redactCredentials(text: string): string {
  return text.replaceAll(/\/\/[^/@\s]*@/g, '//***@');
}

/**
 * execa's result type is generic in the options object, and two structurally
 * identical option types are distinct instantiations to the checker — an
 * inline literal here makes the function's own return type unspellable. The
 * named type is what lets the annotation name what the call actually returns.
 */
interface GitRunOptions {
  cwd: string;
  reject: false;
}

const run = async (cwd: string, args: readonly string[]): Promise<Result<GitRunOptions>> => {
  const options: GitRunOptions = { cwd, reject: false };
  return execa('git', [...args], options);
};

/**
 * The subcommand alone. A failure message names what was run and never its
 * arguments, one of which carries the bot's token.
 */
const subcommandOf = (args: readonly string[]): string => args.slice(0, 1).join('');

async function runOrThrow(cwd: string, args: readonly string[]): Promise<string> {
  const result = await run(cwd, args);
  if (result.exitCode !== 0) {
    throw new Error(redactCredentials(`git ${subcommandOf(args)} failed: ${result.stderr}`));
  }
  return result.stdout.trim();
}

export async function git(cwd: string, args: readonly string[]): Promise<string> {
  return runOrThrow(cwd, args);
}

/**
 * Fetches one remote branch and answers the object id it points at. A branch
 * the remote does not carry throws: both repositories carry `main` for as long
 * as the topology exists, so an absent one is a broken precondition rather
 * than a state to route around.
 */
export async function fetchRemoteBranch(cwd: string, url: string, branch: string): Promise<string> {
  await runOrThrow(cwd, ['fetch', '--no-tags', '--quiet', url, branchRef(branch)]);
  return runOrThrow(cwd, ['rev-parse', 'FETCH_HEAD']);
}

/**
 * Whether `descendant` has `ancestor` in its history. Both object ids must
 * already be present locally, which the fetch above guarantees for anything
 * this module compares.
 */
export async function isAncestor(
  cwd: string,
  ancestor: string,
  descendant: string
): Promise<boolean> {
  const result = await run(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  // Anything else is git declining to answer at all — an object neither side
  // has, most often — which is not the same as answering no.
  throw new Error(`Reading ancestry failed with exit code ${String(result.exitCode)}.`);
}

/**
 * Where a branch stands in this clone, read by name. A run can be checked out
 * on any ref it was dispatched from, so nothing here asks `HEAD` what the trunk
 * is: publication decides what it publishes from the branch alone, and a branch
 * the clone does not carry is a broken precondition rather than an answer.
 */
export async function branchHead(cwd: string, branch: string): Promise<string> {
  return runOrThrow(cwd, ['rev-parse', '--verify', branchRef(branch)]);
}

/**
 * A revision's mainline — itself and its first-parent ancestors, newest first,
 * bounded by `limit`. First-parent rather than every reachable commit because
 * these are publication candidates: a commit on the side of a merge is one the
 * branch never stood at, and publishing it would put a tree on the remote that
 * the branch never had.
 *
 * Read from the clone rather than from a listing endpoint so every object id it
 * answers is one the ancestry check and the push can already reach — a head
 * that advances remotely mid-run cannot put a commit this clone lacks into the
 * candidates.
 */
export async function firstParentCommits(
  cwd: string,
  revision: string,
  limit: number
): Promise<string[]> {
  const listed = await runOrThrow(cwd, [
    'rev-list',
    '--first-parent',
    '-n',
    String(limit),
    revision,
  ]);
  return listed.split('\n').filter((line) => line !== '');
}

type PushResult = 'pushed' | 'rejected';

/**
 * A plain push of one commit onto a remote branch. The refspec carries no
 * leading `+` and the command carries no force flag, so the remote decides:
 * anything but a fast-forward comes back rejected and the branch stands.
 */
export async function pushBranch(
  cwd: string,
  url: string,
  commit: string,
  branch: string
): Promise<PushResult> {
  const result = await run(cwd, ['push', url, `${commit}:${branchRef(branch)}`]);
  return result.exitCode === 0 ? 'pushed' : 'rejected';
}

type FastForwardOutcome =
  | { status: 'already-current'; head: string }
  | { status: 'advanced'; head: string }
  /** `head` is where the remote stands, which the target does not descend from. */
  | { status: 'refused'; head: string };

/**
 * Moves a remote branch to `target`, or reports why it did not. The ancestry
 * check is what makes a refusal diagnosable — the remote's own rejection says
 * only that something was wrong — and the push that follows is still the
 * unforced one, so a head that moves in between is refused by the remote.
 */
export async function fastForwardRemoteBranch(
  cwd: string,
  url: string,
  branch: string,
  target: string
): Promise<FastForwardOutcome> {
  const head = await fetchRemoteBranch(cwd, url, branch);
  if (head === target) return { status: 'already-current', head };
  if (!(await isAncestor(cwd, head, target))) return { status: 'refused', head };
  if ((await pushBranch(cwd, url, target, branch)) === 'rejected') {
    return { status: 'refused', head };
  }
  return { status: 'advanced', head: target };
}
