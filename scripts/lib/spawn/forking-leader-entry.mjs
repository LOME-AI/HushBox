/**
 * A leader that puts the process doing the work in the group it leads, and then
 * stays out of that work's way.
 *
 * This is the shape every command here actually starts. The runner's command
 * line does not become the script it was given: it forks a second process for
 * it and waits, and that fork joins the group the spawner recorded rather than
 * one of its own. A task runner does the same to the server it supervises. So
 * the process a spawn records is routinely not the process that holds the tree,
 * and killing or losing the recorded one leaves the group populated.
 *
 * Its fork is the supervisor fixture, which watches the run rather than this
 * process: watching this one would give the fork a second way to end, and a
 * case about what happens when this process is gone would then pass with the
 * mechanism it exists to prove removed.
 *
 * It names itself beside its fork, so a case can address the group's leader and
 * a member of that group separately.
 *
 * An ES module rather than TypeScript because it never runs inside the vitest
 * process, so its lines are nobody's coverage. It imports nothing of ours, so
 * it is started as `node <this file> <reportDir>`.
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SUPERVISOR = fileURLToPath(new URL('lifeline-supervisor-entry.mjs', import.meta.url));
/** The fork reaches the spawner's module through it, which is how it watches the run. */
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const [reportDir] = process.argv.slice(2);

// Not detached, which is the whole fixture: the fork stays in this process's
// group, so the group outlives this process exactly as a real one does.
const worker = spawn(process.execPath, ['--import', TSX_LOADER, SUPERVISOR, reportDir], {
  stdio: 'ignore',
  detached: false,
});

writeFileSync(path.join(reportDir, 'worker'), `${String(process.pid)} ${String(worker.pid)}`);

// Keeps this process running until something ends it, so a case chooses the
// moment the group loses its leader.
setInterval(() => process.stdout.write(''), 60_000);
