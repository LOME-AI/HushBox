import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HELD_CLAIMS_ENV, tryLock } from '../claims/claim.js';
import { ramPathsFor } from '../stack/ram-root.js';
import { buildLeasePath, withBuildLease } from './lease.js';
import {
  reclaimExpiredSnapshots,
  snapshotLockPath,
  snapshotsDir,
  withBundleSnapshot,
} from './bundle-snapshot.js';
import type { RamRootHost } from '../stack/ram-root.js';
import type { Readable, Writable } from 'node:stream';

/**
 * A snapshot outlives the run that made it only when that run was killed, so
 * the reclamation tests need a real second process to kill. The fixture is the
 * claim primitive's own holder, which is all a snapshot's owner is.
 */
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const HOLDER_ENTRY = fileURLToPath(new URL('../claims/claim-holder-entry.mjs', import.meta.url));

type HolderProcess = ChildProcessByStdio<Writable, Readable, null>;

let repoRoot: string;
let source: string;
let holders: HolderProcess[];
let ramParent: string;
/** Where every snapshot here is made: a scratch directory standing in for the RAM filesystem. */
let ramHost: RamRootHost;

function waitForExit(child: HolderProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => {
      resolve();
    });
  });
}

/** Starts a process holding the snapshot `id`, resolving once it holds it. */
async function startOwner(id: string): Promise<HolderProcess> {
  const child = spawn(
    process.execPath,
    [
      '--import',
      TSX_LOADER,
      HOLDER_ENTRY,
      snapshotLockPath(repoRoot, id, ramHost),
      id,
      'pnpm e2e',
      'refuse',
    ],
    { env: { ...process.env, [HELD_CLAIMS_ENV]: '' }, stdio: ['pipe', 'pipe', 'inherit'] }
  );
  holders.push(child);
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', () => {
      resolve();
    });
    child.once('error', reject);
    child.once('exit', () => {
      resolve();
    });
  });
  return child;
}

/** A snapshot directory an owner made, so reclamation has something to find. */
async function plantSnapshot(id: string): Promise<string> {
  const dir = path.join(snapshotsDir(repoRoot, ramHost), id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'index.html'), 'served');
  return dir;
}

/**
 * The RAM root a test made for its scratch checkout on the machine's own
 * shared-memory filesystem, removed so a failing run leaves nothing there. No
 * test here should make one: each makes its snapshots under {@link ramHost}.
 */
async function removeMachineRamRoot(checkout: string): Promise<string | undefined> {
  const root = ramPathsFor(checkout)?.root;
  if (root === undefined || !existsSync(root)) return undefined;
  await fs.rm(root, { recursive: true, force: true });
  return root;
}

beforeEach(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bundle-snapshot-'));
  ramParent = await fs.mkdtemp(path.join(os.tmpdir(), 'bundle-snapshot-ram-'));
  ramHost = { platform: 'linux', parent: ramParent };
  source = path.join(repoRoot, 'apps', 'web', 'dist');
  holders = [];
  await fs.mkdir(path.join(source, 'welcome'), { recursive: true });
  await fs.writeFile(path.join(source, 'index.html'), 'built');
  await fs.writeFile(path.join(source, 'welcome', 'index.html'), 'welcome');
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of holders) {
    child.kill('SIGKILL');
    await waitForExit(child);
  }
  // Named while the scratch checkout still exists, since its canonical path is
  // what names its RAM root.
  const leftOnMachine = await removeMachineRamRoot(repoRoot);
  await fs.rm(ramParent, { recursive: true, force: true });
  await fs.rm(repoRoot, { recursive: true, force: true });
  expect(leftOnMachine, 'a RAM root on the machine’s shared-memory filesystem').toBeUndefined();
});

function options(
  produce: () => Promise<void> = () => Promise.resolve()
): Parameters<typeof withBundleSnapshot>[0] {
  return { repoRoot, resource: 'web-dist', source, holder: 'pnpm e2e', produce, ramHost };
}

describe('snapshotsDir', () => {
  it('is in the checkout’s RAM root on Linux', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const ramRoot = ramPathsFor(repoRoot)?.root ?? '';

    expect(path.relative(ramRoot, snapshotsDir(repoRoot))).not.toMatch(/^\.\.|^$/);
  });

  it('is in the checkout’s RAM root on the host it is given', () => {
    const ramRoot = ramPathsFor(repoRoot, ramHost)?.root ?? '';

    expect(path.relative(ramRoot, snapshotsDir(repoRoot, ramHost))).not.toMatch(/^\.\.|^$/);
  });

  it.each(['darwin', 'win32'] as const)(
    'is beside the checkout’s other runtime cache files on %s',
    (platform) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);

      expect(snapshotsDir(repoRoot)).toBe(
        path.join(repoRoot, 'scripts', '.cache', 'dist-snapshots')
      );
    }
  );
});

describe('withBundleSnapshot', () => {
  it('serves a copy of the built output rather than the output itself', async () => {
    let served = '';
    await withBundleSnapshot(options(), async (snapshot) => {
      served = await fs.readFile(path.join(snapshot, 'index.html'), 'utf8');
    });
    expect(served).toBe('built');
  });

  it('copies the whole tree, not just its top level', async () => {
    let served = '';
    await withBundleSnapshot(options(), async (snapshot) => {
      served = await fs.readFile(path.join(snapshot, 'welcome', 'index.html'), 'utf8');
    });
    expect(served).toBe('welcome');
  });

  it('serves from somewhere other than the built output', async () => {
    let servedDir = '';
    await withBundleSnapshot(options(), (snapshot) => {
      servedDir = snapshot;
      return Promise.resolve();
    });
    expect(servedDir).not.toBe(source);
  });

  it('holds the build lease while it produces the output', async () => {
    let heldDuringProduce = false;
    await withBundleSnapshot(
      options(async () => {
        const probe = await tryLock(buildLeasePath(repoRoot, 'web-dist'));
        heldDuringProduce = probe.held;
      }),
      () => Promise.resolve()
    );
    expect(heldDuringProduce).toBe(true);
  });

  it('creates the snapshot directory before it produces the output', async () => {
    let directoriesDuringProduce: string[] = [];
    let servedDir = '';
    await withBundleSnapshot(
      options(async () => {
        const entries = await fs.readdir(snapshotsDir(repoRoot, ramHost), {
          withFileTypes: true,
        });
        directoriesDuringProduce = entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      }),
      (snapshot) => {
        servedDir = snapshot;
        return Promise.resolve();
      }
    );
    expect(directoriesDuringProduce).toContain(path.basename(servedDir));
  });

  it('releases the build lease before serving', async () => {
    let heldDuringServe = true;
    await withBundleSnapshot(options(), async () => {
      const probe = await tryLock(buildLeasePath(repoRoot, 'web-dist'));
      heldDuringServe = probe.held;
    });
    expect(heldDuringServe).toBe(false);
  });

  it('leaves the served bytes untouched by a build that runs during the serve', async () => {
    let servedAfterBuild = '';
    await withBundleSnapshot(options(), async (snapshot) => {
      const before = await fs.readFile(path.join(snapshot, 'index.html'), 'utf8');
      expect(before).toBe('built');
      await withBuildLease(repoRoot, 'web-dist', 'pnpm build', async () => {
        await fs.rm(source, { recursive: true, force: true });
        await fs.mkdir(source, { recursive: true });
        await fs.writeFile(path.join(source, 'index.html'), 'rebuilt');
      });
      servedAfterBuild = await fs.readFile(path.join(snapshot, 'index.html'), 'utf8');
    });
    expect(servedAfterBuild).toBe('built');
  });

  it('holds the snapshot claim for as long as it is served', async () => {
    let heldDuringServe = false;
    await withBundleSnapshot(options(), async (snapshot) => {
      const probe = await tryLock(`${snapshot}.lock`);
      heldDuringServe = probe.held;
    });
    expect(heldDuringServe).toBe(true);
  });

  it('refuses to serve a snapshot whose claim file has gone from disk', async () => {
    let served = false;
    const removeClaimFile = async (): Promise<void> => {
      const entries = await fs.readdir(snapshotsDir(repoRoot, ramHost));
      for (const name of entries.filter((entry) => entry.endsWith('.lock'))) {
        await fs.rm(path.join(snapshotsDir(repoRoot, ramHost), name));
      }
    };

    await expect(
      withBundleSnapshot(options(removeClaimFile), () => {
        served = true;
        return Promise.resolve();
      })
    ).rejects.toThrow(/claim/i);
    expect(served).toBe(false);
  });

  it('drops the snapshot when the serve ends the way it meant to', async () => {
    let servedDir = '';
    await withBundleSnapshot(options(), (snapshot) => {
      servedDir = snapshot;
      return Promise.resolve();
    });
    await expect(fs.stat(servedDir)).rejects.toThrow(/ENOENT/);
  });

  it('drops the snapshot when the serve fails', async () => {
    let servedDir = '';
    await expect(
      withBundleSnapshot(options(), (snapshot) => {
        servedDir = snapshot;
        return Promise.reject(new Error('preview exited'));
      })
    ).rejects.toThrow('preview exited');
    await expect(fs.stat(servedDir)).rejects.toThrow(/ENOENT/);
  });

  it('reclaims a killed run’s snapshot before making its own', async () => {
    const abandoned = await plantSnapshot('web-dist-abandoned');
    const owner = await startOwner('web-dist-abandoned');
    owner.kill('SIGKILL');
    await waitForExit(owner);

    await withBundleSnapshot(options(), () => Promise.resolve());

    await expect(fs.stat(abandoned)).rejects.toThrow(/ENOENT/);
  });

  it('takes its own lock file with it when the serve ends the way it meant to', async () => {
    let servedDir = '';
    await withBundleSnapshot(options(), (snapshot) => {
      servedDir = snapshot;
      return Promise.resolve();
    });
    await expect(fs.stat(`${servedDir}.lock`)).rejects.toThrow(/ENOENT/);
  });

  it('takes its own lock file with it when the serve fails', async () => {
    let servedDir = '';
    await expect(
      withBundleSnapshot(options(), (snapshot) => {
        servedDir = snapshot;
        return Promise.reject(new Error('preview exited'));
      })
    ).rejects.toThrow('preview exited');
    await expect(fs.stat(`${servedDir}.lock`)).rejects.toThrow(/ENOENT/);
  });

  it('returns what the serve returned', async () => {
    const result = await withBundleSnapshot(options(), () => Promise.resolve('served'));
    expect(result).toBe('served');
  });
});

describe('reclaimExpiredSnapshots', () => {
  it('names nothing when no snapshot has ever been made', async () => {
    expect(await reclaimExpiredSnapshots(repoRoot, ramHost)).toEqual([]);
  });

  it('names the snapshots it dropped', async () => {
    await plantSnapshot('web-dist-expired');
    expect(await reclaimExpiredSnapshots(repoRoot, ramHost)).toEqual(['web-dist-expired']);
  });

  it('drops a snapshot whose owner is gone', async () => {
    const expired = await plantSnapshot('web-dist-expired');
    await reclaimExpiredSnapshots(repoRoot, ramHost);
    await expect(fs.stat(expired)).rejects.toThrow(/ENOENT/);
  });

  it('leaves a snapshot its owner is still serving', async () => {
    const live = await plantSnapshot('web-dist-live');
    await startOwner('web-dist-live');

    expect(await reclaimExpiredSnapshots(repoRoot, ramHost)).toEqual([]);
    await expect(fs.stat(live)).resolves.toBeDefined();
  });

  it('leaves an empty snapshot directory whose owner still holds the claim', async () => {
    const building = path.join(snapshotsDir(repoRoot, ramHost), 'web-dist-building');
    await fs.mkdir(building, { recursive: true });
    await startOwner('web-dist-building');

    expect(await reclaimExpiredSnapshots(repoRoot, ramHost)).toEqual([]);
    await expect(fs.stat(building)).resolves.toBeDefined();
  });

  it('surfaces a filesystem failure rather than reading it as nothing to reclaim', async () => {
    await fs.mkdir(path.dirname(snapshotsDir(repoRoot, ramHost)), { recursive: true });
    await fs.writeFile(snapshotsDir(repoRoot, ramHost), 'not a directory');
    await expect(reclaimExpiredSnapshots(repoRoot, ramHost)).rejects.toThrow(/ENOTDIR/);
  });

  it('names the directory it dropped and never a lock file beside it', async () => {
    await plantSnapshot('web-dist-expired');
    const owner = await startOwner('web-dist-expired');
    owner.kill('SIGKILL');
    await waitForExit(owner);

    expect(await reclaimExpiredSnapshots(repoRoot, ramHost)).toEqual(['web-dist-expired']);
  });

  it('takes the lock file of a snapshot it drops with the snapshot', async () => {
    await plantSnapshot('web-dist-expired');
    const owner = await startOwner('web-dist-expired');
    owner.kill('SIGKILL');
    await waitForExit(owner);

    await reclaimExpiredSnapshots(repoRoot, ramHost);

    await expect(fs.stat(snapshotLockPath(repoRoot, 'web-dist-expired', ramHost))).rejects.toThrow(
      /ENOENT/
    );
  });

  it('leaves the lock file of a snapshot it left standing', async () => {
    await plantSnapshot('web-dist-live');
    await startOwner('web-dist-live');

    await reclaimExpiredSnapshots(repoRoot, ramHost);

    await expect(
      fs.stat(snapshotLockPath(repoRoot, 'web-dist-live', ramHost))
    ).resolves.toBeDefined();
  });

  it('drops a lock file no snapshot directory stands beside', async () => {
    const alone = snapshotLockPath(repoRoot, 'web-dist-alone', ramHost);
    await fs.mkdir(snapshotsDir(repoRoot, ramHost), { recursive: true });
    await fs.writeFile(alone, 'pnpm e2e\n');

    await reclaimExpiredSnapshots(repoRoot, ramHost);

    await expect(fs.stat(alone)).rejects.toThrow(/ENOENT/);
  });

  it('leaves a lock file with no directory beside it while a run holds it', async () => {
    await startOwner('web-dist-acquiring');

    await reclaimExpiredSnapshots(repoRoot, ramHost);

    await expect(
      fs.stat(snapshotLockPath(repoRoot, 'web-dist-acquiring', ramHost))
    ).resolves.toBeDefined();
  });

  it('leaves a file that is neither a snapshot nor a claim on one', async () => {
    const stray = path.join(snapshotsDir(repoRoot, ramHost), 'notes.txt');
    await fs.mkdir(snapshotsDir(repoRoot, ramHost), { recursive: true });
    await fs.writeFile(stray, 'not ours');

    await reclaimExpiredSnapshots(repoRoot, ramHost);

    await expect(fs.stat(stray)).resolves.toBeDefined();
  });
});
