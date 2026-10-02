/**
 * A parent that will never reap what it started: it starts one child in a group
 * of its own, names it, and then blocks its own thread for good.
 *
 * This is the shape every process here takes on its way out. An exit handler
 * runs with the loop already closed, so a child that dies while the handler is
 * running is never reaped — a dead child whose parent has not collected it
 * stays in its process group as a corpse, and a group read that counts members
 * therefore answers that the tree is still standing long after nothing in it
 * runs. Blocking the thread is what reproduces that state and holds it still
 * long enough for a case to read it.
 *
 * The child holds itself for a span given on the command line and then goes,
 * rather than watching the run the way a spawner's children do: nothing reaches
 * this fixture's child through this fixture, which never runs another line, so
 * a bound is the only thing that can keep it from outliving a case that never
 * reaches its teardown.
 *
 * An ES module rather than TypeScript because it never runs inside the vitest
 * process, so its lines are nobody's coverage. It imports nothing of ours, so
 * it is started as `node <this file> <reportDir> <holdMs>`.
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [reportDir, holdMs] = process.argv.slice(2);

// Detached, so the child leads a group of its own: the corpse a case reads is
// then the only thing that group ever held, which is what a spawner's own
// child is to the process that spawned it.
const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${holdMs})`], {
  stdio: 'ignore',
  detached: true,
});

writeFileSync(path.join(reportDir, 'unreaped'), String(child.pid));

// Blocks the thread, which is the whole fixture: a child's death is delivered
// to the loop, and a loop that never runs again collects nothing. The span is
// the case's own, so this process goes on its own if the case that started it
// never gets to end it.
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMs));
