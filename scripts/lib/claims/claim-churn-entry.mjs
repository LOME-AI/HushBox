/**
 * Takes and releases one claim per round in a separate process, so a probe
 * running beside it lands inside whatever window a claim has between being
 * granted and naming its holder. The round comes from standard input, which is
 * what lets the probe hammer the one claim being contended rather than sweeping
 * for it. Written as an ES module rather than TypeScript because it is a test
 * fixture that never runs inside the vitest process, so its lines are not the
 * claim primitive's coverage.
 *
 * Spawned as `node --import tsx <this file> <dir> <holder>`. It prints
 * `churning` once, then for each round it is given takes and releases that
 * round's claim and prints `done <round>`.
 */
import path from 'node:path';
import readline from 'node:readline';
import { ClaimHeldError, claim } from './claim.ts';

const [dir, holder] = process.argv.slice(2);
const rounds = readline.createInterface({ input: process.stdin });

process.stdout.write('churning\n');

for await (const line of rounds) {
  const round = line.trim();
  try {
    await claim(
      { name: 'churn', lockPath: path.join(dir, `round-${round}.lock`) },
      { onHeld: 'refuse', holder },
      () => Promise.resolve()
    );
  } catch (error) {
    // Expected whenever a sibling churner holds the round: the point is the
    // traffic, not that every round is won.
    if (!(error instanceof ClaimHeldError)) throw error;
  }
  process.stdout.write(`done ${round}\n`);
}
