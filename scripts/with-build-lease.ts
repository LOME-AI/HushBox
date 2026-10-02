#!/usr/bin/env tsx
/**
 * Runs one shell command while holding the build lease over the output it
 * writes, so the package scripts that write a built output can take it without
 * any of them importing a build script. The command is a shell string because
 * three of the writers are two steps joined by `&&` — a build followed by the
 * `cap sync` or the header generation that reads what it produced, both of which
 * have to sit inside the same lease as the build.
 *
 * The lease's whole design, and why it is taken here rather than inside
 * `@hushbox/web`'s own `build` script, is in `scripts/lib/bundling/lease.ts`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { BUILD_OUTPUTS, isBuildOutput, withBuildLease } from './lib/bundling/lease.js';
import { isMainModule } from './lib/cli/is-main.js';
import { runMain } from './lib/cli/run-main.js';
import { asElectedCacheWriter } from './lib/turbo/cache-writer.js';
import type { BuildOutput } from './lib/bundling/lease.js';

const OUTPUT_FLAG = '--resource=';

export interface WithBuildLeaseDeps {
  readonly exec: (command: string, cwd: string) => Promise<{ exitCode: number }>;
}

/** One command, and the built output it writes. */
export interface LeasedInvocation {
  readonly output: BuildOutput;
  readonly command: string;
}

export function readCommand(args: readonly string[]): string {
  const command = args.find((argument) => !argument.startsWith('--'));
  if (!command) throw new Error('with-build-lease requires a command to run');
  return command;
}

/**
 * The web output is what an unflagged invocation writes: every writer but the
 * admin bundle targets it, and naming it in each of their package scripts would
 * be the same value written down six times.
 */
export function readOutput(args: readonly string[]): BuildOutput {
  const flag = args.find((argument) => argument.startsWith(OUTPUT_FLAG));
  if (flag === undefined) return 'web-dist';
  const value = flag.slice(OUTPUT_FLAG.length);
  if (!isBuildOutput(value)) {
    throw new Error(
      `with-build-lease cannot key a lease on \`${value}\` — ` +
        `the leased outputs are ${BUILD_OUTPUTS.join(', ')}.`
    );
  }
  return value;
}

/**
 * The command's own exit code is returned rather than thrown, so wrapping a
 * writer leaves what its caller sees on failure exactly as it was.
 */
export async function runWithBuildLease(
  repoRoot: string,
  cwd: string,
  invocation: LeasedInvocation,
  deps: WithBuildLeaseDeps
): Promise<number> {
  return withBuildLease(repoRoot, invocation.output, invocation.command, async () => {
    const { exitCode } = await deps.exec(invocation.command, cwd);
    return exitCode;
  });
}

/* v8 ignore start -- CLI entry point exercised via the build package scripts */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(scriptDir, '..');
    const args = process.argv.slice(2);
    const invocation = { output: readOutput(args), command: readCommand(args) };
    return asElectedCacheWriter({ rootDir: repoRoot, command: 'build' }, () =>
      runWithBuildLease(repoRoot, process.cwd(), invocation, {
        exec: async (command, cwd) => {
          const result = await execa(command, {
            shell: true,
            stdio: 'inherit',
            cwd,
            reject: false,
          });
          return { exitCode: result.exitCode ?? 1 };
        },
      })
    );
  });
}
/* v8 ignore stop */
