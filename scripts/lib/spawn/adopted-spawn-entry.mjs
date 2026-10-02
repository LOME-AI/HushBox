/**
 * Starts a long-lived child from a process that adopted the run its parent
 * started, and reports what became of the socket that spawn opened — from
 * inside the process that opened it, before it has ended.
 *
 * The vantage point is the whole of the fixture. This process closes the same
 * socket on its way out, so a reading taken once it has exited cannot tell the
 * close ordered against the run's record from the one the runtime runs last.
 *
 * An ES module rather than TypeScript because it never runs inside the vitest
 * process, so its lines are not the spawner's coverage.
 *
 * Spawned as `node --import tsx <this file> <registryDir> <command> <mode>
 * <slot> <gitCommonDir>`, with the run claim it adopts in its environment and a
 * temporary directory of the case's own, which is the world it scans. It prints
 * how many sockets of this mechanism are still there once the adopted run has
 * ended.
 */
import { registerRun } from '../claims/registry.ts';
import { lifelineSocketDir, scanLifelineSockets, spawnLongLived } from './long-lived.ts';

const [registryDir, command, mode, slot, gitCommonDir] = process.argv.slice(2);

await registerRun({ command, mode, slot: Number(slot), gitCommonDir, registryDir }, async () => {
  const child = await spawnLongLived(process.execPath, ['-e', ''], { stdio: 'ignore', ports: [] });
  await child.exit;
});

const left = await scanLifelineSockets(lifelineSocketDir());
process.stdout.write(`${left.length}\n`);
