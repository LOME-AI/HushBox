import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { tryLock } from './lib/claims/claim.js';
import { BuildLeaseHeldError, buildLeasePath, withBuildLease } from './lib/bundling/lease.js';
import { readCommand, readOutput, runWithBuildLease } from './with-build-lease.js';

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'with-build-lease-'));
});

afterEach(async () => {
  await fs.rm(repoRoot, { recursive: true, force: true });
});

describe('readCommand', () => {
  it('reads the command from the first non-flag argument', () => {
    expect(readCommand(['vite build && cap sync ios'])).toBe('vite build && cap sync ios');
  });

  it('reads the command from after the output flag', () => {
    expect(readCommand(['--resource=admin-dist', 'turbo build'])).toBe('turbo build');
  });

  it('rejects an invocation with no command', () => {
    expect(() => readCommand([])).toThrow(/command/);
  });
});

describe('readOutput', () => {
  it('reads the output the command writes', () => {
    expect(readOutput(['--resource=admin-dist', 'turbo build'])).toBe('admin-dist');
  });

  it('writes the web output when no other is named', () => {
    expect(readOutput(['turbo build'])).toBe('web-dist');
  });

  it('rejects an output nothing is keyed on', () => {
    expect(() => readOutput(['--resource=marketing-dist', 'turbo build'])).toThrow(
      /marketing-dist/
    );
  });
});

describe('runWithBuildLease', () => {
  it('holds the lease while the command runs', async () => {
    let heldDuringCommand = false;
    await runWithBuildLease(
      repoRoot,
      repoRoot,
      { output: 'web-dist', command: 'turbo build' },
      {
        exec: async () => {
          const probe = await tryLock(buildLeasePath(repoRoot, 'web-dist'));
          heldDuringCommand = probe.held;
          return { exitCode: 0 };
        },
      }
    );
    expect(heldDuringCommand).toBe(true);
  });

  it("returns the command's exit code", async () => {
    const code = await runWithBuildLease(
      repoRoot,
      repoRoot,
      { output: 'web-dist', command: 'turbo build' },
      {
        exec: () => Promise.resolve({ exitCode: 3 }),
      }
    );
    expect(code).toBe(3);
  });

  it('runs the command in the directory it was invoked from', async () => {
    let observedCwd = '';
    await runWithBuildLease(
      repoRoot,
      path.join(repoRoot, 'apps', 'web'),
      { output: 'web-dist', command: 'vite build' },
      {
        exec: (_command, cwd) => {
          observedCwd = cwd;
          return Promise.resolve({ exitCode: 0 });
        },
      }
    );
    expect(observedCwd).toBe(path.join(repoRoot, 'apps', 'web'));
  });

  it('refuses without running the command while another writer holds the lease', async () => {
    let ran = false;
    await withBuildLease(repoRoot, 'web-dist', 'pnpm build', async () => {
      await expect(
        runWithBuildLease(
          repoRoot,
          repoRoot,
          { output: 'web-dist', command: 'turbo build' },
          {
            exec: () => {
              ran = true;
              return Promise.resolve({ exitCode: 0 });
            },
          }
        )
      ).rejects.toBeInstanceOf(BuildLeaseHeldError);
    });
    expect(ran).toBe(false);
  });

  it('runs an admin build beside a live web build rather than refusing it', async () => {
    let ran = false;
    await withBuildLease(repoRoot, 'web-dist', 'pnpm build', async () => {
      await runWithBuildLease(
        repoRoot,
        repoRoot,
        { output: 'admin-dist', command: 'turbo build' },
        {
          exec: () => {
            ran = true;
            return Promise.resolve({ exitCode: 0 });
          },
        }
      );
    });
    expect(ran).toBe(true);
  });
});
