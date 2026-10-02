import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/neon-serverless/migrator';
import { TEST_DAY_START } from '@hushbox/shared/test-time';

import { createDb, LOCAL_NEON_DEV_CONFIG, type Database } from '../client';
import { userFactory } from '../factories';
import { refusalConstraint, refusalMessages } from './__tests__/shape-helpers';
import { userAcquisition, users } from './index';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for integration tests');
}

const MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../drizzle'
);

/** The fallback tag the growth migration seeds for a signup that carried no campaign. */
const DIRECT = 'direct';

const ANSWERED_AT = new Date(TEST_DAY_START);

let db: Database;
const insertedUserIds: string[] = [];

/**
 * Every test inserts the account it needs, so each one passes run alone and no
 * test depends on a row another left behind.
 */
async function insertUser(): Promise<string> {
  const [row] = await db.insert(users).values(userFactory.build()).returning({ id: users.id });
  if (!row) throw new Error('user insert returned no row');
  insertedUserIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}, 60_000);

afterAll(async () => {
  // Deleting the account cascades its source row away, keeping local reruns clean.
  for (const id of insertedUserIds) {
    await db.delete(users).where(eq(users.id, id));
  }
  await db.$client.end();
});

describe('user_acquisition', () => {
  it('records the campaign and the platform an account was created through', async () => {
    const userId = await insertUser();
    const [row] = await db
      .insert(userAcquisition)
      .values({ userId, campaign: DIRECT, platform: 'web' })
      .returning();
    if (!row) throw new Error('acquisition insert returned no row');
    expect(row.campaign).toBe(DIRECT);
    expect(row.platform).toBe('web');
    expect(row.selfReportedChannel).toBeNull();
    expect(row.selfReportedContext).toBeNull();
    expect(row.selfReportedAt).toBeNull();
    expect(row.selfReportSkipped).toBeNull();
  });

  it('keeps at most one source row per account', async () => {
    const userId = await insertUser();
    await db.insert(userAcquisition).values({ userId, campaign: DIRECT, platform: 'ios' });

    const refusal = await refusalConstraint(
      db.insert(userAcquisition).values({ userId, campaign: DIRECT, platform: 'android' })
    );
    expect(refusal).toBe('user_acquisition_user_id_unique');
  });

  it('removes the source row when the account is deleted', async () => {
    const userId = await insertUser();
    await db.insert(userAcquisition).values({ userId, campaign: DIRECT, platform: 'web' });

    await db.delete(users).where(eq(users.id, userId));

    const after = await db.select().from(userAcquisition).where(eq(userAcquisition.userId, userId));
    expect(after).toEqual([]);
  });

  it('refuses a campaign tag no campaign row claims', async () => {
    const userId = await insertUser();
    const refusal = await refusalConstraint(
      db.insert(userAcquisition).values({ userId, campaign: 'no-such-campaign', platform: 'web' })
    );
    expect(refusal).toBe('user_acquisition_campaign_campaigns_tag_fk');
  });

  it('accepts the complete answer triple', async () => {
    const userId = await insertUser();
    const [row] = await db
      .insert(userAcquisition)
      .values({
        userId,
        campaign: DIRECT,
        platform: 'web',
        selfReportedChannel: 'podcast',
        selfReportedContext: 'post_signup',
        selfReportedAt: ANSWERED_AT,
      })
      .returning();
    expect(row?.selfReportedChannel).toBe('podcast');
    expect(row?.selfReportedAt).toEqual(ANSWERED_AT);
  });

  it('refuses a channel recorded without the context it was asked in', async () => {
    const userId = await insertUser();
    const refusal = await refusalConstraint(
      db.insert(userAcquisition).values({
        userId,
        campaign: DIRECT,
        platform: 'web',
        selfReportedChannel: 'search',
        selfReportedAt: ANSWERED_AT,
      })
    );
    expect(refusal).toBe('user_acquisition_self_report_complete');
  });

  it('refuses a context recorded without the channel it asked for', async () => {
    const userId = await insertUser();
    const refusal = await refusalConstraint(
      db.insert(userAcquisition).values({
        userId,
        campaign: DIRECT,
        platform: 'web',
        selfReportedContext: 'first_payment',
        selfReportedAt: ANSWERED_AT,
      })
    );
    expect(refusal).toBe('user_acquisition_self_report_complete');
  });

  it('refuses an answer timestamp with no answer under it', async () => {
    const userId = await insertUser();
    const refusal = await refusalConstraint(
      db
        .insert(userAcquisition)
        .values({ userId, campaign: DIRECT, platform: 'web', selfReportedAt: ANSWERED_AT })
    );
    expect(refusal).toBe('user_acquisition_self_report_complete');
  });

  it('refuses an answer with no timestamp on it', async () => {
    const userId = await insertUser();
    const refusal = await refusalConstraint(
      db.insert(userAcquisition).values({
        userId,
        campaign: DIRECT,
        platform: 'web',
        selfReportedChannel: 'friend',
        selfReportedContext: 'post_signup',
      })
    );
    expect(refusal).toBe('user_acquisition_self_report_complete');
  });

  it('records a skip while the answer stays absent', async () => {
    const userId = await insertUser();
    const [row] = await db
      .insert(userAcquisition)
      .values({
        userId,
        campaign: DIRECT,
        platform: 'android',
        selfReportSkipped: 'post_signup',
      })
      .returning();
    expect(row?.selfReportSkipped).toBe('post_signup');
    expect(row?.selfReportedChannel).toBeNull();
  });

  it('refuses a channel outside the closed set', async () => {
    const userId = await insertUser();
    const insert = db.execute(
      sql`insert into user_acquisition (user_id, campaign, platform, self_reported_channel, self_reported_context, self_reported_at)
          values (${userId}::uuid, ${DIRECT}, 'web', 'billboard', 'post_signup', now())`
    );
    // The enum type by name, so a table that simply refused the statement for
    // some other reason could not stand in for the closed set holding.
    expect(await refusalMessages(insert)).toMatch(/invalid input value for enum growth_channel/);
  });
});
