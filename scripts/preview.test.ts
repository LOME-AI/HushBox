import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));
vi.mock('concurrently', () => ({ default: vi.fn() }));

import { execa } from 'execa';
import concurrently from 'concurrently';
import { runBuild, runConcurrent, type PreviewConfig } from './preview.js';

const mockExeca = vi.mocked(execa);
const mockConcurrently = vi.mocked(concurrently);

describe('preview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['HB_PREVIEW_PORT'];
  });

  describe('runBuild', () => {
    it('runs pnpm --filter @hushbox/web build in development mode', async () => {
      mockExeca.mockResolvedValue({ exitCode: 0 } as never);
      await runBuild();
      expect(mockExeca).toHaveBeenCalledWith(
        'pnpm',
        ['--filter', '@hushbox/web', 'build', '--mode', 'development'],
        { stdio: 'inherit' }
      );
    });
  });

  describe('runConcurrent', () => {
    function fakeConcurrentlyResult(): ReturnType<typeof concurrently> {
      return {
        result: Promise.resolve([{ command: { name: 'api' }, exitCode: 0 }]) as never,
        commands: [],
        kill: () => {},
      } as unknown as ReturnType<typeof concurrently>;
    }

    it('runs api dev and web preview in parallel with port from env', async () => {
      process.env['HB_PREVIEW_PORT'] = '4321';
      mockConcurrently.mockReturnValue(fakeConcurrentlyResult());
      await runConcurrent();
      expect(mockConcurrently).toHaveBeenCalledWith(
        [
          { name: 'api', command: 'pnpm --filter @hushbox/api dev' },
          {
            name: 'web',
            command: 'pnpm --filter @hushbox/web preview --port 4321 --open',
          },
        ],
        expect.objectContaining({ killOthers: ['failure', 'success'] })
      );
    });

    it('throws when HB_PREVIEW_PORT is unset', async () => {
      await expect(runConcurrent()).rejects.toThrow(
        'HB_PREVIEW_PORT is not set — run pnpm generate:env first'
      );
    });
  });

  describe('PreviewConfig type export', () => {
    it('is structurally compatible with the commands we pass to concurrently', () => {
      const config: PreviewConfig = { name: 'x', command: 'y' };
      expect(config).toEqual({ name: 'x', command: 'y' });
    });
  });
});
