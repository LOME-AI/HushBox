/**
 * A stand-in for a task supervisor: it starts one child in a process group of
 * its own — which is what `turbo` does to every task it runs — and ends that
 * child when it is asked to stop.
 *
 * Nothing outside its own shutdown reaches that child. A teardown that
 * signalled this process's group instead of asking this process to stop would
 * empty the group and leave the child running, which is the shape of the orphan
 * this whole mechanism exists for. It binds no port, so nothing that works from
 * ports can be what cleaned it up.
 *
 * **It watches the run, and never the leader that started it.** The address the
 * spawner leaves in {@link LIFELINE_ENV} names that leader, and watching it
 * would give this fixture a second way to end — so the cases that exist to
 * prove the ask-then-signal path is the only thing reaching a group-escaped
 * task would pass with that path removed. The run's address is carried down
 * under {@link RUN_LIFELINE_ENV} instead, untouched by every hop, and ending on
 * it costs those cases nothing: their run outlives them. What it buys is that a
 * leader killed too hard to ask anything no longer leaves this process and its
 * task standing on the machine for good, named by no claim and reachable by no
 * reclaimer.
 *
 * The task is signalled rather than let go of, unlike the children that run the
 * spawner's own module: it is a bare command line watching nothing, so this
 * process is the only thing that can reach it.
 *
 * Started with no run address it runs on rather than refusing. A chain whose
 * top published none belongs to no run, which is a different thing from a
 * spawner that lost one.
 *
 * An ES module rather than TypeScript because it never runs inside the vitest
 * process, so its lines are nobody's coverage. It imports the spawner's module,
 * so it is spawned as `node --import tsx <this file> <reportDir>`, and names
 * the child it started there so a case can watch that child directly.
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { LIFELINE_ENV, connectLifeline, watchSpawner } from './long-lived.ts';

/**
 * Where the run's own lifeline address travels, which has to be a name of its
 * own: the spawner overwrites {@link LIFELINE_ENV} at every hop, so what this
 * process inherits there is the leader directly above it.
 */
const RUN_LIFELINE_ENV = 'HB_SPAWN_RUN_LIFELINE';

/** What it exits with once the run that started it has gone: its task never finished. */
const RUN_GONE_EXIT_CODE = 1;

const [reportDir] = process.argv.slice(2);

const task = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
  stdio: 'ignore',
  detached: true,
});
task.unref();
writeFileSync(path.join(reportDir, 'task'), String(task.pid));

function endTask() {
  process.kill(task.pid, 'SIGKILL');
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    endTask();
    process.exit(0);
  });
}

// Keeps this process running until something ends it, which is what makes it a
// supervisor rather than a process that happened to spawn something.
const staying = setInterval(() => process.stdout.write(''), 60_000);

watchSpawner({ [LIFELINE_ENV]: process.env[RUN_LIFELINE_ENV] }, connectLifeline, () => {
  // This process's own exit is named rather than forced, unlike the signal
  // handlers: the connection this ran off is unrefed, and the interval was the
  // only other thing holding the loop open, so letting go of it is what ends
  // this process with the code it was let go of for.
  endTask();
  clearInterval(staying);
  process.exitCode = RUN_GONE_EXIT_CODE;
});
