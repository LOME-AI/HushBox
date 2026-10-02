/**
 * Claims a slot from a separate process, so the tests can put real concurrent
 * claimers against one registry — a promise fan-out inside one process shares
 * the allocator's own file descriptors and would prove nothing about two
 * processes racing. An ES module rather than TypeScript because it is a fixture
 * that never runs inside the vitest process, so its lines are not the
 * allocator's coverage.
 *
 * Spawned as `node --import tsx <this file> <registryDir> <worktreePath>
 * <gitDir>`. It prints `ready` once it is loaded and then waits for a line on
 * standard input, so the test can release every claimer only after all of them
 * are past their startup cost — released before that, they allocate one after
 * another and never contend at all.
 */
import { claimSlot } from './slot-claim.ts';

const [registryDir, worktreePath, gitDir] = process.argv.slice(2);

process.stdout.write('ready\n');

await new Promise((resolve) => {
  process.stdin.once('data', () => {
    process.stdin.destroy();
    resolve();
  });
  process.stdin.resume();
});

process.stdout.write(`${String(claimSlot({ registryDir, worktreePath, gitDir }))}\n`);
