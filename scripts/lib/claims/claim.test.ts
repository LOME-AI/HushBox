import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import v8 from 'node:v8';
import vm from 'node:vm';
import { tryLock as tryNativeLock } from 'fs-native-extensions';
import {
  ClaimHeldError,
  HELD_CLAIMS_ENV,
  claim,
  openClaimFileCount,
  tryLock,
  type ClaimResource,
} from './claim.js';
import type { FileHandle } from 'node:fs/promises';

let workDir: string;

function resource(name = 'web-dist'): ClaimResource {
  return { name, lockPath: path.join(workDir, `${name}.lock`) };
}

beforeEach(async () => {
  // Canonical, so a lock path a case builds is the spelling the primitive
  // stores: a temp directory is under a symlinked root on some platforms.
  workDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'claim-')));
  // The invocation running this suite holds claims of its own and advertises
  // them in the environment every child inherits, so a case reading the
  // variable back reads that run's lock paths beside its own unless the
  // variable starts empty here.
  vi.stubEnv(HELD_CLAIMS_ENV, '');
});

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

describe('claim in refuse mode', () => {
  it('runs the body and returns its value', async () => {
    const result = await claim(resource(), { onHeld: 'refuse', holder: 'pnpm build' }, () =>
      Promise.resolve('built')
    );
    expect(result).toBe('built');
  });

  it('holds the lock for the duration of the body', async () => {
    const target = resource();
    let heldDuringBody = false;
    await claim(target, { onHeld: 'refuse', holder: 'pnpm build' }, async () => {
      const probe = await tryLock(target.lockPath);
      heldDuringBody = probe.held;
    });
    expect(heldDuringBody).toBe(true);
  });

  it('releases the lock when the body completes', async () => {
    const target = resource();
    await claim(target, { onHeld: 'refuse', holder: 'pnpm build' }, () => Promise.resolve('built'));
    expect(await tryLock(target.lockPath)).toEqual({ held: false, holder: null });
  });

  it('releases the lock when the body throws', async () => {
    const target = resource();
    await expect(
      claim(target, { onHeld: 'refuse', holder: 'pnpm build' }, () =>
        Promise.reject(new Error('build failed'))
      )
    ).rejects.toThrow('build failed');
    expect(await tryLock(target.lockPath)).toEqual({ held: false, holder: null });
  });
});

describe('tryLock', () => {
  it('reports a resource nothing ever claimed as free', async () => {
    expect(await tryLock(path.join(workDir, 'never-claimed.lock'))).toEqual({
      held: false,
      holder: null,
    });
  });

  it('names the holder of a held resource', async () => {
    const target = resource();
    let observed: string | null = null;
    await claim(target, { onHeld: 'refuse', holder: 'pnpm build' }, async () => {
      const probe = await tryLock(target.lockPath);
      observed = probe.holder;
    });
    expect(observed).toBe('pnpm build');
  });
});

describe('ClaimHeldError', () => {
  it('names both the resource and its holder', () => {
    const error = new ClaimHeldError('web-dist', 'pnpm build');
    expect(error.message).toContain('web-dist');
    expect(error.message).toContain('pnpm build');
    expect(error.resource).toBe('web-dist');
    expect(error.holder).toBe('pnpm build');
  });
});

describe('claim in refuse mode within one process', () => {
  it('refuses a second claim on a resource this process already holds', async () => {
    const target = resource();
    await claim(target, { onHeld: 'refuse', holder: 'pnpm build' }, async () => {
      await expect(
        claim(target, { onHeld: 'refuse', holder: 'pnpm build:e2e' }, () =>
          Promise.resolve('second')
        )
      ).rejects.toBeInstanceOf(ClaimHeldError);
    });
  });

  it('admits a claim on a different resource while one is held', async () => {
    const second = resource('admin-dist');
    const result = await claim(resource(), { onHeld: 'refuse', holder: 'pnpm build' }, () =>
      claim(second, { onHeld: 'refuse', holder: 'pnpm build:admin' }, () => Promise.resolve('both'))
    );
    expect(result).toBe('both');
  });
});

describe('what a claim advertises to the processes it spawns', () => {
  it('advertises the claim it holds', async () => {
    const target = resource();
    let advertised = '';
    await claim(target, { onHeld: 'refuse', holder: 'pnpm build' }, () => {
      advertised = process.env[HELD_CLAIMS_ENV] ?? '';
      return Promise.resolve();
    });
    expect(advertised.split('\n')).toContain(target.lockPath);
  });

  it('stops advertising a claim once it is released', async () => {
    const target = resource();
    await claim(target, { onHeld: 'refuse', holder: 'pnpm build' }, () => Promise.resolve());
    expect(process.env[HELD_CLAIMS_ENV]?.split('\n')).not.toContain(target.lockPath);
  });

  it('keeps advertising the outer claim when an inner one is released', async () => {
    const outer = resource();
    const inner = resource('admin-dist');
    let advertised = '';
    await claim(outer, { onHeld: 'refuse', holder: 'pnpm build' }, async () => {
      await claim(inner, { onHeld: 'refuse', holder: 'pnpm build:admin' }, () => Promise.resolve());
      advertised = process.env[HELD_CLAIMS_ENV] ?? '';
    });
    expect(advertised.split('\n')).toEqual([outer.lockPath]);
  });
});

describe('an inherited claim', () => {
  it('runs the body without taking a lock of its own', async () => {
    const target = resource();
    // What a spawned child sees: the environment names a claim this process
    // never acquired, because its parent holds it.
    vi.stubEnv(HELD_CLAIMS_ENV, target.lockPath);

    let heldDuringBody = true;
    await claim(target, { onHeld: 'refuse', holder: 'nested build' }, async () => {
      const probe = await tryLock(target.lockPath);
      heldDuringBody = probe.held;
    });

    expect(heldDuringBody).toBe(false);
  });

  it('creates no lock file of its own', async () => {
    const target = resource();
    vi.stubEnv(HELD_CLAIMS_ENV, target.lockPath);

    await claim(target, { onHeld: 'refuse', holder: 'nested build' }, () => Promise.resolve());

    await expect(fs.stat(target.lockPath)).rejects.toThrow();
  });
});

/**
 * A claim id is a string, and a directory reached through a symlink has two
 * absolute spellings. A parent that stamps one spelling into the environment
 * and a child that names the other are talking about one lock file, so a
 * spelling-sensitive inherited set would have the child queue behind — or, in
 * refuse mode, be turned away by — a claim its own parent holds.
 */
describe('an inherited claim named through a link', () => {
  it('runs the body without taking a lock of its own', async () => {
    await fs.mkdir(path.join(workDir, 'real'));
    await fs.symlink(path.join(workDir, 'real'), path.join(workDir, 'link'), 'dir');
    const throughRealPath = path.join(workDir, 'real', 'section.lock');
    const throughLink = path.join(workDir, 'link', 'section.lock');
    vi.stubEnv(HELD_CLAIMS_ENV, throughRealPath);

    let heldDuringBody = true;
    await claim(
      { name: 'the local stack', lockPath: throughLink },
      { onHeld: 'refuse', holder: 'nested run' },
      async () => {
        const probe = await tryLock(throughRealPath);
        heldDuringBody = probe.held;
      }
    );

    expect(heldDuringBody).toBe(false);
  });
});

describe('tryLock on an unreadable claim', () => {
  it('surfaces a filesystem failure rather than reporting the claim free', async () => {
    const target = resource();
    await claim(target, { onHeld: 'refuse', holder: 'pnpm build' }, () => Promise.resolve());
    // Read-only: the probe needs a writable descriptor to request an exclusive
    // lock, so this is a failure it must surface rather than read as "free".
    await fs.chmod(target.lockPath, 0o400);
    try {
      await expect(tryLock(target.lockPath)).rejects.toThrow(/EACCES/);
    } finally {
      await fs.chmod(target.lockPath, 0o600);
    }
  });
});

describe('the name a claim publishes', () => {
  it('leaves no part of a longer predecessor behind', async () => {
    const target = resource();
    await claim(target, { onHeld: 'refuse', holder: 'pnpm build:e2e:admin' }, () =>
      Promise.resolve()
    );

    let observed: string | null = null;
    await claim(target, { onHeld: 'refuse', holder: 'pnpm dev' }, async () => {
      const probe = await tryLock(target.lockPath);
      observed = probe.holder;
    });

    expect(observed).toBe('pnpm dev');
  });
});

describe('claim on a lock file it cannot write', () => {
  it('surfaces the filesystem failure rather than running the body', async () => {
    const target = resource();
    await claim(target, { onHeld: 'refuse', holder: 'pnpm build' }, () => Promise.resolve());
    // Read-only: the claim needs a writable descriptor both to publish its name
    // and to be granted an exclusive lock, so this is a failure it must surface
    // rather than run the body without holding anything.
    await fs.chmod(target.lockPath, 0o400);
    try {
      await expect(
        claim(target, { onHeld: 'refuse', holder: 'pnpm dev' }, () => Promise.resolve('ran'))
      ).rejects.toThrow(/EACCES/);
    } finally {
      await fs.chmod(target.lockPath, 0o600);
    }
  });
});

describe('a claim whose holder does not fit the window a reader reads', () => {
  it('refuses the name rather than storing one no reader gets back whole', async () => {
    const target = resource();

    await expect(
      claim(target, { onHeld: 'refuse', holder: 'x'.repeat(9000) }, () => Promise.resolve('ran'))
    ).rejects.toThrow(/must fit in/);
  });
});

/**
 * A read of a file being grown comes back clamped to the size the kernel
 * sampled, and that size lags the pages the write has already put there — so a
 * probe can be handed the beginning of the name going in. Truncating the file
 * under a claim that holds it puts the probe in front of exactly those bytes.
 */
describe('a holder whose name is still going in', () => {
  it('refuses a window with no terminating newline as a whole name', async () => {
    const target = resource();

    const probe = await claim(target, { onHeld: 'refuse', holder: 'pnpm build' }, async () => {
      await fs.truncate(target.lockPath, 4);
      return tryLock(target.lockPath);
    });

    expect(probe).toEqual({ held: true, holder: 'another run', holderPending: true });
  });

  it('is a different reading from a holder that named itself with nothing', async () => {
    const target = resource();

    const probe = await claim(target, { onHeld: 'refuse', holder: '' }, () =>
      tryLock(target.lockPath)
    );

    expect(probe).toEqual({ held: true, holder: 'another run' });
  });
});

describe('what holds the descriptor of a held claim open', () => {
  it('retains the file handle for as long as the lock is held', async () => {
    const before = openClaimFileCount();
    let duringBody = -1;

    await claim(resource(), { onHeld: 'refuse', holder: 'pnpm build' }, () => {
      duringBody = openClaimFileCount();
      return Promise.resolve();
    });

    expect(duringBody).toBe(before + 1);
  });

  it('lets the handle go once the lock is released', async () => {
    const before = openClaimFileCount();

    await claim(resource(), { onHeld: 'refuse', holder: 'pnpm build' }, () => Promise.resolve());

    expect(openClaimFileCount()).toBe(before);
  });
});

/**
 * The runtime through which a reader reaches the claim primitive, and the
 * primitive itself. A reader has to be a process of its own: an advisory lock
 * is granted per open descriptor, so only another process can be turned away by
 * one this process holds.
 */
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const CLAIM_MODULE = new URL('claim.ts', import.meta.url).href;

/** What a reader in another process sends back over the process boundary. */
interface ForeignProbe {
  readonly held: boolean;
  readonly holder: string | null;
}

/** Reads a claim the way every reclaimer reads one: from a process of its own. */
function probeFromAnotherProcess(lockPath: string): ForeignProbe {
  const source =
    `const { tryLock } = await import(${JSON.stringify(CLAIM_MODULE)});\n` +
    `process.stdout.write(JSON.stringify(await tryLock(${JSON.stringify(lockPath)})));`;
  const reader = spawnSync(
    process.execPath,
    ['--import', TSX_LOADER, '--input-type=module', '-e', source],
    { encoding: 'utf8' }
  );
  if (reader.status !== 0) throw new Error(`the reader failed: ${reader.stderr}`);
  return JSON.parse(reader.stdout) as ForeignProbe;
}

/**
 * A full collection on demand. The worker running these cases was not started
 * with the collector exposed, and a case that waited for one to happen would
 * assert nothing on the runs where none did. The pause after each pass is what
 * lets the finalizer that closes a collected descriptor run before anything
 * reads the lock.
 */
async function collect(): Promise<void> {
  v8.setFlagsFromString('--expose-gc');
  const collectNow = vm.runInNewContext('gc') as () => void;
  v8.setFlagsFromString('--no-expose-gc');
  for (let pass = 0; pass < 4; pass++) {
    collectNow();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Allocation heavy enough that the collector runs repeatedly underneath it. */
async function allocateThroughCollections(): Promise<void> {
  for (let round = 0; round < 12; round++) {
    const blocks: number[][] = [];
    for (let block = 0; block < 200; block++) {
      blocks.push(Array.from({ length: 10_000 }, () => round));
    }
    // Read the allocation back, so nothing is free to elide it.
    if (blocks.at(-1)?.[0] !== round) throw new Error('the allocation was elided');
    await collect();
  }
}

/**
 * The holders that reach the collector are the ones doing work themselves: one
 * that only spawns children idles, allocates almost nothing, and never gives
 * the collector the chance. This is the case that has to hold.
 */
describe('a holder that allocates while it holds', () => {
  it('still reads as held from another process', async () => {
    const target = resource();

    const reading = await claim(target, { onHeld: 'refuse', holder: 'pnpm build' }, async () => {
      await allocateThroughCollections();
      return probeFromAnotherProcess(target.lockPath);
    });

    expect(reading).toEqual({ held: true, holder: 'pnpm build' });
  }, 120_000);
});

/**
 * Why the retention exists, in both directions. The lock is a fact about a
 * descriptor, and Node closes a collected handle's descriptor from a finalizer,
 * so a handle nothing holds is a lock the collector can take away from a live
 * run. Only the pair of readings says the retention is what keeps the lock:
 * without the second, a passing case would prove nothing about this module, and
 * without the first it would prove nothing about the collector.
 */
describe('a claim handle the collector reaches', () => {
  it('loses the lock when nothing retains the handle', async () => {
    const target = resource('abandoned');
    await fs.writeFile(target.lockPath, 'pnpm build\n');
    const warnings: string[] = [];
    const emitted = vi.spyOn(process, 'emitWarning').mockImplementation((warning) => {
      warnings.push(String(warning));
    });

    let stray: FileHandle | null = await fs.open(target.lockPath, 'r+');
    expect(tryNativeLock(stray.fd)).toBe(true);
    stray = null;
    await collect();
    const probe = await tryLock(target.lockPath);
    emitted.mockRestore();

    expect(warnings.join('\n')).toContain('garbage collection');
    expect(probe).toEqual({ held: false, holder: null });
  }, 30_000);

  it('keeps the lock when the claim retains the handle', async () => {
    const target = resource('retained');

    const heldDuringBody = await claim(
      target,
      { onHeld: 'refuse', holder: 'pnpm build' },
      async () => {
        await collect();
        const probe = await tryLock(target.lockPath);
        return probe.held;
      }
    );

    expect(heldDuringBody).toBe(true);
  }, 30_000);
});
