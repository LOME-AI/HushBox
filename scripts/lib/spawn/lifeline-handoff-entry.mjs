/**
 * Starts one process of its own, releases it, and exits at once.
 *
 * It is what a shell does with a backgrounded command, and it is the case an
 * inherited descriptor could never answer: the process that was handed the
 * lifeline is gone, so a descriptor would have gone with it, while an address
 * travels down the environment and outlives every process that passed it on.
 * What it leaves behind therefore stands two hops below the process that
 * started this one, which never saw it start.
 *
 * The process it leaves is started in a group of its own and released, so
 * nothing about it keeps this one running and no group signal aimed at this
 * chain reaches it.
 *
 * An ES module rather than TypeScript because it never runs inside the vitest
 * process, so its lines are nobody's coverage.
 *
 * Spawned as `node <this file> <reportDir> <file> [...args]`, and names what it
 * left behind in that directory.
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [reportDir, file, ...args] = process.argv.slice(2);

const left = spawn(file, args, { stdio: 'ignore', detached: true });
left.unref();
writeFileSync(path.join(reportDir, 'handoff'), String(left.pid));
