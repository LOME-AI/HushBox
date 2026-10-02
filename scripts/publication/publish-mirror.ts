/**
 * The outbound mirror: staging `main` → public `main`.
 *
 * Publication is decoupled from work. The workflow fires on a pinned daily
 * schedule so the public repository's event stream discloses the schedule and
 * nothing about when anyone was at a keyboard, and this script decides only
 * *what* that firing publishes.
 *
 * What it publishes is the newest commit on staging's trunk that staging's
 * trusted run proved — the newest `ci.yml` push run on `main` for that commit,
 * judged by {@link isBorrowable} — and nothing unproven is ever published, which
 * is what makes public `main` green by construction rather than by discipline.
 * The predicate is the one a public push borrows staging's verdict by, so every
 * published commit is one whose proof can be borrowed. A red head therefore
 * delays only the commits after the last green one — so long as that commit is
 * within {@link MIRROR_SCAN_DEPTH} of the trunk. When it sits further back the
 * walk never sees it and nothing publishes at all, while the run still reports
 * nothing green and exits successfully, so that stall reads exactly like a day
 * with nothing to publish. Publication also halts loudly: a staging read that
 * fails — a refused scoped mint, a refused or malformed run or job listing —
 * throws, so the run exits non-zero having published nothing rather than
 * reading as a quiet day.
 *
 * The trunk is read by branch name, never from the checkout's own head: the
 * destination is pinned to `main`, a dispatch can start this run from any ref,
 * and publishing that ref's tip onto public would publish unmerged work
 * irreversibly.
 *
 * Candidates stop at what public already carries, so an unfinished or red head
 * is an ordinary day with nothing to publish. Refusal is reserved for public
 * holding a commit the trunk does not — the one state a human has to resolve.
 *
 * Candidates are read from the clone and greenness from the Actions API: the
 * clone is the only place that can answer which objects this run can actually
 * push, and the API is the only place that knows how the suite concluded.
 *
 * Every refusal here is loud and leaves public untouched. Public `main` is
 * append-only, and a mirror that resolved a divergence by force would be
 * overwriting whatever the inbound sync had failed to carry back.
 */
import { isMainModule } from '../lib/cli/is-main.js';
import { readCommandLine, type CommandSpec } from '../lib/cli/command-line.js';
import { runMain } from '../lib/cli/run-main.js';
import { readRepositories, type Repositories } from '../configure-git-clone.js';
import { syncBotToken } from '../lib/publication/sync-bot-credential.js';
import {
  isBorrowable,
  readTrustedRun,
  stagingRunReaderToken,
  type RepositoryApi,
} from '../lib/publication/api.js';
import { BORROWED_JOBS, TRUSTED_WORKFLOW_FILE } from '../lib/publication/borrowed-jobs.js';
import {
  MAIN,
  branchHead,
  fastForwardRemoteBranch,
  fetchRemoteBranch,
  firstParentCommits,
  isAncestor,
} from '../lib/publication/git.js';

/**
 * How far back a single run will look for a publishable commit. Generous
 * against any plausible day of work, and bounded so a repository whose suite
 * has been red for a long time costs one run a bounded number of reads rather
 * than a walk of the whole history.
 */
export const MIRROR_SCAN_DEPTH = 50;

interface MirrorRequest {
  /** A full clone of staging, checked out at the branch to publish. */
  readonly cwd: string;
  /** The public repository's git URL, carrying the bot credential. */
  readonly publicUrl: string;
  /** Staging's REST surface, where the suite's verdict is read. */
  readonly staging: RepositoryApi;
}

const CALLER = 'The outbound mirror';

/**
 * Two tokens from the one app: the unscoped one, which alone may push public
 * `main`, goes only into the public URL, and staging's runs are read under the
 * token narrowed to Actions read on staging. The read path is the borrow's, so
 * a failure there fails this run where an auditor sees it.
 */
export async function mirrorRequest(
  cwd: string,
  repositories: Repositories,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch
): Promise<MirrorRequest> {
  const pushToken = await syncBotToken(CALLER, repositories.stagingRepo, env, fetchImpl);
  const readToken = await stagingRunReaderToken(CALLER, repositories.stagingRepo, env, fetchImpl);
  return {
    cwd,
    publicUrl: `https://x-access-token:${pushToken}@github.com/${repositories.publicRepo}.git`,
    staging: { fetchImpl, token: readToken, repository: repositories.stagingRepo },
  };
}

export type MirrorOutcome =
  | { status: 'published'; sha: string }
  | { status: 'already-current'; sha: string }
  | { status: 'nothing-green' }
  | { status: 'refused'; publicHead: string; target: string };

async function selectPublishable(
  request: MirrorRequest,
  trunk: string,
  publicHead: string
): Promise<string | null> {
  const candidates = await firstParentCommits(request.cwd, trunk, MIRROR_SCAN_DEPTH);
  for (const sha of candidates) {
    // Newest first, so the first candidate public's head is not an ancestor of
    // is one public is already at or past — and so is everything older.
    if (!(await isAncestor(request.cwd, publicHead, sha))) return null;
    const run = await readTrustedRun(request.staging, TRUSTED_WORKFLOW_FILE, sha);
    if (isBorrowable(run, sha, BORROWED_JOBS)) return sha;
  }
  return null;
}

export async function mirror(request: MirrorRequest): Promise<MirrorOutcome> {
  const trunk = await branchHead(request.cwd, MAIN);
  const publicHead = await fetchRemoteBranch(request.cwd, request.publicUrl, MAIN);

  // Asked before selection rather than after it: a candidate set bounded by
  // public's head is empty when the two have diverged, and an empty set is
  // indistinguishable from a day whose commits are all red.
  if (!(await isAncestor(request.cwd, publicHead, trunk))) {
    return { status: 'refused', publicHead, target: trunk };
  }

  const target = await selectPublishable(request, trunk, publicHead);
  if (target === null) return { status: 'nothing-green' };

  // The fast-forward re-reads public's head, which is what catches it having
  // moved between the read above and this push.
  const outcome = await fastForwardRemoteBranch(request.cwd, request.publicUrl, MAIN, target);
  if (outcome.status === 'refused') {
    return { status: 'refused', publicHead: outcome.head, target };
  }
  return {
    status: outcome.status === 'advanced' ? 'published' : 'already-current',
    sha: target,
  };
}

/**
 * The only outcome that is a run failure. Nothing green yet and nothing to do
 * are both ordinary days.
 */
export function isMirrorRefusal(outcome: MirrorOutcome): boolean {
  return outcome.status === 'refused';
}

export function describeMirrorOutcome(outcome: MirrorOutcome): string {
  if (outcome.status === 'published') {
    return `Published ${outcome.sha} to public ${MAIN}.`;
  }
  if (outcome.status === 'already-current') {
    return `Public ${MAIN} already carries ${outcome.sha}; nothing to publish.`;
  }
  if (outcome.status === 'nothing-green') {
    return (
      `No commit on staging ${MAIN} beyond what public ${MAIN} already carries has a green ` +
      `suite, within the newest ${String(MIRROR_SCAN_DEPTH)} scanned, so there is nothing ` +
      'publishable. Fix the suite; the next run publishes the newest green commit.'
    );
  }
  return (
    `Refusing to publish: public ${MAIN} stands at ${outcome.publicHead}, which ${outcome.target} ` +
    'does not descend from. Public history is append-only and this will never force. The ' +
    'inbound sync has not carried the public head back into staging — run it, then re-run ' +
    'this mirror.'
  );
}

export const COMMAND_LINE = {
  command: 'tsx scripts/publication/publish-mirror.ts',
  summary: "Publishes staging's trunk to the public repository.",
  flags: [],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

/* v8 ignore start -- CLI entry point, exercised through CI */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    if (readCommandLine(COMMAND_LINE, process.argv.slice(2)) === null) return;
    const outcome = await mirror(
      await mirrorRequest(process.cwd(), await readRepositories(), process.env, fetch)
    );
    const line = describeMirrorOutcome(outcome);
    if (isMirrorRefusal(outcome)) {
      console.error(line);
      return 1;
    }
    console.log(line);
    return 0;
  });
}
/* v8 ignore stop */
