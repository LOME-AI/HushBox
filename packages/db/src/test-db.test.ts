import { describe, it, expect } from 'vitest';
import { HOUR_MS, isoAt, MINUTE_MS, TEST_DAY_START } from '@hushbox/shared/test-time';

import {
  CREATED_COMMENT_PREFIX,
  STALE_DATABASE_AGE_MS,
  TEMPLATE_COMMENT_PREFIX,
  TEMPLATE_DATABASE,
  TEST_DATABASE_PREFIX,
  listStageDatabasesSql,
  mintStageDatabaseName,
  applyTestDatabaseName,
  BASE_DATABASE_URL_VARIABLE,
  evidenceDatabaseUrl,
  commentDatabaseSql,
  connectionCountSql,
  createDatabaseSql,
  createdComment,
  databaseClaim,
  carriesReadableCreationStamp,
  dropDatabaseSql,
  dropIdleDatabaseSql,
  listTestDatabasesSql,
  mintScratchBucketId,
  publishTemplateSql,
  quoteIdentifier,
  renameDatabaseSql,
  runDatabasePrefix,
  slotDatabaseName,
  preRegistryDatabaseNames,
  runIdFromToken,
  runTokenFor,
  testDatabaseRunToken,
  scratchBucketName,
  scratchBucketPrefix,
  scratchBucketRunToken,
  stageDatabaseRunToken,
  templateComment,
  templateFingerprintSql,
  withDatabaseName,
} from './test-db';

describe('mintStageDatabaseName', () => {
  const RUN_TOKEN = runTokenFor('0189a1f2-c3d4-4e5f-8a9b-0c1d2e3f4a5b');

  it('stays outside the prefix a run token is read out of', () => {
    expect(mintStageDatabaseName(RUN_TOKEN).startsWith(TEST_DATABASE_PREFIX)).toBe(false);
  });

  it('carries no spelling of the live template name for the proof harness to rewrite', () => {
    expect(mintStageDatabaseName(RUN_TOKEN)).not.toContain(TEMPLATE_DATABASE);
  });

  it("produces a different name on each call, so one build never claims another one's", () => {
    expect(mintStageDatabaseName(RUN_TOKEN)).not.toBe(mintStageDatabaseName(RUN_TOKEN));
  });

  it('is a legal database identifier, since every statement quotes it verbatim', () => {
    expect(() => quoteIdentifier(mintStageDatabaseName(RUN_TOKEN))).not.toThrow();
  });

  it('names the run it was minted for, with nothing else on disk consulted', () => {
    expect(stageDatabaseRunToken(mintStageDatabaseName(RUN_TOKEN))).toBe(RUN_TOKEN);
  });

  it('refuses a token the name it would make could not be read back to', () => {
    expect(() => mintStageDatabaseName('a1b2_c3d4')).toThrow(/staging database/);
  });

  it('refuses a token that would push the name past what a database identifier holds', () => {
    expect(() => mintStageDatabaseName('a'.repeat(64))).toThrow(/longer than/);
  });

  it('fits inside a database identifier, which the server truncates rather than refuses', () => {
    expect(mintStageDatabaseName(RUN_TOKEN).length).toBeLessThanOrEqual(63);
  });
});

describe('stageDatabaseRunToken', () => {
  it('names no run token for a staging database minted before names carried one', () => {
    expect(stageDatabaseRunToken('hb_stage_ab12cd34ef567890')).toBeUndefined();
  });

  it('names no run token for a database outside the staging prefix', () => {
    expect(stageDatabaseRunToken(TEMPLATE_DATABASE)).toBeUndefined();
  });
});

describe('listStageDatabasesSql', () => {
  it('lists only databases under the staging prefix', () => {
    expect(listStageDatabasesSql()).toContain(`starts_with(datname, 'hb_stage_')`);
  });
});

describe('the run token a resource name carries', () => {
  const RUN_ID = '0189a1f2-c3d4-4e5f-8a9b-0c1d2e3f4a5b';

  it('is the id of the run itself, in a spelling a database identifier may hold', () => {
    expect(runTokenFor(RUN_ID)).toBe('0189a1f2c3d44e5f8a9b0c1d2e3f4a5b');
  });

  it('names the run it was made for, with nothing else on disk consulted', () => {
    expect(runIdFromToken(runTokenFor(RUN_ID))).toBe(RUN_ID);
  });

  it('names no run for a token minted before tokens carried one', () => {
    expect(runIdFromToken('ab12cd34ef')).toBeUndefined();
  });

  it('names no run for a token of the right length that is not one', () => {
    expect(runIdFromToken('z'.repeat(32))).toBeUndefined();
  });

  it('refuses an id it could not name back, so no resource is named under one', () => {
    expect(() => runTokenFor('a-run-id-of-some-other-shape')).toThrow('run id');
  });
});

describe('slotDatabaseName', () => {
  it('names a slot database from the run token and the pool id', () => {
    expect(slotDatabaseName('ab12cd34ef', '7')).toBe('hb_t_ab12cd34ef_w7');
  });

  it('starts with the swept prefix', () => {
    expect(slotDatabaseName('ab12cd34ef', '1').startsWith(TEST_DATABASE_PREFIX)).toBe(true);
  });

  it('rejects a token that is not lowercase alphanumeric', () => {
    expect(() => slotDatabaseName('ab-12', '1')).toThrow(/run token/);
  });

  it('rejects a slot that is not a positive integer', () => {
    expect(() => slotDatabaseName('ab12cd34ef', '1; drop')).toThrow(/slot/);
  });
});

describe('runDatabasePrefix', () => {
  it('matches every slot database of the run and nothing else', () => {
    const prefix = runDatabasePrefix('ab12cd34ef');
    expect(slotDatabaseName('ab12cd34ef', '3').startsWith(prefix)).toBe(true);
    expect(slotDatabaseName('ff99ff99ff', '3').startsWith(prefix)).toBe(false);
  });
});

describe('TEMPLATE_DATABASE', () => {
  it('is outside the swept prefix so the sweep can never drop it', () => {
    expect(TEMPLATE_DATABASE.startsWith(TEST_DATABASE_PREFIX)).toBe(false);
  });
});

describe('withDatabaseName', () => {
  it('swaps the database while keeping credentials, host and port', () => {
    expect(withDatabaseName('postgres://u:p@localhost:4444/hushbox', 'hb_t_x_w1')).toBe(
      'postgres://u:p@localhost:4444/hb_t_x_w1'
    );
  });

  it('keeps query parameters', () => {
    expect(withDatabaseName('postgresql://h:5432/hushbox?sslmode=require', 'hb_tpl')).toBe(
      'postgresql://h:5432/hb_tpl?sslmode=require'
    );
  });

  it('rejects a connection string that is not a URL', () => {
    expect(() => withDatabaseName('not-a-url', 'hb_tpl')).toThrow(/connection string/);
  });
});

describe('applyTestDatabaseName', () => {
  it('rewrites every postgres URL in the environment', () => {
    const env: NodeJS.ProcessEnv = {
      DATABASE_URL: 'postgres://postgres:postgres@localhost:4444/hushbox',
      MIGRATION_DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/hushbox',
      ADMIN_SQL_PANEL_DATABASE_URL: 'postgres://admin_sql_panel:pw@localhost:4444/hushbox',
    };

    applyTestDatabaseName(env, 'hb_tpl');

    expect(env['DATABASE_URL']).toBe('postgres://postgres:postgres@localhost:4444/hb_tpl');
    expect(env['MIGRATION_DATABASE_URL']).toBe(
      'postgresql://postgres:postgres@localhost:5432/hb_tpl'
    );
    expect(env['ADMIN_SQL_PANEL_DATABASE_URL']).toBe(
      'postgres://admin_sql_panel:pw@localhost:4444/hb_tpl'
    );
  });

  it('leaves absent variables absent', () => {
    const env: NodeJS.ProcessEnv = { DATABASE_URL: 'postgres://h:4444/hushbox' };

    applyTestDatabaseName(env, 'hb_tpl');

    expect(env['MIGRATION_DATABASE_URL']).toBeUndefined();
  });

  it('leaves an empty variable empty', () => {
    const env: NodeJS.ProcessEnv = {
      DATABASE_URL: 'postgres://h:4444/hushbox',
      MIGRATION_DATABASE_URL: '',
    };

    applyTestDatabaseName(env, 'hb_tpl');

    expect(env['MIGRATION_DATABASE_URL']).toBe('');
  });
});

describe('the base URL the retarget preserves', () => {
  const BASE = 'postgres://postgres:postgres@localhost:4444/hushbox';

  it('captures the base DATABASE_URL before overwriting it', () => {
    const env: NodeJS.ProcessEnv = { DATABASE_URL: BASE };

    applyTestDatabaseName(env, 'hb_t_x_w1');

    expect(env[BASE_DATABASE_URL_VARIABLE]).toBe(BASE);
    expect(env['DATABASE_URL']).toBe('postgres://postgres:postgres@localhost:4444/hb_t_x_w1');
  });

  it('keeps the first capture when a second retarget runs in the same environment', () => {
    const env: NodeJS.ProcessEnv = { DATABASE_URL: BASE };

    applyTestDatabaseName(env, 'hb_t_x_w1');
    applyTestDatabaseName(env, 'hb_t_x_w2');

    expect(env[BASE_DATABASE_URL_VARIABLE]).toBe(BASE);
  });

  it('captures nothing when there is no DATABASE_URL to displace', () => {
    const env: NodeJS.ProcessEnv = { MIGRATION_DATABASE_URL: BASE };

    applyTestDatabaseName(env, 'hb_t_x_w1');

    expect(env[BASE_DATABASE_URL_VARIABLE]).toBeUndefined();
  });

  it('treats an empty capture as no capture', () => {
    const env: NodeJS.ProcessEnv = { DATABASE_URL: BASE, [BASE_DATABASE_URL_VARIABLE]: '' };

    applyTestDatabaseName(env, 'hb_t_x_w1');

    expect(env[BASE_DATABASE_URL_VARIABLE]).toBe(BASE);
  });
});

describe('evidenceDatabaseUrl', () => {
  const BASE = 'postgres://postgres:postgres@localhost:4444/hushbox';

  it('yields the preserved base rather than the worker clone', () => {
    const env: NodeJS.ProcessEnv = { DATABASE_URL: BASE, VITEST_POOL_ID: '3' };
    applyTestDatabaseName(env, 'hb_t_x_w3');

    expect(evidenceDatabaseUrl(env)).toBe(BASE);
  });

  it('throws inside a vitest worker whose environment never passed the retarget', () => {
    const env: NodeJS.ProcessEnv = { DATABASE_URL: BASE, VITEST_POOL_ID: '3' };

    expect(() => evidenceDatabaseUrl(env)).toThrow(/HB_BASE_DATABASE_URL/);
  });

  it('yields DATABASE_URL where nothing retargeted it', () => {
    expect(evidenceDatabaseUrl({ DATABASE_URL: BASE })).toBe(BASE);
  });

  it('throws when no connection string is reachable at all', () => {
    expect(() => evidenceDatabaseUrl({})).toThrow(/DATABASE_URL/);
  });
});

describe('createdComment', () => {
  it('records the creation instant in a parseable comment', () => {
    const createdAt = TEST_DAY_START + 10 * HOUR_MS;

    expect(createdComment(new Date(createdAt))).toBe(
      `${CREATED_COMMENT_PREFIX}${isoAt(createdAt)}`
    );
  });
});

describe('scratchBucketName', () => {
  it('carries the owning run, so a sweep can attribute a bucket it did not create', () => {
    expect(scratchBucketRunToken(scratchBucketName('a1b2c3', 'aaaa'))).toBe('a1b2c3');
  });

  it('stays inside the length a bucket name may have', () => {
    expect(
      scratchBucketName(runTokenFor(crypto.randomUUID()), mintScratchBucketId()).length
    ).toBeLessThanOrEqual(63);
  });

  it('refuses a suffix that would push the name past what an object store allows', () => {
    expect(() => scratchBucketName(runTokenFor(crypto.randomUUID()), 'x'.repeat(20))).toThrow(
      'longer than'
    );
  });

  it('carries the run a bucket belongs to, readable with no record left on disk', () => {
    const runId = crypto.randomUUID();
    const bucket = scratchBucketName(runTokenFor(runId), mintScratchBucketId());

    expect(runIdFromToken(scratchBucketRunToken(bucket) ?? '')).toBe(runId);
  });

  it('groups every bucket of one run under the prefix the run claims', () => {
    expect(scratchBucketName('a1b2c3', 'aaaa').startsWith(scratchBucketPrefix('a1b2c3'))).toBe(
      true
    );
  });

  it('refuses to name a bucket from anything but a minted run token', () => {
    expect(() => scratchBucketPrefix('not a token')).toThrow('invalid run token');
  });

  it('reports no run token for a bucket named before buckets carried one', () => {
    expect(scratchBucketRunToken('hushbox-scratch-aaaa')).toBeUndefined();
  });

  it('reports no run token for a bucket that is not a scratch bucket at all', () => {
    expect(scratchBucketRunToken('hushbox-media')).toBeUndefined();
  });
});

describe('testDatabaseRunToken', () => {
  it('reads the owning run out of the name every slot database is created under', () => {
    expect(testDatabaseRunToken(slotDatabaseName('a1b2c3', '4'))).toBe('a1b2c3');
  });

  it('groups every database of one run under the prefix the run claims', () => {
    expect(slotDatabaseName('a1b2c3', '4').startsWith(runDatabasePrefix('a1b2c3'))).toBe(true);
  });

  it('reports no run token for a name this module never minted', () => {
    expect(testDatabaseRunToken('hb_t_a1b2c3')).toBeUndefined();
    expect(testDatabaseRunToken('hb_t_a1b2c3_w')).toBeUndefined();
    expect(testDatabaseRunToken('hb_t_a1b2c3_wx')).toBeUndefined();
    expect(testDatabaseRunToken('hb_t_A1B2C3_w1')).toBeUndefined();
    expect(testDatabaseRunToken('hb_t__w1')).toBeUndefined();
  });

  it('reports no run token for a name carrying a second slot segment', () => {
    expect(testDatabaseRunToken('hb_t_a1b2c3_w1_w2')).toBeUndefined();
  });

  it('reports no run token for a database outside the swept prefix', () => {
    expect(testDatabaseRunToken(TEMPLATE_DATABASE)).toBeUndefined();
  });
});

describe('databaseClaim', () => {
  it('names the run a per-worker database belongs to, out of the name alone', () => {
    const runId = crypto.randomUUID();

    expect(databaseClaim(slotDatabaseName(runTokenFor(runId), '4')).runId).toBe(runId);
  });

  it('names no run for a database whose name predates run-id naming', () => {
    expect(databaseClaim(slotDatabaseName('a1b2c3', '4')).runId).toBeUndefined();
  });

  it('names the run a staging database belongs to, out of the name alone', () => {
    const runId = crypto.randomUUID();

    expect(databaseClaim(mintStageDatabaseName(runTokenFor(runId))).runId).toBe(runId);
  });

  it('names no run for a staging database whose name predates run-id naming', () => {
    expect(databaseClaim('hb_stage_ab12cd34ef567890').runId).toBeUndefined();
  });

  it('claims a per-worker database under the prefix its run recorded', () => {
    expect(databaseClaim(slotDatabaseName('a1b2c3', '4')).id).toBe(runDatabasePrefix('a1b2c3'));
  });

  it('claims a staging database under its whole name, which is what a build records', () => {
    const staged = mintStageDatabaseName(runTokenFor(crypto.randomUUID()));
    expect(databaseClaim(staged).id).toBe(staged);
  });

  it('puts a name carrying a run token in the per-worker family', () => {
    expect(databaseClaim(slotDatabaseName('a1b2c3', '4')).family).toBe('per-worker');
  });

  it('puts a name carrying no run token in the staging family', () => {
    expect(databaseClaim(mintStageDatabaseName(runTokenFor(crypto.randomUUID()))).family).toBe(
      'staging'
    );
  });
});

describe('preRegistryDatabaseNames', () => {
  const now = new Date(TEST_DAY_START + 12 * HOUR_MS);
  const cutoff = now.getTime() - STALE_DATABASE_AGE_MS;

  it('selects an unowned database older than the age limit', () => {
    const rows = [{ datname: 'hb_t_a_w1', comment: createdComment(new Date(cutoff - MINUTE_MS)) }];

    expect(preRegistryDatabaseNames(rows, now, STALE_DATABASE_AGE_MS)).toEqual(['hb_t_a_w1']);
  });

  it('spares an unowned database younger than the age limit', () => {
    const rows = [{ datname: 'hb_t_a_w1', comment: createdComment(new Date(cutoff + MINUTE_MS)) }];

    expect(preRegistryDatabaseNames(rows, now, STALE_DATABASE_AGE_MS)).toEqual([]);
  });

  it('spares a database whose creation stamp cannot be read', () => {
    // A database carries no comment between its CREATE and its COMMENT, so an
    // unreadable stamp is what a database another run is creating right now
    // looks like. Reading it as ancient would destroy it.
    const rows = [
      { datname: 'hb_t_a_w1', comment: null },
      { datname: 'hb_t_b_w1', comment: 'something else' },
      { datname: 'hb_t_c_w1', comment: `${CREATED_COMMENT_PREFIX}not-a-date` },
    ];

    expect(preRegistryDatabaseNames(rows, now, STALE_DATABASE_AGE_MS)).toEqual([]);
  });

  it('reads the instant out of a comment that also carried an owner field', () => {
    const rows = [
      {
        datname: 'hb_t_a_w1',
        comment: `${CREATED_COMMENT_PREFIX}${isoAt(cutoff - MINUTE_MS)} owner=run-abc`,
      },
    ];

    expect(preRegistryDatabaseNames(rows, now, STALE_DATABASE_AGE_MS)).toEqual(['hb_t_a_w1']);
  });
});

describe('carriesReadableCreationStamp', () => {
  it('answers yes for a comment carrying an instant this module can read', () => {
    expect(carriesReadableCreationStamp(createdComment(new Date(TEST_DAY_START)))).toBe(true);
  });

  it('answers no for a database that carries no comment at all', () => {
    expect(carriesReadableCreationStamp(null)).toBe(false);
  });

  it('answers no for a comment that is not a creation stamp', () => {
    expect(carriesReadableCreationStamp('something else')).toBe(false);
  });

  it('answers no for a creation stamp whose instant will not parse', () => {
    expect(carriesReadableCreationStamp(`${CREATED_COMMENT_PREFIX}not-a-date`)).toBe(false);
  });
});

describe('quoteIdentifier', () => {
  it('double-quotes a legal identifier', () => {
    expect(quoteIdentifier('hb_t_a_w1')).toBe('"hb_t_a_w1"');
  });

  it('rejects an identifier carrying anything but lowercase, digits and underscore', () => {
    expect(() => quoteIdentifier('a"; drop database x --')).toThrow(/identifier/);
  });
});

describe('SQL builders', () => {
  it('clones from the template', () => {
    expect(createDatabaseSql('hb_t_a_w1', 'hb_tpl')).toBe(
      'CREATE DATABASE "hb_t_a_w1" TEMPLATE "hb_tpl"'
    );
  });

  it('creates without a template when none is given', () => {
    expect(createDatabaseSql('hb_tpl')).toBe('CREATE DATABASE "hb_tpl"');
  });

  it('escapes single quotes in a comment literal', () => {
    expect(commentDatabaseSql('hb_tpl', "it's")).toBe(`COMMENT ON DATABASE "hb_tpl" IS 'it''s'`);
  });

  it('forces connections closed on drop so a live client cannot block it', () => {
    expect(dropDatabaseSql('hb_t_a_w1')).toBe('DROP DATABASE IF EXISTS "hb_t_a_w1" WITH (FORCE)');
  });

  it('lists only databases under the swept prefix', () => {
    expect(listTestDatabasesSql()).toContain(`starts_with(datname, '${TEST_DATABASE_PREFIX}')`);
  });

  it('reads the template fingerprint from the database comment', () => {
    expect(templateFingerprintSql()).toContain(TEMPLATE_DATABASE);
  });

  it('leaves connections alone when dropping a staged or retired template', () => {
    expect(dropIdleDatabaseSql('hb_stage_a_b')).toBe('DROP DATABASE IF EXISTS "hb_stage_a_b"');
  });

  it('renames one database to another', () => {
    expect(renameDatabaseSql('hb_stage_a_b', 'hb_tpl')).toBe(
      'ALTER DATABASE "hb_stage_a_b" RENAME TO "hb_tpl"'
    );
  });

  it('counts the sessions attached to one database', () => {
    expect(connectionCountSql('hb_tpl')).toContain(`datname = 'hb_tpl'`);
  });
});

describe('templateComment', () => {
  it('records the fingerprint the template was built from', () => {
    expect(templateComment('abc123')).toBe(`${TEMPLATE_COMMENT_PREFIX}abc123`);
  });

  it('names the migrations and the seed inputs as what the fingerprint covers', () => {
    expect(templateComment('abc123')).toBe('hushbox-test-template migrations+seed-inputs=abc123');
  });
});

describe('publishTemplateSql', () => {
  it('retires the live template before installing the staged one under its name', () => {
    expect(publishTemplateSql('hb_stage_a_b', 'hb_stage_c_d')).toBe(
      'BEGIN; ' +
        `ALTER DATABASE "${TEMPLATE_DATABASE}" RENAME TO "hb_stage_c_d"; ` +
        `ALTER DATABASE "hb_stage_a_b" RENAME TO "${TEMPLATE_DATABASE}"; ` +
        'COMMIT'
    );
  });
});
