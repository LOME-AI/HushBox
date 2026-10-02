import { describe, expect, it } from 'vitest';
import {
  GROWTH_DIRECT_CAMPAIGN,
  GROWTH_SCROLL_EVENTS,
  GROWTH_UNKNOWN_CAMPAIGN,
  PRODUCT_ENTRY_ROUTES,
  ROUTES,
  deriveEventName,
  growthDayBucket,
  growthHourBucket,
} from '@hushbox/shared';
import { DAY_MS, HOUR_MS, TEST_DAY_START } from '@hushbox/shared/test-time';

import {
  E2E_GROWTH_SEED_DAYS,
  GROWTH_SEED_CAMPAIGNS,
  GROWTH_SEED_DAYS,
  GROWTH_SEED_DAY_ZERO_EXCLUDED_PAGES,
  buildGrowthSeedPlan,
  growthSeedFigures,
} from './growth.js';

import type { GrowthSeedPlan } from '@hushbox/api/dev-seed';

/** The instant every case here builds its plan at: a fixed UTC hour of the reference day. */
const RUN_AT = new Date(TEST_DAY_START + 4 * HOUR_MS + 37 * 60 * 1000);

const plan = buildGrowthSeedPlan(RUN_AT, GROWTH_SEED_DAYS);

describe('buildGrowthSeedPlan', () => {
  it('covers the widest window the dashboard reads, one hour per day', () => {
    expect(plan.hours).toHaveLength(GROWTH_SEED_DAYS);
  });

  it('orders its hours oldest first', () => {
    const instants = plan.hours.map((hour) => hour.at.getTime());
    expect(instants).toEqual([...instants].toSorted((left, right) => left - right));
  });

  it('counts every day, the run day included, at hour zero of its own UTC day', () => {
    for (const hour of plan.hours) {
      expect(hour.at.getUTCHours()).toBe(0);
    }
  });

  // Pins the newest end of the window, which no other case here does: every
  // other property holds just as well for a window ending yesterday, and a
  // window ending yesterday empties the current week — the week every
  // week-scoped panel opens on.
  it('reaches the run day itself, so the current week is never empty on a fresh seed', () => {
    expect(plan.hours.map((hour) => growthDayBucket(hour.at)).at(-1)).toBe(growthDayBucket(RUN_AT));
  });

  it('files one UTC day under one hour bucket however many hours apart two runs are', () => {
    const bucketsAt = (at: Date): readonly string[] =>
      buildGrowthSeedPlan(at, GROWTH_SEED_DAYS).hours.map((hour) => growthHourBucket(hour.at));
    expect(bucketsAt(new Date(TEST_DAY_START + 9 * HOUR_MS))).toEqual(
      bucketsAt(new Date(TEST_DAY_START + 3 * HOUR_MS))
    );
  });

  it('builds one plan for a whole run day', () => {
    expect(buildGrowthSeedPlan(new Date(TEST_DAY_START + 21 * HOUR_MS), GROWTH_SEED_DAYS)).toEqual(
      buildGrowthSeedPlan(new Date(TEST_DAY_START + 3 * HOUR_MS), GROWTH_SEED_DAYS)
    );
  });

  it('derives a day’s identities from its own UTC day, so a later hour recreates them', () => {
    const later = buildGrowthSeedPlan(new Date(RUN_AT.getTime() + 3 * HOUR_MS), GROWTH_SEED_DAYS);
    const identitiesOf = (built: GrowthSeedPlan): readonly string[] =>
      built.hours.flatMap((hour) => hour.visitors.map((visitor) => visitor.visitor));
    expect(identitiesOf(later)).toEqual(identitiesOf(plan));
  });

  it('names no hour that has not begun', () => {
    for (const hour of plan.hours) {
      expect(hour.at.getTime()).toBeLessThanOrEqual(RUN_AT.getTime());
    }
  });

  it('names one hour per distinct UTC day', () => {
    const days = plan.hours.map((hour) => hour.at.toISOString().slice(0, 10));
    expect(new Set(days).size).toBe(GROWTH_SEED_DAYS);
  });

  it('builds the same plan twice from one instant', () => {
    expect(buildGrowthSeedPlan(RUN_AT, GROWTH_SEED_DAYS)).toEqual(plan);
  });

  it('builds a different plan for a different run day', () => {
    const tomorrow = buildGrowthSeedPlan(new Date(RUN_AT.getTime() + DAY_MS), GROWTH_SEED_DAYS);
    expect(tomorrow.hours.map((hour) => hour.at.getTime())).not.toEqual(
      plan.hours.map((hour) => hour.at.getTime())
    );
  });

  it('derives every visitor identity in the shape the visitor sets admit', () => {
    for (const hour of plan.hours) {
      for (const visitor of hour.visitors) {
        expect(visitor.visitor).toMatch(/^[\da-f]{32}$/u);
      }
    }
  });

  it('derives every address identity in the shape the address sets admit', () => {
    for (const hour of plan.hours) {
      for (const visitor of hour.visitors) {
        expect(visitor.addressId).toMatch(/^[\da-f]{64}$/u);
      }
      for (const start of hour.starts) {
        expect(start.addressId).toMatch(/^[\da-f]{64}$/u);
      }
    }
  });

  it('spreads each day’s visitors over more than one address', () => {
    for (const hour of plan.hours) {
      expect(new Set(hour.visitors.map((visitor) => visitor.addressId)).size).toBeGreaterThan(1);
    }
  });

  it('gives each day’s visitors distinct identities', () => {
    for (const hour of plan.hours) {
      expect(new Set(hour.visitors.map((visitor) => visitor.visitor)).size).toBe(
        hour.visitors.length
      );
    }
  });

  it('keeps day zero off the pages the marketing analytics specification asserts on', () => {
    const dayZero = plan.hours[GROWTH_SEED_DAYS - 1];
    const viewed = (dayZero?.visitors ?? []).flatMap((visitor) =>
      visitor.views.map((view) => view.path)
    );
    for (const page of GROWTH_SEED_DAY_ZERO_EXCLUDED_PAGES) {
      expect(viewed).not.toContain(page);
    }
  });

  it('counts named events on the entry page on every day, day zero included', () => {
    for (const hour of plan.hours) {
      const events = hour.visitors.flatMap((visitor) => visitor.events);
      expect(events.some((event) => event.path === ROUTES.MARKETING)).toBe(true);
    }
  });

  it('fires whatever name the shared derivation gives each product entry route', () => {
    // Derived here rather than spelled, so this case follows a change in the
    // derivation the funnel's entry filter and the overlay's badges both read.
    // A seed that re-spelled those names would part company with it and both
    // surfaces would read zero while every other case here still passed.
    const derived = PRODUCT_ENTRY_ROUTES.map((route) =>
      deriveEventName({
        tagName: 'a',
        textContent: null,
        getAttribute: (attribute) => (attribute === 'href' ? route : null),
      })
    );
    const fired = new Set(
      plan.hours.flatMap((hour) =>
        hour.visitors.flatMap((visitor) => visitor.events.map((event) => event.eventName))
      )
    );
    expect(derived).not.toContain(null);
    for (const name of derived) {
      expect([...fired]).toContain(name);
    }
  });

  it('fires whatever name the shared derivation gives each further destination it links to', () => {
    const fired = new Set(
      plan.hours.flatMap((hour) =>
        hour.visitors.flatMap((visitor) => visitor.events.map((event) => event.eventName))
      )
    );
    for (const name of [...fired].filter((candidate) => candidate.startsWith('link:'))) {
      expect(
        deriveEventName({
          tagName: 'a',
          textContent: null,
          getAttribute: (attribute) => (attribute === 'href' ? name.slice('link:'.length) : null),
        })
      ).toBe(name);
    }
  });

  it('fires the scroll depths the shared closed set spells', () => {
    // Read off the tuple rather than spelled, so this case follows a rename of
    // a member the way the seed now does. A seed that spelled them would part
    // company with the closed set the beacon writes and the pgEnum admits, and
    // the named-events panel would carry a series no beacon can ever produce.
    const fired = new Set(
      plan.hours.flatMap((hour) =>
        hour.visitors.flatMap((visitor) => visitor.events.map((event) => event.eventName))
      )
    );
    const byName = (left: string, right: string): number => left.localeCompare(right);
    const scrolled = [...fired].filter((name) => !name.startsWith('link:')).toSorted(byName);
    expect(scrolled).toEqual([GROWTH_SCROLL_EVENTS[1], GROWTH_SCROLL_EVENTS[3]].toSorted(byName));
  });

  it('gives every visitor a landing page', () => {
    for (const hour of plan.hours) {
      for (const visitor of hour.visitors) {
        expect(visitor.views.length).toBeGreaterThan(0);
      }
    }
  });

  it('counts registration starts on every day', () => {
    for (const hour of plan.hours) {
      expect(hour.starts.length).toBeGreaterThan(0);
    }
  });

  it('records a state only for the country whose states this design records', () => {
    for (const hour of plan.hours) {
      for (const visitor of hour.visitors) {
        if (visitor.country !== 'US') expect(visitor.region).toBe('');
      }
    }
  });

  it('spreads visits over more than one campaign, more than one page and more than one place', () => {
    const visitors = plan.hours.flatMap((hour) => hour.visitors);
    expect(new Set(visitors.map((visitor) => visitor.campaign)).size).toBeGreaterThan(1);
    expect(
      new Set(visitors.flatMap((visitor) => visitor.views.map((v) => v.path))).size
    ).toBeGreaterThan(1);
    expect(new Set(visitors.map((visitor) => visitor.country)).size).toBeGreaterThan(1);
  });

  it('reaches a page from a referrer host on some visits', () => {
    const referred = plan.hours.flatMap((hour) =>
      hour.visitors.flatMap((visitor) =>
        visitor.views.filter((view) => view.referrerHost !== undefined)
      )
    );
    expect(referred.length).toBeGreaterThan(0);
  });

  it('mints only prefixed tags, never a sentinel the mint door refuses', () => {
    for (const campaign of GROWTH_SEED_CAMPAIGNS) {
      expect(campaign.tag).toMatch(/^seed-[a-z-]+$/u);
      expect([GROWTH_DIRECT_CAMPAIGN, GROWTH_UNKNOWN_CAMPAIGN]).not.toContain(campaign.tag);
    }
    expect(plan.campaigns).toEqual(GROWTH_SEED_CAMPAIGNS);
  });

  it('attributes some visits to the tags it mints and some to no campaign at all', () => {
    const tags = new Set(
      plan.hours.flatMap((hour) => hour.visitors.map((visitor) => visitor.campaign))
    );
    expect(tags).toContain(GROWTH_DIRECT_CAMPAIGN);
    for (const campaign of GROWTH_SEED_CAMPAIGNS) {
      expect(tags).toContain(campaign.tag);
    }
  });
});

describe('growthSeedFigures', () => {
  const figures = growthSeedFigures(plan);

  it('states one row per day the plan covers', () => {
    expect(figures.byDay).toHaveLength(GROWTH_SEED_DAYS);
    expect(figures.days).toBe(GROWTH_SEED_DAYS);
  });

  it('names each day by the hour bucket its traffic was counted in', () => {
    expect(figures.byDay.map((day) => day.hour)).toEqual(
      plan.hours.map((hour) => growthHourBucket(hour.at))
    );
  });

  // Against the shared day speller rather than against the exported hour: a
  // specification matches seeded rows by this string, and the rows are filed
  // under whatever the counting path's speller produces, so an exported day
  // derived any other way finds nothing and reports nothing wrong.
  it('spells each day field the way the counting path spells a day bucket', () => {
    expect(figures.byDay.map((day) => day.day)).toEqual(
      plan.hours.map((hour) => growthDayBucket(hour.at))
    );
  });

  it('totals the visitors and the starts the plan carries', () => {
    let visitors = 0;
    let starts = 0;
    for (const hour of plan.hours) {
      visitors += hour.visitors.length;
      starts += hour.starts.length;
    }
    expect(figures.totalVisitors).toBe(visitors);
    expect(figures.totalStarts).toBe(starts);
  });

  it('counts each day’s views and events', () => {
    const dayZero = plan.hours[GROWTH_SEED_DAYS - 1];
    expect(figures.byDay[GROWTH_SEED_DAYS - 1]?.views).toBe(
      (dayZero?.visitors ?? []).reduce((sum, visitor) => sum + visitor.views.length, 0)
    );
    expect(figures.byDay[GROWTH_SEED_DAYS - 1]?.events).toBe(
      (dayZero?.visitors ?? []).reduce((sum, visitor) => sum + visitor.events.length, 0)
    );
  });

  it('lists the campaign tags the plan mints and the pages it touches, sorted', () => {
    expect(figures.campaignTags).toEqual(GROWTH_SEED_CAMPAIGNS.map((campaign) => campaign.tag));
    expect(figures.pages).toEqual(
      [...figures.pages].toSorted((left, right) => left.localeCompare(right))
    );
    expect(figures.pages).toContain(ROUTES.MARKETING);
  });

  it('reads an empty plan as no days and no totals', () => {
    const empty: GrowthSeedPlan = { campaigns: [], hours: [] };
    expect(growthSeedFigures(empty)).toEqual({
      days: 0,
      campaignTags: [],
      pages: [],
      totalVisitors: 0,
      totalStarts: 0,
      byDay: [],
    });
  });
});

describe('the window the E2E stack seeds', () => {
  it('plans no traffic at all', () => {
    // Every key this seed writes is keyspace the per-test rate-limit reset
    // crosses, and no end-to-end specification reads seeded history: the one
    // that reads growth counts mints its own campaign tag and asserts over the
    // run's own day.
    expect(buildGrowthSeedPlan(RUN_AT, E2E_GROWTH_SEED_DAYS).hours).toEqual([]);
  });

  it('still declares the campaigns, so the tag set is one statement', () => {
    expect(buildGrowthSeedPlan(RUN_AT, E2E_GROWTH_SEED_DAYS).campaigns).toEqual(
      GROWTH_SEED_CAMPAIGNS
    );
  });
});
