import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { LOCAL_NEON_DEV_CONFIG, createDb } from '@hushbox/db';
import { SQL_PANEL_MAX_ROWS, SQL_PANEL_STATEMENT_TIMEOUT_MS, createSqlPanel } from './sql-panel.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for sql-panel integration tests');
}

/**
 * The panel role's local URL: same host/db as the owner connection, the
 * `admin_sql_panel` credentials (the env registry's Development value is
 * derived the same way). Test-provisioned below, so the suite is
 * self-sufficient on a fresh CI database.
 */
function panelUrl(): string {
  const url = new URL(DATABASE_URL!);
  url.username = 'admin_sql_panel';
  url.password = 'admin_sql_panel';
  return url.toString();
}

const ownerDb = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const panel = createSqlPanel({ url: panelUrl(), isDev: true });

/**
 * An over-cap query whose poison expression divides by zero only past the
 * fetch cap: a panel that materialized the full result before slicing errors,
 * while the LIMIT-wrapped page stops pulling at the cap and succeeds
 * truncated. `prefix` is whatever leads the query text.
 */
function poisonedOverCapQuery(prefix: string): string {
  const fetchCap = SQL_PANEL_MAX_ROWS + 1;
  return `${prefix}SELECT 1 / (CASE WHEN n <= ${String(fetchCap)} THEN 1 ELSE 0 END) AS ok
     FROM generate_series(1, ${String(SQL_PANEL_MAX_ROWS + 50)}) AS g(n)`;
}

beforeAll(async () => {
  // Migration 0050 creates the role NOLOGIN (the production password is
  // minted out-of-band, never in a migration). Locally and in CI the LOGIN
  // grant is dev-only provisioning — ensure-stack does it for `pnpm dev`;
  // the suite does it here so a bare `db:migrate` database also passes.
  await ownerDb.execute(sql`ALTER ROLE admin_sql_panel LOGIN PASSWORD 'admin_sql_panel'`);
});

describe('createSqlPanel', () => {
  it('runs a SELECT and returns its rows', async () => {
    const result = await panel.run("SELECT 1 AS one, 'two' AS two");

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.rows).toEqual([{ one: 1, two: 'two' }]);
      expect(result.value.rowCount).toBe(1);
      expect(result.value.truncated).toBe(false);
    }
  });

  it('refuses INSERT, UPDATE and DELETE: a write cannot sit inside the row-cap wrap', async () => {
    const insert = await panel.run(
      "INSERT INTO admin_audit (actor, action) VALUES ('panel', 'panel.write')"
    );
    const update = await panel.run("UPDATE users SET username = 'x'");
    const remove = await panel.run('DELETE FROM jobs');

    expect(insert.isErr() && insert.error.code).toBe('validation');
    expect(update.isErr() && update.error.code).toBe('validation');
    expect(remove.isErr() && remove.error.code).toBe('validation');
  });

  it('has no write grants on the role itself, behind the wrap', async () => {
    // Write-proofness is the role's, not the wrapper's: the wrap above refuses
    // writes first, so the grant is proved on a raw connection as the same
    // role. Postgres insufficient_privilege is what a write must hit even if
    // some future shape reached the database as written.
    // `WHERE false` leaves the assertion identical (privileges are checked
    // before the qualifier) and the shared slot database intact if it fires.
    const roleDb = createDb(panelUrl(), { neonDev: LOCAL_NEON_DEV_CONFIG });

    await expect(
      roleDb.execute(sql`UPDATE users SET username = 'x' WHERE false`)
    ).rejects.toMatchObject({
      cause: { code: '42501' },
    });
  });

  it('refuses the plaintext-credential carve-outs', async () => {
    const tokens = await panel.run('SELECT * FROM verification_tokens');
    const opaque = await panel.run('SELECT opaque_registration FROM users');
    const deviceToken = await panel.run('SELECT token FROM device_tokens');

    expect(tokens.isErr() && tokens.error.code).toBe('forbidden');
    expect(opaque.isErr() && opaque.error.code).toBe('forbidden');
    expect(deviceToken.isErr() && deviceToken.error.code).toBe('forbidden');
  });

  it('still reads the non-credential device_tokens columns', async () => {
    const result = await panel.run(
      'SELECT id, user_id, platform, created_at, updated_at FROM device_tokens LIMIT 1'
    );

    expect(result.isOk()).toBe(true);
  });

  it('caps the returned rows and flags truncation', async () => {
    const overCap = String(SQL_PANEL_MAX_ROWS + 50);
    const result = await panel.run(`SELECT generate_series(1, ${overCap}) AS n`);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.rows).toHaveLength(SQL_PANEL_MAX_ROWS);
      expect(result.value.rowCount).toBe(SQL_PANEL_MAX_ROWS);
      expect(result.value.truncated).toBe(true);
    }
  });

  it('applies the row cap server-side (rows past the fetch cap are never pulled)', async () => {
    const result = await panel.run(poisonedOverCapQuery(''));

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.rows).toHaveLength(SQL_PANEL_MAX_ROWS);
      expect(result.value.truncated).toBe(true);
    }
  });

  it('applies the row cap server-side behind a leading line comment', async () => {
    const result = await panel.run(poisonedOverCapQuery('-- operator note\n'));

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.rows).toHaveLength(SQL_PANEL_MAX_ROWS);
      expect(result.value.truncated).toBe(true);
    }
  });

  it('applies the row cap server-side behind a leading block comment', async () => {
    const result = await panel.run(poisonedOverCapQuery('/* operator note */ '));

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.rows).toHaveLength(SQL_PANEL_MAX_ROWS);
      expect(result.value.truncated).toBe(true);
    }
  });

  it('tolerates a trailing line comment on a SELECT-shaped query', async () => {
    const result = await panel.run('SELECT 1 AS one -- operator note');

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.rows).toEqual([{ one: 1 }]);
  });

  it('runs every query under the session statement timeout', async () => {
    // `SHOW` reads the setting but cannot sit inside the row-cap wrap; the
    // function form reads the same GUC in the same transaction as the query
    // it governs.
    const result = await panel.run("SELECT current_setting('statement_timeout') AS timeout");

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.rows).toEqual([
        { timeout: `${String(SQL_PANEL_STATEMENT_TIMEOUT_MS / 1000)}s` },
      ]);
    }
  });

  it('refuses a non-subquery read shape outright (the wrap is unconditional)', async () => {
    const result = await panel.run('SHOW statement_timeout');

    expect(result.isErr() && result.error.code).toBe('validation');
  });

  it('maps a failed connection (bad credentials) to unavailable, never validation', async () => {
    const url = new URL(panelUrl());
    url.password = 'wrong-password';
    const broken = createSqlPanel({ url: url.toString(), isDev: true });

    const result = await broken.run('SELECT 1');

    expect(result.isErr() && result.error.code).toBe('unavailable');
  });

  it('fails closed on an unreachable host when built without dev settings, still through the module-wide dev proxy config', async () => {
    const unroutable = createSqlPanel({
      url: 'postgres://admin_sql_panel:admin_sql_panel@127.0.0.1:1/hushbox',
      isDev: false,
    });

    const result = await unroutable.run('SELECT 1');

    expect(result.isErr() && result.error.code).toBe('unavailable');
  }, 20_000);

  it('maps a malformed query to a typed validation error', async () => {
    const result = await panel.run('SELEKT nothing');

    expect(result.isErr() && result.error.code).toBe('validation');
  });
});
