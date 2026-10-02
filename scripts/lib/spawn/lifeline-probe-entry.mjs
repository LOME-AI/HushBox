/**
 * Reports what a spawned child was actually handed: the address its environment
 * names, and whether anything answers there. Only the child can answer either
 * question, because both are properties of the process the spawner created
 * rather than of the call that created it.
 *
 * It reports through a file rather than through its output because the spawner
 * under test decides where the child's output goes, and a case that had to read
 * it would be constrained by that choice rather than by what it wants to prove.
 *
 * An ES module rather than TypeScript because it never runs inside the vitest
 * process, so its lines are nobody's coverage.
 *
 * Spawned as `node <this file> <reportPath>`. It writes the address on the
 * first line and what a connect to it answered on the second.
 */
import { createConnection } from 'node:net';
import { writeFileSync } from 'node:fs';

const [report] = process.argv.slice(2);
const address = process.env['HB_SPAWN_LIFELINE'] ?? '';

function say(answer) {
  writeFileSync(report, `${address}\n${answer}`);
}

if (address.length === 0) {
  say('none');
} else {
  const socket = createConnection(address);
  const answer = (seen) => {
    say(seen);
    // Nothing else is pending, so letting go of this is what ends the process.
    socket.destroy();
  };
  socket.on('connect', () => answer('answered'));
  socket.on('error', (error) => answer(error.code ?? 'failed'));
}
