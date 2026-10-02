/**
 * How every Docker Compose invocation in this repository is spelled, and the
 * command line `pnpm db:up` reaches compose through.
 *
 * Compose takes its project directory from the working directory the process
 * inherited and resolves every relative bind-mount source against it before
 * hashing the service, so a checkout reachable by two absolute spellings gives
 * one service two configuration hashes. The bring-up's drift check then reads
 * drift from the other spelling, recreates a live container, and a run already
 * past its own bring-up loses the port under it. Every other path this
 * repository owns is canonicalised; the project directory is the one compose
 * decides for itself, and naming it is what takes that decision back.
 */
import path from 'node:path';
import { execa } from 'execa';
import { canonicalPath } from './lib/canonical-path.js';
import { isMainModule } from './lib/cli/is-main.js';
import { runMain } from './lib/cli/run-main.js';

/** The one spelling of this checkout every compose invocation resolves against. */
export const CHECKOUT_DIRECTORY = canonicalPath(path.resolve(import.meta.dirname, '..'));

/** `docker`'s argv for one compose invocation against `projectDirectory`. */
export function composeArguments(projectDirectory: string, args: readonly string[]): string[] {
  return ['compose', '--project-directory', canonicalPath(projectDirectory), ...args];
}

/* v8 ignore start -- real-IO wiring; the argv it runs is built above */
async function main(): Promise<void> {
  await execa('docker', composeArguments(CHECKOUT_DIRECTORY, process.argv.slice(2)), {
    cwd: CHECKOUT_DIRECTORY,
    stdio: 'inherit',
  });
}

if (isMainModule(import.meta.url)) {
  await runMain(main);
}
/* v8 ignore stop */
