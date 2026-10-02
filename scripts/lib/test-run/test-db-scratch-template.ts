import { setTimeout as delay } from 'node:timers/promises';

import { TEMPLATE_DATABASE, withDatabaseName } from '@hushbox/db/test-db';
import { isMainModule } from '../cli/is-main.js';
import { runMain } from '../cli/run-main.js';
import {
  createTestDbExecutor,
  ensureSlotDatabase,
  ensureTemplateDatabase,
  withMaintenanceExecutor,
} from './test-db-provision.js';
import type { SqlExecutor } from '../stack/stack-meta.js';

/**
 * Runs the real template lifecycle against a throwaway clone source.
 *
 * The production clone source is one cluster-global database every concurrent
 * run is using, so exercising drop/create/stamp against it would kill them.
 * Rewriting the identifier on its way to the server points the statements
 * somewhere disposable while leaving the sequence the production code emits
 * byte-identical — which is the property under test.
 *
 * This is also the entry point the multi-process proof spawns: one process per
 * simulated package, all reaching the template step at once.
 */

/** Table the stand-in build writes, so "was it really rebuilt?" has an answer. */
export const MARKER_TABLE = 'scratch_marker';

/**
 * Wraps an executor so every statement naming the production template names
 * `scratchTemplate` instead. Both the quoted DDL identifier and the fingerprint
 * SELECT's string literal carry the same spelling, so one substitution covers
 * the whole sequence.
 */
export function retargetTemplate(executor: SqlExecutor, scratchTemplate: string): SqlExecutor {
  const rewrite = (statement: string): string =>
    statement.replaceAll(TEMPLATE_DATABASE, scratchTemplate);
  return {
    exec: (statement) => executor.exec(rewrite(statement)),
    query: (statement) => executor.query(rewrite(statement)),
  };
}

interface ScratchTemplateOptions {
  readonly connectionString: string;
  readonly scratchTemplate: string;
  readonly fingerprint: string;
  /** Cloned from the scratch template once the template step settles. */
  readonly slotDatabase: string;
  /**
   * Where the builder's claim is taken, which every process standing in for one
   * package shares and the production template does not. A stand-in queueing
   * behind a real template build would wait for a migrate-and-seed it has no
   * interest in, and hold up the run that wanted one.
   */
  readonly registryDir: string;
  /**
   * The seed-input digest the template step is handed, so the stand-in's stamp
   * is a value the proof chose rather than one read from the live checkout.
   */
  readonly seedInputsDigest: string;
}

interface ScratchTemplateOutcome {
  /** This process built the template rather than finding it already current. */
  readonly built: boolean;
  /** This process created the slot rather than absorbing a duplicate. */
  readonly createdSlot: boolean;
  readonly statements: readonly string[];
}

/** Records what the production code asked for, then forwards it unchanged. */
function record(executor: SqlExecutor, statements: string[]): SqlExecutor {
  return {
    exec: (statement) => {
      statements.push(statement);
      return executor.exec(statement);
    },
    query: (statement) => {
      statements.push(statement);
      return executor.query(statement);
    },
  };
}

/**
 * One session against a stand-in template, closed before this returns. Every
 * phase of a stand-in build runs through it, so a build's session lifetime is
 * exactly a phase's — which is what lets a test reproduce both the window
 * where a session holds the database and the window where none does.
 */
export async function withStandInSession<T>(
  connectionString: string,
  databaseName: string,
  use: (executor: SqlExecutor) => Promise<T>
): Promise<T> {
  const executor = createTestDbExecutor(withDatabaseName(connectionString, databaseName));
  try {
    return await use(executor);
  } finally {
    // The clone that follows fails outright while a session holds the source.
    await executor.close();
  }
}

/**
 * Stands in for migrate+seed: one statement inside the freshly created
 * template, stamped with the fingerprint the build was asked for. Cloning it
 * is what proves a rebuild replaced the database rather than only re-stamping
 * its comment. `holdMs` keeps the session open before the write, standing in
 * for a build phase long enough for another checker to reach the same
 * database.
 */
export async function writeMarker(
  connectionString: string,
  databaseName: string,
  fingerprint: string,
  holdMs = 0
): Promise<void> {
  await withStandInSession(connectionString, databaseName, async (executor) => {
    if (holdMs > 0) {
      await executor.query('SELECT 1');
      await delay(holdMs);
    }
    await executor.exec(
      `CREATE TABLE ${MARKER_TABLE} AS SELECT '${fingerprint}'::text AS fingerprint`
    );
  });
}

export async function runScratchTemplateStep(
  options: ScratchTemplateOptions
): Promise<ScratchTemplateOutcome> {
  const statements: string[] = [];
  return withMaintenanceExecutor(options.connectionString, async (maintenance) => {
    const executor = retargetTemplate(record(maintenance, statements), options.scratchTemplate);
    // The build target comes from the callback's argument, not from the
    // options: a build is handed the staging database it is to fill, which is
    // a real name the retargeting never rewrites. Writing to the stand-in
    // instead would fill the database the publish rename then replaces.
    const built = await ensureTemplateDatabase(
      executor,
      options.fingerprint,
      (databaseName) => writeMarker(options.connectionString, databaseName, options.fingerprint),
      // The stand-in template this proof drives holds one marker table and
      // nothing the migration chain describes, so there is nothing to compare
      // it against.
      {
        registryDir: options.registryDir,
        verifyTemplate: () => Promise.resolve(),
        seedInputsDigest: options.seedInputsDigest,
      }
    );
    const beforeSlot = statements.length;
    await ensureSlotDatabase(executor, options.slotDatabase, new Date());
    return { built, createdSlot: statements.length - beforeSlot === 2, statements };
  });
}

/* v8 ignore start -- child-process entry; every decision it composes is covered in-process */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    const [scratchTemplate, fingerprint, slotDatabase, registryDir, seedInputsDigest] =
      process.argv.slice(2);
    const connectionString = process.env['DATABASE_URL'];
    if (
      !connectionString ||
      !scratchTemplate ||
      !fingerprint ||
      !slotDatabase ||
      !registryDir ||
      !seedInputsDigest
    ) {
      throw new Error(
        'test-db-scratch-template: usage: DATABASE_URL=… ' +
          '<template> <fingerprint> <slot> <registry> <seed-inputs-digest>'
      );
    }
    const outcome = await runScratchTemplateStep({
      connectionString,
      scratchTemplate,
      fingerprint,
      slotDatabase,
      registryDir,
      seedInputsDigest,
    });
    process.stdout.write(JSON.stringify(outcome));
  });
}
/* v8 ignore stop */
