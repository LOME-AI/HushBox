/**
 * The process that starts a chain and then answers the socket every process in
 * it watches, doing nothing else. Only a real process can be killed, so only a
 * real one can show what its death does to the tree below it.
 *
 * What it starts is entirely on its own command line, because what is under
 * test is what survives the hops a real command uses: this starts whatever it
 * was given, exactly as the wrappers start the stages they are given. It names
 * the process it started in the report directory before waiting on it, so a
 * case can watch the top of the chain even after this process is gone.
 *
 * `--hold` keeps it running once that process has ended, for a case whose child
 * exits immediately and which has to see what that child left behind still
 * running while this process is still here.
 *
 * The chain inherits this process's output, which is how what it prints reaches
 * whoever started this one.
 *
 * An ES module rather than TypeScript because it never runs inside the vitest
 * process, so its lines are nobody's coverage.
 *
 * Spawned as `node --import tsx <this file> <reportDir> [--hold] <file>
 * [...args]`.
 */
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { spawnLongLived } from './long-lived.ts';

const [reportDir, ...rest] = process.argv.slice(2);
const hold = rest[0] === '--hold';
const [file, ...args] = hold ? rest.slice(1) : rest;

const child = await spawnLongLived(file, args, { stdio: 'inherit', ports: [] });
writeFileSync(path.join(reportDir, 'spawned'), String(child.pid));
await child.exit;

if (hold) setInterval(() => process.stdout.write(''), 60_000);
