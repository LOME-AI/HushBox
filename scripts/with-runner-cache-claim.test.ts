import { describe, it, expect } from 'vitest';

import { runClaimingRunnerCache } from './with-runner-cache-claim.js';

function recorder(): { order: string[]; deps: Parameters<typeof runClaimingRunnerCache>[1] } {
  const order: string[] = [];
  return {
    order,
    deps: {
      hold: async (body) => {
        order.push('claimed');
        try {
          return await body();
        } finally {
          order.push('dropped');
        }
      },
      run: (command, args) => {
        order.push(`${command} ${args.join(' ')}`);
        return Promise.resolve(0);
      },
    },
  };
}

describe('runClaimingRunnerCache', () => {
  it('runs the command that starts the runner inside the cache claim', async () => {
    const probe = recorder();

    await runClaimingRunnerCache(['stryker', 'run'], probe.deps);

    expect(probe.order).toEqual(['claimed', 'stryker run', 'dropped']);
  });

  it('answers with the exit code of the command it ran', async () => {
    const probe = recorder();

    await expect(
      runClaimingRunnerCache(['stryker', 'run'], { ...probe.deps, run: () => Promise.resolve(3) })
    ).resolves.toBe(3);
  });

  it('refuses a command line naming nothing to run', async () => {
    const probe = recorder();

    await expect(runClaimingRunnerCache([], probe.deps)).rejects.toThrow(/Usage/);
    expect(probe.order).toEqual([]);
  });
});
