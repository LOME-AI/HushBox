/**
 * Runs a command that starts a vitest runner this repository does not spawn
 * itself, taking the runner's cache claim first.
 *
 * The commands that spawn a runner directly take that claim inline, ahead of
 * the spawn. A tool that constructs a runner in its own process — the mutation
 * runner does, against the repository-root configuration — is reached by no
 * spawn site here, so there is nowhere inline to put it; this wrapper is where
 * it goes instead. The claim has to precede the start either way: the
 * dependency optimizer creates the invocation directory and commits bundles
 * into it while the runner builds its project servers, before any code of ours
 * runs inside it.
 *
 * One claim covers however many runners the command goes on to start — the
 * mutation tool declares a concurrency and builds one runner per worker
 * process — because what is claimed is the directory they all bundle beneath
 * rather than any one runner's own directory inside it. The command runs inside
 * that claim rather than after it, so the directory goes when the command does
 * however the command ended: a runner killed mid-flight reaches no teardown of
 * its own, and this process watched it die.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainModule } from './lib/cli/is-main.js';
import { runMain } from './lib/cli/run-main.js';
import { withRunnerCacheClaim } from './lib/vitest/cache-sweep.js';
import { runCommand, stackModeFrom, withRunClaim } from './with-env.js';

/** What the wrapper does: the claim the command runs inside, and the command. */
interface RunnerCacheClaimSteps {
  readonly hold: (body: () => Promise<number>) => Promise<number>;
  readonly run: (command: string, args: readonly string[]) => Promise<number>;
}

/** Runs the command inside the claim, and answers what the command answered. */
export async function runClaimingRunnerCache(
  argv: readonly string[],
  steps: RunnerCacheClaimSteps
): Promise<number> {
  const [command, ...args] = argv;
  if (command === undefined) {
    throw new Error(
      'with-runner-cache-claim: nothing to run. Usage: with-runner-cache-claim <command> [...args]'
    );
  }
  return await steps.hold(() => steps.run(command, args));
}

/* v8 ignore start -- CLI entry point exercised via the root mutation scripts */
if (isMainModule(import.meta.url)) {
  await runMain(() =>
    // Reached through `with-env`, which registers the run; this adopts it rather
    // than taking a second claim, and registers one of its own when the wrapper
    // is run on its own.
    withRunClaim(
      { command: 'vitest', mode: stackModeFrom(process.env), rootDir: process.cwd() },
      () =>
        runClaimingRunnerCache(process.argv.slice(2), {
          hold: (body) =>
            withRunnerCacheClaim(
              {
                repoRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
                projectRoot: process.cwd(),
                processId: process.pid,
                env: process.env,
                now: Date.now(),
              },
              body
            ),
          run: (command, args) => runCommand(command, args, []),
        })
    )
  );
}
/* v8 ignore stop */
