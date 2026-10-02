/**
 * A long-lived leader: a process that was started through the spawner and that
 * starts a tree of its own, which is the shape every dev server, watcher and
 * emulator behind this repository's commands takes.
 *
 * Its child is a supervisor, and nothing in the tree binds a port. A listener
 * would let a port reclaimer be the reason the tree went away, and the point of
 * this fixture is what happens with no reclaimer involved at all.
 *
 * It names its own parent as well as itself, because a case has to be able to
 * show that a process stood between this one and the process that started the
 * chain. That is what makes a chain the real one rather than a fixture with the
 * hop taken out, and the hop is exactly what the mechanism this proves had to
 * survive.
 *
 * An ES module rather than TypeScript because it never runs inside the vitest
 * process, so its lines are nobody's coverage.
 *
 * Reached as `<runner command line> <this file> <reportDir>`, through whatever
 * hops the chain under test uses.
 */
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnLongLived } from './long-lived.ts';

const SUPERVISOR = fileURLToPath(new URL('lifeline-supervisor-entry.mjs', import.meta.url));
/** The supervisor reaches the spawner's module through it, which is how it watches the run. */
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const [reportDir] = process.argv.slice(2);

const child = await spawnLongLived(
  process.execPath,
  ['--import', TSX_LOADER, SUPERVISOR, reportDir],
  {
    stdio: 'ignore',
    ports: [],
  }
);

writeFileSync(
  path.join(reportDir, 'leader'),
  `${String(process.pid)} ${String(process.ppid)} ${String(child.pid)}`
);
await child.exit;
