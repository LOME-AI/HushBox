import { describe, it, expect, vi } from 'vitest';
import { runDrizzleStudio } from './drizzle-studio.js';
import type { LongLivedChild, LongLivedOptions } from './lib/spawn/long-lived.js';

function child(exitCode: number): LongLivedChild {
  return {
    pid: 4242,
    pgid: 4242,
    exit: Promise.resolve(exitCode),
    kill: () => Promise.resolve(exitCode),
  };
}

/** A stand-in for the long-lived spawner, typed as the call sites see it. */
function spawning(
  started: LongLivedChild
): (file: string, args: readonly string[], options: LongLivedOptions) => Promise<LongLivedChild> {
  return () => Promise.resolve(started);
}

describe('runDrizzleStudio', () => {
  it('starts the studio on the port the port plan gave this stack', async () => {
    const spawn = vi.fn(spawning(child(0)));

    await runDrizzleStudio({ HB_STUDIO_PORT: '12000' }, spawn);

    expect(spawn).toHaveBeenCalledWith(
      'drizzle-kit',
      ['studio', '--port=12000'],
      expect.objectContaining({ stdio: 'inherit' })
    );
  });

  it('claims the port it tells the studio to bind, so a kill leaves it reclaimable', async () => {
    const spawn = vi.fn(spawning(child(0)));

    await runDrizzleStudio({ HB_STUDIO_PORT: '12000' }, spawn);

    expect(spawn.mock.calls[0]?.[2]).toMatchObject({ ports: [12_000] });
  });

  it('hands back what the studio exited with', async () => {
    const spawn = vi.fn(spawning(child(2)));

    await expect(runDrizzleStudio({ HB_STUDIO_PORT: '12000' }, spawn)).resolves.toBe(2);
  });

  it('refuses to start when the generated env names no studio port', async () => {
    const spawn = vi.fn(spawning(child(0)));

    await expect(runDrizzleStudio({}, spawn)).rejects.toThrow('HB_STUDIO_PORT');
    expect(spawn).not.toHaveBeenCalled();
  });
});
