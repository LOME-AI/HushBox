/**
 * The growth dashboard's seed plan — pure data, no infra and no counting.
 *
 * It describes traffic; the producer it is handed to (`seedGrowthCounts`,
 * published by the api growth slice) writes every member through the same
 * beacon and registration-start writers the running system writes through and
 * then runs the real rollup. So no counting rule is restated here: this module
 * chooses who visited, when, from where and under which campaign, and nothing
 * else.
 *
 * SHAPE: one representative UTC hour per day, over a window as wide as the
 * dashboard's widest read. Hour-grain rows therefore exist only for the hours
 * named here, which is the one fidelity cost: the visitor series' hour-grain
 * toggle shows one bar per day of the week it covers.
 *
 * DETERMINISM is relative to the run day — the contract the persona and
 * public-statistics seeds already make. Both halves of a day's plan are a pure
 * function of its UTC day: the hour bucket is midnight of that day, and every
 * identity and every choice is derived from a fixed label over the day and an
 * index, in the shapes the counting store's key registry validates. So two
 * runs on one day name the same buckets and the same people, which is what
 * makes a re-run a rewrite — the rollup upserts on the bucket and never
 * deletes, so a bucket that moved with the run instant would leave the first
 * run's hour standing beside the second's and double-count both funnel rungs
 * that sum per hour. Buckets are computed in coordinated universal time
 * throughout: a local-timezone day helper would move them with the machine's
 * zone.
 */

import { createHash } from 'node:crypto';

import {
  GROWTH_DIRECT_CAMPAIGN,
  GROWTH_SCROLL_EVENTS,
  PRODUCT_ENTRY_ROUTES,
  ROUTES,
  deriveEventName,
  growthDayBucket,
  growthHourBucket,
  type GrowthDevice,
} from '@hushbox/shared';

import type {
  GrowthSeedCampaign,
  GrowthSeedHour,
  GrowthSeedPlan,
  GrowthSeedView,
  GrowthSeedVisitor,
} from '@hushbox/api/dev-seed';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * How many days the plan covers under the development stack. The visitor series
 * reads ninety days at day grain and the weekly ladder twelve weeks, so this is
 * the wider of the two: the dashboard's widest read, which is what this seed
 * exists to populate.
 */
export const GROWTH_SEED_DAYS = 90;

/**
 * How many days the plan covers under the end-to-end stack: none.
 *
 * No specification reads seeded traffic — the one that reads growth counts
 * mints its own campaign tag and asserts over the run's own day — while every
 * key this seed writes lands in the keyspace the per-test rate-limit reset
 * crosses, where it is paid for once per test rather than once per run.
 */
export const E2E_GROWTH_SEED_DAYS = 0;

/**
 * The campaigns this seed mints, with clearly different volumes so the
 * campaign selector changes what the page shows. Prefixed, so no other tag can
 * collide with one, and deliberately not the tag the marketing analytics
 * specification mints for itself — that tag is that specification's to own.
 */
export const GROWTH_SEED_CAMPAIGNS: readonly GrowthSeedCampaign[] = [
  { tag: 'seed-launch-post', label: 'Seed — launch post' },
  { tag: 'seed-newsletter', label: 'Seed — newsletter' },
  { tag: 'seed-partner', label: 'Seed — partner' },
];

/**
 * How often a visit names each campaign. `direct` is one of the two sentinels
 * the migration already seeded, so it is attributed here and never minted.
 */
const CAMPAIGN_WEIGHTS: readonly (readonly [string, number])[] = [
  [GROWTH_DIRECT_CAMPAIGN, 55],
  ...GROWTH_SEED_CAMPAIGNS.map(
    (campaign, index) => [campaign.tag, 20 - index * 5] as readonly [string, number]
  ),
];

/** The campaigns in the order the first visitors of each day are handed one, so every tag has traffic every day. */
const CAMPAIGN_ROTATION: readonly string[] = CAMPAIGN_WEIGHTS.map(([tag]) => tag);

/**
 * The pages the marketing analytics specification asserts its own counts on.
 *
 * The page-view, landing and reach families are keyed by path alone, so a seed
 * touching one of these pages in the hour that specification runs in would move
 * a figure it owns. Day zero is the only day that can overlap it, so day zero
 * leaves these two pages out of its views. Named events are not on this list:
 * their key carries a campaign dimension, and that specification mints its own
 * tag.
 */
export const GROWTH_SEED_DAY_ZERO_EXCLUDED_PAGES: readonly string[] = [
  ROUTES.MARKETING,
  ROUTES.PRIVACY,
];

/** The pages a seeded visitor may see, with the entry page carrying most of the traffic. */
const PAGE_WEIGHTS: readonly (readonly [string, number])[] = [
  [ROUTES.MARKETING, 34],
  [ROUTES.BLOG, 14],
  [ROUTES.PRIVACY, 9],
  [ROUTES.LEADERBOARD, 8],
  [ROUTES.ROADMAP, 8],
  [ROUTES.NEWSLETTER, 7],
  [ROUTES.TERMS, 5],
  ['/blog/what-is-opaque-authentication', 5],
  ['/blog/why-we-published-our-source-code', 4],
  ['/blog/youre-probably-overpaying-for-ai', 3],
  ['/blog/openai-read-78-million-of-your-chats', 3],
];

/** The hosts a seeded visit is reached from, where it was reached from one at all. */
const REFERRER_HOSTS: readonly string[] = [
  'news.ycombinator.com',
  'www.google.com',
  't.co',
  'www.reddit.com',
  'duckduckgo.com',
  'lobste.rs',
];

/** Where seeded visitors are. A state only where the country is the one this design records states for. */
const PLACES: readonly (readonly [string, string, GrowthDevice])[] = [
  ['US', 'CA', 'desktop'],
  ['US', 'NY', 'mobile'],
  ['US', 'TX', 'desktop'],
  ['US', 'WA', 'tablet'],
  ['GB', '', 'desktop'],
  ['GB', '', 'mobile'],
  ['DE', '', 'desktop'],
  ['FR', '', 'mobile'],
  ['CA', '', 'desktop'],
  ['AU', '', 'mobile'],
  ['IN', '', 'mobile'],
  ['BR', '', 'other'],
];

/**
 * The name a click on a link to `destination` is counted under, run through
 * the same derivation the site's inline script, the build's name extractor and
 * the admin overlay all run.
 *
 * Derived rather than spelled: the funnel's entry step filters on the names
 * that derivation produces and the overlay looks up a badge's total by them,
 * so a second spelling here would have to agree with it to be correct and both
 * surfaces would read zero, quietly, if it ever stopped agreeing. Throws on a
 * destination that derives no legal name, for the same reason the funnel's own
 * filter does: a name nothing can write reports zero and looks healthy.
 */
function linkEventName(destination: string): string {
  const name = deriveEventName({
    tagName: 'a',
    textContent: null,
    getAttribute: (attribute) => (attribute === 'href' ? destination : null),
  });
  /* v8 ignore next 2 -- every destination handed to this is a site route, which always derives a name */
  if (name === null) throw new Error(`growth seed: '${destination}' derives no event name`);
  return name;
}

/** The names an entry click is counted under — the destinations that mean entering the product. */
const ENTRY_EVENT_NAMES: readonly string[] = PRODUCT_ENTRY_ROUTES.map((route) =>
  linkEventName(route)
);

/**
 * Other named events a seeded visitor may fire on the entry page.
 *
 * The two scroll depths are read off the closed set that owns those names
 * rather than spelled again, so a rename of a member moves the seed with it: a
 * second spelling would outlive the rename and seed a series no beacon can
 * emit and no pgEnum admits. Their values are taken rather than their type
 * declared, because a type would turn the rename into a build failure here
 * instead of carrying the seed to the new spelling.
 */
const OTHER_EVENT_NAMES: readonly string[] = [
  ...[ROUTES.BLOG, ROUTES.ROADMAP, ROUTES.PRIVACY].map((route) => linkEventName(route)),
  GROWTH_SCROLL_EVENTS[1],
  GROWTH_SCROLL_EVENTS[3],
];

/** Thirty-two lowercase hex characters — the shape the visitor sets admit. */
function visitorIdentity(bucket: string, index: number): string {
  return createHash('sha256')
    .update(`hushbox-growth-seed:visitor:${bucket}:${String(index)}`)
    .digest('hex')
    .slice(0, 32);
}

/** Sixty-four lowercase hex characters — the shape the address-identity sets admit. */
function addressIdentity(bucket: string, index: number): string {
  return createHash('sha256')
    .update(`hushbox-growth-seed:address:${bucket}:${String(index)}`)
    .digest('hex');
}

/** A generator whose whole state is the label it was seeded from. */
function seededRandom(label: string): () => number {
  let state = Number.parseInt(createHash('sha256').update(label).digest('hex').slice(0, 8), 16);
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let drawn = Math.imul(state ^ (state >>> 15), 1 | state);
    drawn = (drawn + Math.imul(drawn ^ (drawn >>> 7), 61 | drawn)) ^ drawn;
    return ((drawn ^ (drawn >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** One member of a weighted list. */
function weighted<Value>(entries: readonly (readonly [Value, number])[], draw: number): Value {
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let remaining = draw * total;
  for (const [value, weight] of entries) {
    remaining -= weight;
    if (remaining < 0) return value;
  }
  /* v8 ignore next 2 -- the weights sum to `total` and the draw is below 1, so the loop always returns */
  throw new Error('growth seed: a weighted list ran out before it chose');
}

/** The member at `index`, wrapped into the list. A fractional index is taken down to the member it sits in. */
function at<Value>(values: readonly Value[], index: number): Value {
  const chosen = values[Math.floor(index) % values.length];
  /* v8 ignore next 2 -- the index is taken modulo the length, and every list here is a non-empty literal */
  if (chosen === undefined) throw new Error('growth seed: an empty list has no member');
  return chosen;
}

/**
 * The representative hour of every day the plan covers, oldest first: hour zero
 * of each day's own UTC day, the run day included.
 *
 * Hour zero of the run day has begun whatever instant the seed runs at, so no
 * hour that has not begun is ever named without consulting the clock — and
 * because the bucket is then a pure function of the day rather than of the run
 * instant, a second run on that day names the bucket the first one did and the
 * rollup rewrites those rows instead of adding a second hour beside them.
 */
function growthSeedHourInstants(now: Date, days: number): readonly Date[] {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from(
    { length: days },
    (_, index) => new Date(midnight - (days - 1 - index) * DAY_MS)
  );
}

/**
 * How many visitors a day carries: a rising trend with a seeded wobble on it.
 *
 * The ramp's width is the development window rather than the window being
 * built, so a day's figure is the same whichever window names it — a narrower
 * window is the newest days of the same growth curve, not a compressed copy of
 * it.
 */
function visitorCountFor(daysAgo: number, random: () => number): number {
  const trend = 7 + Math.round((17 * (GROWTH_SEED_DAYS - 1 - daysAgo)) / (GROWTH_SEED_DAYS - 1));
  return Math.max(5, Math.round(trend * (0.8 + random() * 0.45)));
}

/** The pages that may be viewed on one day of the plan. */
function pagesFor(isDayZero: boolean): readonly (readonly [string, number])[] {
  if (!isDayZero) return PAGE_WEIGHTS;
  return PAGE_WEIGHTS.filter(([page]) => !GROWTH_SEED_DAY_ZERO_EXCLUDED_PAGES.includes(page));
}

/** One visitor's views: the landing page first, then whatever else the visit reached. */
function viewsFor(
  landing: string,
  pages: readonly (readonly [string, number])[],
  referred: boolean,
  random: () => number
): readonly GrowthSeedView[] {
  const further = weighted(
    [
      [0, 55],
      [1, 30],
      [2, 15],
    ] as const,
    random()
  );
  return [
    { path: landing, ...(referred ? { referrerHost: at(REFERRER_HOSTS, random() * 1e6) } : {}) },
    ...Array.from({ length: further }, () => ({ path: weighted(pages, random()) })),
  ];
}

/** One day's visitors, each with the pages they saw and the events they fired. */
function visitorsFor(
  bucket: string,
  isDayZero: boolean,
  count: number,
  random: () => number
): readonly GrowthSeedVisitor[] {
  const pages = pagesFor(isDayZero);
  const addresses = Math.max(2, Math.min(8, Math.ceil(count / 4)));
  return Array.from({ length: count }, (_, index) => {
    // The first visitors of a day take one campaign each, so every tag has
    // traffic on every day and the campaign selector is never a choice between
    // one populated option and several empty ones.
    const campaign =
      index < CAMPAIGN_ROTATION.length
        ? at(CAMPAIGN_ROTATION, index)
        : weighted(CAMPAIGN_WEIGHTS, random());
    const [country, region, device] = at(PLACES, index);
    // The first visitor of every day clicks into the product, so the funnel's
    // entry step and the overlay's badges carry a figure on every day rather
    // than on most of them.
    const clicksIn = index === 0 || random() < 0.22;
    // An entry clicker lands on the entry page, which is where the site's own
    // entry links are — except on day zero, whose landing comes from the set
    // that leaves the marketing specification's pages alone. The event still
    // names the entry page either way: its key carries a campaign dimension
    // this seed owns, so it cannot move a figure that specification asserts.
    const landing = clicksIn && !isDayZero ? ROUTES.MARKETING : weighted(pages, random());
    return {
      visitor: visitorIdentity(bucket, index),
      addressId: addressIdentity(bucket, index % addresses),
      campaign,
      country,
      region,
      device,
      views: viewsFor(landing, pages, index === 0 || random() < 0.35, random),
      events: [
        ...(clicksIn ? [{ path: ROUTES.MARKETING, eventName: at(ENTRY_EVENT_NAMES, index) }] : []),
        ...(random() < 0.3
          ? [{ path: ROUTES.MARKETING, eventName: at(OTHER_EVENT_NAMES, index) }]
          : []),
      ],
    };
  });
}

/** One day's registration starts, attributed to the campaigns that brought them. */
function startsFor(
  bucket: string,
  visitors: number,
  random: () => number
): GrowthSeedHour['starts'] {
  const count = Math.max(1, Math.round(visitors * 0.12));
  return Array.from({ length: count }, (_, index) => ({
    campaign: weighted(CAMPAIGN_WEIGHTS, random()),
    addressId: addressIdentity(bucket, index),
  }));
}

/**
 * The whole plan, oldest hour first.
 *
 * `now` is the instant the seed is running at, and everything else derives
 * from it — which is what makes the plan deterministic for a run day and
 * nothing wider. `days` is how wide a window to cover, which the stack the seed
 * runs against decides: {@link GROWTH_SEED_DAYS} or
 * {@link E2E_GROWTH_SEED_DAYS}.
 */
export function buildGrowthSeedPlan(now: Date, days: number): GrowthSeedPlan {
  const instants = growthSeedHourInstants(now, days);
  const lastIndex = instants.length - 1;
  return {
    campaigns: GROWTH_SEED_CAMPAIGNS,
    hours: instants.map((instant, index) => {
      const bucket = growthDayBucket(instant);
      const random = seededRandom(`hushbox-growth-seed:day:${bucket}`);
      const visitors = visitorsFor(
        bucket,
        index === lastIndex,
        visitorCountFor(lastIndex - index, random),
        random
      );
      return { at: instant, visitors, starts: startsFor(bucket, visitors.length, random) };
    }),
  };
}

/** One day of the plan, as a specification reads it. */
interface GrowthSeedDayFigures {
  /** The UTC hour bucket the day's traffic is counted in, `YYYY-MM-DDTHH`. */
  readonly hour: string;
  /** The UTC day that hour belongs to, `YYYY-MM-DD`. */
  readonly day: string;
  readonly visitors: number;
  readonly views: number;
  readonly events: number;
  readonly starts: number;
}

/** What a plan says it will produce, so a specification derives its assertions instead of restating them. */
export interface GrowthSeedFigures {
  readonly days: number;
  readonly campaignTags: readonly string[];
  readonly pages: readonly string[];
  readonly totalVisitors: number;
  readonly totalStarts: number;
  readonly byDay: readonly GrowthSeedDayFigures[];
}

/** The figures a plan carries, read off the plan itself. */
export function growthSeedFigures(plan: GrowthSeedPlan): GrowthSeedFigures {
  const byDay = plan.hours.map((hour) => ({
    hour: growthHourBucket(hour.at),
    day: growthDayBucket(hour.at),
    visitors: hour.visitors.length,
    views: hour.visitors.reduce((sum, visitor) => sum + visitor.views.length, 0),
    events: hour.visitors.reduce((sum, visitor) => sum + visitor.events.length, 0),
    starts: hour.starts.length,
  }));
  const pages = new Set<string>();
  for (const hour of plan.hours) {
    for (const visitor of hour.visitors) {
      for (const view of visitor.views) pages.add(view.path);
    }
  }
  return {
    days: plan.hours.length,
    campaignTags: plan.campaigns.map((campaign) => campaign.tag),
    pages: [...pages].toSorted((left, right) => left.localeCompare(right)),
    totalVisitors: byDay.reduce((sum, day) => sum + day.visitors, 0),
    totalStarts: byDay.reduce((sum, day) => sum + day.starts, 0),
    byDay,
  };
}
