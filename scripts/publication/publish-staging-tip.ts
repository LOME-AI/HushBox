/**
 * Publishes staging `main`'s tip to public `main` on a human's demand, so it
 * can be deployed without waiting for the outbound mirror.
 *
 * Production only ever runs public code, so deploying staging means publishing
 * it first — and publishing is the irreversible act. The outbound mirror's
 * contract is that nothing unproven is ever published; this script exists
 * beside it because its tip may be unproven, so it asks the publication
 * questions itself, of the exact commits it publishes, before the push
 * ({@link publicationChecks}). The range scan is what the tree scan cannot
 * answer — a secret committed and removed inside the range reaches history but
 * not the tip.
 *
 * Its output says whether the deploy still needs a bypass run. Where staging's
 * trusted push run already proved the tip, the push run the fast-forward starts
 * borrows that proof and deploys with the whole suite behind it, and a bypass
 * run would only race it. Any other answer — including a proof that could not
 * be read — asks for the bypass run, because a human pressed the button to
 * deploy.
 *
 * Every refusal leaves public untouched, and nothing here forces: public `main`
 * is append-only.
 */
import { appendFileSync } from 'node:fs';
import { execa } from 'execa';
import { isMainModule } from '../lib/cli/is-main.js';
import { readCommandLine, type CommandSpec } from '../lib/cli/command-line.js';
import { messageChain, runMain } from '../lib/cli/run-main.js';
import { readRepositories, type Repositories } from '../configure-git-clone.js';
import { ensureGitleaks, gitleaksRangeScanArgs } from '../lib/privacy/gitleaks.js';
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
  fastForwardRemoteBranch,
  fetchRemoteBranch,
  isAncestor,
} from '../lib/publication/git.js';
import { BASE_VARIABLE, HEAD_VARIABLE } from '../verify-commit-dates.js';

const CALLER = 'The staging tip publisher';

const OUTPUT_VARIABLE = 'GITHUB_OUTPUT';

/** The key the dispatch answer is written under, which `.github/workflows/deploy-now.yml` reads off the publish step. */
export const DISPATCH_OUTPUT = 'dispatch';

/** One question asked of the commits before they are published, as a process to run. */
export interface PublicationCheck {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Added to the inherited environment. */
  readonly env: Readonly<Record<string, string>>;
}

export interface PublishRequest {
  /** A full clone of public, where both heads are fetched and every check runs. */
  readonly cwd: string;
  /** The public repository's git URL, carrying the bot credential. */
  readonly publicUrl: string;
  /** The staging repository's git URL, carrying the bot credential. */
  readonly stagingUrl: string;
  readonly ensureGitleaks: () => Promise<string>;
  /** Runs one check and answers its exit code. */
  readonly runCheck: (check: PublicationCheck) => Promise<number>;
  /**
   * Staging's REST surface, where its proof of the tip is read. Deferred so a
   * refused read credential is a failed read, which answers like any other.
   */
  readonly stagingApi: () => Promise<RepositoryApi>;
}

type Proof =
  | { status: 'borrowable' }
  | { status: 'unproven' }
  | { status: 'unreadable'; reason: string };

export type PublicationOutcome =
  | { status: 'nothing-to-publish'; sha: string }
  | { status: 'diverged'; publicHead: string; tip: string }
  | { status: 'check-failed'; check: string; exitCode: number; tip: string }
  /** `publicHead` is where public moved to during the run. */
  | { status: 'refused'; publicHead: string; tip: string }
  | { status: 'published'; sha: string; proof: Proof };

/** The checks, in the order they run; the first to fail stops the rest. */
export function publicationChecks(
  gitleaksBin: string,
  publicHead: string,
  tip: string
): PublicationCheck[] {
  return [
    {
      name: 'gitleaks range scan',
      command: gitleaksBin,
      args: gitleaksRangeScanArgs(`${publicHead}..${tip}`),
      env: {},
    },
    {
      name: 'gitleaks tree scan',
      command: 'pnpm',
      args: ['gitleaks:scan', '--revision', tip],
      env: {},
    },
    { name: 'privacy sweep', command: 'pnpm', args: ['privacy:sweep', tip], env: {} },
    {
      name: 'commit-date check',
      command: 'pnpm',
      args: ['tsx', 'scripts/verify-commit-dates.ts'],
      env: { [BASE_VARIABLE]: publicHead, [HEAD_VARIABLE]: tip },
    },
  ];
}

/** A check killed without an exit code answers as a failure. */
export async function runCheckProcess(check: PublicationCheck, cwd: string): Promise<number> {
  const result = await execa(check.command, [...check.args], {
    cwd,
    env: check.env,
    stdio: 'inherit',
    reject: false,
  });
  return result.exitCode ?? 1;
}

/**
 * One unscoped token, minted from the installation on public, reaches both
 * repositories' `main` — the inbound sync's practice. Staging's runs are read
 * under the token narrowed to Actions read on staging.
 */
export async function publishRequest(
  cwd: string,
  repositories: Repositories,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch
): Promise<PublishRequest> {
  const token = await syncBotToken(CALLER, repositories.publicRepo, env, fetchImpl);
  const urlOf = (repository: string): string =>
    `https://x-access-token:${token}@github.com/${repository}.git`;
  return {
    cwd,
    publicUrl: urlOf(repositories.publicRepo),
    stagingUrl: urlOf(repositories.stagingRepo),
    ensureGitleaks,
    runCheck: (check) => runCheckProcess(check, cwd),
    stagingApi: async () => ({
      fetchImpl,
      token: await stagingRunReaderToken(CALLER, repositories.stagingRepo, env, fetchImpl),
      repository: repositories.stagingRepo,
    }),
  };
}

async function readProof(request: PublishRequest, sha: string): Promise<Proof> {
  try {
    const run = await readTrustedRun(await request.stagingApi(), TRUSTED_WORKFLOW_FILE, sha);
    return isBorrowable(run, sha, BORROWED_JOBS)
      ? { status: 'borrowable' }
      : { status: 'unproven' };
  } catch (error: unknown) {
    return { status: 'unreadable', reason: messageChain(error) };
  }
}

export async function publishStagingTip(request: PublishRequest): Promise<PublicationOutcome> {
  const tip = await fetchRemoteBranch(request.cwd, request.stagingUrl, MAIN);
  const publicHead = await fetchRemoteBranch(request.cwd, request.publicUrl, MAIN);
  if (publicHead === tip) return { status: 'nothing-to-publish', sha: tip };
  if (!(await isAncestor(request.cwd, publicHead, tip))) {
    return { status: 'diverged', publicHead, tip };
  }

  const gitleaksBin = await request.ensureGitleaks();
  for (const check of publicationChecks(gitleaksBin, publicHead, tip)) {
    const exitCode = await request.runCheck(check);
    if (exitCode !== 0) return { status: 'check-failed', check: check.name, exitCode, tip };
  }

  // The fast-forward re-reads public's head, which is what catches it having
  // moved while the checks ran.
  const outcome = await fastForwardRemoteBranch(request.cwd, request.publicUrl, MAIN, tip);
  if (outcome.status === 'refused') return { status: 'refused', publicHead: outcome.head, tip };
  return { status: 'published', sha: tip, proof: await readProof(request, tip) };
}

/** Whether the deploy needs a bypass run; `null` for a failure, which writes no output. */
export function dispatchFor(outcome: PublicationOutcome): boolean | null {
  if (outcome.status === 'nothing-to-publish') return true;
  if (outcome.status === 'published') return outcome.proof.status !== 'borrowable';
  return null;
}

function describeProof(sha: string, proof: Proof): string {
  if (proof.status === 'borrowable') {
    return (
      `Staging's trusted push run proved ${sha}, so the push run this publication started ` +
      "will deploy it with staging's proof; no bypass run is needed."
    );
  }
  if (proof.status === 'unproven') {
    return `Staging's trusted push run has not proved ${sha}; a bypass run deploys it.`;
  }
  return (
    `Staging's trusted push run for ${sha} could not be read: ${proof.reason} ` +
    'A bypass run deploys it.'
  );
}

export function describePublication(outcome: PublicationOutcome): string[] {
  if (outcome.status === 'nothing-to-publish') {
    return [`Public ${MAIN} already stands at staging's tip ${outcome.sha}; nothing to publish.`];
  }
  if (outcome.status === 'diverged') {
    return [
      `Refusing to publish: public ${MAIN} stands at ${outcome.publicHead}, which staging's tip ` +
        `${outcome.tip} does not descend from, so this is not a fast-forward. Public history is ` +
        'append-only and this will never force. Run the inbound sync to carry public ' +
        `${MAIN} into staging, then deploy again.`,
    ];
  }
  if (outcome.status === 'check-failed') {
    return [
      `Refusing to publish staging's tip ${outcome.tip}: the ${outcome.check} exited ` +
        `${String(outcome.exitCode)}. Nothing was pushed.`,
    ];
  }
  if (outcome.status === 'refused') {
    return [
      `Refusing to publish staging's tip ${outcome.tip}: public ${MAIN} moved to ` +
        `${outcome.publicHead} during this run, and the tip does not descend from it. Nothing ` +
        'was pushed. Run the inbound sync, then deploy again.',
    ];
  }
  return [
    `Published staging's tip ${outcome.sha} to public ${MAIN}.`,
    describeProof(outcome.sha, outcome.proof),
  ];
}

/**
 * Refuses before anything is published: a publication whose dispatch answer
 * cannot be written would leave the workflow unable to tell whether to deploy.
 */
function requireOutputFile(env: NodeJS.ProcessEnv): string {
  const outputFile = env[OUTPUT_VARIABLE] ?? '';
  if (outputFile === '') {
    throw new Error(`${CALLER} writes its answer to ${OUTPUT_VARIABLE}, which is not set.`);
  }
  return outputFile;
}

export async function main(
  env: NodeJS.ProcessEnv,
  buildRequest: () => Promise<PublishRequest>
): Promise<number> {
  const outputFile = requireOutputFile(env);
  const outcome = await publishStagingTip(await buildRequest());
  const dispatch = dispatchFor(outcome);
  const lines = describePublication(outcome);
  if (dispatch === null) {
    for (const line of lines) console.error(line);
    return 1;
  }
  for (const line of lines) process.stdout.write(`${line}\n`);
  appendFileSync(outputFile, `${DISPATCH_OUTPUT}=${String(dispatch)}\n`);
  return 0;
}

export const COMMAND_LINE = {
  command: 'tsx scripts/publication/publish-staging-tip.ts',
  summary: "Publishes staging's tip to the public repository after scanning what it publishes.",
  flags: [],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

/* v8 ignore start -- CLI entry point, exercised through CI */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    if (readCommandLine(COMMAND_LINE, process.argv.slice(2)) === null) return;
    return main(process.env, async () =>
      publishRequest(process.cwd(), await readRepositories(), process.env, fetch)
    );
  });
}
/* v8 ignore stop */
