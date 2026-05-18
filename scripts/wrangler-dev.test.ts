import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));

import { execa } from 'execa';
import { runWranglerDev } from './wrangler-dev.js';

const mockExeca = vi.mocked(execa);

describe('wrangler-dev', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['HB_API_PORT'];
  });

  it('spawns wrangler dev with port from HB_API_PORT', async () => {
    process.env['HB_API_PORT'] = '8915';
    mockExeca.mockResolvedValue({ exitCode: 0 } as never);
    const exitCode = await runWranglerDev();
    expect(mockExeca).toHaveBeenCalledWith('wrangler', ['dev', '--port', '8915'], {
      stdio: 'inherit',
      reject: false,
    });
    expect(exitCode).toBe(0);
  });

  it('propagates child exit code', async () => {
    process.env['HB_API_PORT'] = '8915';
    mockExeca.mockResolvedValue({ exitCode: 3 } as never);
    expect(await runWranglerDev()).toBe(3);
  });

  it('returns 1 when child has no numeric exit code', async () => {
    process.env['HB_API_PORT'] = '8915';
    mockExeca.mockResolvedValue({ exitCode: undefined } as never);
    expect(await runWranglerDev()).toBe(1);
  });

  it('throws when HB_API_PORT is unset', async () => {
    await expect(runWranglerDev()).rejects.toThrow(
      'HB_API_PORT is not set — run pnpm generate:env first'
    );
  });
});
