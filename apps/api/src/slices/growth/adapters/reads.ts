import { and, asc, desc, eq, gte, lt, sql } from 'drizzle-orm';
import {
  acquisitionSourcesView,
  anyOverflow,
  campaigns,
  funnelWeeklyView,
  growthDailyPathReach,
  growthHourlyEvents,
  marketingDailyView,
  marketingHourlyView,
} from '@hushbox/db';
import { unavailableError } from '../../../lib/errors/index.js';
import { growthDayBucket } from '../../../lib/redis/index.js';
import { fromPromise } from '../../../lib/result/index.js';
import type { SQL, SQLWrapper } from 'drizzle-orm';
import type { Database } from '@hushbox/db';
import type { GrowthGrain } from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/** One marketing marginal: a bucket, the family it belongs to, and only that family's dimensions. */
export type MarketingRow = typeof marketingHourlyView.$inferSelect;

/** One week of one campaign's ladder. Read {@link funnelWeeklyView} before acting on a row: the anonymous steps and the identified steps are bucketed differently. */
export type FunnelWeekRow = typeof funnelWeeklyView.$inferSelect;

/** One account's stated and recorded source, carrying no identifier. */
export type AcquisitionSourceRow = typeof acquisitionSourcesView.$inferSelect;

/**
 * One campaign as the admin plane lists it. The row's uuid is left behind: the
 * tag is what every growth row references and what the archive write names, so
 * nothing downstream has a use for the identifier.
 */
export type CampaignRow = Pick<
  typeof campaigns.$inferSelect,
  'tag' | 'label' | 'status' | 'createdAt'
>;

/** One named event's distinct visitors, for one campaign and page, in one hour. */
export type HourlyEventRow = Pick<
  typeof growthHourlyEvents.$inferSelect,
  'hour' | 'campaign' | 'eventName' | 'path' | 'visitors' | 'overflow'
>;

/**
 * One landing page paired with one page reached from it, over a window. The
 * figure sums each day's own distinct count, so a visitor who made the journey
 * on two days counts twice — the name says which bucketing produced it, the
 * way the weekly ladder's anonymous steps do.
 */
export interface PathReachRow {
  readonly landingPath: string;
  readonly reachedPath: string;
  readonly visitorsDailySummed: number;
  /**
   * Any day this figure sums hit a set ceiling, so the sum is a lower bound.
   * Reduced over the window's own days rather than the pair's whole history:
   * a day whose count was a floor says nothing about a window it is outside.
   * The reduction itself is {@link anyOverflow}, the one rule every ceiling
   * flag in this design combines by.
   */
  readonly overflow: boolean;
}

/**
 * One data set's newest bucket, under the grain of the relation it came from —
 * which decides what the bucket means. A week-grouped relation's newest bucket
 * is the instant its newest week *opens on*, which precedes the instant that
 * relation's data runs through; a relation grouped by a day or finer answers a
 * bucket its data does run through. Reading the first as the second understates
 * how current the set is, so the two carry different fields and a reader must
 * narrow on `grain` before it can reach either.
 */
export type GrowthNewestBucket =
  | { readonly grain: 'week'; readonly weekOpening: Date }
  | { readonly grain: 'day'; readonly runsThrough: Date };

/**
 * The newest bucket each growth data set holds, over the whole of that set —
 * no window narrows these. A set holding no rows has no newest bucket and
 * answers `null`, which is a different fact from any instant.
 *
 * The sets are the four the dashboard draws dated rows from, and each names
 * the relation its own read reaches: the weekly ladder, the acquisition view,
 * the marketing marginals at either grain, and the named-event hours.
 */
export interface GrowthNewestBuckets {
  readonly funnel: GrowthNewestBucket | null;
  readonly sources: GrowthNewestBucket | null;
  readonly marketing: GrowthNewestBucket | null;
  readonly events: GrowthNewestBucket | null;
}

/** A half-open window `[from, to)`, so consecutive windows neither overlap nor drop a bucket. */
interface Window {
  readonly from: Date;
  readonly to: Date;
}

/**
 * Which buckets a window holds: the one whose own start lies inside it. Every
 * read here that takes a window goes through this.
 *
 * The bounds are compared against `bucketStart` as it is stored, so a grain
 * stored coarser than an instant supplies bounds of its own kind rather than
 * casting its column up to one — {@link ceilDayUtc} is how the day grain does
 * that. Both ends share one type, because a window with ends of two kinds is
 * not a window.
 */
function withinWindow<TBound>(
  bucketStart: SQLWrapper,
  { from, to }: { readonly from: TBound; readonly to: TBound }
): SQL | undefined {
  return and(gte(bucketStart, from), lt(bucketStart, to));
}

/**
 * The first day bucket at or after an instant, in the form the `date` columns
 * store.
 *
 * Ceiling both ends of a window is {@link withinWindow}'s rule restated one
 * step earlier: a day belongs to the window when the day's own opening instant
 * does, and that instant rises with the day, so the days that satisfy it are
 * exactly the days at or after the first one whose opening instant reaches the
 * bound. Rounding the bound rather than casting the column leaves the
 * comparison a plain range over the stored value, which is what lets it
 * address the index the day column leads — and that index is the difference
 * between a cost bounded by the window cap and one that grows with everything
 * the table has ever held.
 */
function ceilDayUtc(instant: Date): string {
  const dayOpens =
    instant.getTime() ===
    Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate());
  return growthDayBucket(
    dayOpens
      ? instant
      : new Date(
          Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate() + 1)
        )
  );
}

/**
 * The day range the landing→reached read filters on. Exported so a test can
 * plan the read's own comparison instead of a copy of it: whether the range
 * addresses the index {@link growthDailyPathReach}'s day column leads is
 * decided by this expression and nothing else in the query. Comparing the
 * stored date against date bounds is what keeps it addressable — a cast
 * wrapping the column, to compare it against instants instead, is an
 * expression the index cannot answer.
 */
export function pathReachWindow({ from, to }: Window): SQL | undefined {
  return withinWindow(growthDailyPathReach.day, { from: ceilDayUtc(from), to: ceilDayUtc(to) });
}

/**
 * The growth slice's reads: the views the panels compose, and the growth-owned
 * tables no view carries. They live here rather than in `domain/` because they
 * build queries: an infra client and its operators belong to the adapter
 * layer.
 *
 * Every fact these answer is joined at query time out of the table that owns
 * it, so a refund posted to the ledger moves the next read's revenue and no
 * stored aggregate can disagree.
 */
export interface GrowthReads {
  readonly readMarketing: (
    db: Database,
    args: Window & { readonly grain: GrowthGrain }
  ) => ResultAsync<readonly MarketingRow[], DomainError>;
  readonly readFunnelWeeks: (
    db: Database,
    args: Window & { readonly campaign?: string }
  ) => ResultAsync<readonly FunnelWeekRow[], DomainError>;
  readonly readAcquisitionSources: (
    db: Database,
    args: Window
  ) => ResultAsync<readonly AcquisitionSourceRow[], DomainError>;
  /**
   * Every campaign, archived ones included: an archived tag still owns the
   * counts it collected while it ran, so a list that hid it would leave those
   * rows attributed to a tag the reader cannot see.
   */
  readonly readCampaigns: (db: Database) => ResultAsync<readonly CampaignRow[], DomainError>;
  readonly readHourlyEvents: (
    db: Database,
    args: Window & { readonly campaign?: string; readonly path?: string }
  ) => ResultAsync<readonly HourlyEventRow[], DomainError>;
  /**
   * The landing→reached pairs, grouped in the database rather than in the
   * caller: the pair is what the panel shows, and a row per pair per day would
   * make the response grow with the window instead of with the page set.
   *
   * A pair no day in the window holds produces no row. The daily counts are
   * distinct-visitor set cardinalities, so an absent pair means nobody was
   * counted making that journey — never a zero the read could invent for it.
   */
  readonly readPathReach: (
    db: Database,
    args: Window
  ) => ResultAsync<readonly PathReachRow[], DomainError>;
  /**
   * How current each data set is, as the newest bucket it holds. It takes no
   * window on purpose: a figure a window could move would measure the window
   * rather than the data, which is why this is a read of its own rather than a
   * maximum taken over the windowed reads.
   *
   * The marketing answer spans both grains, because the grain is a control
   * too — a set whose only recent row is a day bucket is no less current for
   * the reader having asked for hours.
   */
  readonly readNewestBuckets: (db: Database) => ResultAsync<GrowthNewestBuckets, DomainError>;
}

/**
 * The newest instant across the answers given, or `null` where none of them
 * held a row. One combiner for every set, so the absence of a bucket is
 * decided in a single place rather than once per relation.
 */
function newestInstant(...answers: readonly (readonly { readonly at: Date }[])[]): Date | null {
  const instants = answers.flatMap((rows) => rows.map((row) => row.at.getTime()));
  return instants.length === 0 ? null : new Date(Math.max(...instants));
}

/** A bucket from a relation grouped by week: it names the day that week opens on. */
function weekOpening(at: Date | null): GrowthNewestBucket | null {
  return at === null ? null : { grain: 'week', weekOpening: at };
}

/** A bucket from a relation grouped by a day or finer: its data runs through it. */
function runsThrough(at: Date | null): GrowthNewestBucket | null {
  return at === null ? null : { grain: 'day', runsThrough: at };
}

export function createGrowthReads(): GrowthReads {
  return {
    readMarketing(db, { grain, from, to }) {
      const view = grain === 'hour' ? marketingHourlyView : marketingDailyView;
      return fromPromise(
        db
          .select()
          .from(view)
          .where(withinWindow(view.bucket, { from, to }))
          .orderBy(asc(view.bucket), asc(view.family)),
        (cause) => unavailableError('growth marketing read failed', cause)
      );
    },

    readFunnelWeeks(db, { from, to, campaign }) {
      const window = withinWindow(funnelWeeklyView.week, { from, to });
      return fromPromise(
        db
          .select()
          .from(funnelWeeklyView)
          .where(
            campaign === undefined ? window : and(window, eq(funnelWeeklyView.campaign, campaign))
          )
          .orderBy(asc(funnelWeeklyView.week), asc(funnelWeeklyView.campaign)),
        (cause) => unavailableError('growth funnel read failed', cause)
      );
    },

    readCampaigns(db) {
      return fromPromise(
        db
          .select({
            tag: campaigns.tag,
            label: campaigns.label,
            status: campaigns.status,
            createdAt: campaigns.createdAt,
          })
          .from(campaigns)
          .orderBy(asc(campaigns.tag)),
        (cause) => unavailableError('growth campaign list read failed', cause)
      );
    },

    readHourlyEvents(db, { from, to, campaign, path }) {
      const filters = [withinWindow(growthHourlyEvents.hour, { from, to })];
      if (campaign !== undefined) filters.push(eq(growthHourlyEvents.campaign, campaign));
      if (path !== undefined) filters.push(eq(growthHourlyEvents.path, path));
      return fromPromise(
        db
          .select({
            hour: growthHourlyEvents.hour,
            campaign: growthHourlyEvents.campaign,
            eventName: growthHourlyEvents.eventName,
            path: growthHourlyEvents.path,
            visitors: growthHourlyEvents.visitors,
            overflow: growthHourlyEvents.overflow,
          })
          .from(growthHourlyEvents)
          .where(and(...filters))
          .orderBy(
            asc(growthHourlyEvents.hour),
            asc(growthHourlyEvents.eventName),
            asc(growthHourlyEvents.path)
          ),
        (cause) => unavailableError('growth hourly-event read failed', cause)
      );
    },

    readPathReach(db, { from, to }) {
      return fromPromise(
        db
          .select({
            landingPath: growthDailyPathReach.landingPath,
            reachedPath: growthDailyPathReach.reachedPath,
            visitorsDailySummed: sql<number>`sum(${growthDailyPathReach.visitors})`.mapWith(Number),
            overflow: anyOverflow(growthDailyPathReach.overflow),
          })
          .from(growthDailyPathReach)
          .where(pathReachWindow({ from, to }))
          .groupBy(growthDailyPathReach.landingPath, growthDailyPathReach.reachedPath)
          .orderBy(asc(growthDailyPathReach.landingPath), asc(growthDailyPathReach.reachedPath)),
        (cause) => unavailableError('growth path-reach read failed', cause)
      );
    },

    readNewestBuckets(db) {
      const newest = async (): Promise<GrowthNewestBuckets> => {
        const funnel = await db
          .select({ at: funnelWeeklyView.week })
          .from(funnelWeeklyView)
          .orderBy(desc(funnelWeeklyView.week))
          .limit(1);
        const sources = await db
          .select({ at: acquisitionSourcesView.userCreatedWeek })
          .from(acquisitionSourcesView)
          .orderBy(desc(acquisitionSourcesView.userCreatedWeek))
          .limit(1);
        const marketingHours = await db
          .select({ at: marketingHourlyView.bucket })
          .from(marketingHourlyView)
          .orderBy(desc(marketingHourlyView.bucket))
          .limit(1);
        const marketingDays = await db
          .select({ at: marketingDailyView.bucket })
          .from(marketingDailyView)
          .orderBy(desc(marketingDailyView.bucket))
          .limit(1);
        const events = await db
          .select({ at: growthHourlyEvents.hour })
          .from(growthHourlyEvents)
          .orderBy(desc(growthHourlyEvents.hour))
          .limit(1);
        return {
          funnel: weekOpening(newestInstant(funnel)),
          sources: weekOpening(newestInstant(sources)),
          marketing: runsThrough(newestInstant(marketingHours, marketingDays)),
          events: runsThrough(newestInstant(events)),
        };
      };
      return fromPromise(newest(), (cause) =>
        unavailableError('growth newest-bucket read failed', cause)
      );
    },

    readAcquisitionSources(db, { from, to }) {
      return fromPromise(
        db
          .select()
          .from(acquisitionSourcesView)
          .where(withinWindow(acquisitionSourcesView.userCreatedWeek, { from, to }))
          .orderBy(
            asc(acquisitionSourcesView.userCreatedWeek),
            asc(acquisitionSourcesView.campaign)
          ),
        (cause) => unavailableError('growth acquisition-source read failed', cause)
      );
    },
  };
}
