/**
 * The API Worker's process: started by `scripts/wrangler-dev.ts`, which owns
 * its log files, its terminal and its environment. Everything about how the
 * Worker runs is decided by the input that module builds; this file only
 * starts it and ends the process when it cannot run.
 *
 * It installs no signal handler: miniflare's exit hook kills workerd and exits
 * the process synchronously on SIGINT/SIGTERM, before an async dispose here
 * could finish, so that hook is the one shutdown path.
 */
import { isMainModule } from '../cli/is-main.js';
import { messageChain, runMain } from '../cli/run-main.js';
import { stackModeFrom } from '../stack/stack-mode.js';
import {
  apiWorkerPorts,
  apiWorkerStartInput,
  refuseArguments,
  startWorkerRuntime,
  watchesSource,
} from '../../wrangler-dev.js';
import type { ApiWorker, ApiWorkerStartInput } from '../../wrangler-dev.js';

export interface ApiWorkerRuntime {
  readonly startWorker: (input: ApiWorkerStartInput) => Promise<ApiWorker>;
}

const PROCESS_RUNTIME: ApiWorkerRuntime = { startWorker: startWorkerRuntime };

/**
 * Runs the stack's API Worker, answering an exit code only when it cannot run:
 * a failed start, or a failed build.
 *
 * A build failure ends a Worker that does not watch its source, because
 * nothing will ever rebuild it; one that watches waits for the next save, as
 * the development server always has.
 */
export async function runApiWorker(
  env: NodeJS.ProcessEnv,
  runtime: ApiWorkerRuntime = PROCESS_RUNTIME
): Promise<number> {
  const stackMode = stackModeFrom(env);
  const input = apiWorkerStartInput(stackMode, apiWorkerPorts(env, stackMode));

  let worker: ApiWorker;
  try {
    worker = await runtime.startWorker(input);
  } catch (error: unknown) {
    console.error(messageChain(error));
    return 1;
  }

  return new Promise<number>((resolve) => {
    if (!watchesSource(stackMode)) {
      worker.raw.once('buildFailed', () => {
        resolve(1);
      });
    }
  });
}

/* v8 ignore start -- CLI entry point exercised via scripts/wrangler-dev.ts */
if (isMainModule(import.meta.url)) {
  await runMain(() => {
    refuseArguments(process.argv.slice(2));
    return runApiWorker(process.env);
  });
}
/* v8 ignore stop */
