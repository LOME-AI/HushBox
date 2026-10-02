import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/neon-serverless/migrator';
import { DAY_MS, HOUR_MS, TEST_DAY_START } from '@hushbox/shared/test-time';

import { createDb, LOCAL_NEON_DEV_CONFIG, type Database } from '../../client';
import {
  acquisitionSourcesView,
  campaigns,
  funnelWeeklyView,
  growthCampaignPaths,
  growthGeo,
  growthHourlyEvents,
  growthHourlyFunnel,
  growthHourlyProductEntry,
  growthPaths,
  growthReferrers,
  growthVisitors,
  ledgerEntries,
  marketingDailyView,
  marketingHourlyView,
  payments,
  usageRecords,
  userAcquisition,
  users,
  wallets,
} from '../index';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for integration tests');
}

const MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../drizzle'
);

/** UTC Monday of the week holding `instantMs`, the boundary `date_trunc('week', …, 'UTC')` lands on. */
function weekStart(instantMs: number): Date {
  const day = new Date(instantMs);
  const weekdayFromMonday = (day.getUTCDay() + 6) % 7;
  return new Date(
    Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) - weekdayFromMonday * DAY_MS
  );
}

const WEEK_A = weekStart(TEST_DAY_START - 7 * DAY_MS);
const WEEK_B = weekStart(TEST_DAY_START);

const A_DAY_1 = new Date(WEEK_A.getTime() + DAY_MS);
const A_DAY_2 = new Date(WEEK_A.getTime() + 2 * DAY_MS);
const B_DAY_1 = new Date(WEEK_B.getTime() + DAY_MS);
const A_HOUR_1 = new Date(A_DAY_1.getTime() + 9 * HOUR_MS);
const A_HOUR_2 = new Date(A_DAY_1.getTime() + 10 * HOUR_MS);
const B_HOUR_1 = new Date(B_DAY_1.getTime() + 9 * HOUR_MS);

/** Buckets reserved for the marketing-family rows, so no other suite's grain rows land in the filtered read. */
const MARKETING_DAY = new Date(WEEK_A.getTime() + 4 * DAY_MS);
const MARKETING_HOUR = new Date(MARKETING_DAY.getTime() + 6 * HOUR_MS);

const SPRING = 'spring-launch';
const PODCAST = 'podcast-tour';
const PRESS = 'press-kit';
const NEWSLETTER = 'newsletter-drop';
const SEEDED_CAMPAIGNS = [SPRING, PODCAST, PRESS, NEWSLETTER];
const FUNNEL_CAMPAIGNS = [SPRING, PODCAST, PRESS];

/**
 * The names auto-capture derives for marketing anchors pointing at the two
 * product-entry routes. Written out rather than derived, so the fixture is an
 * independent statement of what the view must count.
 */
const SIGNUP_EVENT = 'link:/signup';
const CHAT_EVENT = 'link:/chat';

const blob = new Uint8Array([1, 2, 3]);

let db: Database;
const createdUserIds: string[] = [];
const createdWalletIds: string[] = [];

async function insertUser(
  handle: string,
  createdAt: Date,
  emailVerified: boolean
): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({
      email: `views-${handle}@test.hushbox.ai`,
      username: `views_${handle}`,
      emailVerified,
      createdAt,
      opaqueRegistration: blob,
      opaqueServerMaterial: blob,
      opaqueKekFingerprint: blob,
      publicKey: blob,
      passwordWrappedPrivateKey: blob,
      recoveryWrappedPrivateKey: blob,
      recoveryPublicKey: blob,
    })
    .returning({ id: users.id });
  if (!row) throw new Error('user insert returned no row');
  createdUserIds.push(row.id);
  return row.id;
}

async function insertWallet(userId: string, type: 'purchased' | 'free'): Promise<string> {
  const [row] = await db.insert(wallets).values({ userId, type }).returning({ id: wallets.id });
  if (!row) throw new Error('wallet insert returned no row');
  createdWalletIds.push(row.id);
  return row.id;
}

/** One balanced double-entry pair: the wallet leg and its house counterpart, which the deferred zero-sum trigger requires. */
async function insertLedgerPair(
  walletId: string,
  kind: 'deposit' | 'charge' | 'refund' | 'clawback',
  amountNanoUsd: bigint,
  key: string
): Promise<void> {
  await db.transaction(async (tx) => {
    const transactionId = crypto.randomUUID();
    await tx.insert(ledgerEntries).values({
      transactionId,
      walletId,
      kind,
      amountNanoUsd,
      balanceAfterNanoUsd: amountNanoUsd,
      idempotencyKey: `views-${key}-wallet`,
    });
    await tx.insert(ledgerEntries).values({
      transactionId,
      houseAccount: 'payments-in',
      kind,
      amountNanoUsd: -amountNanoUsd,
      idempotencyKey: `views-${key}-house`,
    });
  });
}

async function insertTurn(
  payerUserId: string,
  senderUserId: string,
  createdAt: Date,
  key: string
): Promise<void> {
  await db.insert(usageRecords).values({
    payerUserId,
    senderUserId,
    runId: crypto.randomUUID(),
    modelId: 'test/model',
    providerName: 'test',
    modality: 'text',
    costNanoUsd: 1000n,
    idempotencyKey: `views-${key}`,
    createdAt,
  });
}

beforeAll(async () => {
  db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  await db
    .insert(campaigns)
    .values(SEEDED_CAMPAIGNS.map((tag) => ({ tag, label: tag, status: 'active' as const })));

  // The anonymous half: day rows per campaign and path, hourly product-entry
  // click events, and hourly registration starts.
  await db.insert(growthCampaignPaths).values([
    { grain: 'day', bucket: A_DAY_1, campaign: SPRING, path: '/', visitors: 10 },
    // Not the busiest page of its day: the day's figure is the larger '/' row,
    // and this row's ceiling is what makes that figure a floor all the same.
    { grain: 'day', bucket: A_DAY_1, campaign: SPRING, path: '/blog', visitors: 4, overflow: true },
    { grain: 'day', bucket: A_DAY_2, campaign: SPRING, path: '/', visitors: 6 },
    { grain: 'day', bucket: B_DAY_1, campaign: PRESS, path: '/', visitors: 3 },
    // A ceiling hit in this campaign's week by a row of a grain the visited
    // step never counts. The step's flag must stay false, which is what fails
    // if the reduction is taken outside the grain filter.
    { grain: 'hour', bucket: B_HOUR_1, campaign: PRESS, path: '/', visitors: 2, overflow: true },
  ]);
  await db.insert(growthHourlyEvents).values([
    { hour: A_HOUR_1, campaign: SPRING, eventName: SIGNUP_EVENT, path: '/', visitors: 5 },
    // Not the busiest entry row of its hour either, for the same reason.
    {
      hour: A_HOUR_1,
      campaign: SPRING,
      eventName: SIGNUP_EVENT,
      path: '/blog',
      visitors: 2,
      overflow: true,
    },
    { hour: A_HOUR_2, campaign: SPRING, eventName: SIGNUP_EVENT, path: '/', visitors: 3 },
    // The busiest entry row in its hour is a chat click, not a signup click, so
    // an entry step counting only the signup name would report a smaller number.
    { hour: A_HOUR_1, campaign: SPRING, eventName: CHAT_EVENT, path: '/', visitors: 7 },
    { hour: A_HOUR_2, campaign: SPRING, eventName: CHAT_EVENT, path: '/welcome', visitors: 1 },
    // A click that means reading on rather than entering: the entry step
    // never counts it, whatever its visitor count.
    { hour: A_HOUR_1, campaign: SPRING, eventName: 'hero-cta', path: '/', visitors: 40 },
    // The only ceiling among this campaign-week's event rows, hit by an event
    // the entry step never counts. The step's flag must stay false, which is
    // what fails if the reduction is taken outside the event-name filter.
    {
      hour: B_HOUR_1,
      campaign: PRESS,
      eventName: 'hero-cta',
      path: '/',
      visitors: 40,
      overflow: true,
    },
  ]);
  await db.insert(growthHourlyFunnel).values([
    { hour: A_HOUR_1, campaign: SPRING, step: 'started', registrations: 4 },
    // One hour of the week's sum turned an address away at its ceiling, which
    // makes the week's figure a floor however exact the hours beside it were.
    { hour: A_HOUR_2, campaign: SPRING, step: 'started', registrations: 3, overflow: true },
    { hour: A_HOUR_1, campaign: PRESS, step: 'started', registrations: 2 },
  ]);

  // One row per marketing family, in buckets no other suite writes.
  await db.insert(growthVisitors).values({ grain: 'hour', bucket: MARKETING_HOUR, visitors: 11 });
  await db.insert(growthPaths).values({
    grain: 'day',
    bucket: MARKETING_DAY,
    path: '/pricing',
    visitors: 9,
    landings: 4,
    overflow: true,
  });
  await db.insert(growthReferrers).values({
    grain: 'hour',
    bucket: MARKETING_HOUR,
    path: '/pricing',
    referrerHost: 'example.com',
    visitors: 2,
  });
  await db.insert(growthGeo).values({
    grain: 'hour',
    bucket: MARKETING_HOUR,
    country: 'US',
    region: 'CA',
    device: 'desktop',
    visitors: 6,
  });
  await db.insert(growthHourlyProductEntry).values({ hour: MARKETING_HOUR, visitors: 4 });

  // The identified half.
  const a1 = await insertUser('a1', new Date(A_DAY_1.getTime() + 10 * HOUR_MS), true);
  const a2 = await insertUser('a2', new Date(A_DAY_1.getTime() + 11 * HOUR_MS), false);
  const a3 = await insertUser('a3', new Date(A_DAY_2.getTime() + 9 * HOUR_MS), true);
  const owner = await insertUser('owner', new Date(B_DAY_1.getTime() + 9 * HOUR_MS), true);
  const member = await insertUser('member', new Date(B_DAY_1.getTime() + 10 * HOUR_MS), true);
  const b3 = await insertUser('b3', new Date(B_DAY_1.getTime() + 9 * HOUR_MS), true);

  await db.insert(userAcquisition).values([
    {
      userId: a1,
      campaign: SPRING,
      platform: 'web',
      selfReportedChannel: 'podcast',
      selfReportedContext: 'post_signup',
      selfReportedAt: new Date(A_DAY_1.getTime() + 12 * HOUR_MS),
    },
    { userId: a2, campaign: SPRING, platform: 'web' },
    { userId: a3, campaign: PODCAST, platform: 'ios' },
    { userId: owner, campaign: PODCAST, platform: 'web' },
    { userId: member, campaign: SPRING, platform: 'web' },
    { userId: b3, campaign: PRESS, platform: 'android' },
  ]);

  await insertTurn(a1, a1, new Date(A_DAY_1.getTime() + 12 * HOUR_MS), 'a1-first');
  await insertTurn(
    a1,
    a1,
    new Date(A_DAY_1.getTime() + 10 * HOUR_MS + 7 * DAY_MS + HOUR_MS),
    'a1-return'
  );
  await insertTurn(a3, a3, new Date(A_DAY_2.getTime() + 11 * HOUR_MS), 'a3-first');
  // The owner pays, the member sends: activation belongs to the member.
  await insertTurn(owner, member, new Date(B_DAY_1.getTime() + 12 * HOUR_MS), 'group-turn');

  await db.insert(payments).values([
    {
      userId: a1,
      amountNanoUsd: 5_000_000_000n,
      status: 'completed',
      idempotencyKey: 'views-a1-pay',
    },
    {
      userId: a2,
      amountNanoUsd: 5_000_000_000n,
      status: 'pending',
      idempotencyKey: 'views-a2-pay',
    },
    {
      userId: b3,
      amountNanoUsd: 2_000_000_000n,
      status: 'completed',
      idempotencyKey: 'views-b3-pay',
    },
  ]);

  const a1Purchased = await insertWallet(a1, 'purchased');
  const a1Free = await insertWallet(a1, 'free');
  const b3Purchased = await insertWallet(b3, 'purchased');
  await insertLedgerPair(a1Purchased, 'deposit', 5_000_000_000n, 'a1-deposit');
  // A charge is usage recognition, not cash collected, and must not reach revenue.
  await insertLedgerPair(a1Purchased, 'charge', -1_000_000_000n, 'a1-charge');
  // A deposit-kind leg on the FREE wallet: only the wallet-type predicate keeps
  // promotional credit out of revenue, so the fixture puts it in that wallet.
  await insertLedgerPair(a1Free, 'deposit', 7_000_000_000n, 'a1-free');
  await insertLedgerPair(b3Purchased, 'deposit', 2_000_000_000n, 'b3-deposit');
}, 60_000);

afterAll(async () => {
  // One statement, so both legs of every pair leave together: the deferred
  // zero-sum trigger refuses a delete that strands a counterpart.
  await db.delete(ledgerEntries).where(sql`${ledgerEntries.idempotencyKey} like 'views-%'`);
  await db.delete(usageRecords).where(sql`${usageRecords.idempotencyKey} like 'views-%'`);
  await db.delete(payments).where(sql`${payments.idempotencyKey} like 'views-%'`);
  if (createdWalletIds.length > 0) {
    await db.delete(wallets).where(inArray(wallets.id, createdWalletIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db
    .delete(growthCampaignPaths)
    .where(inArray(growthCampaignPaths.campaign, SEEDED_CAMPAIGNS));
  await db.delete(growthHourlyEvents).where(inArray(growthHourlyEvents.campaign, SEEDED_CAMPAIGNS));
  await db.delete(growthHourlyFunnel).where(inArray(growthHourlyFunnel.campaign, SEEDED_CAMPAIGNS));
  await db.delete(growthVisitors).where(eq(growthVisitors.bucket, MARKETING_HOUR));
  await db.delete(growthPaths).where(eq(growthPaths.bucket, MARKETING_DAY));
  await db.delete(growthReferrers).where(eq(growthReferrers.bucket, MARKETING_HOUR));
  await db.delete(growthGeo).where(eq(growthGeo.bucket, MARKETING_HOUR));
  await db
    .delete(growthHourlyProductEntry)
    .where(eq(growthHourlyProductEntry.hour, MARKETING_HOUR));
  await db.delete(campaigns).where(inArray(campaigns.tag, SEEDED_CAMPAIGNS));
  await db.$client.end();
});

/** Every funnel row for the seeded campaigns, ordered so the assertion is one comparison. */
function readFunnel(): Promise<(typeof funnelWeeklyView.$inferSelect)[]> {
  return db
    .select()
    .from(funnelWeeklyView)
    .where(inArray(funnelWeeklyView.campaign, FUNNEL_CAMPAIGNS))
    .orderBy(funnelWeeklyView.week, funnelWeeklyView.campaign);
}

describe('funnel_weekly', () => {
  it('reports every ladder column for three campaigns across two weeks', async () => {
    expect(await readFunnel()).toEqual([
      {
        week: WEEK_A,
        campaign: PODCAST,
        visitorsDailySummed: 0,
        visitorsOverflow: false,
        productEntryClicksHourlySummed: 0,
        productEntryClicksOverflow: false,
        started: 0,
        startedOverflow: false,
        finished: 1,
        verified: 1,
        activated: 1,
        returnedWeek1: 0,
        firstPaid: 0,
        revenueNanoUsd: 0n,
      },
      {
        week: WEEK_A,
        campaign: PRESS,
        visitorsDailySummed: 0,
        visitorsOverflow: false,
        productEntryClicksHourlySummed: 0,
        productEntryClicksOverflow: false,
        started: 2,
        startedOverflow: false,
        finished: 0,
        verified: 0,
        activated: 0,
        returnedWeek1: 0,
        firstPaid: 0,
        revenueNanoUsd: 0n,
      },
      {
        week: WEEK_A,
        campaign: SPRING,
        visitorsDailySummed: 16,
        visitorsOverflow: true,
        productEntryClicksHourlySummed: 10,
        productEntryClicksOverflow: true,
        started: 7,
        startedOverflow: true,
        finished: 2,
        verified: 1,
        activated: 1,
        returnedWeek1: 1,
        firstPaid: 1,
        revenueNanoUsd: 5_000_000_000n,
      },
      {
        week: WEEK_B,
        campaign: PODCAST,
        visitorsDailySummed: 0,
        visitorsOverflow: false,
        productEntryClicksHourlySummed: 0,
        productEntryClicksOverflow: false,
        started: 0,
        startedOverflow: false,
        finished: 1,
        verified: 1,
        activated: 0,
        returnedWeek1: 0,
        firstPaid: 0,
        revenueNanoUsd: 0n,
      },
      {
        week: WEEK_B,
        campaign: PRESS,
        visitorsDailySummed: 3,
        visitorsOverflow: false,
        productEntryClicksHourlySummed: 0,
        productEntryClicksOverflow: false,
        started: 0,
        startedOverflow: false,
        finished: 1,
        verified: 1,
        activated: 0,
        returnedWeek1: 0,
        firstPaid: 1,
        revenueNanoUsd: 2_000_000_000n,
      },
      {
        week: WEEK_B,
        campaign: SPRING,
        visitorsDailySummed: 0,
        visitorsOverflow: false,
        productEntryClicksHourlySummed: 0,
        productEntryClicksOverflow: false,
        started: 0,
        startedOverflow: false,
        finished: 1,
        verified: 1,
        activated: 1,
        returnedWeek1: 0,
        firstPaid: 0,
        revenueNanoUsd: 0n,
      },
    ]);
  });

  it('marks the visited step a floor when a row its bucket maximum beat had hit its ceiling', async () => {
    const rows = await readFunnel();
    const row = rows.find(
      (each) => each.campaign === SPRING && each.week.getTime() === WEEK_A.getTime()
    );
    expect(row?.visitorsDailySummed).toBe(16);
    expect(row?.visitorsOverflow).toBe(true);
  });

  it('marks the started step a floor when an hour its sum covers hit its ceiling', async () => {
    const rows = await readFunnel();
    const row = rows.find(
      (each) => each.campaign === SPRING && each.week.getTime() === WEEK_A.getTime()
    );
    expect(row?.started).toBe(7);
    expect(row?.startedOverflow).toBe(true);
  });

  it('leaves the started step unmarked where the ceiling was hit under another campaign', async () => {
    const rows = await readFunnel();
    const row = rows.find(
      (each) => each.campaign === PRESS && each.week.getTime() === WEEK_A.getTime()
    );
    expect(row?.started).toBe(2);
    expect(row?.startedOverflow).toBe(false);
  });

  it('marks the product-entry step a floor on the same rule', async () => {
    const rows = await readFunnel();
    const row = rows.find(
      (each) => each.campaign === SPRING && each.week.getTime() === WEEK_A.getTime()
    );
    expect(row?.productEntryClicksHourlySummed).toBe(10);
    expect(row?.productEntryClicksOverflow).toBe(true);
  });

  it('leaves the entry step unmarked where the ceiling was hit by an event it never counts', async () => {
    const rows = await readFunnel();
    const row = rows.find(
      (each) => each.campaign === PRESS && each.week.getTime() === WEEK_B.getTime()
    );
    expect(row?.productEntryClicksHourlySummed).toBe(0);
    expect(row?.productEntryClicksOverflow).toBe(false);
  });

  it('leaves the visited step unmarked where the ceiling was hit by a row of a grain it never counts', async () => {
    const rows = await readFunnel();
    const row = rows.find(
      (each) => each.campaign === PRESS && each.week.getTime() === WEEK_B.getTime()
    );
    expect(row?.visitorsDailySummed).toBe(3);
    expect(row?.visitorsOverflow).toBe(false);
  });

  it('credits activation to the account that sent the turn, not the one that paid for it', async () => {
    const rows = await readFunnel();
    const sender = rows.find(
      (row) => row.campaign === SPRING && row.week.getTime() === WEEK_B.getTime()
    );
    const payer = rows.find(
      (row) => row.campaign === PODCAST && row.week.getTime() === WEEK_B.getTime()
    );
    expect(sender?.activated).toBe(1);
    expect(payer?.activated).toBe(0);
  });

  it('names the entry step for every destination it counts, never for one of them', async () => {
    const found = await db.execute(
      sql`select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'funnel_weekly'
          order by ordinal_position`
    );
    const names = found.rows.map((row) => String(row['column_name']));
    expect(names).toContain('visitors_daily_summed');
    expect(names).toContain('product_entry_clicks_hourly_summed');
    expect(names.filter((name) => name.includes('unique'))).toEqual([]);
    expect(names.filter((name) => name.includes('signup'))).toEqual([]);
  });

  it('drops a refunded payment out of revenue on the next read, with no analytics row to disagree', async () => {
    const refunded = await insertUser('refund', new Date(A_DAY_1.getTime() + 13 * HOUR_MS), true);
    await db
      .insert(userAcquisition)
      .values({ userId: refunded, campaign: NEWSLETTER, platform: 'web' });
    const wallet = await insertWallet(refunded, 'purchased');
    await insertLedgerPair(wallet, 'deposit', 9_000_000_000n, 'refund-deposit');

    const before = await db
      .select({ revenue: funnelWeeklyView.revenueNanoUsd })
      .from(funnelWeeklyView)
      .where(eq(funnelWeeklyView.campaign, NEWSLETTER));
    expect(before).toEqual([{ revenue: 9_000_000_000n }]);

    await insertLedgerPair(wallet, 'refund', -4_000_000_000n, 'refund-back');

    const after = await db
      .select({ revenue: funnelWeeklyView.revenueNanoUsd })
      .from(funnelWeeklyView)
      .where(eq(funnelWeeklyView.campaign, NEWSLETTER));
    expect(after).toEqual([{ revenue: 5_000_000_000n }]);
  });
});

describe('acquisition_sources', () => {
  it('prefers the self-reported channel over the campaign as the primary source', async () => {
    const rows = await db
      .select()
      .from(acquisitionSourcesView)
      .where(
        and(
          inArray(acquisitionSourcesView.campaign, [SPRING]),
          eq(acquisitionSourcesView.userCreatedWeek, WEEK_A)
        )
      )
      .orderBy(acquisitionSourcesView.primarySource);
    expect(rows).toEqual([
      {
        userCreatedWeek: WEEK_A,
        campaign: SPRING,
        selfReportedChannel: 'podcast',
        selfReportedContext: 'post_signup',
        primarySource: 'podcast',
      },
      {
        userCreatedWeek: WEEK_A,
        campaign: SPRING,
        selfReportedChannel: null,
        selfReportedContext: null,
        primarySource: SPRING,
      },
    ]);
  });
});

describe('marketing views', () => {
  it('carries each hourly family as its own row, with only its own dimensions filled', async () => {
    const rows = await db
      .select()
      .from(marketingHourlyView)
      .where(eq(marketingHourlyView.bucket, MARKETING_HOUR))
      .orderBy(marketingHourlyView.family);
    expect(rows).toEqual([
      {
        bucket: MARKETING_HOUR,
        family: 'geo',
        path: null,
        referrerHost: null,
        campaign: null,
        country: 'US',
        region: 'CA',
        device: 'desktop',
        visitors: 6,
        landings: null,
        overflow: false,
      },
      {
        bucket: MARKETING_HOUR,
        family: 'product-entry',
        path: null,
        referrerHost: null,
        campaign: null,
        country: null,
        region: null,
        device: null,
        visitors: 4,
        landings: null,
        overflow: false,
      },
      {
        bucket: MARKETING_HOUR,
        family: 'referrer',
        path: '/pricing',
        referrerHost: 'example.com',
        campaign: null,
        country: null,
        region: null,
        device: null,
        visitors: 2,
        landings: null,
        overflow: false,
      },
      {
        bucket: MARKETING_HOUR,
        family: 'total',
        path: null,
        referrerHost: null,
        campaign: null,
        country: null,
        region: null,
        device: null,
        visitors: 11,
        landings: null,
        overflow: false,
      },
    ]);
  });

  it('carries the day-grain path family, landings and overflow included', async () => {
    const rows = await db
      .select()
      .from(marketingDailyView)
      .where(
        and(eq(marketingDailyView.bucket, MARKETING_DAY), eq(marketingDailyView.family, 'path'))
      );
    expect(rows).toEqual([
      {
        bucket: MARKETING_DAY,
        family: 'path',
        path: '/pricing',
        referrerHost: null,
        campaign: null,
        country: null,
        region: null,
        device: null,
        visitors: 9,
        landings: 4,
        overflow: true,
      },
    ]);
  });

  // The entrant marginal is counted per hour and nothing counts it per day: a
  // day figure summed from hours would count one person once per hour they
  // clicked in. So the daily view carries no such family at all, rather than a
  // zero — a zero is a measurement, and at this grain there is none to report.
  it('carries no product-entry family at day grain, where no count of one exists', async () => {
    const rows = await db
      .select({ bucket: marketingDailyView.bucket })
      .from(marketingDailyView)
      .where(eq(marketingDailyView.family, 'product-entry'));
    expect(rows).toEqual([]);
  });

  it('keeps each grain to its own view', async () => {
    const hourly = await db
      .select({ family: marketingHourlyView.family })
      .from(marketingHourlyView)
      .where(eq(marketingHourlyView.bucket, MARKETING_DAY));
    expect(hourly).toEqual([]);
  });
});

describe('the reader surface', () => {
  it('projects no account identifier, email or username from any view', async () => {
    const found = await db.execute(
      sql`select table_name, column_name
          from information_schema.columns
          where table_schema = 'public'
            and table_name in ('marketing_hourly', 'marketing_daily', 'growth_weekly', 'funnel_weekly', 'acquisition_sources')
            and column_name in ('user_id', 'email', 'username', 'payer_user_id', 'sender_user_id', 'id')`
    );
    expect(found.rows).toEqual([]);
  });

  it('creates all five views', async () => {
    const found = await db.execute(
      sql`select table_name from information_schema.views
          where table_schema = 'public'
            and table_name in ('marketing_hourly', 'marketing_daily', 'growth_weekly', 'funnel_weekly', 'acquisition_sources')
          order by table_name`
    );
    expect(found.rows.map((row) => row['table_name'])).toEqual([
      'acquisition_sources',
      'funnel_weekly',
      'growth_weekly',
      'marketing_daily',
      'marketing_hourly',
    ]);
  });
});
