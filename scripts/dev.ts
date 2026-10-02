/**
 * Starts the development servers for the root `dev` script, and is where the
 * claim naming their host ports is taken.
 *
 * The wrapper every root script passes through spawns whatever it was given and
 * cannot know whether that command binds a port: a lint run and the dev servers
 * reach it by the same door. A claim taken there would therefore have to be
 * speculative, and a speculative claim carries no information — every
 * concurrent test run would claim the same band, so a dead run's orphaned
 * server would resolve to a live claim that never bound it and be left
 * standing. So the wrapper claims nothing, and each entry point that starts
 * servers claims the ports its own tree binds. This is that entry point for the
 * development stack, as the end-to-end runner is for the e2e stack.
 *
 * The servers rather than the whole mode band: the band also holds the preview
 * server, the audit console, the readme preview and the emulator's remote
 * display, which other commands start. Claiming one of those would make a dead
 * starter's orphan read live and attributed to this run, and no reclaimer may
 * touch a live claim. Which servers `turbo` fans the dev task out to is read
 * from the manifests that decide it, so a package gaining or losing a dev
 * server moves this set with it.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './lib/cli/is-main.js';
import { readCommandLine, type CommandSpec } from './lib/cli/command-line.js';
import { runMain } from './lib/cli/run-main.js';
import { portsForServers, serversRunningScript } from './lib/stack/server-ports.js';
import { runCommand } from './with-env.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** How the servers are started, so a test can watch what is claimed for them. */
export type SpawnDevServers = (
  command: string,
  args: readonly string[],
  ports: readonly number[]
) => Promise<number>;

/** Runs the workspace's dev task, claiming the ports its servers bind first. */
export function runDevServers(
  env: NodeJS.ProcessEnv,
  spawn: SpawnDevServers = runCommand
): Promise<number> {
  const servers = serversRunningScript('dev', REPO_ROOT);
  return spawn('turbo', ['dev'], portsForServers(servers, env));
}

export const COMMAND_LINE = {
  command: 'pnpm dev',
  summary: 'Starts the development servers.',
  flags: [],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

/* v8 ignore start -- CLI entry point exercised via the root dev script */
if (isMainModule(import.meta.url)) {
  await runMain(() => {
    if (readCommandLine(COMMAND_LINE, process.argv.slice(2)) === null) return;
    return runDevServers(process.env);
  });
}
/* v8 ignore stop */
