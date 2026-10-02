/**
 * CLI entry point for `pnpm ensure-stack`. Composes the pure orchestrator in
 * ensure-stack.ts with real implementations of every dependency: docker, drizzle,
 * pnpm, filesystem, network. The order a bring-up runs its steps in lives in
 * that orchestrator; what this file decides before reaching it — the stack a
 * line selects, the claim the invocation registers under, the socket files it
 * reclaims on the way in — is exported and driven by its own tests.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { execa } from 'execa';
import { sql } from 'drizzle-orm';
import { createDb, LOCAL_NEON_DEV_CONFIG } from '@hushbox/db';
import { assertNoSchemaDrift } from '@hushbox/db/schema-drift';
import { Mode, type EnvMode } from '@hushbox/shared';
import { fileFingerprint, migrationsFingerprint } from './lib/cli/fingerprint.js';
import {
  installDevOnlyTracking,
  readMeta,
  markClean,
  type SqlExecutor,
} from './lib/stack/stack-meta.js';
import { ensureDaemonRunning } from './lib/stack/idle-killer.js';
import { generateEnvFiles, stackModeFor } from './generate-env.js';
import { envModeForStack, stackModeFrom } from './lib/stack/stack-mode.js';
import { hostPortsForRun, loadEnvironment, withRunClaim } from './with-env.js';
import { stackSlotFrom } from './lib/stack/stack-slot.js';
import { cleanupOrphanedProjects } from './docker-cleanup.js';
import { CHECKOUT_DIRECTORY, composeArguments } from './compose.js';
import { auditStackWorld, reclaimPorts } from './dev-clean.js';
import {
  groupSignalWasRefused,
  lifelineSocketDir,
  reclaimLifelineSockets,
  reclaimProcessGroups,
  scanLifelineSockets,
  socketRemovalWasRefused,
} from './lib/spawn/long-lived.js';
import { currentRunId } from './lib/claims/ownership.js';
import { readSlotLiveness } from './lib/claims/registry.js';
import { isMainModule } from './lib/cli/is-main.js';
import { formatUsage, parseCommandLine, type CommandSpec } from './lib/cli/command-line.js';
import { runMain } from './lib/cli/run-main.js';
import {
  ensureStack,
  type EnsureStackDeps,
  type EnsureStackOptions,
} from './lib/stack/ensure-stack.js';
import {
  parseComposeHashes,
  parseComposePs,
  servicesMatchConfig,
} from './lib/stack/compose-state.js';
import { ensureStackBucketsReady } from './lib/stack/minio-bucket-ready.js';
import { ensurePostgresAcceptsPassword } from './lib/stack/postgres-auth-method.js';
import { createDockerPostgresAuthDeps } from './lib/stack/postgres-auth-method-docker.js';
import { postgresRoleFrom } from './lib/stack/compose-env.js';
import { writeSrhTokens } from './lib/stack/srh-tokens.js';
import {
  assertSchemaMatchesMigrations,
  buildTemplateDatabase,
  ensureDatabaseExists,
  ensureTemplateDatabase,
  runBuildCommand,
  templateVerifier,
  withMaintenanceExecutor,
} from './lib/test-run/test-db-provision.js';
import { mediaBucketFrom, stackBucketsFrom } from './lib/stack/stack-bucket.js';
import {
  liveDataPlaneLegs,
  resetDataPlane,
  type DataPlaneTargets,
} from './lib/stack/data-plane-reset.js';
import { objectStoreEndpointFrom } from './lib/test-run/scratch-bucket-reclaim.js';
import { wranglerPersistPath } from './wrangler-dev.js';
import { databaseNameOf } from './lib/stack/stack-database.js';
import { e2eRamPaths, prepareRamRoot, ramRootRequiredBytes } from './lib/stack/ram-root.js';
import { resolveLocalWorkerCount } from './lib/playwright/worker-count.js';
import type {
  LifelineSocketReclaimOptions,
  LifelineSocketReport,
  ProcessGroupReclaimOptions,
  ProcessGroupReclaimReport,
} from './lib/spawn/long-lived.js';
import type { E2eRamPaths, RamRootDeps } from './lib/stack/ram-root.js';
import type { StackMode } from './lib/stack/port-plan.js';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..');
const DAEMON_SCRIPT = path.join(SCRIPTS_DIR, 'lib', 'stack', 'idle-killer-daemon-entry.ts');

/**
 * Tables whose writes flip the `__stack_meta` dirty flag. Intentionally empty:
 * seeding uses an idempotent-mint-always model — `pnpm db:seed` re-mints every
 * persona and fixture on every run (see scripts/seed.ts), so there is no dirty
 * seed state to detect and no conditional re-seed to trigger. The stack-meta
 * dirty-tracking machinery stays parameterized but tracks nothing.
 */
const TRACKED_TABLES: readonly string[] = [];

const DOCKER_SERVICES = ['postgres', 'neon-proxy', 'redis', 'serverless-redis-http', 'minio'];

/**
 * Registers this invocation as a run before it touches the stack, or adopts the
 * one it was launched inside.
 *
 * `pnpm ensure-stack` and `pnpm db:reset` are the two root scripts that never
 * pass through `with-env.ts`, which is where every other invocation registers.
 * Without this they prepare and wipe a stack no reclaimer, idle daemon or
 * concurrent wipe can see a run against — and a wipe queueing on the critical
 * section behind another command's bring-up would land on the volumes that
 * command had just prepared, because the command holds nothing to refuse it.
 *
 * `registryDir` defaults to the machine-wide registry; a test points it
 * elsewhere.
 */
export async function withEnsureStackClaim<T>(
  mode: StackMode,
  body: () => Promise<T>,
  registryDir?: string
): Promise<T> {
  return withRunClaim({ command: 'ensure-stack', mode, rootDir: REPO_ROOT, registryDir }, body);
}

/**
 * Reclaims the lifeline socket files left in the temporary directory by runs
 * that have gone.
 *
 * Every decision about a file is {@link reclaimLifelineSockets}'s, and none of
 * it is taken again here — what this adds is the trigger, and the one thing
 * that trigger has to say for itself. One of these files is collected by a run
 * that comes after the one that left it, and a reclaim reachable only from a
 * command typed by hand collects nothing on a machine where nobody types it.
 * Every run that prepares this stack comes through this bring-up.
 *
 * Housekeeping never fails the command it is housekeeping for over a mess that
 * was never that command's to clear. The temporary directory is shared with
 * every other user of the machine, and a file this user is refused permission
 * to remove is a dead run of theirs: it is named and stepped over, the files
 * behind it in the same pass are reclaimed as they would have been, and the
 * bring-up carries on. A removal that fails for any other reason is this run's
 * own failure and still raises.
 *
 * `registryDir` defaults to the machine-wide registry; a test points it
 * elsewhere.
 */
export async function reclaimStrandedLifelineSockets(
  options: Pick<LifelineSocketReclaimOptions, 'log' | 'registryDir'>
): Promise<LifelineSocketReport> {
  return reclaimLifelineSockets({
    scan: () => scanLifelineSockets(lifelineSocketDir()),
    removalRefused: socketRemovalWasRefused,
    ...options,
  });
}

/**
 * Ends the process trees left running by runs that have gone.
 *
 * The socket reclaim's counterpart, on the same terms and for the same reason:
 * every decision about a tree is {@link reclaimProcessGroups}'s, what this adds
 * is the trigger, and a reclaim reachable only from a command typed by hand
 * ends nothing on a machine where nobody types it. Every run that prepares this
 * stack comes through this bring-up, which is what makes the next run the
 * recovery for a run that was killed.
 *
 * Housekeeping never fails the command it is housekeeping for over a mess that
 * was never that command's to clear, so a tree the operating system refuses
 * this user is named, left running, and the pass goes on to the trees behind
 * it. A signal that fails for any other reason is this run's own failure and
 * still raises.
 *
 * `registryDir` defaults to the machine-wide registry; a test points it
 * elsewhere.
 */
export async function reclaimOrphanedProcessGroups(
  options: Pick<ProcessGroupReclaimOptions, 'log' | 'registryDir' | 'killer'>
): Promise<ProcessGroupReclaimReport> {
  return reclaimProcessGroups({ signalRefused: groupSignalWasRefused, ...options });
}

/** What the registry can say about one slot: the records it read, and the ones it could not. */
type SlotLiveness = Awaited<ReturnType<typeof readSlotLiveness>>;

/**
 * Refuses when another run already holds this slot's e2e band.
 *
 * What stood here instead was a blind reclaim of every host-bound port of the
 * checkout, run on every e2e invocation: it freed a stale run's webServers and
 * took a live `pnpm dev` and the idle daemon's own sentinel with them. The
 * bands are disjoint now, so a development run is no obstacle at all and the
 * only thing that can be in the way is a second e2e run — which is named
 * rather than signalled, because a run holding its claim is one that is still
 * being used.
 *
 * It takes the whole reading rather than the claims that were read, because a
 * run whose record could not be read stated no mode: nothing puts it on
 * another band, its lock says it is alive, and proceeding over it is a second
 * e2e run binding ports the first is already listening on. That state needs no
 * corruption — a record a wider checkout wrote is invalid to a narrower reader.
 *
 * The caller's own claim is not an obstacle to itself: this runs inside the
 * claim `ensure-stack` registered for the very invocation asking.
 */
export function assertE2eBandFree(
  slot: number,
  liveness: SlotLiveness,
  ownRunId: string | null
): void {
  const others = liveness.claimed.filter(
    (found) => found.mode === 'e2e' && found.runId !== ownRunId
  );
  const unread = liveness.unknown.filter((found) => found.runId !== ownRunId);
  if (others.length === 0 && unread.length === 0) return;

  const named = [
    ...others.map((found) => `\`${found.command}\` (pid ${String(found.pid)})`),
    ...unread.map((found) => `the run in ${found.runId}, whose record could not be read`),
  ].join(', ');
  const count = others.length + unread.length;
  throw new Error(
    `ensure-stack: refusing to prepare the e2e stack on slot ${String(slot)} while ${named} ` +
      `${count === 1 ? 'is' : 'are'} still running against its band — two e2e runs ` +
      'bind the same ports. Re-run once it has finished.' +
      (unread.length === 0
        ? ''
        : ' A run whose record cannot be read is on no band this can rule out, so ' +
          'remove its directory by hand once you have established that no run is using it.')
  );
}

/* v8 ignore start -- real-IO wiring; logic lives in tested pure helpers */

/**
 * Whether a bring-up can be skipped: every required service up AND created from
 * the configuration the compose file describes today. Health alone was the old
 * test and it let every compose edit go silently unapplied to a warm stack.
 */
async function containersMatchConfig(
  repoRoot: string,
  services: readonly string[]
): Promise<boolean> {
  const run = (args: readonly string[]): Promise<{ exitCode?: number; stdout: string }> =>
    execa('docker', composeArguments(CHECKOUT_DIRECTORY, args), {
      cwd: repoRoot,
      env: process.env,
      reject: false,
    });

  const [ps, config] = await Promise.all([
    run(['ps', '--format', 'json']),
    run(['config', '--hash', '*']),
  ]);
  if (ps.exitCode !== 0 || config.exitCode !== 0) return false;

  return servicesMatchConfig(
    services,
    parseComposePs(ps.stdout),
    parseComposeHashes(config.stdout)
  );
}

export const COMMAND_LINE = {
  command: 'pnpm ensure-stack',
  summary: 'Brings this checkout\u2019s local stack to the state a run needs, and leaves it there.',
  flags: [
    {
      flag: '--env-mode',
      kind: 'value',
      placeholder: '<mode>',
      summary:
        'Which stack to generate and bring up. Defaults to the one the environment names, and to the development stack where it names none.',
    },
    {
      flag: '--quiet',
      kind: 'boolean',
      summary: 'Leave the closing readiness line unprinted.',
    },
    {
      flag: '--wipe',
      kind: 'boolean',
      summary: 'Recreate the data plane from empty before bringing it up.',
    },
  ],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

/**
 * A line asking for usage answers `help`, and every other field then carries
 * the value it would have taken from an empty line — nothing reads them, and a
 * total return keeps every caller that only wants the selected stack simple.
 *
 * `envMode` is the stack the line names and nothing else: a line naming none
 * answers `undefined` rather than the default, because the environment gets to
 * answer before the default does ({@link selectedEnvMode}).
 */
export function parseCliArgs(argv: readonly string[]): {
  help: boolean;
  wipe: boolean;
  quiet: boolean;
  envMode: EnvMode | undefined;
} {
  const parsed = parseCommandLine(COMMAND_LINE, argv);
  if (parsed.kind === 'help') {
    return { help: true, wipe: false, quiet: false, envMode: undefined };
  }
  const envModeArgument = parsed.flags['--env-mode'];
  return {
    help: false,
    wipe: parsed.flags['--wipe'],
    quiet: parsed.flags['--quiet'],
    envMode: envModeArgument as EnvMode | undefined,
  };
}

/**
 * The stack this invocation prepares: the one its own line names, and
 * otherwise the one the environment it was handed already names.
 *
 * Falling back to the development stack instead left an environment naming a
 * stack unable to point the bring-up at it, so a chain whose later stages ran
 * against one stack had its bring-up prepare another — and `--wipe`, which
 * reaches the same parse, empty one nobody asked about. The environment is read
 * through the repository's one reader of it, and the mode that writes a stack's
 * files is that stack's answer rather than a second table of them.
 */
export function selectedEnvMode(named: EnvMode | undefined, env: NodeJS.ProcessEnv): EnvMode {
  return named ?? envModeForStack(stackModeFrom(env));
}

/**
 * Makes this checkout's E2E RAM root ready for a run of the Playwright workers
 * this machine runs, or refuses one that is too small or not in RAM. Nothing
 * off Linux: there the E2E state stays where it always was.
 */
export async function prepareE2eRamRoot(deps?: RamRootDeps): Promise<E2eRamPaths | undefined> {
  return prepareRamRoot(REPO_ROOT, ramRootRequiredBytes(resolveLocalWorkerCount()), deps);
}

/** Hosts a dev-credential provisioning statement may ever run against. */
const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);

/**
 * Refuses to run the well-known-password `ALTER ROLE admin_sql_panel LOGIN`
 * against anything but a loopback database: with a production DATABASE_URL
 * in the environment, provisioning must fail instead of installing a
 * guessable login on the real database.
 */
export function assertLocalSqlProvisionTarget(databaseUrl: string): void {
  const host = new URL(databaseUrl).hostname;
  if (!LOCAL_DB_HOSTS.has(host)) {
    throw new Error(
      `ensure-stack: refusing to provision the admin_sql_panel LOGIN against non-local ` +
        `database host "${host}" — this dev-credential statement only runs on a local stack.`
    );
  }
}

/**
 * The stores a stack's data-plane reset empties, read off the environment its
 * bring-up loaded — the same variables every downstream process reaches them
 * through — the persist root the Worker launcher gives that stack, and the E2E
 * stack's browser temporary directory where its RAM root gives it one.
 */
export function dataPlaneTargetsFor(
  stackMode: StackMode,
  env: NodeJS.ProcessEnv
): DataPlaneTargets {
  const ramPaths = stackMode === 'e2e' ? e2eRamPaths() : undefined;
  return {
    databaseName: databaseNameOf(requiredVariable(env, 'DATABASE_URL')),
    redisToken: requiredVariable(env, 'UPSTASH_REDIS_REST_TOKEN'),
    bucket: mediaBucketFrom(env),
    persistRoot: wranglerPersistPath(stackMode),
    ...(ramPaths === undefined ? {} : { browserTmp: ramPaths.browserTmp }),
  };
}

function requiredVariable(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new Error(`ensure-stack: ${name} is required (run pnpm generate:env)`);
  }
  return value;
}

function buildDeps(envMode: EnvMode): EnsureStackDeps {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) throw new Error('DATABASE_URL is required (run pnpm generate:env)');
  const db = createDb(databaseUrl, { neonDev: LOCAL_NEON_DEV_CONFIG });

  const executor: SqlExecutor = {
    async exec(query) {
      await db.execute(sql.raw(query));
    },
    async query<T>(query: string): Promise<T[]> {
      const result = await db.execute(sql.raw(query));
      return result.rows as T[];
    },
  };

  return {
    generateEnvFiles: (repoRoot: string) => {
      generateEnvFiles(repoRoot, envMode);
    },
    generateComposeFiles: writeSrhTokens,
    installDeps: async (repoRoot) => {
      // No --frozen-lockfile: a developer editing pnpm-lock.yaml locally
      // should not have ensureStack reject the install. CI's setup-action
      // does run --frozen-lockfile separately for reproducibility.
      await execa('pnpm', ['install'], { cwd: repoRoot, stdio: 'inherit' });
    },
    cleanupOrphans: async () => {
      await cleanupOrphanedProjects({ dryRun: false });
    },
    ensureContainersHealthy: async (repoRoot, recreate) => {
      // Fast-path probe: one `compose ps` and one `compose config --hash`. When
      // every required service is up and carrying today's configuration hash,
      // skip the ~3-4s `compose up --wait` startup.
      if (!(await containersMatchConfig(repoRoot, DOCKER_SERVICES))) {
        await execa(
          'docker',
          composeArguments(CHECKOUT_DIRECTORY, ['up', '-d', '--wait', ...DOCKER_SERVICES]),
          { cwd: repoRoot, stdio: 'inherit', env: process.env }
        );
      }
      // After the bring-up rather than before it, and `--no-deps` so it takes
      // only the named service: whatever the service reads its mounted file
      // alongside is already up by here, and recreating a dependency is work
      // nothing asked for.
      if (recreate.length > 0) {
        await execa(
          'docker',
          composeArguments(CHECKOUT_DIRECTORY, [
            'up',
            '-d',
            '--wait',
            '--no-deps',
            '--force-recreate',
            ...recreate,
          ]),
          { cwd: repoRoot, stdio: 'inherit', env: process.env }
        );
      }
      // Storage readiness gates EVERY path, fast path included: healthy
      // containers do not imply the buckets exist (cold volume, crash
      // between MinIO start and setup, volume wiped under warm containers, a
      // bucket added to the compose file after the volume was made).
      // Probe is ~100ms each; the awaited `compose run` fires only when one is
      // missing (`mc mb -p` is idempotent) and propagates mc's
      // exit code — unlike the old fire-and-forget `up -d minio-setup`,
      // which let the API serve `storage.put` before the bucket existed.
      // Named from the environment this run loaded rather than from the mode it
      // was asked for, exactly as the database below is: what has to exist are
      // the buckets everything downstream writes to.
      await ensureStackBucketsReady({
        buckets: stackBucketsFrom(process.env),
        probeBucket: async (bucket) => {
          // Anonymous HEAD-bucket can't distinguish existence (MinIO answers
          // 403 either way) and signed S3 calls would need a new script dep,
          // so probe the storage truth directly: MinIO's single-drive layout
          // keeps each bucket as a top-level directory under /data.
          const probe = await execa(
            'docker',
            composeArguments(CHECKOUT_DIRECTORY, [
              'exec',
              '-T',
              'minio',
              'sh',
              '-c',
              `test -d /data/${bucket}`,
            ]),
            { cwd: repoRoot, env: process.env, reject: false }
          );
          return probe.exitCode === 0;
        },
        runBucketSetup: async () => {
          await execa(
            'docker',
            composeArguments(CHECKOUT_DIRECTORY, ['run', '--rm', 'minio-setup']),
            {
              cwd: repoRoot,
              stdio: 'inherit',
              env: process.env,
            }
          );
        },
      });
    },
    // Through the container's own socket rather than the maintenance connection
    // below, because a cluster asking for the wrong method is precisely what
    // refuses that connection.
    ensurePostgresAcceptsPassword: async () => {
      await ensurePostgresAcceptsPassword(
        createDockerPostgresAuthDeps(
          async (args) => {
            const result = await execa('docker', [...args], {
              cwd: REPO_ROOT,
              env: process.env,
              reject: false,
            });
            return { exitCode: result.exitCode ?? 1, stdout: result.stdout, stderr: result.stderr };
          },
          {
            role: postgresRoleFrom(process.env),
            report: (message) => {
              console.log(message);
            },
          }
        )
      );
    },
    // Resolved when called rather than here: only the end-to-end bring-up
    // calls it, and the other stacks' environments need not carry what it reads.
    resetDataPlane: () =>
      resetDataPlane(
        dataPlaneTargetsFor(stackModeFor(envMode), process.env),
        liveDataPlaneLegs({
          databaseUrl,
          redisUrl: requiredVariable(process.env, 'UPSTASH_REDIS_REST_URL'),
          objectStore: objectStoreEndpointFrom(process.env),
        })
      ),
    // Through a maintenance connection, and named from the URL this run will
    // actually use rather than from the mode it was asked for: what has to
    // exist is the database everything downstream connects to.
    ensureDatabase: async () => {
      await withMaintenanceExecutor(databaseUrl, (maintenance) =>
        ensureDatabaseExists(maintenance, databaseNameOf(databaseUrl))
      );
    },
    runMigrations: async (repoRoot) => {
      await execa('pnpm', ['--filter', '@hushbox/db', 'db:migrate'], {
        cwd: repoRoot,
        stdio: 'inherit',
        env: process.env,
      });
    },
    installDevTracking: (executorArgument) =>
      installDevOnlyTracking(executorArgument, TRACKED_TABLES),
    // Local-only LOGIN for the SELECT-only SQL-panel role (matches the env
    // registry's Development ADMIN_SQL_PANEL_DATABASE_URL credentials). The
    // target guard makes "cannot run against production" a code property.
    provisionAdminSqlPanelRole: (executorArgument) => {
      assertLocalSqlProvisionTarget(databaseUrl);
      return executorArgument.exec("ALTER ROLE admin_sql_panel LOGIN PASSWORD 'admin_sql_panel'");
    },
    readMeta,
    markClean,
    composeDown: async (repoRoot, options) => {
      const args = composeArguments(CHECKOUT_DIRECTORY, [
        'down',
        ...(options.volumes ? ['-v'] : []),
      ]);
      await execa('docker', args, {
        cwd: repoRoot,
        stdio: 'inherit',
        env: process.env,
      });
    },
    ensureDaemonRunning,
    readDepsHash: async (cacheDir) => {
      try {
        const contents = await readFile(path.join(cacheDir, 'deps.hash'), 'utf8');
        return contents.trim();
      } catch {
        return null;
      }
    },
    writeDepsHash: async (cacheDir, hash) => {
      await writeFile(path.join(cacheDir, 'deps.hash'), `${hash}\n`);
    },
    computeDepsFingerprint: (repoRoot) => fileFingerprint(path.join(repoRoot, 'pnpm-lock.yaml')),
    computeMigrationFingerprint: migrationsFingerprint,
    // Same fingerprint, same staleness check and same builder the vitest global
    // setup runs — reached here first, so the fan-out finds the template
    // present and every process clones it instead of creating it.
    ensureTestTemplate: async (migrationFingerprint) => {
      await withMaintenanceExecutor(databaseUrl, (maintenance) =>
        ensureTemplateDatabase(
          maintenance,
          migrationFingerprint,
          (databaseName) => buildTemplateDatabase(REPO_ROOT, databaseName, runBuildCommand),
          {
            verifyTemplate: templateVerifier(
              maintenance,
              databaseUrl,
              assertSchemaMatchesMigrations
            ),
          }
        )
      );
    },
    assertNoSchemaDrift: () => assertNoSchemaDrift(db),
    reportProgress: (message) => {
      console.log(message);
    },
    // The audit's verdict never fails the command it is housekeeping for, so it
    // is printed and dropped here; `pnpm dev:clean --dry-run` is where it
    // decides an exit code.
    auditStackWorld: async (repoRoot) => {
      await auditStackWorld(repoRoot, (message) => {
        console.log(message);
      });
    },
    sqlExecutor: executor,
  };
}

export function buildOptions(args: { wipe: boolean }, stackMode: StackMode): EnsureStackOptions {
  const slot = stackSlotFrom(process.env);
  const idleDaemonPortRaw = process.env['HB_IDLE_DAEMON_PORT'];
  if (idleDaemonPortRaw === undefined) {
    throw new Error('ensure-stack: HB_IDLE_DAEMON_PORT not set (run pnpm generate:env)');
  }
  const idleDaemonPort = Number(idleDaemonPortRaw);
  if (!Number.isFinite(idleDaemonPort) || idleDaemonPort <= 0) {
    throw new Error(`ensure-stack: invalid HB_IDLE_DAEMON_PORT="${idleDaemonPortRaw}"`);
  }
  return {
    repoRoot: REPO_ROOT,
    slot,
    daemonScriptPath: DAEMON_SCRIPT,
    idleDaemonPort,
    wipe: args.wipe,
    stackMode,
  };
}

async function main(): Promise<number> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    console.log(formatUsage(COMMAND_LINE));
    return 0;
  }

  // CI is a no-op. CI workflows generate env files in a CI-specific mode
  // (with GitHub-secret bindings) before invoking any consumer; regenerating
  // here would overwrite those with Mode.Development values and drop the
  // secrets the tests depend on. Database lifecycle is likewise owned by the
  // workflow steps in CI.
  if (process.env['CI']) {
    if (!args.quiet) console.log('Stack ready (CI no-op).');
    return 0;
  }

  // Generate env first so HB_STACK_SLOT etc. are available, then load it. The
  // slot is claimed rather than derived, so generating is what makes one exist,
  // and nothing downstream may work one out for itself. The whole of the
  // mode's triple, through the same loader every other script reaches: naming
  // two of the three files here left the backend one — and every storage
  // credential in it — out of reach, and named the development stack's spelling
  // whatever `--env-mode` had just generated.
  const envMode = selectedEnvMode(args.envMode, process.env);
  generateEnvFiles(REPO_ROOT, envMode);
  loadEnvironment(REPO_ROOT, envMode);

  // Inside the claim, not before it: the steps below free and rebuild what this
  // slot holds, and a run that owns none of it is one a concurrent wipe reads
  // as absent.
  await withEnsureStackClaim(stackModeFor(envMode), async () => {
    if (envMode === Mode.E2E) {
      // Playwright spawns each webServer in a process group of its own and
      // reaps them only on a clean shutdown, so an interrupted run leaves them
      // bound to the e2e band with their run's claim expired. Culling those is
      // what lets the next run start; the band of any other mode is not this
      // command's to touch, which is why the set is the run's own.
      const slot = stackSlotFrom(process.env);
      assertE2eBandFree(slot, await readSlotLiveness(slot), currentRunId());
      // Before anything below starts, so a root the run cannot fit in is
      // refused naming what to raise, rather than failing whichever write
      // fills it mid-run.
      await prepareE2eRamRoot();
      // Hidden coupling with the `webServer` binds in `playwright.config.ts`:
      // this returns as soon as the holders are signalled, and the kernel can
      // keep a freed port in LISTEN briefly after that — nothing here waits for
      // it. Those binds are safe only because `package.json` puts several
      // process stages between this call and them; shortening that distance
      // re-opens the question.
      await reclaimPorts({
        ports: hostPortsForRun(slot, 'e2e'),
        log: (message) => {
          console.log(message);
        },
      });
    }

    await reclaimStrandedLifelineSockets({
      log: (message) => {
        console.log(message);
      },
    });

    // Ordered before the world audit `ensureStack` finishes with: a tree ended
    // here is one that audit then finds gone, so a run killed at an arbitrary
    // moment leaves the next ordinary command with nothing to print about it
    // and nobody to ask.
    await reclaimOrphanedProcessGroups({
      log: (message) => {
        console.log(message);
      },
    });

    const options = buildOptions(args, stackModeFor(envMode));
    const deps = buildDeps(envMode);
    await ensureStack(options, deps);
  });
  if (!args.quiet) console.log('Stack ready.');
  return 0;
}

if (isMainModule(import.meta.url)) {
  await runMain(main);
}
/* v8 ignore stop */
