/**
 * Decides whether a push to public `main` may borrow staging's green: true only
 * where staging's trusted push run proved this exact commit, by the predicate
 * the outbound mirror publishes by.
 *
 * Every state that cannot establish the proof answers `false` and exits 0,
 * which runs the whole suite: a wrong `false` costs one full run, a wrong
 * `true` would deploy an unproven commit, and a red borrow job would make the
 * deploy verdict refuse, so nothing would publish even after every check ran
 * green. A missing credential or commit is a configuration defect rather than a
 * question staging answered, so it also raises an error annotation where the
 * degradation would otherwise go unseen.
 */
import { readRepositories } from '../configure-git-clone.js';
import { writeGithubOutput } from '../extract-version.js';
import { isMainModule } from '../lib/cli/is-main.js';
import { readCommandLine, type CommandSpec } from '../lib/cli/command-line.js';
import { messageChain, runMain } from '../lib/cli/run-main.js';
import { writeStepSummary } from '../lib/backup/reconcile.js';
import {
  isBorrowable,
  readTrustedRun,
  stagingRunReaderToken,
  type TrustedRun,
} from '../lib/publication/api.js';
import { BORROWED_JOBS, TRUSTED_WORKFLOW_FILE } from '../lib/publication/borrowed-jobs.js';
import { readSyncAppCredentials } from '../lib/publication/sync-bot-credential.js';

const WHAT = 'The green borrow';

export interface BorrowContext {
  /** The commit under test, as `GITHUB_SHA` names it. */
  readonly sha: string | undefined;
  readonly stagingRepository: string;
  readonly env: NodeJS.ProcessEnv;
  readonly fetchImpl: typeof fetch;
}

export interface BorrowDecision {
  readonly borrowed: boolean;
  readonly reason: string;
  /** A configuration defect: surfaced as an error annotation, never as a failed job. */
  readonly defect: boolean;
}

const fullRun = (reason: string, defect = false): BorrowDecision => ({
  borrowed: false,
  reason: `${reason} Every check runs.`,
  defect,
});

export async function decideBorrow(context: BorrowContext): Promise<BorrowDecision> {
  const { sha, stagingRepository, env, fetchImpl } = context;
  if (sha === undefined || sha === '') {
    return fullRun(`${WHAT} needs GITHUB_SHA, the commit under test, and it was not set.`, true);
  }
  try {
    readSyncAppCredentials(WHAT, env);
  } catch (error: unknown) {
    return fullRun(messageChain(error), true);
  }

  let run: TrustedRun | null;
  try {
    const token = await stagingRunReaderToken(WHAT, stagingRepository, env, fetchImpl);
    run = await readTrustedRun(
      { fetchImpl, token, repository: stagingRepository },
      TRUSTED_WORKFLOW_FILE,
      sha
    );
  } catch (error: unknown) {
    return fullRun(`Staging's trusted run for ${sha} could not be read: ${messageChain(error)}`);
  }

  if (run === null) {
    return fullRun(`Staging has no push run on main for ${sha}.`);
  }
  if (!isBorrowable(run, sha, BORROWED_JOBS)) {
    return fullRun(`Staging's newest push run for ${sha} did not prove it.`);
  }
  return {
    borrowed: true,
    reason: `Staging's trusted push run proved ${sha}; the borrowable checks are skipped.`,
    defect: false,
  };
}

export async function main(context: BorrowContext): Promise<void> {
  const decision = await decideBorrow(context);
  if (decision.defect) process.stdout.write(`::error::${decision.reason}\n`);
  process.stdout.write(`${decision.reason}\n`);
  writeStepSummary(decision.reason);
  writeGithubOutput([`borrowed=${String(decision.borrowed)}`]);
}

export const COMMAND_LINE = {
  command: 'tsx scripts/publication/green-borrow.ts',
  summary: "Decides whether this push may borrow staging's green for the same commit.",
  flags: [],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

/* v8 ignore start -- CLI entry point, exercised through CI */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    if (readCommandLine(COMMAND_LINE, process.argv.slice(2)) === null) return;
    const { stagingRepo } = await readRepositories();
    await main({
      sha: process.env['GITHUB_SHA'],
      stagingRepository: stagingRepo,
      env: process.env,
      fetchImpl: fetch,
    });
    return 0;
  });
}
/* v8 ignore stop */
