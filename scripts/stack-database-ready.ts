/**
 * Stack-database readiness gate.
 *
 * A Postgres cluster is born with the one database `docker-compose.yml` hands
 * it, while every stack but the default resolves a database of its own
 * (`scripts/lib/stack/stack-database.ts`). On a developer's machine the stack
 * bring-up closes that gap — {@link ensureDatabaseExists} runs inside
 * `scripts/ensure-stack-cli.ts` — but that bring-up returns at its `CI` guard,
 * which leaves a workflow owning database lifecycle on a runner. This is the
 * step that owns it: run it after the containers are up and before migrations,
 * and the job migrates into the database its own stack names rather than into
 * one nothing created.
 *
 * Pure orchestration; the maintenance connection is injected by the CLI wiring
 * below, the way `scripts/db-bucket-ready.ts` injects its docker probes.
 */

import { isMainModule } from './lib/cli/is-main.js';
import { runMain } from './lib/cli/run-main.js';
import { databaseNameOf } from './lib/stack/stack-database.js';
import { ensureDatabaseExists, withMaintenanceExecutor } from './lib/test-run/test-db-provision.js';

/** The database a stack owns, as the loaded environment names it. */
interface StackDatabaseTarget {
  /** The connection string the stack's generated env files resolved. */
  readonly databaseUrl: string;
  /** The database that connection string names. */
  readonly databaseName: string;
}

interface StackDatabaseDeps {
  /** Creates the database when the cluster lacks it, and answers whether it had to. */
  readonly ensureDatabase: (target: StackDatabaseTarget) => Promise<boolean>;
}

interface StackDatabaseOutcome {
  readonly databaseName: string;
  readonly created: boolean;
}

/**
 * Makes the database the loaded environment names exist.
 *
 * The name is read off the connection string rather than worked out from the
 * stack, so the gate creates exactly what everything downstream connects to —
 * the same reading the bring-up takes.
 */
export async function ensureStackDatabaseReady(
  env: NodeJS.ProcessEnv,
  deps: StackDatabaseDeps
): Promise<StackDatabaseOutcome> {
  const databaseUrl = env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error(
      'stack-database-ready: DATABASE_URL is unset, so nothing names the database this stack owns — run through `tsx scripts/with-env.ts`, which is what loads the generated env files'
    );
  }
  const databaseName = databaseNameOf(databaseUrl);
  return { databaseName, created: await deps.ensureDatabase({ databaseUrl, databaseName }) };
}

/* v8 ignore start -- real-IO wiring; the gate above is unit tested */
async function main(): Promise<void> {
  const { databaseName, created } = await ensureStackDatabaseReady(process.env, {
    ensureDatabase: ({ databaseUrl, databaseName: name }) =>
      withMaintenanceExecutor(databaseUrl, (maintenance) =>
        ensureDatabaseExists(maintenance, name)
      ),
  });
  console.log(created ? `Created database ${databaseName}.` : `Database ${databaseName} is ready.`);
}

if (isMainModule(import.meta.url)) {
  await runMain(main);
}
/* v8 ignore stop */
