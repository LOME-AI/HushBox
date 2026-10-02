import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer, type InlineConfig, type ServerOptions, type ViteDevServer } from 'vite';
import { HOOK_TIMEOUT_MS } from '@hushbox/config/hook-timeout';

/** The fixture's own config, passed to Vite as given; the helper owns the rest. */
export interface FixtureServerOptions extends Pick<
  InlineConfig,
  'plugins' | 'resolve' | 'optimizeDeps' | 'configFile'
> {
  root: string;
  watch?: ServerOptions['watch'];
  /** How long the close waits for the server before it removes the cache folder anyway. */
  closeBudgetMs?: number;
}

export interface FixtureServer {
  url: string;
  cacheDir: string;
  close: () => Promise<void>;
}

// Half the hook budget: callers close their browsers and then this server inside one hook, and
// the overrun branch must remove the cache folder before the runner abandons that hook.
export const DEFAULT_CLOSE_BUDGET_MS = HOOK_TIMEOUT_MS / 2;

/**
 * Starts a Vite server over a real-browser test's fixture directory.
 *
 * Its dependency cache is a fresh folder of its own: a server started on another server's
 * cache with a different config deletes that cache's pre-bundled dependencies at startup, and
 * the other server then answers 504 for every one it had not yet served. The close removes that
 * folder whether the server's own close fails, finishes, or is still running when its budget
 * runs out, and still rejects with what went wrong. A server that fails to start is closed and
 * its folder removed before the failure is rethrown.
 */
export async function startFixtureServer(options: FixtureServerOptions): Promise<FixtureServer> {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'fixture-server-vite-'));
  const { root, watch, closeBudgetMs = DEFAULT_CLOSE_BUDGET_MS, ...config } = options;
  let started: ViteDevServer | undefined;
  let url: string;
  try {
    started = await createServer({
      ...config,
      root,
      cacheDir,
      logLevel: 'error',
      server: { port: 0, host: '127.0.0.1', hmr: false, ...(watch === undefined ? {} : { watch }) },
    });
    await started.listen();
    const address = started.httpServer?.address();
    if (address === null || address === undefined || typeof address === 'string') {
      throw new Error('fixture server has no port');
    }
    url = `http://127.0.0.1:${String(address.port)}`;
  } catch (error) {
    try {
      await started?.close();
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
    throw error;
  }
  const server = started;
  return {
    url,
    cacheDir,
    close: async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const overrun = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`the fixture server did not close within ${String(closeBudgetMs)}ms`));
        }, closeBudgetMs);
      });
      try {
        await Promise.race([server.close(), overrun]);
      } finally {
        clearTimeout(timer);
        await rm(cacheDir, { recursive: true, force: true });
      }
    },
  };
}
