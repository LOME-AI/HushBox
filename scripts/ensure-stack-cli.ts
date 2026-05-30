/**
 * CLI entry point for `pnpm ensure-stack`. Composes the pure orchestrator in
 * ensure-stack.ts with real implementations of every dependency: docker, drizzle,
 * pnpm, filesystem, network. Nothing here is unit-tested directly — every
 * decision lives in the pure orchestrator. This file is the wiring.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { config as loadDotenv } from 'dotenv';
import { execa } from 'execa';
import { sql } from 'drizzle-orm';
import { createDb, LOCAL_NEON_DEV_CONFIG } from '@hushbox/db';
import { createEnvUtilities, Mode, type EnvMode } from '@hushbox/shared';
import { fileFingerprint, treeFingerprint, composeFingerprint } from './lib/fingerprint.js';
import { installDevOnlyTracking, readMeta, markClean, type SqlExecutor } from './lib/stack-meta.js';
import { touchHeartbeat, ensureDaemonRunning } from './lib/idle-killer.js';
import { generateEnvFiles } from './generate-env.js';
import { cleanupOrphanedProjects } from './docker-cleanup.js';
import { isMainModule } from './lib/is-main.js';
import { runMain } from './lib/run-main.js';
import { ensureStack, type EnsureStackDeps, type EnsureStackOptions } from './ensure-stack.js';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..');
const DAEMON_SCRIPT = path.join(SCRIPTS_DIR, 'lib', 'idle-killer-daemon-entry.ts');

/** Snake-case physical table names the seed writes to. */
export const TRACKED_TABLES = [
  'users',
  'wallets',
  'projects',
  'conversations',
  'conversation_members',
  'epochs',
  'epoch_members',
  'messages',
  'content_items',
  'usage_records',
  'llm_completions',
  'conversation_spending',
  'payments',
  'ledger_entries',
] as const;

const DOCKER_SERVICES = ['postgres', 'neon-proxy', 'redis', 'serverless-redis-http', 'minio'];

const DEFAULT_IDLE_TTL_MS = 60 * 60 * 1000;

/* v8 ignore start -- real-IO wiring; logic lives in tested pure helpers */

interface ComposeServiceLine {
  Service: string;
  Health?: string;
  State?: string;
}

async function allContainersHealthy(
  repoRoot: string,
  services: readonly string[]
): Promise<boolean> {
  const result = await execa('docker', ['compose', 'ps', '--format', 'json'], {
    cwd: repoRoot,
    env: process.env,
    reject: false,
  });
  if (result.exitCode !== 0) return false;
  const stdout = result.stdout.trim();
  if (!stdout) return false;
  // `docker compose ps --format json` outputs newline-delimited JSON, one
  // service per line. (Recent versions also support `--format=json` array form
  // — handle both.)
  let rows: ComposeServiceLine[];
  if (stdout.startsWith('[')) {
    rows = JSON.parse(stdout) as ComposeServiceLine[];
  } else {
    rows = stdout.split('\n').map((line) => JSON.parse(line) as ComposeServiceLine);
  }
  const healthyServices = new Set(
    rows
      // Services with a healthcheck must report Health: "healthy" (postgres,
      // redis, minio). Services without one (neon-proxy, serverless-redis-http
      // in older compose versions) report Health: "" — accept State: "running"
      // as the liveness signal in that case.
      .filter((r) => {
        if (r.Health === 'healthy') return true;
        if ((r.Health ?? '') === '' && r.State === 'running') return true;
        return false;
      })
      .map((r) => r.Service)
  );
  return services.every((s) => healthyServices.has(s));
}

function readArgument(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value;
}

export function parseCliArgs(argv: readonly string[]): {
  pristine: boolean;
  wipe: boolean;
  quiet: boolean;
  envMode: EnvMode;
} {
  const envModeArgument = readArgument(argv, '--env-mode');
  const envMode: EnvMode =
    envModeArgument === undefined ? Mode.Development : (envModeArgument as EnvMode);
  return {
    pristine: argv.includes('--pristine'),
    wipe: argv.includes('--wipe'),
    quiet: argv.includes('--quiet'),
    envMode,
  };
}

function buildDeps(envMode: EnvMode): EnsureStackDeps {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) throw new Error('DATABASE_URL is required (run pnpm generate:env)');
  const db = createDb({ connectionString: databaseUrl, neonDev: LOCAL_NEON_DEV_CONFIG });

  const executor: SqlExecutor = {
    async exec(query) {
      await db.execute(sql.raw(query));
    },
    async query<T>(query: string): Promise<T[]> {
      const result = await db.execute(sql.raw(query));
      // Drizzle returns { rows: T[] } for neon-http; some adapters return T[] directly.
      const rows = Array.isArray(result)
        ? (result as unknown as T[])
        : ((result as { rows?: T[] }).rows ?? []);
      return rows;
    },
  };

  return {
    touchHeartbeat,
    generateEnvFiles: (repoRoot: string) => {
      generateEnvFiles(repoRoot, envMode);
    },
    installDeps: async (repoRoot) => {
      await execa('pnpm', ['install', '--frozen-lockfile'], {
        cwd: repoRoot,
        stdio: 'inherit',
      });
    },
    cleanupOrphans: async () => {
      await cleanupOrphanedProjects({ dryRun: false }).catch((error: unknown) => {
        console.warn('docker-cleanup failed (non-fatal):', error);
      });
    },
    ensureContainersHealthy: async (repoRoot) => {
      // Fast-path probe: `docker compose ps --format json --status running`
      // returns the running service set in ~50ms. If every required service
      // is already up and healthy, skip the ~3-4s `compose up --wait` startup.
      if (await allContainersHealthy(repoRoot, DOCKER_SERVICES)) return;
      await execa('docker', ['compose', 'up', '-d', '--wait', ...DOCKER_SERVICES], {
        cwd: repoRoot,
        stdio: 'inherit',
        env: process.env,
      });
      // minio-setup has no healthcheck; --wait skips it. Start separately.
      await execa('docker', ['compose', 'up', '-d', 'minio-setup'], {
        cwd: repoRoot,
        stdio: 'inherit',
        env: process.env,
      });
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
    readMeta,
    truncateTracked: async (executorArgument) => {
      const quoted = TRACKED_TABLES.map((t) => `"${t}"`).join(', ');
      await executorArgument.exec(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
    },
    runSeed: async () => {
      // Run seed in a subprocess so its env / module state stays isolated and
      // it picks up the freshly generated .env.scripts.
      await execa('pnpm', ['db:seed'], { cwd: REPO_ROOT, stdio: 'inherit', env: process.env });
    },
    markClean,
    composeDown: async (repoRoot, options) => {
      const args = ['compose', 'down', ...(options.volumes ? ['-v'] : [])];
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
    computeMigrationFingerprint: (repoRoot) =>
      treeFingerprint(path.join(repoRoot, 'packages', 'db', 'drizzle')),
    computeSeedFingerprint: async (repoRoot) => {
      const seedSource = await fileFingerprint(path.join(repoRoot, 'scripts', 'seed.ts'));
      const cryptoTree = await treeFingerprint(path.join(repoRoot, 'packages', 'crypto', 'src'), {
        filter: (relative) => !relative.endsWith('.test.ts') && !relative.endsWith('.d.ts'),
      });
      const sharedConstants = await fileFingerprint(
        path.join(repoRoot, 'packages', 'shared', 'src', 'constants.ts')
      );
      return composeFingerprint([seedSource, cryptoTree, sharedConstants]);
    },
    sqlExecutor: executor,
  };
}

function buildOptions(args: { pristine: boolean; wipe: boolean }): EnsureStackOptions {
  // Pristine policy: per the design conversation, ensureStack is always
  // pristine. `--pristine` is accepted as an explicit no-op for clarity.
  if (args.pristine) {
    // intentionally a no-op — see comment above.
  }
  const slotRaw = process.env['HB_STACK_SLOT'];
  const slot = slotRaw === undefined ? 0 : Number(slotRaw);
  if (!Number.isFinite(slot) || slot < 0) {
    throw new Error(`ensure-stack: invalid HB_STACK_SLOT="${String(slotRaw)}"`);
  }
  const idleDaemonPort = Number(process.env['HB_IDLE_DAEMON_PORT'] ?? '0');
  if (!Number.isFinite(idleDaemonPort) || idleDaemonPort <= 0) {
    throw new Error('ensure-stack: HB_IDLE_DAEMON_PORT not set (run pnpm generate:env)');
  }
  const env = createEnvUtilities(process.env);
  const ttlOverride = process.env['HB_STACK_IDLE_TTL_MS'];
  const idleTtlMs = ttlOverride === undefined ? DEFAULT_IDLE_TTL_MS : Number(ttlOverride);
  return {
    repoRoot: REPO_ROOT,
    slot,
    isCI: env.isCI,
    daemonScriptPath: DAEMON_SCRIPT,
    idleTtlMs,
    idleDaemonPort,
    wipe: args.wipe,
  };
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));

  // Generate env first so HB_STACK_SLOT etc. are available, then load it.
  // Otherwise we'd need worktree detection in two places.
  generateEnvFiles(REPO_ROOT, args.envMode);
  loadDotenv({ path: path.join(REPO_ROOT, '.env.development'), override: true });
  loadDotenv({ path: path.join(REPO_ROOT, '.env.scripts'), override: true });

  const options = buildOptions(args);
  const deps = buildDeps(args.envMode);
  await ensureStack(options, deps);
  if (!args.quiet) console.log('Stack ready.');
}

if (
  isMainModule(import.meta.url) ||
  pathToFileURL(process.argv[1] ?? '').href === import.meta.url
) {
  await runMain(main);
}
/* v8 ignore stop */
