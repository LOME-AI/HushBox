import { describe, it, expect, vi } from 'vitest';
import { runDocket } from './docket.js';
import type { LongLivedChild, LongLivedOptions } from './lib/spawn/long-lived.js';

function child(exitCode: number): LongLivedChild {
  return {
    pid: 4242,
    pgid: 4242,
    exit: Promise.resolve(exitCode),
    kill: () => Promise.resolve(exitCode),
  };
}

const ENV: NodeJS.ProcessEnv = { HB_DOCKET_PORT: '12800' };

/** A stand-in for the long-lived spawner, typed as the call sites see it. */
function spawning(
  started: LongLivedChild
): (file: string, args: readonly string[], options: LongLivedOptions) => Promise<LongLivedChild> {
  return () => Promise.resolve(started);
}

describe('runDocket', () => {
  it('starts the console package, passing the arguments the caller gave', async () => {
    const spawn = vi.fn(spawning(child(0)));

    await runDocket(['--audit', '2026-01-01'], ENV, spawn);

    expect(spawn).toHaveBeenCalledWith(
      'pnpm',
      ['--filter', '@hushbox/docket-console', 'start', '--audit', '2026-01-01'],
      expect.objectContaining({ stdio: 'inherit' })
    );
  });

  it('claims the port the console binds, so a kill leaves it reclaimable', async () => {
    const spawn = vi.fn(spawning(child(0)));

    await runDocket([], ENV, spawn);

    expect(spawn.mock.calls[0]?.[2]).toMatchObject({ ports: [12_800] });
  });

  it('hands back what the console exited with', async () => {
    const spawn = vi.fn(spawning(child(1)));

    await expect(runDocket([], ENV, spawn)).resolves.toBe(1);
  });

  it('refuses to start when the generated env names no console port', async () => {
    const spawn = vi.fn(spawning(child(0)));

    await expect(runDocket([], {}, spawn)).rejects.toThrow('HB_DOCKET_PORT');
    expect(spawn).not.toHaveBeenCalled();
  });
});
