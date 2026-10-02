import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Plugin, type ViteDevServer } from 'vite';
import { HOOK_TIMEOUT_MS } from '@hushbox/config/hook-timeout';

import { DEFAULT_CLOSE_BUDGET_MS, startFixtureServer, type FixtureServer } from './fixture-server';

/**
 * Every server here runs in a fresh temporary package, never under this app: the stand-in
 * dev server's cache is that package's default, which is what a fixture server rooted inside
 * the package would share if it kept Vite's default.
 */

const SERVER_MS = 120_000;

interface Reply {
  status: number;
  body: string;
}

function get(url: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, body });
        });
      })
      .on('error', reject);
  });
}

/** Every pre-bundled dependency a served module imports, as an absolute URL. */
function depsUrls(origin: string, moduleSource: string): string[] {
  return [...moduleSource.matchAll(/["']([^"']*\/deps\/[^"']*)["']/gu)].map(
    (match) => `${origin}${match[1] ?? ''}`
  );
}

/** Loads a module and every pre-bundled dependency it imports, as a page load would. */
async function loadWithDeps(origin: string, modulePath: string): Promise<number[]> {
  const module = await get(`${origin}${modulePath}`);
  const statuses = [module.status];
  for (const url of depsUrls(origin, module.body)) {
    const reply = await get(url);
    statuses.push(reply.status);
  }
  return statuses;
}

function originOf(server: ViteDevServer): string {
  const address = server.httpServer?.address();
  if (address === null || address === undefined || typeof address === 'string') {
    throw new Error('the stand-in server has no port');
  }
  return `http://127.0.0.1:${String(address.port)}`;
}

const moduleRequire = createRequire(import.meta.url);

function packageDir(name: string): string {
  return path.dirname(moduleRequire.resolve(`${name}/package.json`));
}

async function writePackage(packageRoot: string): Promise<void> {
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(
    path.join(packageRoot, 'index.html'),
    '<!doctype html><script type="module" src="/main.js"></script>'
  );
  await writeFile(
    path.join(packageRoot, 'main.js'),
    "import React from 'react';\nexport const version = React.version;\nexport const later = () => import('./lazy.js');\n"
  );
  await writeFile(
    path.join(packageRoot, 'lazy.js'),
    "import { createRoot } from 'react-dom/client';\nexport { createRoot };\n"
  );
  await mkdir(path.join(packageRoot, 'fixture'));
  await writeFile(
    path.join(packageRoot, 'fixture', 'index.html'),
    '<!doctype html><script type="module" src="/main.js"></script>'
  );
  await writeFile(
    path.join(packageRoot, 'fixture', 'main.js'),
    "import React from 'react';\nexport const version = React.version;\n"
  );
  await mkdir(path.join(packageRoot, 'node_modules'));
  await symlink(packageDir('react'), path.join(packageRoot, 'node_modules', 'react'), 'junction');
  await symlink(
    packageDir('react-dom'),
    path.join(packageRoot, 'node_modules', 'react-dom'),
    'junction'
  );
}

/** A plugin that makes the server's own close run `after` once Vite's close has finished. */
function closeThen(after: () => Promise<void>): Plugin {
  return {
    name: 'close-then',
    configureServer(server) {
      const close = server.close.bind(server);
      server.close = async () => {
        await close();
        await after();
      };
    },
  };
}

function closeFails(): Promise<void> {
  return Promise.reject(new Error('the server failed to close'));
}

/** A close that stays pending until the test releases it. */
function heldClose(): { hold: () => Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    hold: () => held,
    release: () => {
      release();
    },
  };
}

const CLOSE_BUDGET_MS = 200;

function elapse(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('startFixtureServer', () => {
  let packageRoot: string;
  let standIn: ViteDevServer | undefined;
  let fixture: FixtureServer | undefined;

  beforeEach(async () => {
    packageRoot = await mkdtemp(path.join(os.tmpdir(), 'fixture-server-package-'));
    await writePackage(packageRoot);
  });

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
    await standIn?.close();
    standIn = undefined;
    await rm(packageRoot, { recursive: true, force: true });
  }, SERVER_MS);

  it(
    "leaves a running package server's not-yet-loaded dependencies servable",
    async () => {
      standIn = await createServer({
        root: packageRoot,
        configFile: false,
        cacheDir: path.join(packageRoot, 'node_modules', '.vite'),
        logLevel: 'error',
        server: { port: 0, host: '127.0.0.1', hmr: false },
      });
      await standIn.listen();
      const standInOrigin = originOf(standIn);
      await loadWithDeps(standInOrigin, '/main.js');

      fixture = await startFixtureServer({ root: path.join(packageRoot, 'fixture') });
      await loadWithDeps(fixture.url, '/main.js');

      const lazy = await get(`${standInOrigin}/lazy.js`);
      const lazyDeps = depsUrls(standInOrigin, lazy.body);
      const replies = await Promise.all(lazyDeps.map((url) => get(url)));
      const statuses = replies.map((reply) => reply.status);

      expect(lazyDeps.length).toBeGreaterThan(0);
      expect(statuses).toStrictEqual(lazyDeps.map(() => 200));
    },
    SERVER_MS
  );

  it(
    'removes its cache folder when it closes',
    async () => {
      const started = await startFixtureServer({ root: path.join(packageRoot, 'fixture') });
      await loadWithDeps(started.url, '/main.js');

      await started.close();

      expect(existsSync(started.cacheDir)).toBe(false);
    },
    SERVER_MS
  );

  describe('a close that does not finish cleanly', () => {
    /** A server whose close awaits Vite's close before it removes the cache folder. */
    async function startSequentialCloser(
      plugin: Plugin
    ): Promise<{ cacheDir: string; close: () => Promise<void> }> {
      const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'fixture-server-control-'));
      const server = await createServer({
        root: path.join(packageRoot, 'fixture'),
        configFile: false,
        cacheDir,
        logLevel: 'error',
        plugins: [plugin],
        server: { port: 0, host: '127.0.0.1', hmr: false },
      });
      await server.listen();
      return {
        cacheDir,
        close: async () => {
          await server.close();
          await rm(cacheDir, { recursive: true, force: true });
        },
      };
    }

    it(
      'removes the cache folder when the server throws on close',
      async () => {
        const started = await startFixtureServer({
          root: path.join(packageRoot, 'fixture'),
          plugins: [closeThen(closeFails)],
        });

        await expect(started.close()).rejects.toThrow('the server failed to close');
        expect(existsSync(started.cacheDir)).toBe(false);
      },
      SERVER_MS
    );

    it(
      'leaves the folder behind under a close that awaits the server first, when the server throws — control',
      async () => {
        const control = await startSequentialCloser(closeThen(closeFails));
        try {
          await expect(control.close()).rejects.toThrow('the server failed to close');
          expect(existsSync(control.cacheDir)).toBe(true);
        } finally {
          await rm(control.cacheDir, { recursive: true, force: true });
        }
      },
      SERVER_MS
    );

    it(
      'removes the cache folder when the server is still closing at the end of its budget',
      async () => {
        const held = heldClose();
        const started = await startFixtureServer({
          root: path.join(packageRoot, 'fixture'),
          plugins: [closeThen(held.hold)],
          closeBudgetMs: CLOSE_BUDGET_MS,
        });
        try {
          await expect(started.close()).rejects.toThrow(
            `the fixture server did not close within ${String(CLOSE_BUDGET_MS)}ms`
          );
          expect(existsSync(started.cacheDir)).toBe(false);
        } finally {
          held.release();
        }
      },
      SERVER_MS
    );

    it(
      'leaves the folder behind under a close that awaits the server first, when the server is still closing at the end of the budget — control',
      async () => {
        const held = heldClose();
        const control = await startSequentialCloser(closeThen(held.hold));
        const closing = control.close();
        try {
          await elapse(CLOSE_BUDGET_MS);
          expect(existsSync(control.cacheDir)).toBe(true);
        } finally {
          held.release();
          await closing;
        }
      },
      SERVER_MS
    );
  });

  describe('a server that fails to start', () => {
    it(
      'removes the cache folder when Vite refuses the config',
      async () => {
        const seen: { cacheDir?: string } = {};
        const refuseConfig: Plugin = {
          name: 'refuse-config',
          configResolved(config) {
            seen.cacheDir = config.cacheDir;
            throw new Error('the config was refused');
          },
        };

        await expect(
          startFixtureServer({ root: path.join(packageRoot, 'fixture'), plugins: [refuseConfig] })
        ).rejects.toThrow('the config was refused');
        expect(seen.cacheDir).toBeDefined();
        expect(existsSync(seen.cacheDir ?? '')).toBe(false);
      },
      SERVER_MS
    );

    it(
      'closes the server and removes the cache folder when it cannot listen',
      async () => {
        const seen: { server?: ViteDevServer; closed: boolean } = { closed: false };
        const refuseListen: Plugin = {
          name: 'refuse-listen',
          configureServer(server) {
            seen.server = server;
            const close = server.close.bind(server);
            server.close = async () => {
              seen.closed = true;
              await close();
            };
            server.listen = () => Promise.reject(new Error('the port was refused'));
          },
        };

        await expect(
          startFixtureServer({ root: path.join(packageRoot, 'fixture'), plugins: [refuseListen] })
        ).rejects.toThrow('the port was refused');
        expect(seen.closed).toBe(true);
        expect(existsSync(seen.server?.config.cacheDir ?? '')).toBe(false);
      },
      SERVER_MS
    );

    it(
      'stops listening and removes the cache folder when the server reports no port',
      async () => {
        const seen: { server?: ViteDevServer } = {};
        const hidePort: Plugin = {
          name: 'hide-port',
          configureServer(server) {
            seen.server = server;
            const listen = server.listen.bind(server);
            server.listen = async (...args) => {
              const listening = await listen(...args);
              if (listening.httpServer !== null) listening.httpServer.address = () => null;
              return listening;
            };
          },
        };

        await expect(
          startFixtureServer({ root: path.join(packageRoot, 'fixture'), plugins: [hidePort] })
        ).rejects.toThrow('fixture server has no port');
        expect(seen.server?.httpServer?.listening).toBe(false);
        expect(existsSync(seen.server?.config.cacheDir ?? '')).toBe(false);
      },
      SERVER_MS
    );
  });
});

describe('the default close budget', () => {
  it('runs out before the hook that awaits the close is abandoned', () => {
    expect(DEFAULT_CLOSE_BUDGET_MS).toBeLessThan(HOOK_TIMEOUT_MS);
  });
});
