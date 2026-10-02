/**
 * The unused-code gate: the unused-export scan, over the environment its
 * configuration reads.
 *
 * The scanner resolves this repository's entry points by loading its build
 * configs, and `playwright.config.ts` is one of them — it reads the ports a
 * stack's generated env files supply, so a scan that loaded no environment dies
 * on that config load rather than reporting anything. The environment therefore
 * belongs to the module the command names, the way it does for every other
 * gate, instead of to one spelling of a package script: a caller that reaches
 * the gate any other way gets the same run.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { isMainModule } from './lib/cli/is-main.js';
import { runMain } from './lib/cli/run-main.js';
import { stackModeFrom } from './lib/stack/stack-mode.js';
import { loadEnvironment, withRunClaim } from './with-env.js';

/**
 * What the gate always carries. Progress rendering addresses a terminal, and
 * every run of this gate anyone reads back is a log.
 */
export const KNIP_ARGUMENTS = ['--no-progress'] as const;

interface UnusedGateDeps {
  /** The checkout whose environment the scan reads and whose code it scans. */
  readonly rootDir: string;
  readonly loadEnvironment: (rootDir: string) => void;
  /** Runs the scan and answers its exit code. */
  readonly scan: (args: readonly string[]) => Promise<number>;
}

export async function runUnusedGate(
  args: readonly string[],
  deps: UnusedGateDeps
): Promise<number> {
  deps.loadEnvironment(deps.rootDir);
  return deps.scan([...KNIP_ARGUMENTS, ...args]);
}

/* v8 ignore start -- CLI entry point exercised via the lint:unused package script */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const deps: UnusedGateDeps = {
      rootDir,
      loadEnvironment,
      // The claim is taken here rather than around the whole run because it
      // reads the slot the loaded environment names, and the environment is
      // loaded as the first step of the run itself.
      scan: (args) =>
        withRunClaim({ command: 'knip', mode: stackModeFrom(process.env), rootDir }, async () => {
          const result = await execa('knip', args, {
            stdio: 'inherit',
            cwd: rootDir,
            // The scanner is this repository's own dependency, so a caller that
            // arrived without a package manager's PATH still finds it.
            preferLocal: true,
            reject: false,
          });
          return result.exitCode ?? 1;
        }),
    };
    return runUnusedGate(process.argv.slice(2), deps);
  });
}
/* v8 ignore stop */
