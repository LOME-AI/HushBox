import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

import { buildTreeScanTasks, runParallel, type Task } from './pre-push.js';

/**
 * The runner's own termination path is what this file exercises, so the process
 * library is the real one here and the rest of the hook's tests, which fake it,
 * live beside this file rather than in it.
 */

/**
 * A script whose termination handler leaves work behind it, as the tree scan's
 * does: the handler ends the wait, and what removes the materialised tree runs
 * after it. The wait it leaves behind outlasts the five seconds the process
 * library kills after by default, because the removal has been measured past
 * that too.
 */
const UNWINDING_SCRIPT = `
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const terminated = new Promise((resolve) => {
  const keepAlive = setTimeout(resolve, 60_000);
  process.once('SIGTERM', () => {
    clearTimeout(keepAlive);
    resolve();
  });
});

void (async () => {
  await writeFile(path.join(directory, 'armed'), '');
  try {
    await terminated;
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 6500));
    await writeFile(path.join(directory, 'unwound'), '');
  }
})();
`;

/** Fails as soon as the scan is running, which is when the runner kills it. */
const FAILING_SIBLING = `
import { existsSync } from 'node:fs';

const armed = process.argv[2];
const deadline = Date.now() + 30_000;
const poll = () => {
  if (existsSync(armed) || Date.now() > deadline) process.exit(1);
  setTimeout(poll, 25);
};
poll();
`;

describe.skipIf(process.platform === 'win32')('runParallel', () => {
  // The runner ends a losing parallel set by terminating every sibling, and the
  // tree scan removes close to half a gigabyte in the unwind that starts. Two
  // things can lose that unwind: a launcher that relays the signal to a child
  // and then kills it, and the force kill the runner schedules behind its own
  // signal. Neither is visible in the task's shape, so the task is run against
  // a script that records whether its unwind finished.
  it('leaves a terminated task long enough to finish an unwind that outlasts five seconds', async () => {
    const [scan] = buildTreeScanTasks('', true, []);
    if (scan === undefined) throw new Error('the hook built no tree scan');
    const directory = await mkdtemp(path.join(os.tmpdir(), 'hushbox-pre-push-unwind-'));
    try {
      const script = path.join(directory, 'probe.ts');
      const siblingScript = path.join(directory, 'sibling.mjs');
      await writeFile(script, UNWINDING_SCRIPT);
      await writeFile(siblingScript, FAILING_SIBLING);
      const probe: Task = {
        ...scan,
        args: scan.args.map((argument) =>
          argument.endsWith('gitleaks-scan.ts') ? script : argument
        ),
      };
      expect(probe.args).toContain(script);
      const sibling: Task = {
        name: 'sibling',
        command: 'node',
        args: [siblingScript, path.join(directory, 'armed')],
      };

      await expect(runParallel([probe, sibling])).rejects.toThrow();

      expect(existsSync(path.join(directory, 'unwound'))).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 40_000);
});
