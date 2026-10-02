import { describe, it, expect, beforeAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { TEST_DAY_START } from '@hushbox/shared/test-time';

import { placeholderBytes } from './factories/helpers';
import { userFactory } from './factories/user';
import {
  applyMigrations,
  readMigrationChain,
  splitChainAt,
  withRehearsalDatabase,
} from './migration-rehearsal';
import { conversations, epochs, users } from './schema/index';

import type { Database } from './client';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for integration tests');
}

const LINK_AUTH_HASH_MIGRATION = '0088_slim_wendell_rand';

const PRE_REVOKED_AT = new Date(TEST_DAY_START).toISOString();

interface MigratedLink {
  readonly revoked: boolean;
  readonly keptRevokedAt: boolean;
  readonly authHashHex: string | null;
}

async function seedConversation(db: Database): Promise<string> {
  const [user] = await db.insert(users).values(userFactory.build()).returning({ id: users.id });
  if (!user) throw new Error('user insert returned no row');
  // `conversations.current_epoch` is a deferred foreign key into `epochs`, so
  // the conversation and its first epoch commit in one transaction.
  return db.transaction(async (tx) => {
    const [conversation] = await tx
      .insert(conversations)
      .values({ userId: user.id, title: placeholderBytes(16) })
      .returning({ id: conversations.id });
    if (!conversation) throw new Error('conversation insert returned no row');
    await tx.insert(epochs).values({
      conversationId: conversation.id,
      epochNumber: 1,
      epochPublicKey: placeholderBytes(32),
      confirmationHash: placeholderBytes(32),
    });
    return conversation.id;
  });
}

/** Raw SQL: the Drizzle table already names the column this migration adds. */
async function seedLink(
  db: Database,
  conversationId: string,
  revokedAt: string | null
): Promise<string> {
  const result = await db.execute(sql`
    insert into shared_links (conversation_id, link_public_key, revoked_at)
    values (${conversationId}, ${Buffer.from(placeholderBytes(32))}, ${revokedAt}::timestamptz)
    returning id
  `);
  return String(result.rows[0]?.['id']);
}

async function readLink(db: Database, id: string): Promise<MigratedLink> {
  const result = await db.execute(sql`
    select revoked_at is not null as revoked,
           revoked_at is not distinct from ${PRE_REVOKED_AT}::timestamptz as kept_revoked_at,
           encode(link_auth_hash, 'hex') as auth_hash_hex
    from shared_links where id = ${id}
  `);
  const row = result.rows[0];
  if (!row) throw new Error(`shared link ${id} did not survive the migration`);
  return {
    revoked: row['revoked'] === true,
    keptRevokedAt: row['kept_revoked_at'] === true,
    authHashHex: typeof row['auth_hash_hex'] === 'string' ? row['auth_hash_hex'] : null,
  };
}

describe('link auth hash migration', () => {
  let live: MigratedLink;
  let preRevoked: MigratedLink;

  beforeAll(async () => {
    await withRehearsalDatabase(DATABASE_URL, async (db) => {
      const { before, from } = splitChainAt(readMigrationChain(), LINK_AUTH_HASH_MIGRATION);
      await applyMigrations(db, before);
      const conversationId = await seedConversation(db);
      const liveId = await seedLink(db, conversationId, null);
      const preRevokedId = await seedLink(db, conversationId, PRE_REVOKED_AT);

      await applyMigrations(db, from);

      live = await readLink(db, liveId);
      preRevoked = await readLink(db, preRevokedId);
    });
  }, 60_000);

  it('revokes a link that was live', () => {
    expect(live.revoked).toBe(true);
    expect(live.keptRevokedAt).toBe(false);
  });

  it('keeps the original revocation instant of a link already revoked', () => {
    expect(preRevoked.keptRevokedAt).toBe(true);
  });

  it('fills every link with a SHA-256-sized placeholder hash', () => {
    expect(live.authHashHex).toMatch(/^[\da-f]{64}$/);
    expect(preRevoked.authHashHex).toMatch(/^[\da-f]{64}$/);
  });

  it('gives each link a distinct placeholder hash', () => {
    expect(live.authHashHex).not.toBe(preRevoked.authHashHex);
  });
});
