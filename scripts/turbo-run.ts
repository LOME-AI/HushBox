#!/usr/bin/env tsx
/**
 * Runs the task runner as the elected build-cache writer, for the root scripts
 * that invoke it directly.
 *
 * The election has to happen in a process that owns the whole invocation, and a
 * package script naming the task runner owns nothing: there is no wrapper
 * around it to elect in. This is that wrapper, and it does nothing else — a
 * caller's arguments reach the runner exactly as they reached it before.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { isMainModule } from './lib/cli/is-main.js';
import { runMain } from './lib/cli/run-main.js';
import { asElectedCacheWriter } from './lib/turbo/cache-writer.js';

export interface TurboRunDeps {
  readonly rootDir: string;
  readonly env: NodeJS.ProcessEnv;
  /** Runs the task runner and answers its exit code. */
  readonly exec: (args: readonly string[]) => Promise<number>;
}

export async function runTurbo(args: readonly string[], deps: TurboRunDeps): Promise<number> {
  return asElectedCacheWriter({ rootDir: deps.rootDir, command: 'turbo', env: deps.env }, () =>
    deps.exec(args)
  );
}

/* v8 ignore start -- CLI entry point exercised via the root package scripts */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    return runTurbo(process.argv.slice(2), {
      rootDir: path.resolve(scriptDir, '..'),
      env: process.env,
      exec: async (args) => {
        const result = await execa('turbo', args, { stdio: 'inherit', reject: false });
        return result.exitCode ?? 1;
      },
    });
  });
}
/* v8 ignore stop */
