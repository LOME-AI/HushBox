import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { tryLock } from '../claims/claim.js';
import { BuildLeaseHeldError, buildLeasePath, withBuildLease } from './lease.js';

let repoRoot: string;

async function leaseHeld(resource: 'web-dist' | 'admin-dist' = 'web-dist'): Promise<boolean> {
  const probe = await tryLock(buildLeasePath(repoRoot, resource));
  return probe.held;
}

beforeEach(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'build-lease-'));
});

afterEach(async () => {
  await fs.rm(repoRoot, { recursive: true, force: true });
});

describe('withBuildLease', () => {
  it('runs the body and returns its value', async () => {
    const result = await withBuildLease(repoRoot, 'web-dist', 'pnpm build', () =>
      Promise.resolve('built')
    );
    expect(result).toBe('built');
  });

  it('holds the lease for the duration of the body', async () => {
    let heldDuringBody = false;
    await withBuildLease(repoRoot, 'web-dist', 'pnpm build', async () => {
      heldDuringBody = await leaseHeld();
    });
    expect(heldDuringBody).toBe(true);
  });

  it('refuses a second acquirer while the lease is live', async () => {
    await withBuildLease(repoRoot, 'web-dist', 'pnpm build', async () => {
      await expect(
        withBuildLease(repoRoot, 'web-dist', 'pnpm build:e2e', () => Promise.resolve('second'))
      ).rejects.toBeInstanceOf(BuildLeaseHeldError);
    });
  });

  it('names the holder it refused for in the refusal', async () => {
    await withBuildLease(repoRoot, 'web-dist', 'pnpm build', async () => {
      await expect(
        withBuildLease(repoRoot, 'web-dist', 'pnpm build:e2e', () => Promise.resolve('second'))
      ).rejects.toThrow(/pnpm build/);
    });
  });

  it('names the output the refused writer was aiming at', async () => {
    await withBuildLease(repoRoot, 'admin-dist', 'pnpm build:e2e:admin', async () => {
      await expect(
        withBuildLease(repoRoot, 'admin-dist', 'pnpm build', () => Promise.resolve('second'))
      ).rejects.toThrow(/admin-dist/);
    });
  });

  it('admits an admin build while a web build holds its own lease', async () => {
    let admin = '';
    await withBuildLease(repoRoot, 'web-dist', 'pnpm build', async () => {
      admin = await withBuildLease(repoRoot, 'admin-dist', 'pnpm build:e2e:admin', () =>
        Promise.resolve('admin built')
      );
    });
    expect(admin).toBe('admin built');
  });

  it('leaves the other output free while one is held', async () => {
    let adminHeld = true;
    await withBuildLease(repoRoot, 'web-dist', 'pnpm build', async () => {
      adminHeld = await leaseHeld('admin-dist');
    });
    expect(adminHeld).toBe(false);
  });

  it('releases the lease when the body completes', async () => {
    await withBuildLease(repoRoot, 'web-dist', 'pnpm build', () => Promise.resolve('built'));
    expect(await leaseHeld()).toBe(false);
  });

  it('releases the lease when the body throws', async () => {
    await expect(
      withBuildLease(repoRoot, 'web-dist', 'pnpm build', () =>
        Promise.reject(new Error('build failed'))
      )
    ).rejects.toThrow('build failed');
    expect(await leaseHeld()).toBe(false);
  });

  it('admits the next writer once the previous one has finished', async () => {
    await withBuildLease(repoRoot, 'web-dist', 'pnpm build', () => Promise.resolve('first'));
    const second = await withBuildLease(repoRoot, 'web-dist', 'pnpm build:e2e', () =>
      Promise.resolve('second')
    );
    expect(second).toBe('second');
  });

  it('surfaces a filesystem failure rather than treating it as contention', async () => {
    const cacheDir = path.dirname(buildLeasePath(repoRoot, 'web-dist'));
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.chmod(cacheDir, 0o500);
    try {
      const failure = withBuildLease(repoRoot, 'web-dist', 'pnpm build', () =>
        Promise.resolve('built')
      );
      await expect(failure).rejects.toThrow(/EACCES/);
      await expect(failure).rejects.not.toBeInstanceOf(BuildLeaseHeldError);
    } finally {
      await fs.chmod(cacheDir, 0o700);
    }
  });

  it('writes the lease beside the other runtime cache files, never inside the build output', () => {
    expect(path.relative(repoRoot, buildLeasePath(repoRoot, 'web-dist'))).toBe(
      path.join('scripts', '.cache', 'web-dist.lease')
    );
  });

  it('keys each output at its own lease file', () => {
    expect(path.relative(repoRoot, buildLeasePath(repoRoot, 'admin-dist'))).toBe(
      path.join('scripts', '.cache', 'admin-dist.lease')
    );
  });
});
