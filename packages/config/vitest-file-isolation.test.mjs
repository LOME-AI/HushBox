// A lane the worker count is derived against is a child process of the runner,
// and these declarations are what make that true. The memory bound reads what a
// whole run held filed under the lanes that were live when it held it, and the
// lane counter in `scripts/lib/vitest/workers.ts` takes those lanes by parentage
// in the machine's process table: a worker that is a thread of the
// runner is no child of it, so a run on a thread pool records a peak under no
// width at all and the ledger falls back to approximating one, while a run
// funnelled through a single fork files every peak it ever takes at one lane.
// Neither is observable from inside a run — a worker sees its own process and no
// other — so the declaration is what gets asserted, here, where it is made.
// Every run that is not the standalone workerd pool resolves against this
// config: a package config merges it, and the consolidated config spreads its
// test options into its own root block.
//
// Written against the effective value rather than the literal one, so declaring
// a safe setting explicitly is not a failure.
import { describe, expect, it } from 'vitest';

import rootConfig from './vitest.config.ts';

const { pool, isolate, fileParallelism, poolOptions } = rootConfig.test;

describe('the shared test configuration', () => {
  it('runs a test file in a process rather than a thread of the runner', () => {
    expect(pool ?? 'forks').toBe('forks');
  });

  it('gives each test file a fork of its own', () => {
    expect(isolate ?? true).toBe(true);
    expect(poolOptions?.forks?.isolate ?? true).toBe(true);
  });

  it('never funnels the whole run through one fork', () => {
    expect(fileParallelism ?? true).toBe(true);
    expect(poolOptions?.forks?.singleFork ?? false).toBe(false);
  });
});
