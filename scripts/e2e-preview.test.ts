import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tryLock } from './lib/claims/claim.js';
import { buildLeasePath } from './lib/bundling/lease.js';
import { snapshotsDir } from './lib/bundling/bundle-snapshot.js';
import { ramPathsFor } from './lib/stack/ram-root.js';
import { readApp, readPort, readPrebuilt, runE2ePreview } from './e2e-preview.js';
import type { E2ePreviewDeps } from './e2e-preview.js';
import type { RamRootHost } from './lib/stack/ram-root.js';

let repoRoot: string;
let calls: { file: string; args: readonly string[] }[];
let ramParent: string;
/** Where every snapshot here is made: a scratch directory standing in for the RAM filesystem. */
let ramHost: RamRootHost;

async function seedDistribution(app: string, contents: string): Promise<void> {
  const distribution = path.join(repoRoot, 'apps', app, 'dist');
  await fs.mkdir(distribution, { recursive: true });
  await fs.writeFile(path.join(distribution, 'index.html'), contents);
}

function recordingExec(
  onCall: (file: string, args: readonly string[]) => Promise<number> | number = () => 0
): E2ePreviewDeps {
  return {
    exec: async (file, args) => {
      calls.push({ file, args });
      return onCall(file, args);
    },
    ramHost,
  };
}

/** The `--outDir` the preview was told to serve. */
function servedDir(): string {
  const preview = calls.find((call) => call.args.includes('preview'));
  const flag = preview?.args.indexOf('--outDir') ?? -1;
  return preview?.args[flag + 1] ?? '';
}

/**
 * The RAM root a test made for its scratch checkout on the machine's own
 * shared-memory filesystem, removed so a failing run leaves nothing there. No
 * test here should make one: each serves its snapshot under {@link ramHost}.
 */
async function removeMachineRamRoot(checkout: string): Promise<string | undefined> {
  const root = ramPathsFor(checkout)?.root;
  if (root === undefined || !existsSync(root)) return undefined;
  await fs.rm(root, { recursive: true, force: true });
  return root;
}

beforeEach(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-preview-'));
  ramParent = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-preview-ram-'));
  ramHost = { platform: 'linux', parent: ramParent };
  calls = [];
  await seedDistribution('web', 'web bundle');
  await seedDistribution('admin', 'admin bundle');
});

afterEach(async () => {
  // Named while the scratch checkout still exists, since its canonical path is
  // what names its RAM root.
  const leftOnMachine = await removeMachineRamRoot(repoRoot);
  await fs.rm(ramParent, { recursive: true, force: true });
  await fs.rm(repoRoot, { recursive: true, force: true });
  expect(leftOnMachine, 'a RAM root on the machine’s shared-memory filesystem').toBeUndefined();
});

describe('readApp', () => {
  it('reads the web bundle', () => {
    expect(readApp(['--app=web', '--port=1'])).toBe('web');
  });

  it('reads the admin bundle', () => {
    expect(readApp(['--app=admin', '--port=1'])).toBe('admin');
  });

  it('rejects an invocation naming no bundle', () => {
    expect(() => readApp(['--port=1'])).toThrow(/nothing/);
  });

  it('rejects a bundle it does not serve', () => {
    expect(() => readApp(['--app=marketing'])).toThrow(/marketing/);
  });

  it('names no app for a line asking for usage', () => {
    expect(() => readApp(['--help'])).toThrow(/nothing/);
  });

  it('refuses a flag it does not recognise', () => {
    expect(() => readApp(['--app=web', '--verbose'])).toThrow(/--verbose/);
  });
});

describe('readPort', () => {
  it('reads the port to serve on', () => {
    expect(readPort(['--app=web', '--port=4173'])).toBe('4173');
  });

  it('rejects an invocation with no port', () => {
    expect(() => readPort(['--app=web'])).toThrow(/port/);
  });
});

describe('readPrebuilt', () => {
  it('takes the flag as a bundle that is already built', () => {
    expect(readPrebuilt(['--app=web', '--port=1', '--prebuilt'])).toBe(true);
  });

  it('builds when nothing says the bundle is already built', () => {
    expect(readPrebuilt(['--app=web', '--port=1'])).toBe(false);
  });

  it('reads a line asking for usage as no prebuilt bundle', () => {
    expect(readPrebuilt(['--help'])).toBe(false);
  });
});

describe('runE2ePreview', () => {
  it('builds the bundle before serving it', async () => {
    await runE2ePreview(repoRoot, { app: 'web', port: '4173', prebuilt: false }, recordingExec());
    expect(calls.map((call) => call.args[0])).toEqual(['build:e2e', '--filter']);
  });

  it('builds the admin bundle through its own build script', async () => {
    await runE2ePreview(repoRoot, { app: 'admin', port: '4174', prebuilt: false }, recordingExec());
    expect(calls[0]?.args).toEqual(['build:e2e:admin']);
  });

  it('serves the package the bundle belongs to', async () => {
    await runE2ePreview(repoRoot, { app: 'admin', port: '4174', prebuilt: false }, recordingExec());
    expect(calls[1]?.args).toContain('@hushbox/admin');
  });

  it('serves on the port it was given', async () => {
    await runE2ePreview(repoRoot, { app: 'web', port: '4173', prebuilt: false }, recordingExec());
    expect(calls[1]?.args).toContain('4173');
  });

  it('serves a snapshot rather than the built output', async () => {
    await runE2ePreview(repoRoot, { app: 'web', port: '4173', prebuilt: false }, recordingExec());
    expect(path.dirname(servedDir())).toBe(snapshotsDir(repoRoot, ramHost));
  });

  it('serves the bytes the build produced', async () => {
    let served = '';
    await runE2ePreview(
      repoRoot,
      { app: 'web', port: '4173', prebuilt: false },
      recordingExec(async (_file, args) => {
        if (args.includes('preview')) {
          served = await fs.readFile(path.join(servedDir(), 'index.html'), 'utf8');
        }
        return 0;
      })
    );
    expect(served).toBe('web bundle');
  });

  it('leaves the build lease free while it serves', async () => {
    let heldDuringServe = true;
    await runE2ePreview(
      repoRoot,
      { app: 'web', port: '4173', prebuilt: false },
      recordingExec(async (_file, args) => {
        if (args.includes('preview')) {
          const probe = await tryLock(buildLeasePath(repoRoot, 'web-dist'));
          heldDuringServe = probe.held;
        }
        return 0;
      })
    );
    expect(heldDuringServe).toBe(false);
  });

  it('skips the build when the bundle was already built elsewhere', async () => {
    await runE2ePreview(repoRoot, { app: 'web', port: '4173', prebuilt: true }, recordingExec());
    expect(calls.map((call) => call.args[0])).toEqual(['--filter']);
  });

  it('still serves a snapshot of an already-built bundle', async () => {
    await runE2ePreview(repoRoot, { app: 'web', port: '4173', prebuilt: true }, recordingExec());
    expect(path.dirname(servedDir())).toBe(snapshotsDir(repoRoot, ramHost));
  });

  it("returns the preview server's exit code", async () => {
    const code = await runE2ePreview(
      repoRoot,
      { app: 'web', port: '4173', prebuilt: false },
      recordingExec((_file, args) => (args.includes('preview') ? 7 : 0))
    );
    expect(code).toBe(7);
  });

  it('refuses to serve a bundle whose build failed', async () => {
    await expect(
      runE2ePreview(
        repoRoot,
        { app: 'web', port: '4173', prebuilt: false },
        recordingExec((_file, args) => (args.includes('build:e2e') ? 2 : 0))
      )
    ).rejects.toThrow(/build:e2e/);
    expect(calls.map((call) => call.args[0])).toEqual(['build:e2e']);
  });
});
