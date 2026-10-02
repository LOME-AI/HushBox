/**
 * Registers a release from a process that adopted the run its parent started,
 * and reports what became of it while this process is still running — which is
 * the only moment the ordering can be read, because a release the runtime never
 * reaches and one an exit handler runs look the same from outside.
 *
 * An ES module rather than TypeScript because it never runs inside the vitest
 * process, so its lines are not the registry's coverage.
 *
 * Spawned as `node --import tsx <this file> <registryDir> <command> <mode>
 * <slot> <gitCommonDir>`, with the run claim it adopts in its environment. It
 * prints how many of the releases it registered ran, and whether the record
 * naming what they released was still on disk when they did.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { RUN_CLAIM_ENV, registerRun, releaseBeforeRecordDrops } from './registry.ts';

const [registryDir, command, mode, slot, gitCommonDir] = process.argv.slice(2);
const runDir = process.env[RUN_CLAIM_ENV];

let released = 0;
let record = 'nothing released';

await registerRun({ command, mode, slot: Number(slot), gitCommonDir, registryDir }, () => {
  releaseBeforeRecordDrops(() => {
    released += 1;
    record = existsSync(path.join(runDir, 'run.json')) ? 'record still there' : 'record gone';
  });
  return Promise.resolve();
});

process.stdout.write(`${released} ${record}\n`);
