/**
 * Spawns Playwright for the root `e2e*` scripts, honouring the arguments the
 * caller appended to them, and is where the claim naming the host ports of the
 * servers that run starts is taken.
 *
 * Playwright starts each of its `webServer` entries in a process group of its
 * own, so the ports are the only handle a reclaimer has on what an interrupted
 * run leaves behind. Those servers rather than the whole end-to-end band: the
 * band also holds the bundler, the static site, the database studio, the audit
 * console, the readme preview, the crawler's-eye inspector and the emulator's
 * remote display, none of which this run starts. Claiming one of those would
 * make a dead starter's orphan read live and attributed to this run, and no
 * reclaimer may touch a live claim. Which servers the run starts is read from
 * the configuration that decides it, so a `webServer` added or removed there
 * moves this set with it.
 *
 * pnpm appends a script's extra arguments to the end of the script's command
 * string with the `--` separator left in place, unlike npm, which strips it.
 * Playwright's CLI stops parsing options at `--`, so `pnpm e2e -- <file> -g
 * "<name>"` reaches it as `playwright test -- <file> -g "<name>"` and both `-g`
 * and its value are read as extra positional path-filter regexes: the selection
 * silently widens to whatever those regexes also match instead of failing.
 * Removing the separator here is what makes the entry point run what it names.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './lib/cli/is-main.js';
import { runMain } from './lib/cli/run-main.js';
import { stripFirstSeparator } from './lib/cli/argument-separator.js';
import { declaredWebServers, portsForWebServers } from './lib/playwright/e2e-servers.js';
import { runCommand } from './with-env.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The full `playwright` argument vector for arguments arriving from a pnpm
 * script. Only the first separator goes — a later one is pnpm's no longer, so
 * it reaches Playwright and is answered there rather than dropped here.
 */
export function playwrightTestArgs(passed: readonly string[]): string[] {
  return ['test', ...stripFirstSeparator(passed)];
}

/** How the test run is started, so a test can watch what is claimed for it. */
type SpawnE2eRun = (
  command: string,
  args: readonly string[],
  ports: readonly number[]
) => Promise<number>;

/** Runs the end-to-end suite, claiming the ports its servers bind first. */
export async function runE2eTests(
  passed: readonly string[],
  env: NodeJS.ProcessEnv,
  spawn: SpawnE2eRun = runCommand
): Promise<number> {
  const servers = await declaredWebServers(REPO_ROOT);
  return spawn('playwright', playwrightTestArgs(passed), portsForWebServers(servers, env));
}

/* v8 ignore start -- CLI entry point exercised via the root e2e scripts */
if (isMainModule(import.meta.url)) {
  await runMain(() => runE2eTests(process.argv.slice(2), process.env));
}
/* v8 ignore stop */
