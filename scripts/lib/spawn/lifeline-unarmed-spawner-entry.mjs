/**
 * Starts one command with the raw process library, in a group of its own, and
 * publishes no lifeline address for it to watch.
 *
 * It is the negative control for the whole mechanism: the same chain, under a
 * starter that arms nothing, must survive that starter's hard kill. Without it
 * a case watching an armed tree go away cannot say whether the lifeline was
 * what took it, or whether the tree would have gone anyway.
 *
 * **Publishing none is what makes it a control; stripping the inherited one
 * made it a leak.** This process hosts no socket, so what it starts watches
 * whatever started *this* — the run — and never this process, which is exactly
 * the property the control rests on. Deleting the address instead left the
 * chain watching nothing at all: named by no claim, reachable by no reclaimer,
 * and standing on the machine for good once the run was killed. So the address
 * is passed down untouched, and this process watches it too, which is what
 * makes the control itself end with the run that started it.
 *
 * Started with nothing to watch it runs on rather than refusing, unlike the
 * children the spawner starts: this one is reached directly by whatever ran the
 * chain, and an invocation that published no address is a chain with no run to
 * belong to rather than a spawner that lost one.
 *
 * An ES module rather than TypeScript because it never runs inside the vitest
 * process, so its lines are nobody's coverage. It imports the spawner's module,
 * so it is started as `node --import tsx <this file> <reportDir> <file>
 * [...args]`.
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { connectLifeline, watchSpawner } from './long-lived.ts';

/** What it exits with once the run that started it has gone. */
const RUN_GONE_EXIT_CODE = 1;

const [reportDir, file, ...args] = process.argv.slice(2);

/** Held rather than passed, so the watch below is armed before there is anything to hold. */
let child;

watchSpawner(process.env, connectLifeline, () => {
  // Let go of rather than signalled: the chain watches the same address this
  // does and ends on its own, and reaching down to end it as well would be a
  // second mechanism for one job. Letting go of the child is what empties this
  // process's loop, since the connection this ran off is unrefed.
  child?.unref();
  process.exitCode = RUN_GONE_EXIT_CODE;
});

child = spawn(file, args, { stdio: 'inherit', detached: true });
writeFileSync(path.join(reportDir, 'spawned'), String(child.pid));
child.on('exit', (code) => {
  // Set rather than forced: nothing else is pending once the child has gone, so
  // this process ends of its own accord with the code its child answered.
  process.exitCode = code ?? 1;
});
