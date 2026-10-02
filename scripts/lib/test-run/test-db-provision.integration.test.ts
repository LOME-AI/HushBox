import { describe, expect, it, vi } from 'vitest';

import {
  RUN_TOKEN_VARIABLE,
  TEMPLATE_DATABASE,
  createDatabaseSql,
  dropDatabaseSql,
  listTestDatabasesSql,
  slotDatabaseName,
  templateComment,
  templateFingerprintSql,
  withDatabaseName,
  type DatabaseRow,
} from '@hushbox/db/test-db';

import {
  assertSchemaMatchesMigrations,
  connectionCount,
  createTestDbExecutor,
  ensureSlotDatabase,
  ensureTemplateDatabase,
  templateFingerprint,
  templateVerifier,
  withMaintenanceExecutor,
} from './test-db-provision.js';
import type { SqlExecutor } from '../stack/stack-meta.js';

/**
 * That the comparison the build skip consults names a database changed outside
 * the migration chain, and that it reaches that answer without ever holding a
 * session on the clone source — executed against the live cluster rather than
 * reasoned about.
 *
 * The drifted database is this worker's own — a clone of the clone-source
 * template, so it starts holding exactly what the chain records — given one
 * table no migration describes; it is named after the run so a table a killed
 * process leaves behind is attributable, and the `finally` covers every path
 * this process controls. The matching one is this worker's own database again,
 * read and not written: it is a clone of the template, which is what makes it
 * describe the same schema.
 */

/** Slots no vitest worker is given, so the databases these cases make are their own. */
const CLONE_SOURCE_SLOT = '9101';
const CLONE_SLOT = '9102';
const CONCURRENT_CLONE_SLOT = '9103';

function databaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new Error('DATABASE_URL is required for this test');
  }
  return url;
}

function runToken(): string {
  const token = process.env[RUN_TOKEN_VARIABLE];
  if (token === undefined || token === '') {
    throw new Error('the vitest global setup did not run');
  }
  return token;
}

/** The table this suite adds outside the chain, named after the run that added it. */
function markerTable(): string {
  return `hb_drift_tpl_${runToken()}`;
}

/** What the refusal says about the table this suite added. */
function namedInTheRefusal(): RegExp {
  return new RegExp(`table ${markerTable()}: the database has it`);
}

/** Runs `body` against a database holding one relation the migration chain does not describe. */
async function withDrift(body: (databaseUrl: string) => Promise<void>): Promise<void> {
  const executor = createTestDbExecutor(databaseUrl());
  const table = markerTable();
  await executor.exec(`CREATE TABLE "${table}" (id integer)`);
  try {
    await body(databaseUrl());
  } finally {
    await executor.exec(`DROP TABLE IF EXISTS "${table}"`);
    await executor.close();
  }
}

/** A database the chain describes, which is what every clone of the template is. */
function matchingDatabaseUrl(): string {
  return databaseUrl();
}

/** Drops the databases a case named, whichever of them it got as far as creating. */
async function withDroppedAfter(
  names: readonly string[],
  body: (maintenance: SqlExecutor) => Promise<void>
): Promise<void> {
  await withMaintenanceExecutor(databaseUrl(), async (maintenance) => {
    try {
      await body(maintenance);
    } finally {
      for (const name of names) await maintenance.exec(dropDatabaseSql(name));
    }
  });
}

/**
 * Sessions counted on the clone source for as long as one comparison runs,
 * sampled from a connection of its own.
 *
 * The window that matters is the one the comparison is inside, so the count is
 * taken repeatedly while it runs: a reading taken before it starts sees nothing
 * whichever database the comparison goes on to read.
 */
async function sessionsOnTheSourceDuringAComparison(): Promise<number[]> {
  const held: number[] = [];
  const state = { comparing: true };
  const stillComparing = (): boolean => state.comparing;

  await withMaintenanceExecutor(databaseUrl(), async (observer) => {
    await withMaintenanceExecutor(databaseUrl(), async (maintenance) => {
      const verified = templateVerifier(
        maintenance,
        databaseUrl(),
        assertSchemaMatchesMigrations
      )().finally(() => {
        state.comparing = false;
      });
      while (stillComparing()) held.push(await connectionCount(observer, TEMPLATE_DATABASE));
      await verified;
    });
  });
  return held;
}

/**
 * Raises `clone` from the clone source on a connection of its own, inside the
 * window one comparison occupies — which is what a second run's worker does.
 */
async function cloneRaisedDuringAComparison(
  maintenance: SqlExecutor,
  clone: string
): Promise<void> {
  await withMaintenanceExecutor(databaseUrl(), (cloner) =>
    templateVerifier(maintenance, databaseUrl(), (url) =>
      Promise.all([
        assertSchemaMatchesMigrations(url),
        ensureSlotDatabase(cloner, clone, new Date()),
      ]).then(() => undefined)
    )()
  );
}

describe('the comparison both migration skips consult', () => {
  it('names the relation a change outside the migration chain left behind', async () => {
    await withDrift(async (url) => {
      await expect(assertSchemaMatchesMigrations(url)).rejects.toThrow(namedInTheRefusal());
    });
  });

  it('returns without a refusal for a database the chain describes', async () => {
    await expect(assertSchemaMatchesMigrations(matchingDatabaseUrl())).resolves.toBeUndefined();
  });

  it('names that relation in a clone of the database holding it', async () => {
    // Why a clone of the clone source answers for the clone source: a clone
    // carries its source's drift, so the comparison names the same object
    // without the source ever being read.
    const source = slotDatabaseName(runToken(), CLONE_SOURCE_SLOT);
    const clone = slotDatabaseName(runToken(), CLONE_SLOT);

    await withDroppedAfter([clone, source], async (maintenance) => {
      await maintenance.exec(createDatabaseSql(source, TEMPLATE_DATABASE));
      const drifted = createTestDbExecutor(withDatabaseName(databaseUrl(), source));
      try {
        await drifted.exec(`CREATE TABLE "${markerTable()}" (id integer)`);
      } finally {
        await drifted.close();
      }
      await maintenance.exec(createDatabaseSql(clone, source));

      await expect(
        assertSchemaMatchesMigrations(withDatabaseName(databaseUrl(), clone))
      ).rejects.toThrow(namedInTheRefusal());
    });
  });
});

describe('the comparison that answers for the clone source', () => {
  it('holds no session on the clone source while it compares', async () => {
    const held = await sessionsOnTheSourceDuringAComparison();

    expect(held.length).toBeGreaterThan(0);
    expect(Math.max(...held)).toBe(0);
  });

  it('lets a clone of the source be created while it compares', async () => {
    const clone = slotDatabaseName(runToken(), CONCURRENT_CLONE_SLOT);

    await withDroppedAfter([clone], async (maintenance) => {
      await cloneRaisedDuringAComparison(maintenance, clone);

      const rows = await maintenance.query<DatabaseRow>(listTestDatabasesSql());
      expect(rows.map((row) => row.datname)).toContain(clone);
    });
  });

  it('returns without a refusal for the live clone source', async () => {
    await withMaintenanceExecutor(databaseUrl(), async (maintenance) => {
      await expect(
        templateVerifier(maintenance, databaseUrl(), assertSchemaMatchesMigrations)()
      ).resolves.toBeUndefined();
    });
  });
});

describe('the build skip in the clone-source template', () => {
  /**
   * The seed-input digest both the stamp below and the template step are handed,
   * so the skip is decided against the value this test chose and never against a
   * second walk of a checkout another process may be editing.
   */
  const SEED_INPUTS_DIGEST = 'stand-in-seed-inputs';

  /**
   * Answers the stamp of a template already built from `migrationFingerprint`
   * and {@link SEED_INPUTS_DIGEST}.
   */
  function stamped(migrationFingerprint: string): SqlExecutor {
    const fingerprint = templateFingerprint(migrationFingerprint, SEED_INPUTS_DIGEST);
    return {
      exec: vi.fn(),
      query: <T>(statement: string): Promise<T[]> =>
        Promise.resolve(
          statement === templateFingerprintSql()
            ? ([{ comment: templateComment(fingerprint) }] as T[])
            : ([] as T[])
        ),
    };
  }

  it('refuses when the template the stamp accepted has drifted', async () => {
    await withDrift(async (url) => {
      await expect(
        ensureTemplateDatabase(stamped('mig-fp'), 'mig-fp', () => Promise.resolve(), {
          verifyTemplate: () => assertSchemaMatchesMigrations(url),
          seedInputsDigest: SEED_INPUTS_DIGEST,
        })
      ).rejects.toThrow(namedInTheRefusal());
    });
  });

  it('takes the skip when the template matches the schema the chain records', async () => {
    await withMaintenanceExecutor(databaseUrl(), async (maintenance) => {
      const built = await ensureTemplateDatabase(
        stamped('mig-fp'),
        'mig-fp',
        () => Promise.resolve(),
        {
          verifyTemplate: templateVerifier(
            maintenance,
            databaseUrl(),
            assertSchemaMatchesMigrations
          ),
          seedInputsDigest: SEED_INPUTS_DIGEST,
        }
      );
      expect(built).toBe(false);
    });
  });
});
