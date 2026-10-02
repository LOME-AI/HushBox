/**
 * Registers a run in a separate process, so the tests can do to it what only an
 * operating system can do to a process: kill it, or let it exit cleanly. An ES
 * module rather than TypeScript because it is a fixture that never runs inside
 * the vitest process, so its lines are not the registry's coverage.
 *
 * Spawned as `node --import tsx <this file> <registryDir> <command> <mode>
 * <slot> <gitCommonDir> <hold|exit> [resourceId...]`. It prints the run id it
 * registered, then either holds until something arrives on standard input or
 * exits straight away. A process that inherited a run claim adopts it, so the
 * same fixture also serves as a concurrent recorder against its parent's run.
 */
import path from 'node:path';
import { RUN_CLAIM_ENV, addResource, registerRun } from './registry.ts';

const [registryDir, command, mode, slot, gitCommonDir, ending, ...resourceIds] =
  process.argv.slice(2);

function untilStdin() {
  return new Promise((resolve) => {
    process.stdin.once('data', () => {
      // A resumed stdin keeps the event loop alive even once paused, so the
      // process would hold its claim forever after being told to let go.
      process.stdin.destroy();
      resolve();
    });
    process.stdin.resume();
  });
}

await registerRun({ command, mode, slot: Number(slot), gitCommonDir, registryDir }, async () => {
  for (const id of resourceIds) await addResource({ kind: 'port', id });
  process.stdout.write(`${path.basename(process.env[RUN_CLAIM_ENV])}\n`);
  if (ending === 'hold') await untilStdin();
});
