import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { runDocket } from '../cli/run';
import { parseLaunchOptions } from './launch-options';
import type { InlineConfig } from 'vite';

interface StartedServer {
  listen(): Promise<unknown>;
  readonly resolvedUrls?: { readonly local: readonly string[] } | null;
}

export interface StartDeps {
  create(config: InlineConfig): Promise<StartedServer>;
  log(message: string): void;
}

/**
 * The console's own entry point rather than a bare `vite`: Vite's CLI rejects
 * unknown options outright, and `--idle` / `--no-idle` / `--audit` are the
 * console's flags, not Vite's.
 */
export async function startConsole(
  argv: readonly string[],
  deps: StartDeps
): Promise<StartedServer> {
  const options = parseLaunchOptions(argv);
  const server = await deps.create(options.port === null ? {} : { server: { port: options.port } });
  await server.listen();

  const [url] = server.resolvedUrls?.local ?? [];
  deps.log(url === undefined ? 'docket console started' : `docket console: ${url}`);
  return server;
}

/* v8 ignore start -- process entry point, exercised through the `start` script */
const invoked = process.argv[1];
if (invoked !== undefined && pathToFileURL(invoked).href === import.meta.url) {
  process.exitCode = await runDocket(process.argv.slice(2), {
    repoRoot: fileURLToPath(new URL('../../../../', import.meta.url)),
    out: (message) => {
      process.stdout.write(`${message}\n`);
    },
    err: (message) => {
      process.stderr.write(`${message}\n`);
    },
    startConsole: async (argv) => {
      await startConsole(argv, {
        create: (config) => createServer(config),
        log: (message) => {
          process.stdout.write(`${message}\n`);
        },
      });
    },
  });
}
/* v8 ignore stop */
