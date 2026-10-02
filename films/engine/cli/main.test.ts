import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MockInstance } from 'vitest';

const originalArgv = process.argv;
let stderr: MockInstance<typeof process.stderr.write>;
let exit: MockInstance<typeof process.exit>;

/** Stands in for the process exiting, which a test cannot let happen. */
class ExitCalled extends Error {
  constructor(readonly code: number | string | null | undefined) {
    super(`exit ${String(code)}`);
  }
}

/**
 * Loads the entry module fresh with `args` after the script path, as
 * `pnpm films <args>` would, and returns the code it exits with.
 */
async function runEntry(...args: string[]): Promise<unknown> {
  process.argv = [originalArgv[0] ?? 'node', 'main.ts', ...args];
  vi.resetModules();
  try {
    await import('./main.js');
  } catch (error) {
    if (error instanceof ExitCalled) return error.code;
    throw error;
  }
  return 'no exit';
}

function writtenToStderr(): string {
  return stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
}

beforeEach(() => {
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation((_chunk, done?: unknown) => {
    if (typeof done === 'function') Reflect.apply(done, undefined, []);
    return true;
  });
  exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new ExitCalled(code);
  });
});

afterEach(() => {
  process.argv = originalArgv;
  stderr.mockRestore();
  exit.mockRestore();
});

describe('pnpm films', () => {
  it('prints the usage line for an unknown verb', async () => {
    await runEntry('dance');

    expect(writtenToStderr()).toMatch(/usage: pnpm films <score\|stills\|render\|verify\|take>/);
  });

  it('exits 2 for an unknown verb', async () => {
    expect(await runEntry('dance')).toBe(2);
  });

  it('exits 2 when no verb is given', async () => {
    expect(await runEntry()).toBe(2);
  });

  it('exits 2 for verify without a film id', async () => {
    expect(await runEntry('verify')).toBe(2);
  });
});
