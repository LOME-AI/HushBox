import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { TIMEOUTS } from '../../config/timeouts.js';
import { killTree, untilChildExit } from '../../../scripts/lib/spawn/long-lived.js';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

const ADMIN_DIRECTORY = fileURLToPath(new URL('../../../apps/admin/', import.meta.url));

/**
 * Vite's entry point, resolved through the admin package that declares it,
 * because the suite's own package does not.
 */
const VITE_ENTRY = path.join(
  path.dirname(
    createRequire(path.join(ADMIN_DIRECTORY, 'package.json')).resolve('vite/package.json')
  ),
  'bin',
  'vite.js'
);

/** The status the development server answers its root document with. */
const SERVING = 200;

/** A port nothing holds when it is read. The dev server binds it strictly, so a race is loud. */
async function freePort(): Promise<number> {
  const probe = net.createServer();
  try {
    return await new Promise<number>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('the port probe bound no inet address'));
          return;
        }
        resolve(address.port);
      });
    });
  } finally {
    await new Promise<void>((resolve) => {
      probe.close(() => {
        resolve();
      });
    });
  }
}

/**
 * What one request to `url` observed: the status it was answered with, or the
 * reason it was not.
 *
 * Every attempt shares the one deadline, so a request the server accepts and
 * then never answers cannot push the wait past it — with a deadline per
 * attempt the wait would be bounded by the deadline times the attempts.
 */
async function observe(url: string, deadline: AbortSignal): Promise<number | string> {
  try {
    const response = await fetch(url, { signal: deadline });
    return response.status;
  } catch (error) {
    const { cause } = error as { cause?: NodeJS.ErrnoException };
    return cause?.code ?? (error as Error).name;
  }
}

/**
 * Resolves once the server answers its own root URL; rejects the moment the
 * child exits instead, and rejects on its own deadline otherwise.
 *
 * Readiness is asking the server rather than matching what it printed. Printed
 * output is a rendering chosen for humans — it is colorized, buffered and
 * reworded without notice, and none of that is a breaking change to anyone but
 * a reader of it. Measured on this tree, with `FORCE_COLOR` in the
 * environment, Vite bolds the port and puts escape bytes between the colon and
 * the digits, so a substring of the banner is absent while the server is
 * serving.
 *
 * Every failure carries everything the server printed, because that output is
 * the artefact that explains the failure, and a check whose failure discards
 * its own evidence costs more to diagnose than the defect it watches for.
 */
async function serving(
  child: ChildProcessByStdio<null, Readable, Readable>,
  url: string,
  printed: () => string
): Promise<void> {
  const died = new Promise<never>((_resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => {
      reject(
        new Error(`the admin development server exited before answering ${url}:\n${printed()}`)
      );
    });
  });
  await Promise.race([answered(url, printed), died]);
}

/**
 * Asks the server, under the one deadline, and turns the deadline expiring
 * into a failure that names the URL waited for and everything the server
 * printed while it was waited on.
 */
async function answered(url: string, printed: () => string): Promise<void> {
  const deadline = AbortSignal.timeout(TIMEOUTS.DEV_SERVER_ANSWERS);
  try {
    await expect
      .poll(() => observe(url, deadline), { timeout: TIMEOUTS.DEV_SERVER_ANSWERS })
      .toBe(SERVING);
  } catch (error) {
    throw new Error(
      `the admin development server did not answer ${url} with ${String(SERVING)} within ` +
        `${String(TIMEOUTS.DEV_SERVER_ANSWERS)} ms of the spawn; it printed:\n${printed()}`,
      { cause: error }
    );
  }
}

/** A running development server, and the one way to end it. */
interface AdminDevServer {
  /** The origin it answers on. */
  readonly url: string;
  /** Ends the server's whole process tree and waits for it to be gone. */
  stop: () => Promise<void>;
}

/**
 * The admin package's own development server — `pnpm --filter @hushbox/admin
 * dev` run through Vite's entry point — on a port of its own, already
 * answering.
 *
 * A server that never answers is stopped here rather than handed back, so a
 * caller holding one of these holds a server that served at least once.
 */
export async function startAdminDevServer(): Promise<AdminDevServer> {
  const port = await freePort();
  const child = spawn(process.execPath, [VITE_ENTRY], {
    cwd: ADMIN_DIRECTORY,
    env: { ...process.env, HB_ADMIN_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group on POSIX, which is what `killTree` addresses: it
    // signals the negated group id, so whatever the server started ends with
    // it. On Windows `detached` would drop libuv's job object, and `killTree`
    // reaches the tree with `taskkill /T /F` there instead.
    detached: process.platform !== 'win32',
  });
  let printed = '';
  const collect = (chunk: Buffer): void => {
    printed += chunk.toString();
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  const stop = async (): Promise<void> => {
    // No pid means the spawn itself failed, so there is no tree to end and no
    // exit to wait for — waiting on an event a failed spawn never fires is the
    // hang this file exists to avoid.
    if (child.pid === undefined) return;
    killTree(child.pid, 'SIGKILL');
    await untilChildExit(child);
  };

  const url = `http://localhost:${String(port)}`;
  try {
    await serving(child, url, () => printed);
  } catch (error) {
    await stop();
    throw error;
  }
  return { url, stop };
}
