/**
 * A whole pnpm invocation in another process: it registers a run, records what
 * that run owns, starts a long-lived child through the spawner, and then waits
 * on that child exactly as `with-env` waits on the command it wraps.
 *
 * Only a real process can be killed, so only a real one can show what a killed
 * run leaves behind. An ES module rather than TypeScript because it never runs
 * inside the vitest process, so its lines are nobody's coverage.
 *
 * Spawned as `node --import tsx <this file> <registryDir> <command> <mode>
 * <slot> <gitCommonDir> <childPort> <grandchildPort> [escape]`. It prints the
 * run id and the group id of the tree it started, then waits for that tree to
 * end. `escape` puts the grandchild in its own process group, as a task
 * supervisor does.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUN_CLAIM_ENV, addResource, registerRun } from '../claims/registry.ts';
import { spawnLongLived } from './long-lived.ts';

const PORT_HOLDER = fileURLToPath(new URL('port-holder-entry.mjs', import.meta.url));

const [registryDir, command, mode, slot, gitCommonDir, childPort, grandchildPort, escape] =
  process.argv.slice(2);

await registerRun({ command, mode, slot: Number(slot), gitCommonDir, registryDir }, async () => {
  await addResource({ kind: 'database', id: `hb_t_${slot}` });
  await addResource({ kind: 'bucket', id: `hushbox-scratch-${slot}` });
  await addResource({ kind: 'container', id: `hushbox-${slot}-postgres` });

  const child = await spawnLongLived(
    process.execPath,
    [PORT_HOLDER, childPort, grandchildPort, escape ?? ''],
    // Claimed by the spawner, as `with-env` claims the band of its slot and mode.
    { stdio: 'ignore', ports: [Number(childPort), Number(grandchildPort)] }
  );
  process.stdout.write(`${path.basename(process.env[RUN_CLAIM_ENV])} ${String(child.pgid)}\n`);
  await child.exit;
});
