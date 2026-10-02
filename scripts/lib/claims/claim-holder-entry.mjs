/**
 * Holds a claim in a separate process so the tests can do to it what only an
 * operating system can do to a process: freeze it, kill it, or let it exit
 * cleanly. Written as an ES module rather than TypeScript because it is a test
 * fixture that never runs inside the vitest process, so its lines are not the
 * claim primitive's coverage.
 *
 * Spawned as `node --import tsx <this file> <lockPath> <name> <holder> <onHeld>`.
 * It prints `held` once the claim is granted and `refused` if it was not, then
 * holds until anything arrives on standard input.
 */
import { ClaimHeldError, claim } from './claim.ts';

const [lockPath, name, holder, onHeld] = process.argv.slice(2);

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

try {
  await claim({ name, lockPath }, { onHeld, holder }, async () => {
    process.stdout.write('held\n');
    await untilStdin();
  });
} catch (error) {
  if (!(error instanceof ClaimHeldError)) throw error;
  process.stdout.write('refused\n');
  process.exitCode = 1;
}
