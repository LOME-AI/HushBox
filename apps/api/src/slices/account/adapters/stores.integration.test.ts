import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, createDb, users } from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { createAccountStores, invitableUserSearchQuery } from './stores.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for account store integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

/**
 * Unique per module load: a worker slot's database outlives the file that runs
 * on it, so the next file to land on that slot sees whatever rows this one
 * leaves behind.
 */
const PREFIX = `zs${crypto.randomUUID().replaceAll('-', '').slice(0, 4)}`;

/**
 * Enough rows that a sequential scan is the expensive plan and the planner has
 * a reason to prefer an index. A handful of rows would let ANY plan win on
 * cost, which would make the assertion below pass whatever the schema says.
 */
const SEEDED_ROWS = 600;

/**
 * The prefix as it reaches the store: the domain LIKE-escapes `_`, so the
 * separator the seeded usernames carry matches literally rather than as a
 * single-character wildcard — which is also what makes the prefix selective
 * enough for the planner to have a reason to reach for the index.
 */
const LIKE_ESCAPED_UNDERSCORE = String.raw`\_`;
const LIKE_PREFIX = PREFIX + LIKE_ESCAPED_UNDERSCORE;

const conversationId = crypto.randomUUID();
const callerUserId = crypto.randomUUID();

/** Reads the chosen plan for the exact query the store runs. */
async function explainSearch(usernamePattern: string): Promise<string> {
  const query = invitableUserSearchQuery(db, {
    usernamePattern,
    excludeUserId: callerUserId,
    conversationId,
    limit: 20,
  });
  const explained = await db.execute(sql`EXPLAIN ${query.getSQL()}`);
  const rows = explained.rows as { 'QUERY PLAN': string }[];
  return rows.map((row) => row['QUERY PLAN']).join('\n');
}

beforeAll(async () => {
  // The sealed-material pair comes from the shared factory so the bulk seed
  // carries the factory's shape; every seeded row shares one pair, which the
  // plan under test never reads.
  const { opaqueServerMaterial, opaqueKekFingerprint } = userFactory.build();
  await db.execute(sql`
    INSERT INTO users (
      email, username, opaque_registration, public_key,
      password_wrapped_private_key, recovery_wrapped_private_key, recovery_public_key,
      opaque_server_material, opaque_kek_fingerprint
    )
    SELECT
      ${PREFIX} || '-' || g || '@account-store.test',
      ${PREFIX} || '_' || g,
      '\\x01'::bytea, '\\x02'::bytea, '\\x03'::bytea, '\\x04'::bytea, '\\x05'::bytea,
      ${sql.param(opaqueServerMaterial, users.opaqueServerMaterial)}::bytea,
      ${sql.param(opaqueKekFingerprint, users.opaqueKekFingerprint)}::bytea
    FROM generate_series(1, ${SEEDED_ROWS}) g
  `);
  await db.execute(sql`ANALYZE users`);
});

afterAll(async () => {
  const seeded = `${LIKE_PREFIX}%`;
  await db.execute(sql`DELETE FROM users WHERE username LIKE ${seeded}`);
});

describe('the invitable-user search query', () => {
  it('resolves its username prefix through an index rather than scanning users', async () => {
    const plan = await explainSearch(`${LIKE_PREFIX}500%`);

    expect(plan).toContain('users_username_lower_pattern_idx');
  });

  it('never falls back to a sequential scan of users', async () => {
    const plan = await explainSearch(`${LIKE_PREFIX}500%`);

    expect(plan).not.toContain('Seq Scan on users');
  });

  it('still matches a stored username whose case differs from the query', async () => {
    await db.insert(users).values(
      userFactory.build({
        email: `${PREFIX}-upper@account-store.test`,
        username: `${PREFIX}_UP`,
        opaqueRegistration: new Uint8Array([1]),
        publicKey: new Uint8Array([2]),
        passwordWrappedPrivateKey: new Uint8Array([3]),
        recoveryWrappedPrivateKey: new Uint8Array([4]),
        recoveryPublicKey: new Uint8Array([5]),
      })
    );

    const found = await createAccountStores(db).users.searchInvitable({
      usernamePattern: `${LIKE_PREFIX}up%`,
      excludeUserId: callerUserId,
      conversationId,
      limit: 20,
    });

    expect(found._unsafeUnwrap().map((row) => row.username)).toEqual([`${PREFIX}_UP`]);
  });
});
