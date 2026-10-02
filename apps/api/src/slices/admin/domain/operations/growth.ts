import {
  ADMIN_OP_CONTRACTS,
  GROWTH_EVENTS_PAGE_SIZE,
  MAX_GROWTH_READ_WINDOW_DAYS,
  growthDayBucket,
} from '@hushbox/shared';
import { conflictError, notFoundError, validationError } from '../../../../lib/errors/index.js';
import { err, ok } from '../../../../lib/result/index.js';
import { defineAdminOp, defineAdminReadOp } from '../registry.js';
import type {
  GrowthCampaignsRead,
  GrowthEventsRead,
  GrowthFreshnessRead,
  GrowthFunnelRead,
  GrowthGrain,
  GrowthMarketingRead,
  GrowthNewestDayWire,
  GrowthReachRead,
  GrowthSourceCountWire,
  GrowthSourcesRead,
} from '@hushbox/shared';
import type {
  AcquisitionSourceRow,
  CampaignRow,
  FunnelWeekRow,
  GrowthNewestBucket,
  GrowthNewestBuckets,
  HourlyEventRow,
  MarketingRow,
  PathReachRow,
} from '../../../growth/index.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { SettlementTx } from '../../../../lib/idempotency/index.js';
import type { Result, ResultAsync } from '../../../../lib/result/index.js';

/**
 * The growth operations: the reads the Growth dashboard composes, and the
 * campaign pair that mints and retires the tags every growth row references.
 *
 * The reads degrade per panel rather than failing: an infrastructure failure
 * lands in the panel as its error code, inside a run that still succeeds, so a
 * dashboard shows one panel unavailable instead of nothing (the Customer-360
 * pattern). What refuses the whole run is what the reader got wrong — an
 * unordered or over-wide window — never what a dependency did.
 */

/** A half-open window `[from, to)`, as the growth reads take one. */
interface ReadWindow {
  readonly from: Date;
  readonly to: Date;
}

/** The growth slice's published campaign doors, bound at composition. */
export interface AdminGrowthCampaignDoor {
  /**
   * The campaign a tag names, read on the caller's transaction and locked for
   * the rest of it. The lock is what makes the status decision below atomic:
   * without it two operators archiving one tag would both read `active`, and
   * the loser would record an act it did not perform and an undo that would
   * undo the winner's.
   */
  readWithinTx(tx: SettlementTx, tag: string): Promise<CampaignRow | null>;
  createWithinTx(
    tx: SettlementTx,
    campaign: { readonly tag: string; readonly label: string }
  ): ResultAsync<CampaignRow, DomainError>;
  archiveWithinTx(tx: SettlementTx, tag: string): ResultAsync<CampaignRow, DomainError>;
}

/** The growth slice's published reads, bound to a database handle at composition. */
export interface AdminGrowthReadDoor {
  marketing(
    args: ReadWindow & { readonly grain: GrowthGrain }
  ): ResultAsync<readonly MarketingRow[], DomainError>;
  funnelWeeks(
    args: ReadWindow & { readonly campaign?: string }
  ): ResultAsync<readonly FunnelWeekRow[], DomainError>;
  acquisitionSources(args: ReadWindow): ResultAsync<readonly AcquisitionSourceRow[], DomainError>;
  campaigns(): ResultAsync<readonly CampaignRow[], DomainError>;
  hourlyEvents(
    args: ReadWindow & { readonly campaign?: string; readonly path?: string }
  ): ResultAsync<readonly HourlyEventRow[], DomainError>;
  pathReach(args: ReadWindow): ResultAsync<readonly PathReachRow[], DomainError>;
  /**
   * The newest bucket each dated set holds, over the whole of that set. It
   * takes no window, which is the point of it: the dashboard's currency line
   * must not move when the operator narrows what the panels show.
   */
  newestBuckets(): ResultAsync<GrowthNewestBuckets, DomainError>;
}

export interface AdminGrowthDeps {
  readonly growthCampaigns: AdminGrowthCampaignDoor;
  readonly growthReads: AdminGrowthReadDoor;
}

const MAX_WINDOW_MS = MAX_GROWTH_READ_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * The window every read runs over. The contract has already proved both ends
 * are timestamps; what it cannot state without ceasing to be a flat object is
 * the relation between them, so the ordering and the width live here.
 */
function readWindow(input: {
  readonly from: string;
  readonly to: string;
}): Result<ReadWindow, DomainError> {
  const from = new Date(input.from);
  const to = new Date(input.to);
  if (to.getTime() < from.getTime()) {
    return err(validationError('growth read window ends before it starts'));
  }
  if (to.getTime() - from.getTime() > MAX_WINDOW_MS) {
    return err(validationError('growth read window is wider than the cap'));
  }
  return ok({ from, to });
}

/** One panel's outcome: what it loaded, or the code of the failure that stopped it. */
async function panelOf<T>(
  load: () => PromiseLike<Result<T, DomainError>>
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const result = await load();
  return result.match(
    (data): { ok: true; data: T } | { ok: false; error: string } => ({ ok: true, data }),
    (error): { ok: true; data: T } | { ok: false; error: string } => ({
      ok: false,
      error: error.code,
    })
  );
}

/**
 * The day a bucket falls in, or no day at all where the set held no bucket. The
 * bucket's own grain travels with it rather than being restated here: the
 * relation it came from is what decides whether the day opens a week or is the
 * day that set's data runs through, and only the adapter reading that relation
 * knows which.
 */
function dayOrNone(bucket: GrowthNewestBucket | null): GrowthNewestDayWire | null {
  if (bucket === null) return null;
  return bucket.grain === 'week'
    ? { ...bucket, weekOpening: growthDayBucket(bucket.weekOpening) }
    : { ...bucket, runsThrough: growthDayBucket(bucket.runsThrough) };
}

const freshnessContract = ADMIN_OP_CONTRACTS['growth.freshness.read'];
const funnelContract = ADMIN_OP_CONTRACTS['growth.funnel.read'];
const marketingContract = ADMIN_OP_CONTRACTS['growth.marketing.read'];
const sourcesContract = ADMIN_OP_CONTRACTS['growth.sources.read'];
const campaignsContract = ADMIN_OP_CONTRACTS['growth.campaigns.read'];
const eventsContract = ADMIN_OP_CONTRACTS['growth.events.read'];
const reachContract = ADMIN_OP_CONTRACTS['growth.reach.read'];
const createContract = ADMIN_OP_CONTRACTS['growth.campaign.create'];
const archiveContract = ADMIN_OP_CONTRACTS['growth.campaign.archive'];

/**
 * How current the growth data is: the newest day each dated set holds. It takes
 * no input, and an input is what it must never take — a figure a window could
 * move would measure the window rather than the data, and a reader cannot tell
 * the two readings apart.
 *
 * Day resolution is the ceiling, and each set's day carries the grain of the
 * relation it came from, so a reader cannot take a week's opening day for the
 * day that set's data runs through.
 */
export const growthFreshnessRead = defineAdminReadOp<
  AdminGrowthDeps,
  (typeof freshnessContract)['input'],
  GrowthFreshnessRead
>(freshnessContract, {
  read: async (ctx) => {
    const freshness = await panelOf(() =>
      ctx.deps.growthReads.newestBuckets().map((buckets) => ({
        funnel: dayOrNone(buckets.funnel),
        sources: dayOrNone(buckets.sources),
        marketing: dayOrNone(buckets.marketing),
        events: dayOrNone(buckets.events),
      }))
    );
    return ok({ panels: { freshness } });
  },
});

export const growthFunnelRead = defineAdminReadOp<
  AdminGrowthDeps,
  (typeof funnelContract)['input'],
  GrowthFunnelRead
>(funnelContract, {
  read: async (ctx, input) => {
    const window = readWindow(input);
    if (window.isErr()) return err(window.error);
    const funnel = await panelOf(() =>
      ctx.deps.growthReads
        .funnelWeeks({
          ...window.value,
          ...(input.campaign === undefined ? {} : { campaign: input.campaign }),
        })
        .map((rows) => ({
          weeks: rows.map((row) => ({
            week: row.week.toISOString(),
            campaign: row.campaign,
            visitorsDailySummed: row.visitorsDailySummed,
            visitorsOverflow: row.visitorsOverflow,
            productEntryClicksHourlySummed: row.productEntryClicksHourlySummed,
            productEntryClicksOverflow: row.productEntryClicksOverflow,
            started: row.started,
            startedOverflow: row.startedOverflow,
            finished: row.finished,
            verified: row.verified,
            activated: row.activated,
            returnedWeek1: row.returnedWeek1,
            firstPaid: row.firstPaid,
            revenueNanoUsd: row.revenueNanoUsd.toString(10),
          })),
        }))
    );
    return ok({ panels: { funnel } });
  },
});

export const growthMarketingRead = defineAdminReadOp<
  AdminGrowthDeps,
  (typeof marketingContract)['input'],
  GrowthMarketingRead
>(marketingContract, {
  read: async (ctx, input) => {
    const window = readWindow(input);
    if (window.isErr()) return err(window.error);
    const marketing = await panelOf(() =>
      ctx.deps.growthReads.marketing({ ...window.value, grain: input.grain }).map((rows) => ({
        grain: input.grain,
        rows: rows.map((row) => ({
          bucket: row.bucket.toISOString(),
          family: row.family,
          path: row.path,
          referrerHost: row.referrerHost,
          campaign: row.campaign,
          country: row.country,
          region: row.region,
          device: row.device,
          visitors: row.visitors,
          landings: row.landings,
          overflow: row.overflow,
        })),
      }))
    );
    return ok({ panels: { marketing } });
  },
});

/**
 * The acquisition view is one row per account, so the read counts rather than
 * forwards: the dashboard asks how many accounts named each source, and a row
 * per account would grow the response with the user base for a number nobody
 * reads at that grain.
 */
function countSources(rows: readonly AcquisitionSourceRow[]): GrowthSourceCountWire[] {
  const counts = new Map<string, GrowthSourceCountWire>();
  for (const row of rows) {
    const userCreatedWeek = row.userCreatedWeek.toISOString();
    const key = [
      userCreatedWeek,
      row.campaign,
      row.selfReportedChannel ?? '',
      row.selfReportedContext ?? '',
      row.primarySource,
      // A separator no dimension value can contain, so two different tuples
      // can never render to one key.
    ].join('\u0000');
    const seen = counts.get(key);
    if (seen === undefined) {
      counts.set(key, {
        userCreatedWeek,
        campaign: row.campaign,
        selfReportedChannel: row.selfReportedChannel,
        selfReportedContext: row.selfReportedContext,
        primarySource: row.primarySource,
        accounts: 1,
      });
      continue;
    }
    counts.set(key, { ...seen, accounts: seen.accounts + 1 });
  }
  return [...counts.values()];
}

export const growthSourcesRead = defineAdminReadOp<
  AdminGrowthDeps,
  (typeof sourcesContract)['input'],
  GrowthSourcesRead
>(sourcesContract, {
  read: async (ctx, input) => {
    const window = readWindow(input);
    if (window.isErr()) return err(window.error);
    const sources = await panelOf(() =>
      ctx.deps.growthReads
        .acquisitionSources(window.value)
        .map((rows) => ({ rows: countSources(rows) }))
    );
    return ok({ panels: { sources } });
  },
});

export const growthCampaignsRead = defineAdminReadOp<
  AdminGrowthDeps,
  (typeof campaignsContract)['input'],
  GrowthCampaignsRead
>(campaignsContract, {
  read: async (ctx) => {
    const campaigns = await panelOf(() =>
      ctx.deps.growthReads.campaigns().map((rows) => ({
        rows: rows.map((row) => ({
          tag: row.tag,
          label: row.label,
          status: row.status,
          createdAt: row.createdAt.toISOString(),
        })),
      }))
    );
    return ok({ panels: { campaigns } });
  },
});

export const growthEventsRead = defineAdminReadOp<
  AdminGrowthDeps,
  (typeof eventsContract)['input'],
  GrowthEventsRead
>(eventsContract, {
  read: async (ctx, input) => {
    const window = readWindow(input);
    if (window.isErr()) return err(window.error);
    const start = input.page * GROWTH_EVENTS_PAGE_SIZE;
    const events = await panelOf(() =>
      ctx.deps.growthReads
        .hourlyEvents({
          ...window.value,
          ...(input.campaign === undefined ? {} : { campaign: input.campaign }),
          ...(input.path === undefined ? {} : { path: input.path }),
        })
        .map((rows) => ({
          page: input.page,
          pageSize: GROWTH_EVENTS_PAGE_SIZE,
          hasMore: rows.length > start + GROWTH_EVENTS_PAGE_SIZE,
          rows: rows.slice(start, start + GROWTH_EVENTS_PAGE_SIZE).map((row) => ({
            hour: row.hour.toISOString(),
            campaign: row.campaign,
            eventName: row.eventName,
            path: row.path,
            visitors: row.visitors,
            overflow: row.overflow,
          })),
        }))
    );
    return ok({ panels: { events } });
  },
});

/**
 * The landing→reached pairs. The slice groups them, so this body forwards what
 * it is given: a pair the table holds no row for arrives absent and stays
 * absent, because nobody was counted making that journey and a zero would
 * claim they were.
 */
export const growthReachRead = defineAdminReadOp<
  AdminGrowthDeps,
  (typeof reachContract)['input'],
  GrowthReachRead
>(reachContract, {
  read: async (ctx, input) => {
    const window = readWindow(input);
    if (window.isErr()) return err(window.error);
    const reach = await panelOf(() =>
      ctx.deps.growthReads.pathReach(window.value).map((rows) => ({
        rows: rows.map((row) => ({
          landingPath: row.landingPath,
          reachedPath: row.reachedPath,
          visitorsDailySummed: row.visitorsDailySummed,
          overflow: row.overflow,
        })),
      }))
    );
    return ok({ panels: { reach } });
  },
});

/**
 * Minting a campaign. A tag an archive retired returns to active, which is what
 * makes this the archive's inverse; a tag an active campaign already holds is
 * refused, because a mint that changed nothing would still record an act whose
 * undo retires a campaign somebody else is running.
 */
export const growthCampaignCreate = defineAdminOp<
  AdminGrowthDeps,
  (typeof createContract)['input']
>(createContract, {
  execute: async (ctx, input) => {
    const standing = await ctx.deps.growthCampaigns.readWithinTx(ctx.tx, input.tag);
    if (standing !== null && standing.status === 'active') {
      return err(conflictError('an active campaign already holds this tag'));
    }
    const created = await ctx.deps.growthCampaigns.createWithinTx(ctx.tx, {
      tag: input.tag,
      label: input.label,
    });
    if (created.isErr()) return err(created.error);
    return ok({
      effects: [
        {
          label: 'growth.campaign.status',
          before: standing === null ? null : standing.status,
          after: created.value.status,
        },
      ],
      target: { type: 'campaign', id: input.tag },
      inverseInput: { tag: input.tag },
    });
  },
});

/**
 * Retiring a campaign. The row survives with its status changed — growth rows
 * are kept forever and their tag has to resolve — and the label is snapshotted
 * into the inverse input, so the create that undoes this restores the name the
 * campaign was running under rather than one typed at undo time.
 */
export const growthCampaignArchive = defineAdminOp<
  AdminGrowthDeps,
  (typeof archiveContract)['input']
>(archiveContract, {
  execute: async (ctx, input) => {
    const standing = await ctx.deps.growthCampaigns.readWithinTx(ctx.tx, input.tag);
    if (standing === null) return err(notFoundError('no campaign holds this tag'));
    if (standing.status === 'archived') {
      return err(conflictError('campaign is already archived'));
    }
    const archived = await ctx.deps.growthCampaigns.archiveWithinTx(ctx.tx, input.tag);
    if (archived.isErr()) return err(archived.error);
    return ok({
      effects: [
        {
          label: 'growth.campaign.status',
          before: standing.status,
          after: archived.value.status,
        },
      ],
      target: { type: 'campaign', id: input.tag },
      inverseInput: { tag: input.tag, label: standing.label },
    });
  },
});
