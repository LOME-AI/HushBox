import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));
vi.mock('concurrently', () => ({ default: vi.fn() }));

import { execa } from 'execa';
import concurrently from 'concurrently';
import {
  runPrep,
  runParallelBuilds,
  runMerge,
  startPreview,
  main,
  type Step,
} from './e2e-preview-up.js';

const mockExeca = vi.mocked(execa);
const mockConcurrently = vi.mocked(concurrently);

function fakeConcurrentlyResult(): ReturnType<typeof concurrently> {
  return {
    result: Promise.resolve([{ command: { name: 'x' }, exitCode: 0 }]) as never,
    commands: [],
    kill: () => {},
  } as unknown as ReturnType<typeof concurrently>;
}

function rejectedConcurrentlyResult(error: Error): ReturnType<typeof concurrently> {
  return {
    // eslint-disable-next-line promise/no-promise-in-callback -- test fixture deliberately models a rejected concurrently.result
    result: Promise.reject(error) as never,
    commands: [],
    kill: () => {},
  } as unknown as ReturnType<typeof concurrently>;
}

describe('e2e-preview-up', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['CI'];
    delete process.env['HB_PREVIEW_PORT'];
  });

  afterEach(() => {
    delete process.env['CI'];
    delete process.env['HB_PREVIEW_PORT'];
  });

  describe('runPrep', () => {
    it('in local mode runs kill-ports and generate:env in parallel with kill-on-failure', async () => {
      mockConcurrently.mockReturnValue(fakeConcurrentlyResult());
      await runPrep();
      expect(mockConcurrently).toHaveBeenCalledTimes(1);
      const call = mockConcurrently.mock.calls[0];
      expect(call).toBeDefined();
      const [steps, options] = call as [Step[], { killOthers: string[]; prefix: string }];
      expect(steps).toEqual([
        { name: 'kill-ports', command: 'tsx scripts/kill-ports.ts HB_PREVIEW_PORT' },
        { name: 'gen-env', command: 'pnpm generate:env --mode=e2e' },
      ]);
      expect(options).toMatchObject({ killOthers: ['failure'], prefix: 'name' });
    });

    it('in CI mode skips generate:env', async () => {
      process.env['CI'] = '1';
      mockConcurrently.mockReturnValue(fakeConcurrentlyResult());
      await runPrep();
      const call = mockConcurrently.mock.calls[0];
      expect(call).toBeDefined();
      const [steps] = call as [Step[], unknown];
      expect(steps).toEqual([
        { name: 'kill-ports', command: 'tsx scripts/kill-ports.ts HB_PREVIEW_PORT' },
      ]);
    });

    it('propagates failure from any of the parallel prep steps', async () => {
      mockConcurrently.mockReturnValue(rejectedConcurrentlyResult(new Error('kill-ports failed')));
      await expect(runPrep()).rejects.toThrow('kill-ports failed');
    });
  });

  describe('runParallelBuilds', () => {
    it('in local mode runs marketing build, web build, and db:reset in parallel', async () => {
      mockConcurrently.mockReturnValue(fakeConcurrentlyResult());
      await runParallelBuilds();
      const call = mockConcurrently.mock.calls[0];
      expect(call).toBeDefined();
      const [steps, options] = call as [Step[], { killOthers: string[]; prefix: string }];
      expect(steps).toEqual([
        {
          name: 'marketing',
          command: 'pnpm --filter @hushbox/marketing build --mode development',
        },
        {
          name: 'web',
          command: 'pnpm --filter @hushbox/web build --mode development',
        },
        { name: 'db', command: 'pnpm db:reset' },
      ]);
      expect(options).toMatchObject({ killOthers: ['failure'], prefix: 'name' });
    });

    it('in CI mode runs marketing build and web build only (CI provides its own DB)', async () => {
      process.env['CI'] = '1';
      mockConcurrently.mockReturnValue(fakeConcurrentlyResult());
      await runParallelBuilds();
      const call = mockConcurrently.mock.calls[0];
      expect(call).toBeDefined();
      const [steps] = call as [Step[], unknown];
      expect(steps).toEqual([
        {
          name: 'marketing',
          command: 'pnpm --filter @hushbox/marketing build --mode development',
        },
        {
          name: 'web',
          command: 'pnpm --filter @hushbox/web build --mode development',
        },
      ]);
    });

    it('propagates failure when any parallel child rejects', async () => {
      mockConcurrently.mockReturnValue(rejectedConcurrentlyResult(new Error('web build failed')));
      await expect(runParallelBuilds()).rejects.toThrow('web build failed');
    });
  });

  describe('runMerge', () => {
    it('invokes scripts/merge-marketing-into-web.ts via tsx', async () => {
      mockExeca.mockResolvedValue({ exitCode: 0 } as never);
      await runMerge();
      expect(mockExeca).toHaveBeenCalledWith('tsx', ['scripts/merge-marketing-into-web.ts'], {
        stdio: 'inherit',
      });
    });

    it('propagates merge failure', async () => {
      mockExeca.mockRejectedValueOnce(new Error('merge failed: missing dist'));
      await expect(runMerge()).rejects.toThrow('merge failed: missing dist');
    });
  });

  describe('startPreview', () => {
    it('runs pnpm --filter @hushbox/web preview with port from env', async () => {
      process.env['HB_PREVIEW_PORT'] = '4301';
      mockExeca.mockResolvedValue({ exitCode: 0 } as never);
      await startPreview();
      expect(mockExeca).toHaveBeenCalledWith(
        'pnpm',
        ['--filter', '@hushbox/web', 'preview', '--port', '4301'],
        { stdio: 'inherit' }
      );
    });

    it('throws a clear error when HB_PREVIEW_PORT is unset', async () => {
      await expect(startPreview()).rejects.toThrow(
        'HB_PREVIEW_PORT is not set — run pnpm generate:env first'
      );
    });
  });

  describe('main', () => {
    it('executes steps in order: prep → parallel-builds → merge → preview', async () => {
      process.env['HB_PREVIEW_PORT'] = '4301';
      const callOrder: string[] = [];
      mockConcurrently.mockImplementation(((steps: readonly Step[]) => {
        const names = new Set(steps.map((s) => s.name));
        if (names.has('kill-ports')) callOrder.push('prep');
        else if (names.has('marketing')) callOrder.push('parallel');
        return fakeConcurrentlyResult();
      }) as never);
      mockExeca.mockImplementation(((cmd: string, args: readonly string[]) => {
        if (cmd === 'tsx' && args[0] === 'scripts/merge-marketing-into-web.ts') {
          callOrder.push('merge');
        } else if (cmd === 'pnpm' && args.includes('preview')) {
          callOrder.push('preview');
        }
        return Promise.resolve({ exitCode: 0 } as never);
      }) as never);
      await main();
      expect(callOrder).toEqual(['prep', 'parallel', 'merge', 'preview']);
    });

    it('stops the pipeline if a build fails (merge and preview do not run)', async () => {
      process.env['HB_PREVIEW_PORT'] = '4301';
      const callOrder: string[] = [];
      mockConcurrently.mockImplementation(((steps: readonly Step[]) => {
        const names = steps.map((s) => s.name);
        if (names.includes('kill-ports')) {
          callOrder.push('prep');
          return fakeConcurrentlyResult();
        }
        callOrder.push('parallel');
        return rejectedConcurrentlyResult(new Error('marketing build failed'));
      }) as never);
      mockExeca.mockImplementation(((cmd: string, args: readonly string[]) => {
        if (cmd === 'tsx' && args[0] === 'scripts/merge-marketing-into-web.ts') {
          callOrder.push('merge');
        } else if (cmd === 'pnpm' && args.includes('preview')) {
          callOrder.push('preview');
        }
        return Promise.resolve({ exitCode: 0 } as never);
      }) as never);
      await expect(main()).rejects.toThrow('marketing build failed');
      expect(callOrder).toEqual(['prep', 'parallel']);
    });
  });
});
