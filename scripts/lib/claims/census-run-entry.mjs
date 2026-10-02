/**
 * A whole invocation in another process: it registers a run and starts one
 * task, in one of the three shapes a task can stand in relative to the run's
 * own record.
 *
 * Only a real process carries an environment a census can read, and only a real
 * one can be put in a group of its own, so only a real one can show what the
 * record does and does not reach. An ES module rather than TypeScript because it
 * never runs inside the vitest process, so its lines are nobody's coverage.
 *
 * Spawned as `node --import tsx <this file> <registryDir> <reportDir> <shape>`,
 * where the shape is `recorded` (the task in the group the run records),
 * `departed` (the task starts its own work in a group of its own) or
 * `unrecorded` (the task started with no record taken at all). It prints the run
 * id and the recorded group id, then holds until something arrives on standard
 * input.
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RUN_CLAIM_ENV, registerRun } from './registry.ts';
import { spawnLongLived } from '../spawn/long-lived.ts';

const TASK = fileURLToPath(new URL('census-task-entry.mjs', import.meta.url));

const [registryDir, reportDir, shape] = process.argv.slice(2);

function untilStdin() {
  return new Promise((resolve) => {
    process.stdin.once('data', () => {
      process.stdin.destroy();
      resolve();
    });
    process.stdin.resume();
  });
}

await registerRun(
  {
    command: 'pnpm dev',
    mode: 'development',
    slot: 3,
    gitCommonDir: path.join(registryDir, 'checkout', '.git'),
    registryDir,
  },
  async () => {
    let recorded = '';
    if (shape === 'unrecorded') {
      // Started the way a command that takes no record starts one: in this
      // process's own group, which nothing named.
      spawn(process.execPath, [TASK, reportDir, 'task'], { stdio: 'ignore', detached: false });
    } else {
      const child = await spawnLongLived(
        process.execPath,
        [TASK, reportDir, 'task', shape === 'departed' ? 'escape' : ''],
        { stdio: 'ignore', ports: [] }
      );
      recorded = String(child.pgid);
    }
    process.stdout.write(`${path.basename(process.env[RUN_CLAIM_ENV])} ${recorded}\n`);
    await untilStdin();
  }
);
