import { A11Y_STORAGE_KEY, GROWTH_SCROLL_EVENTS, ROUTES, TEST_IDS } from '@hushbox/shared';

import { test as base } from './fixtures.js';
import { matrix } from '../scripts/lib/playwright/browser-matrix.js';
// The growth key registry, imported rather than re-spelled — see the note on
// the same import in `e2e/helpers/growth-counts.ts`.
import { GROWTH_REDIS_KEYS } from '../apps/api/src/lib/redis/growth-keys.js';
import { TIMEOUTS } from './config/timeouts.js';
import { expect } from './helpers/expect.js';
import {
  GROWTH_ACTORS,
  mintCampaign,
  mintGrowthAdminContext,
  readEventRows,
  readMarketingRows,
  readReachRows,
  rollupHour,
} from './helpers/growth-admin.js';
import {
  membersAcrossHours,
  openBeaconWindow,
  openGrowthStore,
  soleMemberAcrossHours,
} from './helpers/growth-counts.js';
import {
  clientStorageFootprint,
  committedEventNames,
  derivedEventName,
  privacyLink,
  productEntryLink,
  watchPageViewBeacon,
} from './helpers/growth-page.js';
import { guestIp } from './helpers/guest-identity.js';
import type { GrowthStore } from './helpers/growth-counts.js';
import type { GrowthReadWindow } from './helpers/growth-admin.js';
import type { APIRequestContext } from './fixtures.js';

const SPEC_MATRIX = matrix({ engine: 'engine-matrix', formFactor: 'either' });

/**
 * The storage keys the marketing site itself owns — the allowlist the
 * device-footprint claim is a subset of.
 *
 * One entry today: the accessibility store's persist key. That store is
 * written on every page load, because each host hands the library its
 * reduced-motion override at boot and zustand's persist wrapper writes on
 * every `set` — so an empty-storage claim would be false of the page and would
 * say nothing about the counter.
 *
 * Imported from the module that owns each key, never spelled here: a literal
 * would be a second spelling that has to agree with the store's to be correct,
 * and a key renamed at the store would then silently widen this allowlist to
 * cover a name nothing writes.
 */
const SITE_OWNED_STORAGE_KEYS: ReadonlySet<string> = new Set([A11Y_STORAGE_KEY]);

/**
 * The anonymous marketing counter, end to end: a visit and a click counted
 * into the store by the beacon the built marketing pages carry, then reduced
 * into the growth tables by the real rollup and read back through the
 * operations an operator reads them through.
 *
 * WHAT THIS SPECIFICATION OWNS, AND WHAT IT MERELY VISITS. It mints a campaign
 * tag derived from the running project and worker slot, so every set keyed by
 * that tag holds this run's visitor and nobody else's — those are asserted at
 * an exact cardinality. The page-keyed families (the view sets, the landing
 * latch, the reach pair) are shared with every other specification that loads
 * the same marketing page in the same hour, and the suite runs many workers at
 * once, so those are asserted by MEMBERSHIP: this run's visitor is present.
 * Membership survives a neighbour's traffic; "exactly one" would not.
 *
 * THE VISITOR IDENTITY IS THE GUEST ADDRESS. The identity every count is a
 * membership of is a keyed hash over the caller's address and user agent, so
 * it is shared by every page load presenting the same pair. The guest block is
 * what keeps this run's identity out of the project's own caller traffic: the
 * landing latch claims a visitor's FIRST marketing page of the day, so a
 * neighbouring specification loading some other marketing page first under the
 * same identity would move it. Nothing loads a marketing page under the guest
 * identity today; a specification that started to would fail the latch
 * assertion below, which names that cause.
 *
 * THREE THINGS THIS CANNOT COVER, STATED SO NOBODY READS THEM AS COVERED. The
 * referrers table needs an EXTERNAL referrer host, and every origin in a local
 * stack is `localhost` — the internal-referrer rule compares hostnames, so no
 * local navigation can produce one. The hourly funnel table is written by
 * registration starts, which the signup specification drives. And geography is
 * not asserted: the country and region are edge properties of the request,
 * which no browser-side configuration can supply.
 */

/**
 * Everything the specification needs to read the store and drive the admin
 * plane: the counting store, the operator that mints the campaign and forces
 * the reduction, and the read-only role the Growth screen reads through.
 */
interface GrowthFixtures {
  growth: {
    readonly store: GrowthStore;
    readonly operator: APIRequestContext;
    readonly reader: APIRequestContext;
  };
}

const test = base.extend<GrowthFixtures>({
  growth: async ({ playwright }, use) => {
    const store = await openGrowthStore(playwright.request);
    const operator = await mintGrowthAdminContext(playwright.request, GROWTH_ACTORS.operator);
    const reader = await mintGrowthAdminContext(playwright.request, GROWTH_ACTORS.reader);
    try {
      await use({ store, operator, reader });
    } finally {
      await store.dispose();
      await operator.dispose();
      await reader.dispose();
    }
  },
});

/**
 * This specification's pages carry no network allowlist, and that is the only
 * guardrail they give up — the console-error and API-error guards attach
 * listeners rather than routes, so both stay armed here.
 *
 * The allowlist is a Playwright route, and registering any route at all
 * switches on WebKit's page-wide request interception, under which WebKit
 * cancels a `keepalive` request still in flight when a cross-document
 * navigation begins. Both clicks below fire the marketing beacon and navigate
 * in the same tick, so under interception their events are cancelled and the
 * counts this specification exists to assert never arrive — on WebKit only,
 * and with no product defect behind it.
 *
 * A specification that fires a beacon during a navigation needs this
 * declaration; one that does not should not carry it, because the allowlist
 * is what keeps a live third party out of the hot path.
 */
test.use({ networkAllowlist: false });

/**
 * The campaign tag this run counts under.
 *
 * Both axes are load-bearing. The project and the worker slot are exactly what
 * the caller address is derived from, so a tag built from them is written by
 * one visitor identity and no other — which is what lets every set keyed by it
 * be asserted at an exact cardinality, and what makes a re-run in the same slot
 * converge on the same single member rather than adding a second.
 */
function specCampaignTag(): string {
  const info = test.info();
  return `e2e-analytics-${info.project.name}-w${String(info.parallelIndex)}`;
}

/** The thresholds every page reports by being scrolled, which no click of this run's makes. */
const SCROLL_NAMES = new Set<string>(GROWTH_SCROLL_EVENTS);

/** Alphabetical, by the collation the locale pins, so two name lists compare as sets. */
function byName(left: string, right: string): number {
  return left.localeCompare(right);
}

/**
 * The rows the reduction wrote, read back through the operations the Growth
 * screen reads them through.
 *
 * What is claimed per family follows the family's key. The campaign rows carry
 * this run's own tag, so they are claimed exactly — one visitor. The page,
 * visitor and geography rows are shared with whatever else visited the same
 * page in the same bucket, so they are claimed as present and non-zero.
 */
async function assertRolledRows(
  reader: APIRequestContext,
  window: GrowthReadWindow,
  campaign: string,
  eventName: string
): Promise<void> {
  for (const grain of ['hour', 'day'] as const) {
    const rows = await readMarketingRows(reader, window, grain);
    // One row per page this run's tag was seen on, each holding its one
    // visitor. Matched on the page as well as the tag: the run visited two,
    // so a match on the tag alone answers with whichever row came first.
    for (const path of [ROUTES.MARKETING, ROUTES.PRIVACY]) {
      expect(
        rows.find(
          (row) => row.family === 'campaign' && row.campaign === campaign && row.path === path
        ),
        `no ${grain}-grain campaign row for ${campaign} on ${path}`
      ).toMatchObject({ visitors: 1 });
    }
    const pathRow = rows.find((row) => row.family === 'path' && row.path === ROUTES.MARKETING);
    expect(pathRow?.visitors, `no ${grain}-grain page row`).toBeGreaterThan(0);
    // Landings are claimed once per visitor per day, so only the day row is
    // sure to carry one: an hour in which every visitor had already been seen
    // has views and no landings, which is a true reading rather than a gap.
    if (grain === 'day') {
      expect(pathRow?.landings, 'no day-grain landing count').toBeGreaterThan(0);
    }
    expect(
      rows.find((row) => row.family === 'total')?.visitors,
      `no ${grain}-grain visitors row`
    ).toBeGreaterThan(0);
    expect(
      rows.find((row) => row.family === 'geo')?.visitors,
      `no ${grain}-grain geography row`
    ).toBeGreaterThan(0);
  }

  const reach = await readReachRows(reader, window);
  expect(
    reach.find((row) => row.landingPath === ROUTES.MARKETING && row.reachedPath === ROUTES.PRIVACY)
      ?.visitorsDailySummed,
    'no daily reach row for the journey this run made'
  ).toBeGreaterThan(0);

  // Every named event the tag carries, less the thresholds a page reports by
  // being scrolled: exactly the two clicks this run made, one visitor each.
  // The newsletter field is absent from it, which is the whole of the negative
  // the specification makes by clicking it.
  const events = await readEventRows(reader, window, campaign);
  const clicked = events.filter((row) => !SCROLL_NAMES.has(row.eventName));
  // The distinct names, not the rows: an event row is per hour, so a re-run in
  // a later hour of the same day gives this tag a second row per name, which
  // says nothing new about which names it carries.
  expect([...new Set(clicked.map((row) => row.eventName))].toSorted(byName)).toEqual(
    [`link:${ROUTES.PRIVACY}`, eventName].toSorted(byName)
  );
  for (const row of clicked) {
    expect(row.visitors, `${row.eventName} counted more than this run's visitor`).toBe(1);
    expect(row.path).toBe(ROUTES.MARKETING);
  }
}

test.describe('Marketing analytics', SPEC_MATRIX, () => {
  test('counts a visit and a click into the store, then rolls them into the growth tables', async ({
    unauthenticatedPage,
    growth,
  }) => {
    // Four page loads (the last of them the app the call to action leads
    // into), a forced reduction and four operation reads sit inside one
    // journey; the per-test default is sized for a single flow.
    test.setTimeout(TIMEOUTS.XLONG);

    const page = unauthenticatedPage;
    const { store, operator, reader } = growth;
    const campaign = specCampaignTag();
    const landing = `${ROUTES.MARKETING}?c=${campaign}`;

    // The tag has to stand in the campaigns table before the first beacon,
    // or it folds to the unknown sentinel and every key built from it below
    // is a key nothing ever wrote.
    await mintCampaign(operator, campaign);
    await store.forgetActiveCampaigns();

    await page.setExtraHTTPHeaders({ 'cf-connecting-ip': guestIp() });
    const beacons = openBeaconWindow();

    // ---- The visit ------------------------------------------------------
    await page.goto(landing);

    // The one member of a campaign-keyed set IS this run's visitor, because
    // nothing else can write this tag. Everything below is asserted about it.
    const visitor = await soleMemberAcrossHours(
      store,
      beacons,
      (hour) => GROWTH_REDIS_KEYS.campaignPaths.buildKey('h', hour, campaign, ROUTES.MARKETING),
      `the visit to ${landing} was counted under the campaign tag this run minted`
    );
    const holdsVisitor = (key: string): Promise<void> =>
      expect.poll(() => store.members(key)).toContain(visitor);
    const holdsOnlyVisitor = (key: string): Promise<void> =>
      expect.poll(() => store.members(key)).toEqual([visitor]);
    const hourlyHoldsVisitor = (key: (hour: string) => string): Promise<void> =>
      expect.poll(() => membersAcrossHours(store, beacons, key)).toContain(visitor);
    const hourlyHoldsOnlyVisitor = (key: (hour: string) => string): Promise<void> =>
      expect.poll(() => membersAcrossHours(store, beacons, key)).toEqual([visitor]);

    await holdsOnlyVisitor(
      GROWTH_REDIS_KEYS.campaignPaths.buildKey('d', beacons.day(), campaign, ROUTES.MARKETING)
    );

    // The dimensionless and page-keyed families: membership, never a count.
    await hourlyHoldsVisitor((hour) => GROWTH_REDIS_KEYS.visitors.buildKey('h', hour));
    await holdsVisitor(GROWTH_REDIS_KEYS.visitors.buildKey('d', beacons.day()));
    await hourlyHoldsVisitor((hour) =>
      GROWTH_REDIS_KEYS.views.buildKey('h', hour, ROUTES.MARKETING)
    );
    await holdsVisitor(GROWTH_REDIS_KEYS.views.buildKey('d', beacons.day(), ROUTES.MARKETING));

    // The landing is claimed at a visitor's FIRST sight of the day and never
    // again, so only the day-grain set carries it for the whole day: the hour
    // set records the hour that first sight happened in, which is this run's
    // hour the first time it runs today and some earlier hour afterwards. The
    // day claim is the one that holds however often this runs.
    await holdsVisitor(GROWTH_REDIS_KEYS.landings.buildKey('d', beacons.day(), ROUTES.MARKETING));

    // The landing latch: this visitor's first page of the day, claimed once.
    const landingKey = GROWTH_REDIS_KEYS.landing.buildKey(beacons.day(), visitor);
    await expect
      .poll(() => store.value(landingKey), {
        message:
          'the landing latch names another page, so something beacon-bearing ran under the guest identity earlier today',
      })
      .toBe(ROUTES.MARKETING);

    // ---- The internal navigation -----------------------------------------
    const privacy = privacyLink(page);
    await expect(privacy).toHaveAttribute('href', `${ROUTES.PRIVACY}?c=${campaign}`);
    await privacy.click();
    await expect(page).toHaveURL(new RegExp(String.raw`${ROUTES.PRIVACY}\?c=${campaign}$`));

    await hourlyHoldsVisitor((hour) => GROWTH_REDIS_KEYS.views.buildKey('h', hour, ROUTES.PRIVACY));
    await holdsVisitor(GROWTH_REDIS_KEYS.views.buildKey('d', beacons.day(), ROUTES.PRIVACY));
    await hourlyHoldsOnlyVisitor((hour) =>
      GROWTH_REDIS_KEYS.campaignPaths.buildKey('h', hour, campaign, ROUTES.PRIVACY)
    );
    await holdsVisitor(
      GROWTH_REDIS_KEYS.reach.buildKey(beacons.day(), ROUTES.MARKETING, ROUTES.PRIVACY)
    );

    // ---- The repeat visit ------------------------------------------------
    // Waited on this visit's own pageview beacon being answered, not on the
    // page: a second count that never arrived would make "nothing changed"
    // true for the wrong reason.
    //
    // Bounded, and the bound names what it caught: a saturated stack holds
    // beacon requests and answers them in a later burst, so an unbounded wait
    // here spends the whole per-test budget and reports only that the test
    // timed out, naming neither the beacon nor the stack. The watch is armed
    // before the navigation, because the answer can arrive before `goto`
    // returns, and it hands back its failure rather than throwing it — see
    // {@link watchPageViewBeacon} for why that matters here.
    const repeat = watchPageViewBeacon(page, ROUTES.MARKETING, TIMEOUTS.BEACON_ANSWERED);
    await page.goto(landing);
    const unanswered = await repeat;
    if (unanswered !== undefined) throw unanswered;

    await hourlyHoldsOnlyVisitor((hour) =>
      GROWTH_REDIS_KEYS.campaignPaths.buildKey('h', hour, campaign, ROUTES.MARKETING)
    );
    await holdsOnlyVisitor(
      GROWTH_REDIS_KEYS.campaignPaths.buildKey('d', beacons.day(), campaign, ROUTES.MARKETING)
    );
    await expect.poll(() => store.value(landingKey)).toBe(ROUTES.MARKETING);

    // ---- A click that must not be counted ---------------------------------
    // A form control derives no name, so nothing leaves the page. It is
    // clicked BEFORE the call to action, so by the time that click's event
    // has landed, this one has had its chance on the same transport.
    await page.getByTestId(TEST_IDS.newsletterSignupInput).click();

    // ---- The click that must be -------------------------------------------
    const entry = productEntryLink(page);
    const eventName = await derivedEventName(entry);
    expect(
      committedEventNames(ROUTES.MARKETING),
      `the committed click-name index carries no "${eventName}" for ${ROUTES.MARKETING}: it is stale against the page this build serves, and the beacon validates every name it receives against it`
    ).toContain(eventName);

    // Nothing of the counter's is on the device. Read while the marketing site
    // is still the page under test: the call to action leads into the app,
    // which writes to the device legitimately.
    //
    // Cookies and databases are claimed outright — the marketing pages set
    // none of either, and the counter is the only thing on them that could.
    // The two key-value storages cannot be claimed empty, because the page's
    // own accessibility bootstrap persists the reader's preferences on every
    // page load. So the claim is a SUBSET one: every key the origin holds is a
    // key the site itself owns, and any other key at all fails — a visitor id,
    // a "beacon sent" flag, a dedupe stamp, whatever it were named.
    const footprint = await clientStorageFootprint(page);
    expect(footprint.cookies).toEqual([]);
    expect(footprint.indexedDatabases ?? []).toEqual([]);
    expect(
      footprint.storedKeys.filter((key) => !SITE_OWNED_STORAGE_KEYS.has(key)),
      'the marketing pages wrote a storage key no part of the site owns, and the counter is the only thing on them that could'
    ).toEqual([]);

    // The site's own keys are allowlisted by NAME, so a counter could still
    // hide inside one of their values. Nothing of the counter's reaches any
    // value either: not the campaign tag, which is supposed to live in the
    // address bar and die with the tab, and not a name it counts clicks under.
    for (const trace of [campaign, eventName, `link:${ROUTES.PRIVACY}`]) {
      expect(
        footprint.storedValues.filter((value) => value.includes(trace)),
        `the marketing page kept "${trace}" on the device`
      ).toEqual([]);
    }

    await entry.click();
    await expect(page).toHaveURL(new RegExp(ROUTES.CHAT));

    await hourlyHoldsOnlyVisitor((hour) =>
      GROWTH_REDIS_KEYS.events.buildKey(hour, campaign, eventName, ROUTES.MARKETING)
    );

    // ---- The reduction ----------------------------------------------------
    const rolled: string[] = [];
    for (const hour of beacons.hours()) rolled.push(await rollupHour(operator, hour));
    expect(rolled, 'the hour this run counted in reduced to nothing').toContain('rolled');

    await assertRolledRows(reader, beacons.readWindow(), campaign, eventName);
  });
});
