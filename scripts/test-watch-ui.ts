/**
 * Spawns the watch-mode vitest UI for the root `test:watch:ui` script,
 * honouring the arguments the caller appended to it.
 *
 * pnpm appends a script's extra arguments to the end of the script's command
 * string with the `--` separator left in place, unlike npm, which strips it.
 * vitest's parser reads `--` as the end of its own options and collects
 * everything past it into a bucket vitest never reads, so `pnpm test:watch:ui
 * -- <path> -t "<name>"` reaches it as `vitest --ui -- <path> -t "<name>"` and
 * neither the path nor the title filter reaches a filter or a flag: the run
 * widens to everything the config collects and still exits 0. Removing the
 * separator here is what makes the entry point run what it names.
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
    `test:watch:ui: \`--\` ends vitest's options, so ${listed} would have reached neither a ` +
      `filter nor a flag and the run would have covered everything the config collects. ` +
      `Write the same arguments without the \`--\`.`
  );
}

/**
 * The full `vitest` argument vector for arguments arriving from the pnpm
 * script.
 */
export function vitestUiArgs(passed: readonly string[]): string[] {
  const forwarded = stripFirstSeparator(passed);
  rejectTerminatedSlots(forwarded);
  return ['--ui', ...forwarded];
}

/* v8 ignore start -- CLI entry point exercised via the root test:watch:ui script */
if (isMainModule(import.meta.url)) {
  await runMain(() =>
    // Not reached through `with-env`'s own entry point, so it registers its own
    // run: a test run holds the slot's stack for as long as it takes.
    withRunClaim(
      { command: 'vitest --ui', mode: stackModeFrom(process.env), rootDir: process.cwd() },
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
          () => runCommand('vitest', vitestUiArgs(process.argv.slice(2)), [])
        )
    )
  );
}
/* v8 ignore stop */
