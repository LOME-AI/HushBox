import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));

import { execa } from 'execa';
import { runDrizzleStudio } from './drizzle-studio.js';

const mockExeca = vi.mocked(execa);

describe('drizzle-studio', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['HB_STUDIO_PORT'];
  });

  it('spawns drizzle-kit studio with port from HB_STUDIO_PORT', async () => {
    process.env['HB_STUDIO_PORT'] = '5111';
    mockExeca.mockResolvedValue({ exitCode: 0 } as never);
    const exitCode = await runDrizzleStudio();
    expect(mockExeca).toHaveBeenCalledWith('drizzle-kit', ['studio', '--port=5111'], {
      stdio: 'inherit',
      reject: false,
    });
    expect(exitCode).toBe(0);
  });

  it('propagates child exit code', async () => {
    process.env['HB_STUDIO_PORT'] = '5111';
    mockExeca.mockResolvedValue({ exitCode: 2 } as never);
    expect(await runDrizzleStudio()).toBe(2);
  });

  it('returns 1 when child has no numeric exit code', async () => {
    process.env['HB_STUDIO_PORT'] = '5111';
    mockExeca.mockResolvedValue({ exitCode: undefined } as never);
    expect(await runDrizzleStudio()).toBe(1);
  });

  it('throws when HB_STUDIO_PORT is unset', async () => {
    await expect(runDrizzleStudio()).rejects.toThrow(
      'HB_STUDIO_PORT is not set — run pnpm generate:env first'
    );
  });
});
