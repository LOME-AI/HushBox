import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Mode } from '@hushbox/shared';
import { e2eOutputDir } from './e2e-clean.js';
import { stackModeFor } from './generate-env.js';
import { claimsDir } from './lib/claims/registry.js';
import { E2E_PROJECTS } from './lib/playwright/projects.js';
import { TMPFS_MAGIC, ramPathsFor, ramRootRequiredBytes } from './lib/stack/ram-root.js';
import { ENV_MODE_VARIABLE } from './with-env.js';
import type { E2eRamPaths, RamRootDeps, RamRootHost, ReadStatfs } from './lib/stack/ram-root.js';
import type { PlaywrightTestConfig } from '@playwright/test';

/**
 * The Playwright config is a module that reads the environment as it loads, so
 * it is exercised by loading it — each case installs an environment and imports
 * it fresh. It lives at the repo root, which belongs to no workspace and so has
 * no test project of its own; this package is the one that already owns the
 * helpers the config is built from.
 */
const PORTS = {
  preview: '11111',
  api: '22222',
  admin: '33333',
  sandbox: '44444',
} as const;

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/** The variable Playwright sets in each of its worker processes, and only there. */
const WORKER_MARKER = 'TEST_WORKER_INDEX';

const BLOCK_SIZE = 4096;

/**
 * The machine the config resolves its RAM root on. The resolver's own host is
 * the live `/dev/shm`, where no test writes, so every case stands the config on
 * a scratch parent directory and a filesystem reading of its choosing instead.
 */
const machine = vi.hoisted(() => ({
  host: undefined as RamRootHost | undefined,
  statfs: undefined as ReadStatfs | undefined,
}));

vi.mock('./lib/stack/ram-root.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/stack/ram-root.js')>();
  const host = (): RamRootHost => {
    if (machine.host === undefined) throw new Error('no case has stood the config on a host');
    return machine.host;
  };
  return {
    ...actual,
    ramPathsFor: (checkout: string, onHost: RamRootHost = host()): E2eRamPaths | undefined =>
      actual.ramPathsFor(checkout, onHost),
    e2eRamPaths: (): E2eRamPaths | undefined => actual.ramPathsFor(REPO_ROOT, host()),
    prepareRamRoot: (
      checkout: string,
      requiredBytes: number,
      deps: RamRootDeps = {}
    ): Promise<E2eRamPaths | undefined> =>
      actual.prepareRamRoot(checkout, requiredBytes, {
        host: host(),
        ...(machine.statfs === undefined ? {} : { statfs: machine.statfs }),
        ...deps,
      }),
  };
});

/** A tmpfs with `freeBytes` available, whatever the path asked about. */
function tmpfsWithFree(freeBytes: number): ReadStatfs {
  return () =>
    Promise.resolve({ type: TMPFS_MAGIC, bsize: BLOCK_SIZE, bavail: freeBytes / BLOCK_SIZE });
}

function loadConfig(): Promise<{ default: PlaywrightTestConfig }> {
  vi.resetModules();
  return import('../playwright.config.js') as Promise<{ default: PlaywrightTestConfig }>;
}

/** The servers Playwright starts, as the config declares them. */
function serverText(config: PlaywrightTestConfig, name: string): string {
  const servers = (config.webServer ?? []) as { name?: string; command: string; url?: string }[];
  const server = servers.find((candidate) => candidate.name === name);
  return `${server?.command ?? ''} ${server?.url ?? ''}`;
}

/** The RAM paths the config resolves on the case's host. */
function ramPaths(): E2eRamPaths {
  const paths = ramPathsFor(REPO_ROOT, machine.host);
  if (paths === undefined) throw new Error('the case’s host resolves no RAM root');
  return paths;
}

let scratchParent = '';

beforeEach(async () => {
  vi.stubEnv('HB_PREVIEW_PORT', PORTS.preview);
  vi.stubEnv('HB_API_PORT', PORTS.api);
  vi.stubEnv('HB_ADMIN_PORT', PORTS.admin);
  vi.stubEnv('HB_SANDBOX_PORT', PORTS.sandbox);
  vi.stubEnv(ENV_MODE_VARIABLE, stackModeFor(Mode.E2E));
  // Registered so the restore below puts back whatever a worker case assigns.
  vi.stubEnv('TMPDIR', process.env['TMPDIR']);
  scratchParent = await mkdtemp(path.join(os.tmpdir(), 'playwright-config-ram-'));
  machine.host = { platform: 'linux', parent: scratchParent };
  machine.statfs = tmpfsWithFree(Number.MAX_SAFE_INTEGER - (Number.MAX_SAFE_INTEGER % BLOCK_SIZE));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  machine.host = undefined;
  machine.statfs = undefined;
  await rm(scratchParent, { recursive: true, force: true });
});

describe('the Playwright config and the stack it runs against', () => {
  it('demands the end-to-end stack of the run, ahead of the suite’s own global setup', async () => {
    const { default: config } = await loadConfig();

    expect([config.globalSetup].flat()).toEqual([
      './scripts/lib/playwright/require-e2e-stack.ts',
      './e2e/global-setup.ts',
    ]);
  });

  it('still loads under another stack, so a tool that only reads it is not refused', async () => {
    // knip resolves this repo's entry points by loading this config, and its
    // own command names no env mode, so it loads the default stack's env files.
    vi.stubEnv(ENV_MODE_VARIABLE, stackModeFor(Mode.Development));

    await expect(loadConfig()).resolves.toBeDefined();
  });

  it('serves the browser its base URL on the preview port of that stack', async () => {
    const { default: config } = await loadConfig();

    expect(config.use?.baseURL).toContain(PORTS.preview);
  });

  it('starts each server of the run on that stack’s port for it', async () => {
    const { default: config } = await loadConfig();

    expect(serverText(config, 'Preview')).toContain(PORTS.preview);
    expect(serverText(config, 'API')).toContain(PORTS.api);
    expect(serverText(config, 'Admin')).toContain(PORTS.admin);
    expect(serverText(config, 'Sandbox')).toContain(PORTS.sandbox);
  });
});

describe('the temporary directory of a Playwright worker', () => {
  it('is the RAM root’s browser temporary directory on Linux', async () => {
    vi.stubEnv(WORKER_MARKER, '3');

    await loadConfig();

    expect(process.env['TMPDIR']).toBe(ramPaths().browserTmp);
  });

  it('is created where it is absent', async () => {
    vi.stubEnv(WORKER_MARKER, '3');

    await loadConfig();

    expect(existsSync(ramPaths().browserTmp)).toBe(true);
  });

  it.each(['darwin', 'win32'] as const)('is left as it was on %s', async (platform) => {
    machine.host = { platform, parent: scratchParent };
    vi.stubEnv(WORKER_MARKER, '3');
    const before = process.env['TMPDIR'];

    await loadConfig();

    expect(process.env['TMPDIR']).toBe(before);
  });

  it('is assigned without the runner’s capacity check', async () => {
    vi.stubEnv(WORKER_MARKER, '3');
    machine.statfs = tmpfsWithFree(0);

    await expect(loadConfig()).resolves.toBeDefined();
  });
});

describe('the runner’s temporary directory', () => {
  it('is left as it was', async () => {
    const before = process.env['TMPDIR'];

    await loadConfig();

    expect(process.env['TMPDIR']).toBe(before);
  });

  it('keeps the machine-wide claims registry where every other process finds it', async () => {
    const before = claimsDir();

    await loadConfig();

    expect(claimsDir()).toBe(before);
  });
});

describe('the runner’s RAM root capacity check', () => {
  /** The run's worker count, read off a load that runs no check. */
  async function runWorkers(): Promise<number> {
    vi.stubEnv(ENV_MODE_VARIABLE, stackModeFor(Mode.Development));
    const { default: config } = await loadConfig();
    vi.stubEnv(ENV_MODE_VARIABLE, stackModeFor(Mode.E2E));
    if (typeof config.workers !== 'number') throw new Error('the config states no worker count');
    return config.workers;
  }

  it('refuses a RAM root one block short of the room the run’s workers need', async () => {
    machine.statfs = tmpfsWithFree(ramRootRequiredBytes(await runWorkers()) - BLOCK_SIZE);

    await expect(loadConfig()).rejects.toThrow(/Raise the shared-memory size/);
  });

  it('admits a RAM root with exactly the room the run’s workers need', async () => {
    machine.statfs = tmpfsWithFree(ramRootRequiredBytes(await runWorkers()));

    await expect(loadConfig()).resolves.toBeDefined();
  });

  it('is not run for a load under another stack', async () => {
    vi.stubEnv(ENV_MODE_VARIABLE, stackModeFor(Mode.Development));
    machine.statfs = tmpfsWithFree(0);

    await expect(loadConfig()).resolves.toBeDefined();
  });

  it.each(['darwin', 'win32'] as const)('is not run on %s', async (platform) => {
    machine.host = { platform, parent: scratchParent };
    machine.statfs = tmpfsWithFree(0);

    await expect(loadConfig()).resolves.toBeDefined();
  });
});

/**
 * Playwright runs the projects that depend on nothing first, all of them, and
 * starts no dependent project until every one of those has finished. A project
 * that runs specs and depends on nothing therefore shares that first phase with
 * the setup projects, and one of its tests that hangs holds every browser
 * project idle behind it. The registry is what names the projects that run
 * specs; every other project the config declares is a setup project.
 */
describe('the project dependency graph', () => {
  const RUNS_SPECS: ReadonlySet<string> = new Set(E2E_PROJECTS.map((project) => project.name));

  it('makes every project that runs specs wait on at least one other project', async () => {
    const { default: config } = await loadConfig();
    const runningSpecs = (config.projects ?? []).filter((project) =>
      RUNS_SPECS.has(project.name ?? '')
    );

    expect(runningSpecs).toHaveLength(RUNS_SPECS.size);
    for (const project of runningSpecs) {
      expect(project.dependencies ?? [], project.name).not.toHaveLength(0);
    }
  });

  it('makes every project another waits on a project that waits on nothing', async () => {
    const { default: config } = await loadConfig();
    const projects = config.projects ?? [];

    for (const dependency of projects.flatMap((project) => project.dependencies ?? [])) {
      const waitedOn = projects.find((project) => project.name === dependency);
      expect(waitedOn, dependency).toBeDefined();
      expect(waitedOn?.dependencies ?? [], dependency).toHaveLength(0);
    }
  });
});

describe('the Firefox project', () => {
  it('turns the disk cache off', async () => {
    const { default: config } = await loadConfig();

    const firefox = config.projects?.find((project) => project.name === 'firefox');

    expect(firefox?.use?.launchOptions?.firefoxUserPrefs?.['browser.cache.disk.enable']).toBe(
      false
    );
  });
});

describe('the output directory', () => {
  it('is the RAM root’s test output directory on Linux', async () => {
    const { default: config } = await loadConfig();

    expect(config.outputDir).toBe(ramPaths().testResults);
  });

  it('is the one e2e-clean clears on Linux', async () => {
    const { default: config } = await loadConfig();

    expect(config.outputDir).toBe(e2eOutputDir(machine.host));
  });

  it.each(['darwin', 'win32'] as const)(
    'is left to Playwright’s default, the repository’s test-results directory, on %s',
    async (platform) => {
      machine.host = { platform, parent: scratchParent };

      const { default: config } = await loadConfig();

      expect(config.outputDir).toBeUndefined();
    }
  );
});
