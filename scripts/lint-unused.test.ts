import { describe, expect, it } from 'vitest';

import { KNIP_ARGUMENTS, runUnusedGate } from './lint-unused.js';

const rootDir = 'checkout-root';

describe('the unused-code gate', () => {
  it('loads the checkout’s environment before it runs the unused-code scan', async () => {
    const order: string[] = [];

    await runUnusedGate([], {
      rootDir,
      loadEnvironment: () => {
        order.push('environment');
      },
      scan: () => {
        order.push('scan');
        return Promise.resolve(0);
      },
    });

    expect(order).toEqual(['environment', 'scan']);
  });

  it('loads the environment of the checkout it was told to scan', async () => {
    const loaded: string[] = [];

    await runUnusedGate([], {
      rootDir,
      loadEnvironment: (dir) => {
        loaded.push(dir);
      },
      scan: () => Promise.resolve(0),
    });

    expect(loaded).toEqual([rootDir]);
  });

  it('carries the caller’s arguments after its own', async () => {
    const seen: string[][] = [];

    await runUnusedGate(['--reporter', 'json'], {
      rootDir,
      loadEnvironment: () => {},
      scan: (args) => {
        seen.push([...args]);
        return Promise.resolve(0);
      },
    });

    expect(seen).toEqual([[...KNIP_ARGUMENTS, '--reporter', 'json']]);
  });

  it('answers the exit code the scan answered', async () => {
    const exitCode = await runUnusedGate([], {
      rootDir,
      loadEnvironment: () => {},
      scan: () => Promise.resolve(2),
    });

    expect(exitCode).toBe(2);
  });
});
