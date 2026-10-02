import { describe, it, expect, vi } from 'vitest';

import { runWorkersTests, workersVitestArgs } from './run-workers-tests.js';

describe('runWorkersTests', () => {
  it('provisions before running and tears down after', async () => {
    const order: string[] = [];

    await runWorkersTests({
      prepare: async () => {
        order.push('prepare');
        await Promise.resolve();
      },
      run: async () => {
        order.push('run');
        await Promise.resolve();
        return 0;
      },
      teardown: async () => {
        order.push('teardown');
        await Promise.resolve();
      },
    });

    expect(order).toEqual(['prepare', 'run', 'teardown']);
  });

  it('passes the runner exit code through', async () => {
    const exitCode = await runWorkersTests({
      prepare: async () => {},
      run: () => Promise.resolve(7),
      teardown: async () => {},
    });

    expect(exitCode).toBe(7);
  });

  it('tears the database down even when the run throws', async () => {
    const teardown = vi.fn(async () => {});

    await expect(
      runWorkersTests({
        prepare: async () => {},
        run: async () => {
          await Promise.resolve();
          throw new Error('vitest exploded');
        },
        teardown,
      })
    ).rejects.toThrow('vitest exploded');
    expect(teardown).toHaveBeenCalledTimes(1);
  });
});

describe('workersVitestArgs', () => {
  it('runs the package’s whole workerd project when the caller passes nothing', () => {
    expect(workersVitestArgs([])).toEqual(['run', '--config', 'vitest.workers.config.ts']);
  });

  it('forwards a caller’s arguments behind the project’s own', () => {
    expect(workersVitestArgs(['src/settlement.workers.test.ts'])).toEqual([
      'run',
      '--config',
      'vitest.workers.config.ts',
      'src/settlement.workers.test.ts',
    ]);
  });

  it('drops the separator pnpm keeps ahead of a caller’s arguments', () => {
    expect(workersVitestArgs(['--', 'src/settlement.workers.test.ts'])).toEqual([
      'run',
      '--config',
      'vitest.workers.config.ts',
      'src/settlement.workers.test.ts',
    ]);
  });

  it('refuses a separator the caller’s own arguments still carry', () => {
    expect(() => workersVitestArgs(['--', 'src', '--', '-t', 'a name'])).toThrow(
      "package-vitest: `--` ends vitest's options, so `-t`, `a name` would have reached neither " +
        'a filter nor a flag and the run would have covered every file the package config ' +
        'collects. Write the same arguments without the `--`.'
    );
  });
});
