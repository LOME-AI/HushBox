/**
 * Spawns vitest for a package's own test scripts, honouring the arguments the
 * caller appended to them.
 *
 * pnpm appends a script's extra arguments to the end of the script's command
 * string with the `--` separator left in place, unlike npm, which strips it.
 * vitest's parser reads `--` as the end of its own options and collects
 * everything past it into a bucket vitest never reads, so
 * `pnpm --filter <package> test:watch -- <path>` reached vitest as
 * `vitest -- <path>`, the path scoped nothing, and the run widened from that
 * one file to every file the package's config collects while still exiting 0.
 * Removing the separator here is what makes these entry points run what they
 * name.
 *
 * A script's own flags are spelled in its manifest entry, ahead of anything
 * pnpm appends, so they arrive as leading slots and ride through untouched.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainModule } from './lib/cli/is-main.js';
import { runMain } from './lib/cli/run-main.js';
import { slotsHiddenBySeparator, stripFirstSeparator } from './lib/cli/argument-separator.js';
import { withRunnerCacheClaim } from './lib/vitest/cache-sweep.js';
import { runCommand, stackModeFrom, withRunClaim } from './with-env.js';

/**
 * Refuses every slot a separator the caller wrote themselves would hide.
 *
 * The E2E runner passes a surviving separator on, because Playwright reads what
 * follows one and answers for it. vitest does not, so passing one on drops
 * arguments without a word and widens the run.
 */
function rejectTerminatedSlots(args: readonly string[]): void {
  const listed = slotsHiddenBySeparator(args);
  if (listed === null) {
    return;
  }
  throw new Error(
    `package-vitest: \`--\` ends vitest's options, so ${listed} would have reached neither a ` +
      `filter nor a flag and the run would have covered every file the package config ` +
      `collects. Write the same arguments without the \`--\`.`
  );
}

/**
 * The full `vitest` argument vector for a package test script's own leading
 * arguments plus whatever the caller appended.
 */
export function packageVitestArgs(passed: readonly string[]): string[] {
  const forwarded = stripFirstSeparator(passed);
  rejectTerminatedSlots(forwarded);
  return [...forwarded];
}

/* v8 ignore start -- CLI entry point exercised via each package's test scripts */
if (isMainModule(import.meta.url)) {
  await runMain(() =>
    // Not reached through `with-env`'s own entry point, so it registers its own
    // run: a test run holds the slot's stack for as long as it takes.
    withRunClaim(
      { command: 'vitest', mode: stackModeFrom(process.env), rootDir: process.cwd() },
      () =>
        // The runner's dependency optimizer writes into its cache directory
        // while it builds its project servers, before any of our code runs
        // inside it — so the claim on that directory is taken around the start
        // rather than beside it.
        withRunnerCacheClaim(
          {
            repoRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
            projectRoot: process.cwd(),
            processId: process.pid,
            env: process.env,
            now: Date.now(),
          },
          () => runCommand('vitest', packageVitestArgs(process.argv.slice(2)), [])
        )
    )
  );
}
/* v8 ignore stop */
