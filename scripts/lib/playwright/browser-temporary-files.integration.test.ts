import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, readlink, rm, statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, firefox, type Browser, type LaunchOptions } from '@playwright/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Mode } from '@hushbox/shared';
import { stackModeFor } from '../../generate-env.js';
import { ENV_MODE_VARIABLE } from '../../with-env.js';
import { TMPFS_MAGIC, prepareRamRoot, ramPathsFor } from '../stack/ram-root.js';
import type { E2eRamPaths } from '../stack/ram-root.js';
import type { PlaywrightTestConfig } from '@playwright/test';

/**
 * Where the browsers a Playwright worker launches keep their hot files, asked
 * of the browsers themselves rather than reasoned about: Chromium's shared
 * memory follows the temporary directory it inherits, and Playwright makes
 * Firefox's profile in the temporary directory of the process that launches it.
 * The config gives a worker a RAM directory for both, so each case loads the
 * config as a worker does and launches the browser as that project does.
 *
 * The worker's RAM root is never the live one. It is the root the resolver makes
 * for a scratch checkout this case owns, so it sits beside the E2E root on the
 * same tmpfs, and its owner file names a checkout that is gone once the case
 * ends, however it ends.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

/** What one arm may spend launching a browser, loading a page and closing it. */
const BROWSER_ARM_BUDGET_MS = 90_000;

const scratch = vi.hoisted(() => ({ checkout: '' }));

vi.mock('../stack/ram-root.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../stack/ram-root.js')>();
  return {
    ...actual,
    e2eRamPaths: (): E2eRamPaths | undefined => actual.ramPathsFor(scratch.checkout),
  };
});

let ramRoot: string | undefined;
let browser: Browser | undefined;
let server: Server | undefined;

beforeEach(async () => {
  scratch.checkout = await mkdtemp(path.join(os.tmpdir(), 'browser-tmp-checkout-'));
  // The case needs no room beyond one browser's files, so the refusal it can
  // meet is the one for a root that is not in RAM.
  const prepared = await prepareRamRoot(scratch.checkout, 0);
  ramRoot = prepared?.root;
  vi.stubEnv('HB_PREVIEW_PORT', '11111');
  vi.stubEnv('HB_API_PORT', '22222');
  vi.stubEnv('HB_ADMIN_PORT', '33333');
  vi.stubEnv('HB_SANDBOX_PORT', '44444');
  vi.stubEnv(ENV_MODE_VARIABLE, stackModeFor(Mode.E2E));
  vi.stubEnv('TEST_WORKER_INDEX', '0');
  vi.stubEnv('TMPDIR', process.env['TMPDIR']);
});

afterEach(async () => {
  try {
    await browser?.close();
    await new Promise<void>((resolve) => {
      if (server === undefined) resolve();
      else
        server.close(() => {
          resolve();
        });
    });
  } finally {
    browser = undefined;
    server = undefined;
    vi.unstubAllEnvs();
    if (ramRoot !== undefined) await rm(ramRoot, { recursive: true, force: true });
    ramRoot = undefined;
    await rm(scratch.checkout, { recursive: true, force: true });
  }
});

/** The launch options of a project, read off the config as a Playwright worker evaluates it. */
async function launchOptionsAsAWorker(project: string): Promise<LaunchOptions> {
  vi.resetModules();
  const loaded = (await import('../../../playwright.config.js')) as {
    default: PlaywrightTestConfig;
  };
  const found = loaded.default.projects?.find((candidate) => candidate.name === project);
  if (found === undefined) throw new Error(`the config defines no ${project} project`);
  return found.use?.launchOptions ?? {};
}

/** A local page that writes to localStorage, so the browser has storage to keep. */
async function servePageWritingStorage(): Promise<string> {
  const page =
    '<!doctype html><title>storage probe</title>' +
    "<script>localStorage.setItem('probe', 'x'.repeat(65536));</script>";
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(page);
  });
  const listening = server;
  await new Promise<void>((resolve) => listening.listen(0, '127.0.0.1', resolve));
  const address = listening.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');
  return `http://127.0.0.1:${String(address.port)}/`;
}

async function loadPageWritingStorage(launched: Browser): Promise<void> {
  const page = await launched.newPage();
  await page.goto(await servePageWritingStorage());
  await page.waitForFunction(() => localStorage.getItem('probe') !== null);
}

/** The parent of each process, from `/proc/<pid>/stat`, whose command name may hold spaces. */
async function parentOf(pid: string): Promise<string | undefined> {
  try {
    const stat = await readFile(path.join('/proc', pid, 'stat'), 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1];
  } catch {
    // The process exited between the listing and the read.
    return undefined;
  }
}

/** Every process descended from this one: the browsers this case launched and their children. */
async function descendantProcesses(): Promise<string[]> {
  const entries = await readdir('/proc');
  const pids = entries.filter((entry) => /^\d+$/.test(entry));
  const parents = new Map<string, string | undefined>();
  for (const pid of pids) parents.set(pid, await parentOf(pid));
  const found = new Set([String(process.pid)]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, parent] of parents) {
      if (parent !== undefined && found.has(parent) && !found.has(pid)) {
        found.add(pid);
        grew = true;
      }
    }
  }
  found.delete(String(process.pid));
  return [...found];
}

/** Each open descriptor of a process, with the path it names; none where the process has gone. */
async function descriptorsOf(pid: string): Promise<{ descriptor: string; target: string }[]> {
  const directory = path.join('/proc', pid, 'fd');
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    // The process exited between the listing and the read.
    return [];
  }
  const descriptors: { descriptor: string; target: string }[] = [];
  for (const entry of entries) {
    const descriptor = path.join(directory, entry);
    try {
      descriptors.push({ descriptor, target: await readlink(descriptor) });
    } catch {
      // The descriptor closed between the listing and the read.
    }
  }
  return descriptors;
}

/**
 * The filesystem type of each file that still exists: a browser removes its own
 * temporary files as it goes, so one listed a moment ago may be gone.
 */
async function filesystemTypes(files: readonly string[]): Promise<number[]> {
  const types: number[] = [];
  for (const file of files) {
    try {
      const reading = await statfs(file);
      types.push(reading.type);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return types;
}

/** The value after `-profile` on a Firefox command line this case started. */
async function firefoxProfile(): Promise<string> {
  for (const pid of await descendantProcesses()) {
    const commandLine = await readFile(path.join('/proc', pid, 'cmdline'), 'utf8').catch(
      // The process exited between the listing and the read.
      () => ''
    );
    const argv = commandLine.split('\0').filter((argument) => argument !== '');
    const at = argv.indexOf('-profile');
    const profile = at === -1 ? undefined : argv[at + 1];
    if (profile !== undefined) return profile;
  }
  throw new Error('no Firefox process of this case names a profile');
}

describe('the browsers of a Playwright worker on Linux', () => {
  it.runIf(process.platform === 'linux')(
    'keep every Chromium shared-memory file on a RAM filesystem',
    async () => {
      browser = await chromium.launch(await launchOptionsAsAWorker('chromium'));
      await loadPageWritingStorage(browser);

      const sharedMemory = [];
      for (const pid of await descendantProcesses()) {
        for (const open of await descriptorsOf(pid)) {
          if (path.basename(open.target).startsWith('.org.chromium.Chromium.')) {
            sharedMemory.push(open.descriptor);
          }
        }
      }
      const types = await filesystemTypes(sharedMemory);

      expect(types.length).toBeGreaterThan(0);
      expect(types.filter((type) => type !== TMPFS_MAGIC)).toEqual([]);
    },
    BROWSER_ARM_BUDGET_MS
  );

  it.runIf(process.platform === 'linux')(
    'keep every file of the Firefox profile on a RAM filesystem',
    async () => {
      browser = await firefox.launch(await launchOptionsAsAWorker('firefox'));
      await loadPageWritingStorage(browser);

      const profile = await firefoxProfile();
      const entries = await readdir(profile, { recursive: true, withFileTypes: true });
      const files = entries
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(entry.parentPath, entry.name));
      const types = await filesystemTypes(files);

      expect(types.length).toBeGreaterThan(0);
      expect(types.filter((type) => type !== TMPFS_MAGIC)).toEqual([]);
    },
    BROWSER_ARM_BUDGET_MS
  );
});

describe('the RAM root a case gives its worker', () => {
  it.runIf(process.platform === 'linux')('sits beside the E2E root, on the same parent', () => {
    expect(path.dirname(ramRoot ?? '')).toBe(path.dirname(ramPathsFor(REPO_ROOT)?.root ?? ''));
  });
});
