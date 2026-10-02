import { describe, expect, it, vi } from 'vitest';
import { composeProjectName } from './lib/cli/worktree.js';
import { tearDownStack, type StackTeardownDeps } from './stack-teardown.js';

const SLOT = 5;
const REPO_ROOT = 'a-checkout';

function deps(overrides: Partial<StackTeardownDeps> = {}): StackTeardownDeps {
  return {
    assertSlotFree: vi.fn(() => Promise.resolve()),
    composeDown: vi.fn().mockResolvedValue({ exitCode: 0, output: '' }),
    ...overrides,
  };
}

describe('tearDownStack', () => {
  it('asks the guard about the slot it was given', async () => {
    const injected = deps();

    await tearDownStack(SLOT, REPO_ROOT, injected);

    expect(injected.assertSlotFree).toHaveBeenCalledWith(SLOT);
  });

  it('destroys nothing when the guard refuses', async () => {
    const injected = deps({
      assertSlotFree: vi.fn().mockRejectedValue(new Error('another run holds slot 5')),
    });

    await expect(tearDownStack(SLOT, REPO_ROOT, injected)).rejects.toThrow('another run holds');

    expect(injected.composeDown).not.toHaveBeenCalled();
  });

  it('tears down the compose project the slot names', async () => {
    const injected = deps();

    await tearDownStack(SLOT, REPO_ROOT, injected);

    expect(injected.composeDown).toHaveBeenCalledWith(composeProjectName(SLOT), REPO_ROOT);
  });

  it('fails when the teardown command fails, reporting what it printed', async () => {
    const injected = deps({
      composeDown: vi.fn().mockResolvedValue({ exitCode: 1, output: 'no such network' }),
    });

    await expect(tearDownStack(SLOT, REPO_ROOT, injected)).rejects.toThrow('no such network');
  });

  it('fails when the teardown command was ended by a signal', async () => {
    const injected = deps({
      composeDown: vi.fn().mockResolvedValue({ exitCode: null, output: 'interrupted' }),
    });

    await expect(tearDownStack(SLOT, REPO_ROOT, injected)).rejects.toThrow('interrupted');
  });
});
