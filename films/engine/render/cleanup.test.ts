import { describe, expect, it } from 'vitest';

import { thenCleanUp } from './cleanup.js';

const RESOLVED = async (): Promise<void> => {
  await Promise.resolve();
};

function rejecting(reason: unknown): () => Promise<never> {
  return async () => {
    await Promise.resolve();
    throw reason;
  };
}

/** What `thenCleanUp` rejects with, or the string 'resolved'. */
async function outcomeOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return error;
  }
}

describe('thenCleanUp', () => {
  it("resolves with the work's value", async () => {
    await expect(thenCleanUp(() => Promise.resolve(7), RESOLVED)).resolves.toBe(7);
  });

  it('cleans up after work that succeeds', async () => {
    const calls: string[] = [];
    await thenCleanUp(
      () => {
        calls.push('work');
        return Promise.resolve();
      },
      () => {
        calls.push('cleanup');
        return Promise.resolve();
      }
    );

    expect(calls).toEqual(['work', 'cleanup']);
  });

  it('cleans up after work that fails', async () => {
    const calls: string[] = [];
    await outcomeOf(
      thenCleanUp(rejecting(new Error('render')), () => {
        calls.push('cleanup');
        return Promise.resolve();
      })
    );

    expect(calls).toEqual(['cleanup']);
  });

  it("rejects with the work's error when the cleanup succeeds", async () => {
    const failure = new Error('render');

    expect(await outcomeOf(thenCleanUp(rejecting(failure), RESOLVED))).toBe(failure);
  });

  it("rejects with the cleanup's error when only the cleanup fails", async () => {
    const cleanupFailure = new Error('cleanup');

    expect(await outcomeOf(thenCleanUp(() => Promise.resolve(), rejecting(cleanupFailure)))).toBe(
      cleanupFailure
    );
  });

  it("keeps the work's error when the cleanup also fails", async () => {
    const failure = new Error('render');

    expect(await outcomeOf(thenCleanUp(rejecting(failure), rejecting(new Error('cleanup'))))).toBe(
      failure
    );
  });

  it("makes the cleanup's failure the cause of the work's error", async () => {
    const failure = new Error('render');
    const cleanupFailure = new Error('cleanup');
    await outcomeOf(thenCleanUp(rejecting(failure), rejecting(cleanupFailure)));

    expect(failure.cause).toBe(cleanupFailure);
  });

  it("keeps the work's own cause beside the cleanup's failure", async () => {
    const ownCause = new Error('remotion');
    const failure = new Error('render', { cause: ownCause });
    const cleanupFailure = new Error('cleanup');
    await outcomeOf(thenCleanUp(rejecting(failure), rejecting(cleanupFailure)));

    expect(failure.cause).toMatchObject({ errors: [ownCause, cleanupFailure] });
  });

  it('keeps a failure that is no Error beside the cleanup failure', async () => {
    const cleanupFailure = new Error('cleanup');

    expect(
      await outcomeOf(thenCleanUp(rejecting('render'), rejecting(cleanupFailure)))
    ).toMatchObject({ errors: ['render', cleanupFailure] });
  });
});
