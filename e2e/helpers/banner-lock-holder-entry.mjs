/**
 * Holds the banner-row lock in a separate process, so the spec can do to the
 * holder what only an operating system can do to a process: freeze it, kill it,
 * or let it exit cleanly. Written as an ES module rather than TypeScript
 * because it is a fixture that never runs inside a Playwright worker.
 *
 * Spawned as `node --import tsx <this file> <lockPath>`. It prints `held` once
 * the lock is granted, then holds it until anything arrives on standard input.
 */
import { withBannerLock } from './banner-lock.ts';

const [lockPath] = process.argv.slice(2);

function untilStdin() {
  return new Promise((resolve) => {
    process.stdin.once('data', () => {
      // A resumed stdin keeps the event loop alive even once paused, so the
      // process would hold the row forever after being told to let go.
      process.stdin.destroy();
      resolve();
    });
    process.stdin.resume();
  });
}

await withBannerLock(
  async () => {
    process.stdout.write('held\n');
    await untilStdin();
  },
  { lockPath }
);
