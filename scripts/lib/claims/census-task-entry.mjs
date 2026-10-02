/**
 * A task of a run's tree, which optionally makes a process group of its own for
 * the work it starts — which is what a task supervisor does to everything it
 * runs, and what puts a process outside every group its run recorded.
 *
 * It names itself and whatever it started in a file, so a case can address the
 * escaped process directly and end it however the case turns out. What the
 * census finds it is told nothing of: the name file is the test's handle on the
 * process, never the census's.
 *
 * An ES module rather than TypeScript because it never runs inside the vitest
 * process, so its lines are nobody's coverage. It imports nothing of ours, so it
 * is started as `node <this file> <reportDir> <name> [escape]`.
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [reportDir, name, escape] = process.argv.slice(2);

const started =
  escape === 'escape'
    ? spawn(process.execPath, [fileURLToPath(import.meta.url), reportDir, `${name}-escaped`], {
        stdio: 'ignore',
        // The whole fixture: the child leads a group of its own, so the group
        // its run recorded reaches this process and stops here.
        detached: true,
      })
    : undefined;

writeFileSync(
  path.join(reportDir, name),
  `${String(process.pid)} ${started === undefined ? '' : String(started.pid)}`
);

// Holds until something ends it, so a case chooses the moment the tree goes.
setInterval(() => process.stdout.write(''), 60_000);
