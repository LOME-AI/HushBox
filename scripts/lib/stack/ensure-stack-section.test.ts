import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * The section's whole point is that a second caller cannot run a mutating step
 * beside the first, and only real processes scheduled against each other can
 * show that. They run through tsx's loader in-process (`--import`) rather than
 * through its CLI, which forks: the lock must belong to the process the test
 * is watching.
 */
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const ENTRY = fileURLToPath(new URL('ensure-stack-entry.mjs', import.meta.url));

const SLOT = 11;

let workDir = '';
let registryDir = '';
let logFile = '';

function runEnsureStack(holdMs: number, shape: 'plain' | 'nested' = 'plain'): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        TSX_LOADER,
        ENTRY,
        workDir,
        String(SLOT),
        registryDir,
        logFile,
        String(holdMs),
        shape,
      ],
      { stdio: ['ignore', 'ignore', 'inherit'] }
    );
    child.once('error', reject);
    child.once('exit', (code) => {
      resolve(code ?? -1);
    });
  });
}

function installLog(): string[] {
  return readFileSync(logFile, 'utf8').trim().split('\n');
}

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'hb-section-'));
  registryDir = mkdtempSync(path.join(tmpdir(), 'hb-section-claims-'));
  logFile = path.join(workDir, 'install.log');
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  rmSync(registryDir, { recursive: true, force: true });
});

describe('two ensure-stack runs on one slot', () => {
  it('runs their mutating steps in sequence, so an install never overlaps an install', async () => {
    // Long enough that a second caller reaching the step unlocked would land
    // inside the first one's bracket rather than after it.
    const [first, second] = await Promise.all([runEnsureStack(750), runEnsureStack(750)]);

    expect([first, second]).toEqual([0, 0]);
    expect(installLog()).toEqual(['enter', 'exit', 'enter', 'exit']);
  });

  it('lets a run spawned inside the section through, rather than queueing it behind its parent', async () => {
    // The nested run claims the same section from a child process. Without
    // inherited re-entrancy this does not fail, it never returns.
    expect(await runEnsureStack(0, 'nested')).toBe(0);
    expect(installLog()).toEqual(['enter', 'exit', 'enter', 'exit']);
  });
});
