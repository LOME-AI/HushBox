/**
 * Runs `ensureStack` in a separate process, so a test can prove that two of
 * them serialise rather than interleave — which only real, concurrently
 * scheduled processes can show. An ES module rather than TypeScript because it
 * is a fixture that never runs inside the vitest process, so its lines are not
 * the orchestrator's coverage.
 *
 * Spawned as `node --import tsx <this file> <repoRoot> <slot> <registryDir>
 * <logFile> <holdMs> <plain|nested>`. Its install step brackets itself in the
 * shared log, so an interleaving is visible as two `enter` lines in a row.
 * `nested` additionally spawns one more of these from inside the section, which
 * is the re-entrancy a wrapper script depends on.
 */
// @ts-check
import { appendFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureStack } from './ensure-stack.ts';

/**
 * One argument of the command line above, refused where it is absent: a
 * fixture handed fewer arguments than it reads would otherwise spawn a stack
 * bring-up against `undefined` and fail somewhere further in.
 *
 * @param {number} position — counted from the first argument after the module.
 * @param {string} name
 * @returns {string}
 */
function argument(position, name) {
  const value = process.argv[position + 2];
  if (value === undefined) {
    throw new Error(`ensure-stack-entry: <${name}> is missing from the command line.`);
  }
  return value;
}

const repoRoot = argument(0, 'repoRoot');
const slot = argument(1, 'slot');
const registryDir = argument(2, 'registryDir');
const logFile = argument(3, 'logFile');
const holdMs = argument(4, 'holdMs');
const shape = argument(5, 'shape');

const selfPath = fileURLToPath(import.meta.url);

/** @returns {Promise<void>} */
function runNested() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [...process.execArgv, selfPath, repoRoot, slot, registryDir, logFile, '0', 'plain'],
      { env: process.env, stdio: ['ignore', 'ignore', 'inherit'] }
    );
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`nested ensure-stack exited ${String(code)}`));
    });
  });
}

const noop = async () => undefined;

await ensureStack(
  {
    repoRoot,
    slot: Number(slot),
    daemonScriptPath: 'unused',
    idleDaemonPort: 1,
    registryDir,
  },
  {
    generateEnvFiles: () => undefined,
    generateComposeFiles: () => [],
    installDeps: async () => {
      await appendFile(logFile, 'enter\n');
      await new Promise((resolve) => setTimeout(resolve, Number(holdMs)));
      await appendFile(logFile, 'exit\n');
    },
    cleanupOrphans: noop,
    ensureContainersHealthy: noop,
    ensurePostgresAcceptsPassword: noop,
    ensureDatabase: noop,
    runMigrations: shape === 'nested' ? runNested : noop,
    installDevTracking: noop,
    provisionAdminSqlPanelRole: noop,
    readMeta: async () => ({ seedHash: '', seededAt: null, dirty: true }),
    markClean: noop,
    composeDown: noop,
    ensureDaemonRunning: noop,
    readDepsHash: async () => null,
    writeDepsHash: noop,
    computeDepsFingerprint: async () => 'fingerprint',
    computeMigrationFingerprint: async () => 'fingerprint',
    ensureTestTemplate: noop,
    assertNoSchemaDrift: noop,
    reportProgress: () => undefined,
    auditStackWorld: noop,
    sqlExecutor: { exec: noop, query: async () => [] },
  }
);
