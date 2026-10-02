import { eq, like } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  LOCAL_NEON_DEV_CONFIG,
  adminAudit,
  campaigns,
  createDb,
  growthCampaignPaths,
  growthDailyPathReach,
  growthHourlyEvents,
  growthHourlyFunnel,
  growthVisitors,
  idempotencyKeys,
  userAcquisition,
  users,
} from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import {
  ADMIN_OP_CONTRACTS,
  ADMIN_OP_NAMES,
  GROWTH_CAMPAIGN_LABEL_MAX_LENGTH,
  GROWTH_EVENTS_PAGE_SIZE,
  MAX_GROWTH_READ_WINDOW_DAYS,
  defineAdminOpContract,
  growthCampaignsReadSchema,
  growthEventsReadSchema,
  growthFreshnessReadSchema,
  growthFunnelReadSchema,
  growthMarketingReadSchema,
  growthReachReadSchema,
  growthSourcesReadSchema,
} from '@hushbox/shared';
import { DAY_MS, HOUR_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { growthDayBucket } from '../../../../lib/redis/index.js';
import { createGrowthReads } from '../../../growth/index.js';
import {
  archiveCampaignWithinTx,
  createCampaignWithinTx,
} from '../../../growth/public/campaigns.js';
import { createAdminStores } from '../../adapters/stores.js';
import { createAdminOpEngine } from '../engine.js';
import { createAdminOpRegistry } from '../registry.js';
import { describeAdminOp } from '../describe-admin-op.js';
import { adminGrowthOperations } from './index.js';
import { errAsync, okAsync } from '../../../../lib/result/index.js';
import { unavailableError } from '../../../../lib/errors/index.js';
import { createJobWakeCollector, grantJobWakes } from '../../../../lib/jobs/index.js';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type { AdminOpEngineHooks } from '../engine.js';
import type { AdminOpHarnessInstance, AdminOpInterleavingAction } from '../describe-admin-op.js';
import type { GrowthNewestBuckets } from '../../../growth/index.js';
import type { AdminGrowthDeps } from './growth.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for admin growth op tests');
}

const db = grantJobWakes(
  createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG }),
  createJobWakeCollector()
);
const adminStores = createAdminStores();
const growthReads = createGrowthReads();

/** Every harness tag carries this run's prefix, so one harness never sees another's rows. */
const harnessPrefixes: string[] = [];

function newPrefix(): string {
  const prefix = `t${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}-`;
  harnessPrefixes.push(prefix);
  return prefix;
}

afterAll(async () => {
  // The acquisition rows cascade with their accounts; the growth rows are
  // removed with the campaign they reference.
  for (const userId of seededUserIds) {
    await db.delete(users).where(eq(users.id, userId));
  }
  for (const bucket of seededVisitorBuckets) {
    await db.delete(growthVisitors).where(eq(growthVisitors.bucket, bucket));
  }
  for (const prefix of harnessPrefixes) {
    await db.delete(growthHourlyEvents).where(like(growthHourlyEvents.campaign, `${prefix}%`));
    await db.delete(growthHourlyFunnel).where(like(growthHourlyFunnel.campaign, `${prefix}%`));
    await db.delete(growthCampaignPaths).where(like(growthCampaignPaths.campaign, `${prefix}%`));
    await db
      .delete(growthDailyPathReach)
      .where(like(growthDailyPathReach.landingPath, `/${prefix}%`));
    await db.delete(campaigns).where(like(campaigns.tag, `${prefix}%`));
  }
  await db.delete(idempotencyKeys).where(like(idempotencyKeys.route, 'admin/ops/growth.%'));
});

function noopTelemetry(): Telemetry {
  const noop = (): void => undefined;
  return { debug: noop, info: noop, warn: noop, error: noop, captureError: noop };
}

/** The production dependency binding, mirrored here: reads bound to this test's db, writes to the growth slice's published doors. */
function growthDeps(): AdminGrowthDeps {
  return {
    growthCampaigns: {
      readWithinTx: async (tx, tag) => {
        const rows = await tx
          .select({
            tag: campaigns.tag,
            label: campaigns.label,
            status: campaigns.status,
            createdAt: campaigns.createdAt,
          })
          .from(campaigns)
          .where(eq(campaigns.tag, tag))
          .for('update');
        return rows[0] ?? null;
      },
      createWithinTx: (tx, campaign) => createCampaignWithinTx(tx, campaign),
      archiveWithinTx: (tx, tag) => archiveCampaignWithinTx(tx, tag),
    },
    growthReads: {
      marketing: (args) => growthReads.readMarketing(db, args),
      funnelWeeks: (args) => growthReads.readFunnelWeeks(db, args),
      acquisitionSources: (args) => growthReads.readAcquisitionSources(db, args),
      campaigns: () => growthReads.readCampaigns(db),
      hourlyEvents: (args) => growthReads.readHourlyEvents(db, args),
      pathReach: (args) => growthReads.readPathReach(db, args),
      newestBuckets: () => growthReads.readNewestBuckets(db),
    },
  };
}

interface GrowthHarness extends AdminOpHarnessInstance {
  readonly prefix: string;
  readonly deps: AdminGrowthDeps;
}

async function createGrowthHarness(
  options: { hooks?: AdminOpEngineHooks; seedTag?: string; deps?: AdminGrowthDeps } = {}
): Promise<GrowthHarness> {
  const prefix = newPrefix();
  const actor = `admin-growth-test-${crypto.randomUUID()}@hushbox.ai`;
  const deps = options.deps ?? growthDeps();
  if (options.seedTag !== undefined) {
    await db
      .insert(campaigns)
      .values({ tag: `${prefix}${options.seedTag}`, label: 'Seeded campaign', status: 'active' });
  }
  const engine = createAdminOpEngine({
    db,
    registry: createAdminOpRegistry<AdminGrowthDeps>([...adminGrowthOperations]),
    stores: adminStores,
    telemetry: noopTelemetry(),
    opDeps: deps,
    postDeps: {},
    executorId: `admin-growth-test-${crypto.randomUUID()}`,
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  });
  return {
    engine,
    actor,
    prefix,
    deps,
    /**
     * The Iron Law projection: the ACTIVE campaigns this harness owns, with the
     * prefix stripped so a control harness and an op harness are comparable. An
     * archived row and no row at all are the same effective state — an archived
     * tag names no running campaign — which is what lets create and archive be
     * mutual inverses without either destroying a row.
     */
    projection: async (): Promise<readonly { tag: string; label: string }[]> => {
      const rows = await db
        .select({ tag: campaigns.tag, label: campaigns.label, status: campaigns.status })
        .from(campaigns)
        .where(like(campaigns.tag, `${prefix}%`));
      return rows
        .filter((row) => row.status === 'active')
        .map((row) => ({ tag: row.tag.slice(prefix.length), label: row.label }))
        .toSorted((a, b) => a.tag.localeCompare(b.tag));
    },
    auditCount: async (): Promise<number> => {
      const rows = await db
        .select({ id: adminAudit.id })
        .from(adminAudit)
        .where(eq(adminAudit.actor, actor));
      return rows.length;
    },
  };
}

/**
 * The interleaving `U₁…Uₙ` action: another campaign is minted while the op's
 * own campaign stands. Its tag comes from the seeded stream, so the control
 * run and the op run mint exactly the same set — the only difference left
 * between the two projections is the op's own delta, which is what the Iron
 * Law measures.
 */
const campaignInterleavingActions: readonly AdminOpInterleavingAction[] = [
  {
    name: 'another-campaign-is-minted',
    run: async (harness, rng): Promise<void> => {
      const tag = `${(harness as GrowthHarness).prefix}u${String(Math.floor(rng() * 1_000_000))}`;
      await db
        .insert(campaigns)
        .values({ tag, label: 'Unrelated campaign', status: 'active' })
        .onConflictDoNothing();
    },
  },
];

const CREATE_CONTRACT = ADMIN_OP_CONTRACTS['growth.campaign.create'];
const ARCHIVE_CONTRACT = ADMIN_OP_CONTRACTS['growth.campaign.archive'];

const createTarget = { prefix: '' };
describeAdminOp({
  contract: CREATE_CONTRACT,
  createHarness: async (options) => {
    const harness = await createGrowthHarness(options);
    createTarget.prefix = harness.prefix;
    return harness;
  },
  validInput: () => ({
    tag: `${createTarget.prefix}minted`,
    label: 'Minted campaign',
    reason: 'launching a campaign',
  }),
  invalidInput: { tag: 'Not A Tag', label: 'Minted campaign', reason: 'x' },
  interleaving: {
    seeds: [7, 23, 91],
    stepsPerSeed: 4,
    opInput: (harness) => ({
      tag: `${(harness as GrowthHarness).prefix}minted`,
      label: 'Minted campaign',
      reason: 'interleaving mint',
    }),
    actions: campaignInterleavingActions,
  },
});

const archiveTarget = { prefix: '' };
describeAdminOp({
  contract: ARCHIVE_CONTRACT,
  createHarness: async (options) => {
    const harness = await createGrowthHarness({ ...options, seedTag: 'retiring' });
    archiveTarget.prefix = harness.prefix;
    return harness;
  },
  validInput: () => ({ tag: `${archiveTarget.prefix}retiring`, reason: 'campaign is over' }),
  invalidInput: { tag: 'Not A Tag', reason: 'x' },
  interleaving: {
    seeds: [11, 37, 83],
    stepsPerSeed: 4,
    opInput: (harness) => ({
      tag: `${(harness as GrowthHarness).prefix}retiring`,
      reason: 'interleaving retire',
    }),
    actions: campaignInterleavingActions,
  },
});

const WINDOW = { from: isoAt(TEST_DAY_START), to: isoAt(TEST_DAY_START + DAY_MS) };
/** Wide enough to hold an account created now, whatever day the suite runs on. */
const WIDE_WINDOW = {
  from: isoAt(TEST_DAY_START),
  to: isoAt(TEST_DAY_START + MAX_GROWTH_READ_WINDOW_DAYS * DAY_MS),
};
/** An hour no other suite writes a visitor bucket into: the marketing read needs one row of its own. */
const VISITOR_BUCKET = new Date(TEST_DAY_START - 400 * DAY_MS);
const seededVisitorBuckets: Date[] = [];

const seededUserIds: string[] = [];

/**
 * One account, with or without an answer to the channel question. The unanswered
 * shape is the one the column check demands: channel, context and the answered
 * moment are all null together, and the read falls back to the campaign for the
 * primary source.
 */
async function seedAccountSource(campaign: string, channel: 'podcast' | null): Promise<string> {
  const inserted = await db.insert(users).values(userFactory.build()).returning({ id: users.id });
  const user = inserted[0];
  if (user === undefined) throw new Error('growth harness: user insert returned no row');
  await db.insert(userAcquisition).values({
    userId: user.id,
    campaign,
    platform: 'web',
    selfReportedChannel: channel,
    ...(channel === null
      ? {}
      : { selfReportedContext: 'post_signup' as const, selfReportedAt: new Date(TEST_DAY_START) }),
  });
  return user.id;
}
const BAD_WINDOW = { from: 'not-a-date', to: isoAt(TEST_DAY_START) };

describeAdminOp({
  contract: ADMIN_OP_CONTRACTS['growth.funnel.read'],
  createHarness: (options) => createGrowthHarness(options),
  validInput: () => ({ ...WINDOW }),
  invalidInput: BAD_WINDOW,
});

describeAdminOp({
  contract: ADMIN_OP_CONTRACTS['growth.marketing.read'],
  createHarness: (options) => createGrowthHarness(options),
  validInput: () => ({ ...WINDOW, grain: 'day' }),
  invalidInput: { ...WINDOW, grain: 'century' },
});

describeAdminOp({
  contract: ADMIN_OP_CONTRACTS['growth.sources.read'],
  createHarness: (options) => createGrowthHarness(options),
  validInput: () => ({ ...WINDOW }),
  invalidInput: BAD_WINDOW,
});

describeAdminOp({
  contract: ADMIN_OP_CONTRACTS['growth.campaigns.read'],
  createHarness: (options) => createGrowthHarness(options),
  validInput: () => ({}),
  invalidInput: { from: 5 },
});

describeAdminOp({
  contract: ADMIN_OP_CONTRACTS['growth.events.read'],
  createHarness: (options) => createGrowthHarness(options),
  validInput: () => ({ ...WINDOW }),
  invalidInput: { ...WINDOW, page: -1 },
});

describeAdminOp({
  contract: ADMIN_OP_CONTRACTS['growth.freshness.read'],
  createHarness: (options) => createGrowthHarness(options),
  validInput: () => ({}),
  invalidInput: { from: 5 },
});

describeAdminOp({
  contract: ADMIN_OP_CONTRACTS['growth.reach.read'],
  createHarness: (options) => createGrowthHarness(options),
  validInput: () => ({ ...WINDOW }),
  invalidInput: BAD_WINDOW,
});

function runRead(
  harness: GrowthHarness,
  name: string,
  input: Record<string, unknown>
): ReturnType<GrowthHarness['engine']['read']> {
  return harness.engine.read({ name, input, actor: harness.actor, role: 'growth-viewer' });
}

function runMutation(
  harness: GrowthHarness,
  name: string,
  input: Record<string, unknown>
): ReturnType<GrowthHarness['engine']['run']> {
  return harness.engine.run({
    name,
    input,
    actor: harness.actor,
    role: 'operator',
    mode: 'execute',
    idempotencyKey: crypto.randomUUID(),
  });
}

describe('the growth reads', () => {
  it('answers the funnel read with the ladder for the campaign it counted', async () => {
    const harness = await createGrowthHarness();
    const tag = `${harness.prefix}funnel`;
    await db.insert(campaigns).values({ tag, label: 'Funnel campaign', status: 'active' });
    await db.insert(growthCampaignPaths).values({
      grain: 'day',
      bucket: new Date(TEST_DAY_START),
      campaign: tag,
      path: '/welcome',
      visitors: 6,
    });

    // The ladder buckets by week, and the week containing the seeded day
    // starts before it, so the window has to reach back past that boundary.
    const result = await runRead(harness, 'growth.funnel.read', {
      from: isoAt(TEST_DAY_START - 7 * DAY_MS),
      to: isoAt(TEST_DAY_START + DAY_MS),
      campaign: tag,
    });

    const panel = growthFunnelReadSchema.parse(result._unsafeUnwrap().data).panels.funnel;
    // Six is this campaign's busiest page on the seeded day, and the week sums
    // that one bucket: the visitors step is a lower bound, not a weekly unique,
    // which is what {@link ADMIN_OP_CONTRACTS} tells the operator about this read.
    expect(panel.ok && panel.data.weeks.map((week) => week.visitorsDailySummed)).toEqual([6]);
    expect(panel.ok && panel.data.weeks.map((week) => week.revenueNanoUsd)).toEqual(['0']);
  });

  it('forwards the ceiling flag of the rows a funnel week was built from', async () => {
    const harness = await createGrowthHarness();
    const tag = `${harness.prefix}floor`;
    await db.insert(campaigns).values({ tag, label: 'Floor campaign', status: 'active' });
    await db.insert(growthCampaignPaths).values({
      grain: 'day',
      bucket: new Date(TEST_DAY_START),
      campaign: tag,
      path: '/welcome',
      visitors: 6,
      overflow: true,
    });

    const result = await runRead(harness, 'growth.funnel.read', {
      from: isoAt(TEST_DAY_START - 7 * DAY_MS),
      to: isoAt(TEST_DAY_START + DAY_MS),
      campaign: tag,
    });

    const panel = growthFunnelReadSchema.parse(result._unsafeUnwrap().data).panels.funnel;
    expect(panel.ok && panel.data.weeks.map((week) => week.visitorsOverflow)).toEqual([true]);
  });

  it('forwards the ceiling flag an hour of registration starts latched', async () => {
    const harness = await createGrowthHarness();
    const tag = `${harness.prefix}starts`;
    await db.insert(campaigns).values({ tag, label: 'Capped starts', status: 'active' });
    await db.insert(growthHourlyFunnel).values({
      hour: new Date(TEST_DAY_START),
      campaign: tag,
      step: 'started',
      registrations: 4,
      overflow: true,
    });

    const result = await runRead(harness, 'growth.funnel.read', {
      from: isoAt(TEST_DAY_START - 7 * DAY_MS),
      to: isoAt(TEST_DAY_START + DAY_MS),
      campaign: tag,
    });

    const panel = growthFunnelReadSchema.parse(result._unsafeUnwrap().data).panels.funnel;
    expect(panel.ok && panel.data.weeks.map((week) => week.started)).toEqual([4]);
    expect(panel.ok && panel.data.weeks.map((week) => week.startedOverflow)).toEqual([true]);
  });

  it('answers the marketing read at the grain it was asked for', async () => {
    const harness = await createGrowthHarness();
    seededVisitorBuckets.push(VISITOR_BUCKET);
    await db
      .insert(growthVisitors)
      .values({ grain: 'hour', bucket: VISITOR_BUCKET, visitors: 3 })
      .onConflictDoNothing();

    const result = await runRead(harness, 'growth.marketing.read', {
      from: isoAt(VISITOR_BUCKET.getTime()),
      to: isoAt(VISITOR_BUCKET.getTime() + HOUR_MS),
      grain: 'hour',
    });

    const panel = growthMarketingReadSchema.parse(result._unsafeUnwrap().data).panels.marketing;
    expect(panel.ok && panel.data.grain).toBe('hour');
    expect(panel.ok && panel.data.rows.map((row) => row.family)).toContain('total');
  });

  it('answers the sources read with counted rows carrying no identifier', async () => {
    const harness = await createGrowthHarness();

    const result = await runRead(harness, 'growth.sources.read', WINDOW);

    const parsed = growthSourcesReadSchema.parse(result._unsafeUnwrap().data);
    expect(parsed.panels.sources.ok).toBe(true);
    expect(JSON.stringify(parsed)).not.toContain('userId');
  });

  it('lists the campaign a create minted, archived rows included', async () => {
    const harness = await createGrowthHarness();
    const tag = `${harness.prefix}listed`;
    const minted = await runMutation(harness, 'growth.campaign.create', {
      tag,
      label: 'Listed campaign',
      reason: 'seed the list',
    });
    minted._unsafeUnwrap();

    const result = await runRead(harness, 'growth.campaigns.read', {});

    const parsed = growthCampaignsReadSchema.parse(result._unsafeUnwrap().data);
    const panel = parsed.panels.campaigns;
    expect(panel.ok && panel.data.rows.some((row) => row.tag === tag)).toBe(true);
  });

  it('answers the events read with the first page and its size', async () => {
    const harness = await createGrowthHarness();

    const result = await runRead(harness, 'growth.events.read', WINDOW);

    const parsed = growthEventsReadSchema.parse(result._unsafeUnwrap().data);
    expect(parsed.panels.events.ok && parsed.panels.events.data.pageSize).toBe(
      GROWTH_EVENTS_PAGE_SIZE
    );
    expect(parsed.panels.events.ok && parsed.panels.events.data.hasMore).toBe(false);
  });

  it('counts accounts that named the same source into one row', async () => {
    const harness = await createGrowthHarness();
    // A tag of this harness's own. The read groups by creation week, campaign,
    // channel and context, while this lookup matches on two of those, so an
    // exact count under a tag anything else writes — the development seed
    // populates the direct-traffic sentinel — would count rows this case never
    // created.
    const campaign = `${harness.prefix}sources`;
    await db
      .insert(campaigns)
      .values({ tag: campaign, label: 'Sources campaign', status: 'active' });
    const seeded = await Promise.all([
      seedAccountSource(campaign, 'podcast'),
      seedAccountSource(campaign, 'podcast'),
      seedAccountSource(campaign, null),
    ]);
    seededUserIds.push(...seeded);

    const result = await runRead(harness, 'growth.sources.read', WIDE_WINDOW);

    const panel = growthSourcesReadSchema.parse(result._unsafeUnwrap().data).panels.sources;
    const rowFor = (channel: string | null): number | undefined =>
      panel.ok
        ? panel.data.rows.find(
            (row) => row.selfReportedChannel === channel && row.campaign === campaign
          )?.accounts
        : undefined;

    expect(rowFor('podcast')).toBe(2);
    // An account that answered nothing counts under the campaign instead, which
    // is what the primary source falls back to.
    expect(rowFor(null)).toBe(1);
  });

  it('filters named events by campaign and path, and pages what is left', async () => {
    const harness = await createGrowthHarness();
    const tag = `${harness.prefix}events`;
    await db.insert(campaigns).values({ tag, label: 'Events campaign', status: 'active' });
    await db.insert(growthHourlyEvents).values([
      {
        hour: new Date(TEST_DAY_START),
        campaign: tag,
        eventName: 'link:/signup',
        path: '/welcome',
        visitors: 4,
      },
      {
        hour: new Date(TEST_DAY_START + HOUR_MS),
        campaign: tag,
        eventName: 'link:/signup',
        path: '/privacy',
        visitors: 2,
      },
    ]);

    const filtered = await runRead(harness, 'growth.events.read', {
      ...WINDOW,
      campaign: tag,
      path: '/welcome',
    });
    const secondPage = await runRead(harness, 'growth.events.read', {
      ...WINDOW,
      campaign: tag,
      page: 1,
    });

    const filteredPanel = growthEventsReadSchema.parse(filtered._unsafeUnwrap().data).panels.events;
    expect(filteredPanel.ok && filteredPanel.data.rows.map((row) => row.path)).toEqual([
      '/welcome',
    ]);
    const pagedPanel = growthEventsReadSchema.parse(secondPage._unsafeUnwrap().data).panels.events;
    expect(pagedPanel.ok && pagedPanel.data.page).toBe(1);
    expect(pagedPanel.ok && pagedPanel.data.rows).toEqual([]);
  });

  it('answers the reach read with each pair summed over the days it was counted on', async () => {
    const harness = await createGrowthHarness();
    const landing = `/${harness.prefix}land`;
    const reached = `/${harness.prefix}reached`;
    await db.insert(growthDailyPathReach).values([
      {
        day: growthDayBucket(new Date(TEST_DAY_START)),
        landingPath: landing,
        reachedPath: reached,
        visitors: 3,
        overflow: true,
      },
      {
        day: growthDayBucket(new Date(TEST_DAY_START + DAY_MS)),
        landingPath: landing,
        reachedPath: reached,
        visitors: 4,
      },
    ]);

    const result = await runRead(harness, 'growth.reach.read', {
      from: isoAt(TEST_DAY_START),
      to: isoAt(TEST_DAY_START + 2 * DAY_MS),
    });

    const panel = growthReachReadSchema.parse(result._unsafeUnwrap().data).panels.reach;
    // One of the two days it sums was a floor, so the sum is one too and the
    // row says so — the operation forwards the mark rather than reducing the
    // figure to a number that looks exact.
    expect(panel.ok && panel.data.rows.filter((row) => row.landingPath === landing)).toEqual([
      { landingPath: landing, reachedPath: reached, visitorsDailySummed: 7, overflow: true },
    ]);
  });

  // Two landings each with their own reached page: the cross product is two
  // pairs wider than the table, and the read must report neither of them.
  it('reports no row for a landing→reached pair the table does not hold', async () => {
    const harness = await createGrowthHarness();
    const day = growthDayBucket(new Date(TEST_DAY_START));
    const first = { landing: `/${harness.prefix}one`, reached: `/${harness.prefix}saw-one` };
    const second = { landing: `/${harness.prefix}two`, reached: `/${harness.prefix}saw-two` };
    await db.insert(growthDailyPathReach).values([
      { day, landingPath: first.landing, reachedPath: first.reached, visitors: 3 },
      { day, landingPath: second.landing, reachedPath: second.reached, visitors: 5 },
    ]);

    const result = await runRead(harness, 'growth.reach.read', WINDOW);

    const panel = growthReachReadSchema.parse(result._unsafeUnwrap().data).panels.reach;
    expect(
      panel.ok &&
        panel.data.rows
          .filter((row) => row.landingPath.startsWith(`/${harness.prefix}`))
          .map((row) => `${row.landingPath} ${row.reachedPath}`)
    ).toEqual([`${first.landing} ${first.reached}`, `${second.landing} ${second.reached}`]);
  });

  it('filters the funnel by campaign', async () => {
    const harness = await createGrowthHarness();

    const result = await runRead(harness, 'growth.funnel.read', {
      ...WINDOW,
      campaign: `${harness.prefix}none`,
    });

    const panel = growthFunnelReadSchema.parse(result._unsafeUnwrap().data).panels.funnel;
    expect(panel.ok && panel.data.weeks).toEqual([]);
  });

  it('refuses a window wider than the cap, before it reads anything', async () => {
    const harness = await createGrowthHarness();

    const result = await runRead(harness, 'growth.funnel.read', {
      from: isoAt(TEST_DAY_START),
      to: isoAt(TEST_DAY_START + (MAX_GROWTH_READ_WINDOW_DAYS + 1) * DAY_MS),
    });

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it.each([
    ['growth.marketing.read', { grain: 'day' }],
    ['growth.sources.read', {}],
    ['growth.events.read', {}],
    ['growth.reach.read', {}],
  ])('refuses an over-wide window on %s too', async (name, extra) => {
    const harness = await createGrowthHarness();

    const result = await runRead(harness, name, {
      from: isoAt(TEST_DAY_START),
      to: isoAt(TEST_DAY_START + (MAX_GROWTH_READ_WINDOW_DAYS + 1) * DAY_MS),
      ...extra,
    });

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('refuses a window whose end precedes its start', async () => {
    const harness = await createGrowthHarness();

    const result = await runRead(harness, 'growth.funnel.read', {
      from: isoAt(TEST_DAY_START + DAY_MS),
      to: isoAt(TEST_DAY_START),
    });

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('shows one panel unavailable while the others answer', async () => {
    const failing = growthDeps();
    const harness = await createGrowthHarness({
      deps: {
        growthCampaigns: failing.growthCampaigns,
        growthReads: {
          ...failing.growthReads,
          campaigns: () => errAsync(unavailableError('growth campaign list read failed')),
        },
      },
    });

    const campaignsResult = await runRead(harness, 'growth.campaigns.read', {});
    const funnelResult = await runRead(harness, 'growth.funnel.read', WINDOW);

    // The failing read still answers 200 with its own panel marked unavailable,
    // which is what leaves the rest of the dashboard rendered.
    const campaignsPanel = growthCampaignsReadSchema.parse(campaignsResult._unsafeUnwrap().data)
      .panels.campaigns;
    expect(campaignsPanel).toEqual({ ok: false, error: 'unavailable' });
    expect(growthFunnelReadSchema.parse(funnelResult._unsafeUnwrap().data).panels.funnel.ok).toBe(
      true
    );
  });
});

describe('the campaign pair', () => {
  it('mints a campaign and records the tag as the archive’s input', async () => {
    const harness = await createGrowthHarness();
    const tag = `${harness.prefix}fresh`;

    const result = await runMutation(harness, 'growth.campaign.create', {
      tag,
      label: 'Fresh campaign',
      reason: 'new campaign',
    });

    const run = result._unsafeUnwrap();
    expect(run.effects).toEqual([
      { label: 'growth.campaign.status', before: null, after: 'active' },
    ]);
    expect(run.inverseInput).toEqual({ tag });
    expect(await harness.projection()).toEqual([{ tag: 'fresh', label: 'Fresh campaign' }]);
  });

  it('returns a tag the archive retired to active, which is what makes the pair inverse', async () => {
    const harness = await createGrowthHarness({ seedTag: 'again' });
    const tag = `${harness.prefix}again`;
    const retired = await runMutation(harness, 'growth.campaign.archive', { tag, reason: 'over' });
    retired._unsafeUnwrap();

    const result = await runMutation(harness, 'growth.campaign.create', {
      tag,
      label: 'Seeded campaign',
      reason: 'running it again',
    });

    expect(result._unsafeUnwrap().effects).toEqual([
      { label: 'growth.campaign.status', before: 'archived', after: 'active' },
    ]);
    expect(await harness.projection()).toEqual([{ tag: 'again', label: 'Seeded campaign' }]);
  });

  it('refuses a tag an active campaign already holds', async () => {
    const harness = await createGrowthHarness({ seedTag: 'taken' });

    const result = await runMutation(harness, 'growth.campaign.create', {
      tag: `${harness.prefix}taken`,
      label: 'Another label',
      reason: 'clash',
    });

    expect(result._unsafeUnwrapErr().code).toBe('conflict');
  });

  it('refuses a tag shaped like a per-person identifier', async () => {
    const harness = await createGrowthHarness();

    const result = await runMutation(harness, 'growth.campaign.create', {
      tag: crypto.randomUUID(),
      label: 'Per person',
      reason: 'should refuse',
    });

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('refuses a label one character past the bound, at the boundary rather than at the column', async () => {
    const harness = await createGrowthHarness();

    const result = await runMutation(harness, 'growth.campaign.create', {
      tag: `${harness.prefix}toolong`,
      label: 'a'.repeat(GROWTH_CAMPAIGN_LABEL_MAX_LENGTH + 1),
      reason: 'should refuse',
    });

    expect(result._unsafeUnwrapErr().code).toBe('validation');
    expect(await harness.projection()).toEqual([]);
  });

  it('records the retired campaign’s label so the create that undoes it restores that label', async () => {
    const harness = await createGrowthHarness({ seedTag: 'labelled' });
    const tag = `${harness.prefix}labelled`;

    const result = await runMutation(harness, 'growth.campaign.archive', { tag, reason: 'over' });

    expect(result._unsafeUnwrap().inverseInput).toEqual({ tag, label: 'Seeded campaign' });
  });

  it('refuses to retire a campaign already retired', async () => {
    const harness = await createGrowthHarness({ seedTag: 'twice' });
    const tag = `${harness.prefix}twice`;
    const retired = await runMutation(harness, 'growth.campaign.archive', { tag, reason: 'over' });
    retired._unsafeUnwrap();

    const result = await runMutation(harness, 'growth.campaign.archive', { tag, reason: 'again' });

    expect(result._unsafeUnwrapErr().code).toBe('conflict');
  });

  it('refuses to retire a tag no campaign holds', async () => {
    const harness = await createGrowthHarness();

    const result = await runMutation(harness, 'growth.campaign.archive', {
      tag: `${harness.prefix}absent`,
      reason: 'over',
    });

    expect(result._unsafeUnwrapErr().code).toBe('not_found');
  });

  it('refuses to retire a seeded tag every growth row folds to', async () => {
    const harness = await createGrowthHarness();

    const result = await runMutation(harness, 'growth.campaign.archive', {
      tag: 'unknown',
      reason: 'over',
    });

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });
});

describe('the campaign mutations cannot be widened to the read-only role', () => {
  it('throws when the minting contract is defined with the viewer role', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'growth.campaign.create',
        title: 'Create campaign',
        kind: 'mutation',
        input: z.object({ tag: z.string(), label: z.string(), reason: z.string().trim().min(1) }),
        inverse: 'growth.campaign.archive',
        effectClass: 'durable',
        target: { type: 'campaign', field: 'tag' },
        allowedRoles: ['operator', 'growth-viewer'],
      })
    ).toThrow(/growth-viewer/);
  });

  it('leaves the registered contract operator-only', () => {
    expect(CREATE_CONTRACT.allowedRoles).toEqual(['operator']);
    expect(ARCHIVE_CONTRACT.allowedRoles).toEqual(['operator']);
  });
});

describe('the campaign ops are registered as a mutually inverse pair', () => {
  it('registers each as the other’s inverse', () => {
    const registry = createAdminOpRegistry<AdminGrowthDeps>([...adminGrowthOperations]);

    expect(registry.get('growth.campaign.create')?.contract.inverse).toBe(
      'growth.campaign.archive'
    );
    expect(registry.get('growth.campaign.archive')?.contract.inverse).toBe(
      'growth.campaign.create'
    );
  });

  // Derived from the contracts rather than counted, so a growth read added to
  // the inventory and left out of this family reds here.
  it('registers a read body for every growth read the inventory declares', () => {
    const registry = createAdminOpRegistry<AdminGrowthDeps>([...adminGrowthOperations]);
    const declared = ADMIN_OP_NAMES.filter(
      (name) => name.startsWith('growth.') && ADMIN_OP_CONTRACTS[name].kind === 'read'
    );

    expect(
      registry
        .list()
        .filter((contract) => contract.kind === 'read')
        .map((contract) => contract.name)
        .toSorted((a, b) => a.localeCompare(b))
    ).toEqual([...declared].toSorted((a, b) => a.localeCompare(b)));
  });
});

describe('the growth freshness read', () => {
  /** A door answering with fixed newest buckets, so a case measures the op's own mapping. */
  function freshnessDeps(buckets: GrowthNewestBuckets): AdminGrowthDeps {
    const real = growthDeps();
    return {
      growthCampaigns: real.growthCampaigns,
      growthReads: { ...real.growthReads, newestBuckets: () => okAsync(buckets) },
    };
  }

  it('answers the day each data set’s newest bucket falls in', async () => {
    const harness = await createGrowthHarness({
      deps: freshnessDeps({
        funnel: { grain: 'week', weekOpening: new Date(TEST_DAY_START) },
        sources: { grain: 'week', weekOpening: new Date(TEST_DAY_START - 7 * DAY_MS) },
        marketing: {
          grain: 'day',
          runsThrough: new Date(TEST_DAY_START + DAY_MS + 22 * HOUR_MS),
        },
        events: { grain: 'day', runsThrough: new Date(TEST_DAY_START + 2 * DAY_MS + 3 * HOUR_MS) },
      }),
    });

    const result = await runRead(harness, 'growth.freshness.read', {});

    const panel = growthFreshnessReadSchema.parse(result._unsafeUnwrap().data).panels.freshness;
    expect(panel.ok && panel.data).toEqual({
      funnel: { grain: 'week', weekOpening: growthDayBucket(new Date(TEST_DAY_START)) },
      sources: {
        grain: 'week',
        weekOpening: growthDayBucket(new Date(TEST_DAY_START - 7 * DAY_MS)),
      },
      marketing: {
        grain: 'day',
        runsThrough: growthDayBucket(new Date(TEST_DAY_START + DAY_MS)),
      },
      events: { grain: 'day', runsThrough: growthDayBucket(new Date(TEST_DAY_START + 2 * DAY_MS)) },
    });
  });

  it('answers no day at all for a data set holding nothing', async () => {
    const harness = await createGrowthHarness({
      deps: freshnessDeps({
        funnel: { grain: 'week', weekOpening: new Date(TEST_DAY_START) },
        sources: null,
        marketing: null,
        events: null,
      }),
    });

    const result = await runRead(harness, 'growth.freshness.read', {});

    const panel = growthFreshnessReadSchema.parse(result._unsafeUnwrap().data).panels.freshness;
    expect(panel.ok && panel.data).toEqual({
      funnel: { grain: 'week', weekOpening: growthDayBucket(new Date(TEST_DAY_START)) },
      sources: null,
      marketing: null,
      events: null,
    });
  });

  it('answers the same whether or not a caller sends a window', async () => {
    const harness = await createGrowthHarness();

    const unnarrowed = await runRead(harness, 'growth.freshness.read', {});
    const withAWindow = await runRead(harness, 'growth.freshness.read', {
      ...WINDOW,
      campaign: `${harness.prefix}funnel`,
      grain: 'hour',
    });

    expect(growthFreshnessReadSchema.parse(withAWindow._unsafeUnwrap().data)).toEqual(
      growthFreshnessReadSchema.parse(unnarrowed._unsafeUnwrap().data)
    );
  });

  it('degrades to the panel’s own error when the read fails', async () => {
    const real = growthDeps();
    const harness = await createGrowthHarness({
      deps: {
        growthCampaigns: real.growthCampaigns,
        growthReads: {
          ...real.growthReads,
          newestBuckets: () => errAsync(unavailableError('growth is down')),
        },
      },
    });

    const result = await runRead(harness, 'growth.freshness.read', {});

    const panel = growthFreshnessReadSchema.parse(result._unsafeUnwrap().data).panels.freshness;
    expect(panel).toEqual({ ok: false, error: 'unavailable' });
  });
});
