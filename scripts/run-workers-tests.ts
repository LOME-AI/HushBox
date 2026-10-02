import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';

import { isMainModule } from './lib/cli/is-main.js';
import { runMain } from './lib/cli/run-main.js';
import { withRunnerCacheClaim } from './lib/vitest/cache-sweep.js';
import { prepareWorkersPhase, teardown } from './lib/vitest/global.setup.js';
import { packageVitestArgs } from './package-vitest.js';

/**
 * Runs a package's workerd vitest project against its own Postgres database.
 *
 * The workerd configs read `DATABASE_URL` at config load, in the main process,
 * and pass it to miniflare as a binding — so the per-worker rewrite in the
 * vitest setup file can never reach them, and `VITEST_POOL_ID` does not exist
 * that early. Provisioning therefore happens here, before vitest starts. One
 * database is enough: those projects run serially with parallelism off.
 */

/** The workerd project, as vitest is asked for it. */
const WORKERS_PROJECT_ARGS: readonly string[] = ['run', '--config', 'vitest.workers.config.ts'];

/**
 * The full `vitest` vector: the project's own arguments, then the caller's,
 * answered for by {@link packageVitestArgs} — which is what strips the `--`
 * pnpm keeps ahead of a caller's arguments and refuses one they wrote
 * themselves.
 *
 * The other `test:workers` scripts name that module in their manifest entry
 * and reach it directly; this one cannot, because {@link prepareWorkersPhase}
 * has to run in this process first. Borrowing its answer rather than keeping a
 * second one is what makes every `test:workers` script behave alike, refusal
 * message included.
 */
export function workersVitestArgs(passed: readonly string[]): string[] {
  return packageVitestArgs([...WORKERS_PROJECT_ARGS, ...passed]);
}

interface WorkersTestsDeps {
  readonly prepare: () => Promise<void>;
  readonly run: () => Promise<number>;
  readonly teardown: () => Promise<void>;
}

export async function runWorkersTests(deps: WorkersTestsDeps): Promise<number> {
  await deps.prepare();
  try {
    return await deps.run();
  } finally {
    await deps.teardown();
  }
}

/* v8 ignore start -- CLI entry point exercised via package.json scripts */
if (isMainModule(import.meta.url)) {
  await runMain(async () =>
    // The phase below stamps the cache directories this invocation resolves to,
    // creating them; the claim naming them has to exist first, and it is the
    // same scope that removes them once the runner it enclosed is gone.
    withRunnerCacheClaim(
      {
        repoRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
        projectRoot: process.cwd(),
        processId: process.pid,
        env: process.env,
        now: Date.now(),
      },
      () =>
        runWorkersTests({
          prepare: async () => {
            await prepareWorkersPhase();
          },
          run: async () => {
            const result = await execa('vitest', workersVitestArgs(process.argv.slice(2)), {
              stdio: 'inherit',
              reject: false,
            });
            return typeof result.exitCode === 'number' ? result.exitCode : 1;
          },
          teardown,
        })
    )
  );
}
/* v8 ignore stop */
