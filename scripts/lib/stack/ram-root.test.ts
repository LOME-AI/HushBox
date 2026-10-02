import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  truncate,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalPath } from '../canonical-path.js';
import {
  RAM_ROOT_OWNER_FILE,
  TMPFS_MAGIC,
  assertRamRootCapacity,
  e2eRamPaths,
  prepareRamRoot,
  ramHostMountNamespace,
  ramPathsFor,
  ramRootRequiredBytes,
  ramRootUsedBytes,
} from './ram-root.js';
import type { RamRootHost, ReadStatfs } from './ram-root.js';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

const PARENT = path.join(path.sep, 'ram-parent');
const CHECKOUT = path.join(path.sep, 'checkouts', 'hushbox-one');
const OTHER_CHECKOUT = path.join(path.sep, 'checkouts', 'hushbox-two');
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

/** btrfs, the filesystem a disk-backed checkout sits on here. */
const BTRFS_MAGIC = 0x91_23_68_3e;
const BLOCK_SIZE = 4096;
const REQUIRED = ramRootRequiredBytes(12);

/**
 * How many times the atomicity case writes the owner file while a reader reads
 * it: several times the most writes a write that truncates before it fills took
 * to be seen empty, when measured.
 */
const OWNER_FILE_REWRITES = 1000;

function onPlatform(platform: NodeJS.Platform): RamRootHost {
  return { platform, parent: PARENT };
}

/** A filesystem of `type` answering `freeBytes` free to an unprivileged writer. */
function filesystem(type: number, freeBytes: number): ReadStatfs {
  return () => Promise.resolve({ type, bsize: BLOCK_SIZE, bavail: freeBytes / BLOCK_SIZE });
}

let scratchParent: string;

beforeEach(async () => {
  scratchParent = await mkdtemp(path.join(os.tmpdir(), 'ram-root-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(scratchParent, { recursive: true, force: true });
});

function linuxOnScratch(): RamRootHost {
  return { platform: 'linux', parent: scratchParent };
}

async function ownerFileOf(root: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(root, RAM_ROOT_OWNER_FILE), 'utf8'));
}

/** A root already on the candidate, its owner file holding `contents`. */
async function plantRoot(contents: string): Promise<string> {
  const root = ramPathsFor(CHECKOUT, linuxOnScratch())?.root ?? '';
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, RAM_ROOT_OWNER_FILE), contents);
  return root;
}

describe('the space an E2E run needs in its RAM root', () => {
  it('is 1.5 GiB at the local twelve workers', () => {
    expect(ramRootRequiredBytes(12)).toBe(1.5 * GIB);
  });

  it('is 1,216 MiB at CI’s seven workers', () => {
    expect(ramRootRequiredBytes(7)).toBe(1216 * MIB);
  });
});

describe('where a checkout’s E2E RAM root is', () => {
  it.each(['darwin', 'win32'] as const)('is nowhere on %s', (platform) => {
    expect(ramPathsFor(CHECKOUT, onPlatform(platform))).toBeUndefined();
  });

  it('is a directory of the RAM parent on Linux', () => {
    const paths = ramPathsFor(CHECKOUT, onPlatform('linux'));

    expect(path.dirname(paths?.root ?? '')).toBe(PARENT);
  });

  it('is named for the harness and a digest, never for where the checkout is', () => {
    const name = path.basename(ramPathsFor(CHECKOUT, onPlatform('linux'))?.root ?? '');

    expect(name).toMatch(/^hushbox-e2e-[0-9a-f]{16}$/);
  });

  it('differs between two checkouts', () => {
    const one = ramPathsFor(CHECKOUT, onPlatform('linux'))?.root;
    const two = ramPathsFor(OTHER_CHECKOUT, onPlatform('linux'))?.root;

    expect(one).not.toBe(two);
  });

  it('is the same for one checkout however its path is spelled', () => {
    const spelled = path.join(CHECKOUT, '..', path.basename(CHECKOUT));

    expect(ramPathsFor(spelled, onPlatform('linux'))?.root).toBe(
      ramPathsFor(CHECKOUT, onPlatform('linux'))?.root
    );
  });

  it('holds its four stores as distinct children of itself', () => {
    const paths = ramPathsFor(CHECKOUT, onPlatform('linux'));
    const children = [paths?.persist, paths?.snapshots, paths?.browserTmp, paths?.testResults];

    expect(new Set(children.map((child) => path.dirname(child ?? '')))).toEqual(
      new Set([paths?.root])
    );
    expect(new Set(children).size).toBe(4);
  });

  it('lives in the shared-memory filesystem on Linux, for this checkout', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');

    expect(e2eRamPaths()?.root).toBe(
      ramPathsFor(REPO_ROOT, { platform: 'linux', parent: path.join(path.sep, 'dev', 'shm') })?.root
    );
  });

  it.each(['darwin', 'win32'] as const)('is nowhere for this checkout on %s', (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);

    expect(e2eRamPaths()).toBeUndefined();
  });
});

describe('the mount namespace a host reads its RAM filesystem in', () => {
  it.runIf(process.platform === 'linux')(
    'is the one the kernel names for this process, on the machine’s own host',
    async () => {
      expect(await ramHostMountNamespace()).toMatch(/^mnt:\[\d+\]$/);
    }
  );

  it('is none for a host that states none', async () => {
    expect(await ramHostMountNamespace(linuxOnScratch())).toBeUndefined();
  });
});

describe('preparing a checkout’s E2E RAM root for a run', () => {
  it('yields a directory inside a tmpfs candidate with room', async () => {
    const paths = await prepareRamRoot(CHECKOUT, REQUIRED, {
      host: linuxOnScratch(),
      statfs: filesystem(TMPFS_MAGIC, REQUIRED),
    });

    const made = await stat(paths?.root ?? '');

    expect(path.dirname(paths?.root ?? '')).toBe(scratchParent);
    expect(made.isDirectory()).toBe(true);
  });

  it('records the checkout the root belongs to in its owner file', async () => {
    const paths = await prepareRamRoot(CHECKOUT, REQUIRED, {
      host: linuxOnScratch(),
      statfs: filesystem(TMPFS_MAGIC, REQUIRED),
    });

    expect(await ownerFileOf(paths?.root ?? '')).toEqual({ checkout: canonicalPath(CHECKOUT) });
  });

  it('records the mount namespace its host claims it in', async () => {
    const paths = await prepareRamRoot(CHECKOUT, REQUIRED, {
      host: { ...linuxOnScratch(), mountNamespace: () => Promise.resolve('mnt:[7]') },
      statfs: filesystem(TMPFS_MAGIC, REQUIRED),
    });

    expect(await ownerFileOf(paths?.root ?? '')).toEqual({
      checkout: canonicalPath(CHECKOUT),
      mountNamespace: 'mnt:[7]',
    });
  });

  it('is never seen empty by a reader while its owner file is written over and over', async () => {
    const host = linuxOnScratch();
    const ownerFile = path.join(ramPathsFor(CHECKOUT, host)?.root ?? '', RAM_ROOT_OWNER_FILE);
    const seen: string[] = [];
    const writes = { finished: false };

    const writer = (async (): Promise<void> => {
      try {
        for (let write = 0; write < OWNER_FILE_REWRITES; write += 1) {
          await rm(ownerFile, { force: true });
          await prepareRamRoot(CHECKOUT, 0, { host, statfs: filesystem(TMPFS_MAGIC, 0) });
        }
      } finally {
        writes.finished = true;
      }
    })();
    while (!writes.finished) {
      try {
        seen.push(await readFile(ownerFile, 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await writer;

    expect(seen.length).toBeGreaterThan(0);
    expect(seen).not.toContain('');
  });

  it('takes up a root its own checkout already owns', async () => {
    const root = await plantRoot(JSON.stringify({ checkout: canonicalPath(CHECKOUT) }));

    const paths = await prepareRamRoot(CHECKOUT, REQUIRED, {
      host: linuxOnScratch(),
      statfs: filesystem(TMPFS_MAGIC, REQUIRED),
    });

    expect(paths?.root).toBe(root);
  });

  it('records the mount namespace in a root its own checkout owns that records none', async () => {
    const root = await plantRoot(JSON.stringify({ checkout: canonicalPath(CHECKOUT) }));

    await prepareRamRoot(CHECKOUT, REQUIRED, {
      host: { ...linuxOnScratch(), mountNamespace: () => Promise.resolve('mnt:[7]') },
      statfs: filesystem(TMPFS_MAGIC, REQUIRED),
    });

    expect(await ownerFileOf(root)).toEqual({
      checkout: canonicalPath(CHECKOUT),
      mountNamespace: 'mnt:[7]',
    });
  });

  it('refuses a candidate that is not tmpfs, with a message naming what to change', async () => {
    const refusal = prepareRamRoot(CHECKOUT, REQUIRED, {
      host: linuxOnScratch(),
      statfs: filesystem(BTRFS_MAGIC, 4 * GIB),
    });

    await expect(refusal).rejects.toThrow(/not tmpfs.*0x9123683e/);
    await expect(refusal).rejects.toThrow('4096 MiB free');
    await expect(refusal).rejects.toThrow('needs 1536 MiB');
    await expect(refusal).rejects.toThrow(/Mount a tmpfs.*shared-memory size/);
  });

  it('refuses a tmpfs with too little free space, with a message naming what to change', async () => {
    const refusal = prepareRamRoot(CHECKOUT, REQUIRED, {
      host: linuxOnScratch(),
      statfs: filesystem(TMPFS_MAGIC, REQUIRED - BLOCK_SIZE),
    });

    await expect(refusal).rejects.toThrow(/is tmpfs/);
    await expect(refusal).rejects.toThrow('1535 MiB free');
    await expect(refusal).rejects.toThrow('needs 1536 MiB');
    await expect(refusal).rejects.toThrow(/Raise the shared-memory size/);
  });

  it('refuses a root whose owner file names another checkout, naming both', async () => {
    await plantRoot(JSON.stringify({ checkout: OTHER_CHECKOUT }));

    const refusal = prepareRamRoot(CHECKOUT, REQUIRED, {
      host: linuxOnScratch(),
      statfs: filesystem(TMPFS_MAGIC, REQUIRED),
    });

    await expect(refusal).rejects.toThrow(OTHER_CHECKOUT);
    await expect(refusal).rejects.toThrow(canonicalPath(CHECKOUT));
  });

  it('leaves the other checkout’s owner file as it found it', async () => {
    const root = await plantRoot(JSON.stringify({ checkout: OTHER_CHECKOUT }));

    await expect(
      prepareRamRoot(CHECKOUT, REQUIRED, {
        host: linuxOnScratch(),
        statfs: filesystem(TMPFS_MAGIC, REQUIRED),
      })
    ).rejects.toThrow(OTHER_CHECKOUT);

    expect(await ownerFileOf(root)).toEqual({ checkout: OTHER_CHECKOUT });
  });

  it('refuses a root whose owner file is not JSON, naming the file', async () => {
    const root = await plantRoot('not json');

    await expect(
      prepareRamRoot(CHECKOUT, REQUIRED, {
        host: linuxOnScratch(),
        statfs: filesystem(TMPFS_MAGIC, REQUIRED),
      })
    ).rejects.toThrow(path.join(root, RAM_ROOT_OWNER_FILE));
  });

  it('refuses a root whose owner file names no checkout, naming the file', async () => {
    const root = await plantRoot(JSON.stringify({ owner: CHECKOUT }));

    await expect(
      prepareRamRoot(CHECKOUT, REQUIRED, {
        host: linuxOnScratch(),
        statfs: filesystem(TMPFS_MAGIC, REQUIRED),
      })
    ).rejects.toThrow(path.join(root, RAM_ROOT_OWNER_FILE));
  });

  // Write-only, so a claim that took an unreadable owner file for an absent one
  // would overwrite it and succeed rather than surface the failure.
  it.skipIf(process.platform === 'win32')(
    'surfaces an owner file it cannot read rather than claiming the root over it',
    async () => {
      const root = await plantRoot(JSON.stringify({ checkout: OTHER_CHECKOUT }));
      await chmod(path.join(root, RAM_ROOT_OWNER_FILE), 0o200);

      await expect(
        prepareRamRoot(CHECKOUT, REQUIRED, {
          host: linuxOnScratch(),
          statfs: filesystem(TMPFS_MAGIC, REQUIRED),
        })
      ).rejects.toThrow(/EACCES/);
    }
  );

  it.each(['darwin', 'win32'] as const)(
    'makes nothing and yields no root on %s',
    async (platform) => {
      const paths = await prepareRamRoot(CHECKOUT, REQUIRED, {
        host: { platform, parent: scratchParent },
        statfs: filesystem(TMPFS_MAGIC, REQUIRED),
      });

      expect(paths).toBeUndefined();
      expect(await readdir(scratchParent)).toEqual([]);
    }
  );
});

describe('the capacity check on a RAM root', () => {
  it('admits a tmpfs with exactly the space required', async () => {
    await expect(
      assertRamRootCapacity(scratchParent, REQUIRED, filesystem(TMPFS_MAGIC, REQUIRED))
    ).resolves.toBeUndefined();
  });

  it('reads the filesystem of the root it is given', async () => {
    const asked: string[] = [];
    const recording: ReadStatfs = (target) => {
      asked.push(target);
      return filesystem(TMPFS_MAGIC, REQUIRED)(target);
    };

    await assertRamRootCapacity(scratchParent, REQUIRED, recording);

    expect(asked).toEqual([scratchParent]);
  });

  it('asks the real filesystem when given no reader', async () => {
    await expect(assertRamRootCapacity(scratchParent, Number.MAX_SAFE_INTEGER)).rejects.toThrow(
      'needs'
    );
  });
});

/** What an earlier run left in each store a run starts by emptying. */
const LAST_RUN_BYTES = 4 * MIB;

/** A root holding {@link LAST_RUN_BYTES} of an earlier run's files, spread over its stores. */
async function rootAfterAnEarlierRun(): Promise<string> {
  const paths = ramPathsFor(CHECKOUT, linuxOnScratch());
  const files = [
    { at: path.join(paths?.persist ?? '', 'v3', 'do', 'room.sqlite'), bytes: 2 * MIB },
    { at: path.join(paths?.browserTmp ?? '', 'profile', 'cache', 'entry'), bytes: MIB },
    { at: path.join(paths?.testResults ?? '', 'trace.zip'), bytes: MIB },
  ];
  for (const file of files) {
    await mkdir(path.dirname(file.at), { recursive: true });
    await writeFile(file.at, Buffer.alloc(file.bytes));
  }
  return paths?.root ?? '';
}

describe('the capacity check on a root an earlier run used', () => {
  it('admits a root whose free space falls short only by what the earlier run left', async () => {
    const root = await rootAfterAnEarlierRun();

    await expect(
      assertRamRootCapacity(root, REQUIRED, filesystem(TMPFS_MAGIC, REQUIRED - LAST_RUN_BYTES))
    ).resolves.toBeUndefined();
  });

  it('refuses a root whose free space and earlier run together fall short, naming both', async () => {
    const root = await rootAfterAnEarlierRun();

    const refusal = assertRamRootCapacity(
      root,
      REQUIRED,
      filesystem(TMPFS_MAGIC, REQUIRED - LAST_RUN_BYTES - BLOCK_SIZE)
    );

    await expect(refusal).rejects.toThrow('1531 MiB free');
    await expect(refusal).rejects.toThrow('4 MiB in the stores a run starts by emptying');
  });

  // Unlistable, so a check that took an unreadable store for an empty one
  // would pass over files it never counted.
  it.skipIf(process.platform === 'win32')(
    'surfaces a store it cannot list rather than counting it as empty',
    async () => {
      const root = await rootAfterAnEarlierRun();
      const persist = ramPathsFor(CHECKOUT, linuxOnScratch())?.persist ?? '';
      await chmod(persist, 0o000);

      try {
        await expect(
          assertRamRootCapacity(root, REQUIRED, filesystem(TMPFS_MAGIC, REQUIRED))
        ).rejects.toThrow(/EACCES/);
      } finally {
        await chmod(persist, 0o700);
      }
    }
  );
});

/** A file in the persist store holding `bytes` of written data, every block of it allocated. */
async function writtenPersistFile(bytes: number): Promise<{ root: string; file: string }> {
  const paths = ramPathsFor(CHECKOUT, linuxOnScratch());
  const file = path.join(paths?.persist ?? '', 'v3', 'do', 'room.sqlite');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.alloc(bytes, 1));
  return { root: paths?.root ?? '', file };
}

describe('the capacity check’s credit for the space an earlier run’s files occupy', () => {
  // NTFS allocates the whole of a file extended by truncation, so no sparse
  // file can be made there without marking it sparse first.
  it.skipIf(process.platform === 'win32')(
    'refuses a root that only a sparse file’s size, not its allocation, would admit',
    async () => {
      const { root, file } = await writtenPersistFile(MIB);
      await truncate(file, 64 * MIB);

      const refusal = assertRamRootCapacity(
        root,
        REQUIRED,
        filesystem(TMPFS_MAGIC, REQUIRED - 2 * MIB)
      );

      await expect(refusal).rejects.toThrow('1 MiB in the stores a run starts by emptying');
    }
  );

  it('credits a file hard-linked twice, across two stores, once', async () => {
    const { root, file } = await writtenPersistFile(MIB);
    const testResults = ramPathsFor(CHECKOUT, linuxOnScratch())?.testResults ?? '';
    await mkdir(testResults, { recursive: true });
    await link(file, path.join(path.dirname(file), 'room-link.sqlite'));
    await link(file, path.join(testResults, 'room.sqlite'));

    const refusal = assertRamRootCapacity(
      root,
      REQUIRED,
      filesystem(TMPFS_MAGIC, REQUIRED - 2 * MIB)
    );

    await expect(refusal).rejects.toThrow('1 MiB in the stores a run starts by emptying');
  });
});

describe('the space an E2E RAM root occupies', () => {
  it('counts every file under the root by its allocation, each inode once', async () => {
    const { root, file } = await writtenPersistFile(MIB);
    await link(file, path.join(path.dirname(file), 'room-link.sqlite'));
    const snapshot = path.join(ramPathsFor(CHECKOUT, linuxOnScratch())?.snapshots ?? '', 'web.js');
    await mkdir(path.dirname(snapshot), { recursive: true });
    await writeFile(snapshot, Buffer.alloc(2 * MIB, 1));
    const persisted = await stat(file);
    const snapshotted = await stat(snapshot);

    await expect(ramRootUsedBytes(root)).resolves.toBe(
      (persisted.blocks + snapshotted.blocks) * 512
    );
  });
});
