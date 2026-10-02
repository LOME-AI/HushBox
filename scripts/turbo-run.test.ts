import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { READ_ONLY_LOCAL_CACHE, TURBO_CACHE_VARIABLE } from './lib/turbo/cache-writer.js';
import { runTurbo } from './turbo-run.js';

let rootDir: string;

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'turbo-run-'));
});

afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

describe('runTurbo', () => {
  it('runs the task runner with the arguments it was given', async () => {
    const seen: string[][] = [];

    await runTurbo(['run', '//#privacy:check'], {
      rootDir,
      env: {},
      exec: (args) => {
        seen.push([...args]);
        return Promise.resolve(0);
      },
    });

    expect(seen).toEqual([['run', '//#privacy:check']]);
  });

  it('answers the exit code the task runner answered', async () => {
    const exitCode = await runTurbo(['lint'], {
      rootDir,
      env: {},
      exec: () => Promise.resolve(2),
    });

    expect(exitCode).toBe(2);
  });

  it('runs the task runner inside the writer election', async () => {
    const env: NodeJS.ProcessEnv = { [TURBO_CACHE_VARIABLE]: READ_ONLY_LOCAL_CACHE };
    let modeSeen: string | undefined = 'unset';

    await runTurbo(['lint'], {
      rootDir,
      env,
      exec: () => {
        modeSeen = env[TURBO_CACHE_VARIABLE];
        return Promise.resolve(0);
      },
    });

    // Unrestricted, because nothing else holds the seat this run just took —
    // which is only observable if the election ran at all.
    expect(modeSeen).toBeUndefined();
  });
});
