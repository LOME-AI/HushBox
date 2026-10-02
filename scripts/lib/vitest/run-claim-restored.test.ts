import { describe, it, expect } from 'vitest';

import { RUN_CLAIM_ENV } from '../claims/registry.js';
import { runClaimRestorationFailure, runClaimRestorationGuard } from './run-claim-restored.js';

describe('runClaimRestorationFailure', () => {
  it('finds nothing to report when the variable ends where it started', () => {
    expect(runClaimRestorationFailure('a-run-directory', 'a-run-directory')).toBeNull();
  });

  it('reads an absent variable and an empty one as the same state', () => {
    expect(runClaimRestorationFailure(undefined, '')).toBeNull();
  });

  it('reports a file that was invoked holding a claim and left the variable empty', () => {
    const failure = runClaimRestorationFailure('a-run-directory', '');

    expect(failure).toContain(RUN_CLAIM_ENV);
    expect(failure).toContain('holding a run claim');
    expect(failure).toContain('holding no run claim');
  });

  it('reads a variable the file removed as the empty one it is meant to leave', () => {
    expect(runClaimRestorationFailure('a-run-directory')).toContain(RUN_CLAIM_ENV);
  });

  it('reports a file that was invoked holding none and left one set', () => {
    expect(runClaimRestorationFailure('', 'a-run-directory')).toContain(RUN_CLAIM_ENV);
  });

  it('reports a file that swapped one claim for another', () => {
    expect(runClaimRestorationFailure('a-run-directory', 'another-run-directory')).toContain(
      RUN_CLAIM_ENV
    );
  });

  it('sends the reader after a stub as readily as an assignment, since both survive a file', () => {
    const failure = runClaimRestorationFailure('a-run-directory', '');

    expect(failure).not.toContain('raw assignment');
    expect(failure).not.toContain('unstubAllEnvs');
  });

  it('scopes the surviving value to a per-test setup hook, the only kind a stub outlives a file from', () => {
    const failure = runClaimRestorationFailure('a-run-directory', '');

    expect(failure).toContain('per-test setup hook');
  });

  it('names neither value, because a claim directory is a path on someone’s machine', () => {
    const failure = runClaimRestorationFailure('a-run-directory', 'another-run-directory');

    expect(failure).not.toContain('a-run-directory');
    expect(failure).not.toContain('another-run-directory');
  });
});

describe('runClaimRestorationGuard', () => {
  it('reads the variable after the file has run, not when the guard is armed', async () => {
    const order: string[] = [];
    const guard = runClaimRestorationGuard('a-run-directory', () => {
      order.push('read');
      return 'a-run-directory';
    });

    await guard(() => {
      order.push('file');
      return Promise.resolve();
    });

    expect(order).toEqual(['file', 'read']);
  });

  it('says nothing when the file gave the variable back', async () => {
    const guard = runClaimRestorationGuard('a-run-directory', () => 'a-run-directory');

    await expect(guard(() => Promise.resolve())).resolves.toBeUndefined();
  });

  it('throws the refusal when the file left the variable somewhere else', async () => {
    const guard = runClaimRestorationGuard('a-run-directory', () => '');

    await expect(guard(() => Promise.resolve())).rejects.toThrow(RUN_CLAIM_ENV);
  });
});
