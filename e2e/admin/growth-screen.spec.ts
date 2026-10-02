import {
  ADMIN_PREVIEW_PREFIX,
  GROWTH_BEACON_PATH,
  ROUTES,
  TEST_IDS,
  TEST_ID_BUILDERS,
} from '@hushbox/shared';

import { test as base, expect } from './fixtures.js';
import { expectConsoleErrors } from '../fixtures.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
import { TIMEOUTS } from '../config/timeouts.js';
import { requireEnv } from '../helpers/env.js';
import {
  GROWTH_ACTORS,
  mintCampaign,
  mintGrowthAdminContext,
  rollupHour,
} from '../helpers/growth-admin.js';
import { openBeaconWindow, openGrowthStore } from '../helpers/growth-counts.js';
import { committedEventNames } from '../helpers/growth-page.js';
import { guestIp } from '../helpers/guest-identity.js';
import { expectOkResponse } from '../helpers/ok-response.js';
import { withProjectHeaders } from '../helpers/project-headers.js';
import type { ConsoleErrorMatcher } from '../fixtures.js';
import type { BeaconBody } from '@hushbox/shared';
import type { GrowthStore } from '../helpers/growth-counts.js';
import type { APIRequestContext, Locator, Page } from './fixtures.js';

const SPEC_MATRIX = matrix({ engine: 'engine-fixed', formFactor: 'desktop' });

/**
 * The two widths the section rail behaves differently at. The growth header is
 * pinned only from `md` up, so above the breakpoint a jumped-to heading has
 * chrome to clear and below it has none — and the rail's mark is derived from
 * the same edge either way. Both are walked because the mark reads the shell's
 * scroll container, whose offset from the viewport top is not the same at the
 * two widths.
 */
const WIDE_VIEWPORT = { width: 1440, height: 900 } as const;
const NARROW_VIEWPORT = { width: 375, height: 860 } as const;

const apiUrl = requireEnv('VITE_API_URL');

/**
 * The last hop of the growth chain, and the only one no specification covers:
 * the admin Growth screen, opened by the read-only role it exists to serve.
 *
 * WHERE THIS BEGINS AND WHERE IT STOPS. `e2e/marketing-analytics.spec.ts` walks
 * a browser visit through the beacon, the counting store and the real reduction
 * to the operations an operator reads them through, and ends there. This one
 * begins where that ends: it seeds its figures through the same writers without
 * a browser, and everything it asserts is on the screen. Neither asserts the
 * other's half, so a failure here is about rendering and authorization and a
 * failure there is about counting.
 *
 * WHAT A SEEDED FIGURE PROVES, AND WHAT IT DOES NOT. It proves the screen
 * renders a figure that is in the table under the campaign this run minted; it
 * does not prove the product put it there, which is the other specification's
 * claim.
 *
 * WHY "THE SCREEN LOADED" IS NOT THE ASSERTION. Every panel here distinguishes
 * three outcomes — still in flight, failed with a code, answered — because a
 * panel that drew a failed read's empty rows would show an outage as a fact
 * about the product. A specification asserting only that the screen appeared
 * would pass on all three, so the claim is that no panel is in either unanswered
 * state and the figures on screen are the ones this run seeded.
 */

/** How many distinct visitors this run counts under its own campaign tag. */
const SEEDED_VISITORS = 3;

/** The click this run counts — a name the built page index carries for the landing page. */
const SEEDED_EVENT = `link:${ROUTES.CHAT}`;

/**
 * One seeded visitor's user agent.
 *
 * The visitor identity is a keyed hash over the caller's address and user
 * agent, and the address space this suite presents is one address per project
 * and worker slot — so the user agent is the axis a specification may vary, and
 * varying it is what makes these three distinct visitors rather than one seen
 * three times. An ordinary desktop agent, because the counter drops a beacon
 * whose agent reads as a robot.
 */
function seededUserAgent(visitor: number): string {
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/1${String(visitor)}0.0.0.0 Safari/537.36`;
}

interface GrowthFixtures {
  growth: {
    /** The counting store, for the one write it offers: dropping the cached campaign list. */
    readonly store: GrowthStore;
    /** The operator that mints this run's campaign and forces the reduction. */
    readonly operator: APIRequestContext;
    /** Counts one beacon under a visitor identity of this run's own. */
    readonly countAs: (visitor: number, beacon: BeaconBody) => Promise<void>;
  };
}

const test = base.extend<GrowthFixtures>({
  growth: async ({ playwright }, use) => {
    const store = await openGrowthStore(playwright.request);
    const operator = await mintGrowthAdminContext(playwright.request, GROWTH_ACTORS.operator);
    const visitors: APIRequestContext[] = [];

    const countAs = async (visitor: number, beacon: BeaconBody): Promise<void> => {
      const context = await playwright.request.newContext({
        baseURL: apiUrl,
        extraHTTPHeaders: withProjectHeaders({
          'cf-connecting-ip': guestIp(),
          'user-agent': seededUserAgent(visitor),
          'content-type': 'text/plain',
        }),
      });
      visitors.push(context);
      const response = await context.post(GROWTH_BEACON_PATH, { data: JSON.stringify(beacon) });
      // The counter answers everything it accepts, and every failure it meets,
      // with 204 — so this says the request was well formed and arrived, and
      // nothing more. Whether it was counted is the figure on screen below.
      await expectOkResponse(response, `the beacon for seeded visitor ${String(visitor)}`, 204);
    };

    try {
      await use({ store, operator, countAs });
    } finally {
      await store.dispose();
      await operator.dispose();
      for (const context of visitors) await context.dispose();
    }
  },
});

/** The campaign tag this run counts under, minted fresh so nothing else can write its sets. */
function specCampaignTag(): string {
  return `e2e-growth-screen-${crypto.randomUUID().slice(0, 8)}`;
}

/** The screens this role's navigation offers, as the list it renders. */
function navScreens(page: Page): Locator {
  return page.getByTestId(TEST_IDS.adminNav).getByRole('listitem');
}

/** One entry of the navigation, which is how every visit here arrives. */
function navLink(page: Page, screen: string): Locator {
  return page.getByTestId(TEST_IDS.adminNav).getByRole('link', { name: screen });
}

/** Every Growth panel whose reads have done `state`. */
function panelsIn(page: Page, state: 'pending' | 'failed' | 'answered'): Locator {
  return page.getByTestId(TEST_ID_BUILDERS.adminGrowthPanel(state));
}

/**
 * Every Growth panel, in whatever state — the union of the three rather than a
 * pattern, so the one place a frame's anchor is spelled stays the builder.
 */
function growthPanels(page: Page): Locator {
  return panelsIn(page, 'answered').or(panelsIn(page, 'failed')).or(panelsIn(page, 'pending'));
}

/**
 * Every panel that has not answered, as the text each one shows.
 *
 * Read as text rather than counted because a failure has to name the panel: an
 * unanswered frame carries its own title and, when it failed, the code it failed
 * with. A screen holding no panels at all answers with a sentence instead, which
 * no empty expectation can match — an emptiness claim alone is satisfied by a
 * page that has rendered nothing, which is the outcome this assertion exists to
 * separate from success.
 */
async function unansweredPanels(page: Page): Promise<readonly string[]> {
  const [total, unanswered] = await Promise.all([
    growthPanels(page).count(),
    panelsIn(page, 'failed').or(panelsIn(page, 'pending')).allInnerTexts(),
  ]);
  return total === 0 ? ['the Growth screen rendered no panel at all'] : unanswered;
}

/** The panel holding the named-event figures, once its read has answered. */
function namedEventsPanel(page: Page): Locator {
  return panelsIn(page, 'answered').filter({ hasText: 'Named events' });
}

/** The campaign mutation's control, which only an operator's catalogue draws. */
function createCampaignControl(page: Page): Locator {
  return page.getByRole('button', { name: 'Create campaign' });
}

/**
 * The toolbar control the campaign multi-select sits behind, named for what it
 * narrows and for how much of the list the selection covers. Matched on the
 * name's opening word because the rest of it counts the selection, which is
 * what this specification is about to change.
 */
function campaignControl(page: Page): Locator {
  return page.getByRole('button', { name: /^Campaigns/ });
}

/**
 * What the browser reports about the framed marketing page, which is not this
 * screen's fault.
 *
 * One panel frames the site's own page from the copy the admin origin serves,
 * sandboxed with no permission to run script, and the browser logs an error
 * for each script on that page it refuses to run. That refusal is the frame's
 * containment working rather than a fault of it. Allowed by WHERE it comes
 * from, the framed copy's own path, so nothing the admin app itself logs is
 * covered by it.
 */
const framedPageNoise: ConsoleErrorMatcher = (error) =>
  error.url.includes(`/${ADMIN_PREVIEW_PREFIX}/`);

/** The frame the click overlay draws the marketing copy in. */
function overlayFrame(page: Page): Locator {
  return page.getByTitle(/^Marketing page /);
}

/**
 * Where the overlay's badges are drawn against the page they badge, read as one
 * value so a failure prints all of it.
 *
 * The badges sit on one layer in the framed page's own document coordinates, so
 * they are aligned exactly when that layer is drawn where the framed document
 * is: its top offset by the frame's scroll, and its height the document's own.
 * A scroll the overlay never heard of leaves the layer at the top while the
 * document moves under it; a page that grew without the overlay hearing of it
 * leaves the layer the height the page used to be.
 *
 * Read from this page's realm, as the overlay itself reads it: the framed page
 * runs no script, so nothing can be asked of it from the inside.
 */
interface OverlayAlignment {
  readonly framedPageScrolledBy: number;
  /** Screen pixels between the badge layer's top and the framed document's, unsigned. */
  readonly layerPastTheDocument: number;
  /** Framed-page pixels between the badge layer's height and the document's, unsigned. */
  readonly layerHeightPastTheDocument: number;
}

async function overlayAlignment(frame: Locator): Promise<OverlayAlignment> {
  return frame.evaluate((element) => {
    if (!(element instanceof HTMLIFrameElement))
      throw new Error('the overlay frame is not a frame');
    const framedDocument = element.contentDocument;
    const framedWindow = element.contentWindow;
    const layer = element.parentElement?.querySelector('[data-slot="overlay-document-layer"]');
    if (framedDocument === null || framedWindow === null || !(layer instanceof HTMLElement)) {
      throw new Error('the overlay frame or its badge layer is unreadable');
    }
    const frameBox = element.getBoundingClientRect();
    const scale = frameBox.width / element.offsetWidth;
    const documentTop = framedDocument.documentElement.getBoundingClientRect().top * scale;
    return {
      framedPageScrolledBy: Math.round(framedWindow.scrollY),
      layerPastTheDocument: Math.round(
        Math.abs(layer.getBoundingClientRect().top - frameBox.top - documentTop)
      ),
      layerHeightPastTheDocument: Math.round(
        Math.abs(layer.offsetHeight - framedDocument.documentElement.scrollHeight)
      ),
    };
  });
}

/**
 * How many badges the overlay has drawn over the framed page. Read through the
 * frame's own stage, which holds both of the overlay's layers and nothing else
 * on the screen.
 */
async function badgeCount(frame: Locator): Promise<number> {
  return frame.evaluate(
    (element) =>
      element.parentElement?.querySelectorAll('[data-slot="overlay-badge"]').length ?? Number.NaN
  );
}

/** Whether the framed page and this screen are each in the dark theme, read together. */
async function themes(page: Page): Promise<{ readonly screen: boolean; readonly framed: boolean }> {
  const [screen, framed] = await Promise.all([
    page.evaluate(() => document.documentElement.classList.contains('dark')),
    overlayFrame(page).evaluate((element) =>
      element instanceof HTMLIFrameElement
        ? (element.contentDocument?.documentElement.classList.contains('dark') ?? false)
        : false
    ),
  ]);
  return { screen, framed };
}

/** Where the shell sits, which is the whole of what a fragment jump may not move. */
interface ShellPosition {
  readonly documentScrollTop: number;
  /** How far the document itself could scroll, which the shell intends to be none. */
  readonly documentScrollRange: number;
  readonly topbarTop: number | 'the topbar is not on the screen';
}

/** How far past its own edge each part of the topbar row hangs. */
interface RowOverhang {
  readonly topbarPastItsBox: number;
  readonly shellPastItsBox: number;
  /** The trailing control's right edge beyond the viewport's, floored at zero. */
  readonly themeControlPastTheViewport: number;
}

/**
 * The shell's own position, read as one value so a failure prints all of it.
 *
 * `apps/admin/src/app.css` states that the document never scrolls and every
 * scrollable region is an explicit overflow container. A scroll range on the
 * document is that guarantee broken from inside: out-of-flow content whose
 * containing block is the viewport rather than the container it was written in
 * contributes its overflow to the document, and a fragment jump then aligns the
 * target inside every ancestor scroll container in turn — the container first,
 * the document after, taking the topbar with it.
 */
async function shellPosition(page: Page): Promise<ShellPosition> {
  const [scroll, topbar] = await Promise.all([
    page.evaluate(() => ({
      documentScrollTop: document.scrollingElement?.scrollTop ?? 0,
      documentScrollRange: document.documentElement.scrollHeight - window.innerHeight,
    })),
    page.getByTestId(TEST_IDS.adminTopbar).boundingBox(),
  ]);
  return {
    ...scroll,
    topbarTop: topbar === null ? 'the topbar is not on the screen' : topbar.y,
  };
}

/** The shell unmoved: no scroll range to take, none taken, topbar still there. */
const SHELL_AT_REST: ShellPosition = {
  documentScrollTop: 0,
  documentScrollRange: 0,
  topbarTop: 0,
};

/**
 * What the topbar's row, the shell around it, and the last control in the row
 * each hang past their own box, read as one value so a failure prints all of it.
 *
 * Widths and edges rather than a scroll position: the shell wrapper is
 * `overflow-x: hidden`, which is still programmatically scrollable, so a click
 * on a control outside the clip leaves a scroll offset behind that describes
 * the driver's own actionability scrolling as much as the page.
 *
 * The theme control stands for the row's trailing end because it is drawn last
 * in it; nothing in the row sits further right, so a theme control inside the
 * viewport is a row inside the viewport.
 */
async function rowOverhang(page: Page): Promise<RowOverhang> {
  const [boxes, theme] = await Promise.all([
    page.evaluate(
      ([topbarId, shellId]) => {
        const past = (id: string): number => {
          const el = document.querySelector(`[data-testid="${id}"]`);
          return el === null ? Number.NaN : el.scrollWidth - el.clientWidth;
        };
        return { topbarPastItsBox: past(topbarId), shellPastItsBox: past(shellId) };
      },
      [TEST_IDS.adminTopbar, TEST_IDS.adminShell] as const
    ),
    page.getByTestId(TEST_IDS.themeToggle).boundingBox(),
  ]);
  const viewport = page.viewportSize();
  return {
    ...boxes,
    themeControlPastTheViewport:
      theme === null || viewport === null
        ? Number.NaN
        : Math.max(0, theme.x + theme.width - viewport.width),
  };
}

/** Nothing past any edge: the whole row is on the screen and reachable. */
const NOTHING_OVERHANGS: RowOverhang = {
  topbarPastItsBox: 0,
  shellPastItsBox: 0,
  themeControlPastTheViewport: 0,
};

/** The rail of section links the screen groups its panels under. */
function sectionRail(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Growth sections' });
}

/** How far the scrollable region the screen is drawn inside has scrolled. */
function mainScrollTop(page: Page): Promise<number> {
  return page.getByRole('main').evaluate((main) => main.scrollTop);
}

/**
 * Follows every section link and holds two properties on each jump: the shell
 * does not move, and the link the rail marks is the section the URL now names.
 *
 * Per link rather than once at the end, because how far a jump moves the shell
 * depends on how far down the page it lands — the last section moved it further
 * than the first — and a failure has to name the link it happened on.
 */
async function followEverySectionLink(page: Page, width: number): Promise<void> {
  const at = `at ${String(width)}px`;
  const links = await sectionRail(page).getByRole('link').all();
  expect(links.length, `the section rail draws no links ${at}`).toBeGreaterThan(0);

  for (const link of links) {
    const fragment = await link.getAttribute('href');
    const jumped = `following ${String(fragment)} ${at}`;
    await link.click();

    await expect(page, `${jumped} left the URL naming something else`).toHaveURL(
      new RegExp(`${String(fragment)}$`)
    );
    await expect(
      link,
      `${jumped} left the rail marking a section other than the one the URL names`
    ).toHaveAttribute('aria-current', 'location');
    await expect
      .poll(() => shellPosition(page), {
        message: `${jumped} scrolled the shell itself, which takes the topbar off screen`,
      })
      .toEqual(SHELL_AT_REST);
  }
}

test.describe('Admin growth screen', SPEC_MATRIX, () => {
  test('the growth reader opens the Growth screen from the navigation and reads the figures it was seeded', async ({
    adminPage,
    growth,
  }) => {
    // One seeding round, three navigations and a screen's worth of reads under
    // two identities sit inside one journey; the per-test default is sized for
    // a single flow.
    test.setTimeout(TIMEOUTS.XLONG);
    expectConsoleErrors(adminPage, [framedPageNoise]);

    const { store, operator, countAs } = growth;
    const campaign = specCampaignTag();

    // ---- The seed -------------------------------------------------------
    // The tag has to stand in the campaigns table before the first beacon, or
    // every count folds to the unknown sentinel and the figure below is one
    // this run cannot claim.
    await mintCampaign(operator, campaign);
    await store.forgetActiveCampaigns();

    expect(
      committedEventNames(ROUTES.MARKETING),
      `the committed click-name index carries no "${SEEDED_EVENT}" for ${ROUTES.MARKETING}, and the counter drops every name that is not in it`
    ).toContain(SEEDED_EVENT);

    const counted = openBeaconWindow();
    for (let visitor = 0; visitor < SEEDED_VISITORS; visitor += 1) {
      await countAs(visitor, { t: 'e', p: ROUTES.MARKETING, n: SEEDED_EVENT, c: campaign });
    }

    // The seed's own receipt rather than a claim about the reduction: a run that
    // reduced nothing has seeded nothing, and saying so here is what keeps a
    // failed seed from reading as a screen that renders no figure.
    const reduced: string[] = [];
    for (const hour of counted.hours()) reduced.push(await rollupHour(operator, hour));
    expect(reduced, 'the hour this run seeded into reduced to nothing').toContain('rolled');

    // ---- The operator's screen, which holds the other side of the claim ----
    await navLink(adminPage, 'Growth').click();
    await expect(adminPage).toHaveURL(/\/growth$/);
    await expect(
      createCampaignControl(adminPage),
      'the campaign control is absent for an operator too, so its absence below says nothing about the role'
    ).toBeVisible();

    // ---- The identity, changed through the interface's own control ---------
    // On the operations catalogue rather than on the dashboard: the switch drops
    // everything the previous identity read, so whatever screen is mounted
    // refetches under the new one, and this is the screen both identities may
    // read.
    await navLink(adminPage, 'Ops catalog').click();
    await expect(adminPage).toHaveURL(/\/ops$/);
    await adminPage
      .getByTestId(TEST_IDS.adminActorSwitcher)
      .getByRole('button', { name: GROWTH_ACTORS.reader })
      .click();

    // What the navigation offers this role, which is also how it reaches the
    // screen: the one screen the role is drawn for, and no other.
    await expect(navScreens(adminPage)).toHaveText(['Growth']);

    // ---- The reader's screen ----------------------------------------------
    await navLink(adminPage, 'Growth').click();
    await expect(adminPage).toHaveURL(/\/growth$/);

    // Narrowed to this run's own campaign, which is what makes the figure below
    // exactly this run's: the named-events read takes one tag, and every set
    // under this one was written by these three visitors and nobody else.
    //
    // The boxes are in the toolbar's popover, which keeps them out of the
    // document while it is closed, so the control is opened first and dismissed
    // after: an open popover covers the panels the assertions below read.
    await campaignControl(adminPage).click();
    await adminPage.getByRole('checkbox', { name: campaign }).check();
    await adminPage.keyboard.press('Escape');

    // Every panel on the screen is answered: none still in flight, none standing
    // for a failure, and at least one panel there to be either. Stated over the
    // panels the screen actually holds rather than against a count of them, so a
    // panel added later is covered without anyone remembering to raise a number.
    await expect
      .poll(() => unansweredPanels(adminPage), {
        message: 'the Growth screen has a panel that never answered or that failed',
      })
      .toEqual([]);

    // The figure, exactly: one row naming the click, the page it happened on,
    // and the visitors this run counted under its tag — each cell stated, so a
    // failure prints which of the three is wrong.
    await expect(
      namedEventsPanel(adminPage).getByRole('row', { name: SEEDED_EVENT }).getByRole('cell'),
      'the named-events panel carries no row holding the visitors this run seeded under its campaign'
    ).toHaveText([SEEDED_EVENT, ROUTES.MARKETING, String(SEEDED_VISITORS)]);

    // And the mutation's control is gone with the role that could run it.
    //
    // A zero count is vacuous by default: it is satisfied by a page that has
    // drawn nothing, so it is a claim only downstream of the read that would
    // draw the control. That read is the operations catalogue — the control is
    // drawn from what it returned, and while it is unanswered
    // `apps/admin/src/components/growth/campaign-controls.ts` answers no — and
    // what says the catalogue answered is the navigation assertion above,
    // whose entries are derived from the same read
    // (`apps/admin/src/hooks/use-admin-role.ts`). Not the panel poll, which
    // gates the growth reads and says nothing about the catalogue. The
    // operator's own sight of this control earlier is the other side of the
    // claim: the control exists, and this role is what removes it.
    await expect(
      createCampaignControl(adminPage),
      'the campaign control an operator is drawn is on this reader screen too'
    ).toHaveCount(0);

    // ---- The shell a jump happens inside ----------------------------------
    // Asserted on this screen because it is the one that jumps: the rail's
    // links are the only in-page fragments the admin app offers a pointer, and
    // this is the load that has drawn every panel, which is what gives the
    // scrollable region a range to jump within. The property is the shell's
    // rather than this screen's, so a screen added later inherits it.
    await expect
      .poll(() => shellPosition(adminPage), {
        message:
          'the admin shell carries a document scroll range it never paints, so anything that follows a fragment scrolls the whole shell',
      })
      .toEqual(SHELL_AT_REST);

    await followEverySectionLink(adminPage, WIDE_VIEWPORT.width);
    expect(
      await mainScrollTop(adminPage),
      'the last section link scrolled nothing, so the jump above proves nothing about where it landed'
    ).toBeGreaterThan(0);

    // Below the breakpoint that pins the header, where the room a jump clears
    // is nothing and the rail derives its mark from a scrollport that starts
    // further down the viewport.
    await adminPage.setViewportSize(NARROW_VIEWPORT);

    // The topbar's own controls at this width, before anything here is clicked:
    // the search trigger and the trailing actor-and-theme group each fit the row
    // alone and do not fit it together, and a row that cannot wrap puts the
    // trailing ones past a clip with no scrollbar to reach them.
    await expect
      .poll(() => rowOverhang(adminPage), {
        message: `the admin topbar's row hangs past the viewport at ${String(NARROW_VIEWPORT.width)}px, where the shell clips it without a scrollbar`,
      })
      .toEqual(NOTHING_OVERHANGS);

    await followEverySectionLink(adminPage, NARROW_VIEWPORT.width);
    await adminPage.setViewportSize(WIDE_VIEWPORT);

    // And the same property through the skip link, which every admin screen
    // carries and which lands on the scrollable region itself. Costs nothing:
    // the screen is already loaded and no read is re-issued.
    await adminPage.getByRole('main').evaluate((main) => {
      main.scrollTop = 500;
    });
    await adminPage.getByRole('link', { name: 'Skip to content' }).press('Enter');
    await expect
      .poll(() => shellPosition(adminPage), {
        message: 'the skip link scrolled the shell instead of only moving focus into it',
      })
      .toEqual(SHELL_AT_REST);
    expect(
      await mainScrollTop(adminPage),
      'the skip link moved the content under the reader as well as the focus'
    ).toBe(500);
  });
  test('the click overlay badges the marketing copy it frames without running its scripts', async ({
    adminPage,
  }) => {
    expectConsoleErrors(adminPage, [framedPageNoise]);

    await navLink(adminPage, 'Growth').click();
    await expect(adminPage).toHaveURL(/\/growth$/);
    await expect
      .poll(() => unansweredPanels(adminPage), {
        message: 'the Growth screen has a panel that never answered or that failed',
      })
      .toEqual([]);

    const frame = overlayFrame(adminPage);
    await frame.scrollIntoViewIfNeeded();
    await expect(
      frame,
      "the overlay frames the copy with permission to run its scripts, which then act with the operator's authority on this origin"
    ).toHaveAttribute('sandbox', 'allow-same-origin');

    // Every element the page could be clicked on is badged in this view, zero
    // included, so the badges below do not depend on what was counted.
    await adminPage
      .getByRole('group', { name: 'Show' })
      .getByRole('radio', { name: 'Counts' })
      .click();
    await expect
      .poll(() => badgeCount(frame), { message: 'the overlay drew no badge over the framed page' })
      .toBeGreaterThan(0);

    // Astro takes the `ssr` mark off an island once its script has hydrated
    // it, so an island still carrying it on a loaded page is one whose script
    // never ran.
    expect(
      await frame.evaluate((element) =>
        element instanceof HTMLIFrameElement
          ? [...(element.contentDocument?.querySelectorAll('astro-island') ?? [])].filter(
              (island) => !island.hasAttribute('ssr')
            ).length
          : Number.NaN
      ),
      "an island on the framed page hydrated, so the frame ran the page's scripts"
    ).toBe(0);

    await expect
      .poll(() => overlayAlignment(frame), {
        message: 'the badge layer is not drawn where the framed page is before anything moves',
      })
      .toEqual({ framedPageScrolledBy: 0, layerPastTheDocument: 0, layerHeightPastTheDocument: 0 });

    // A scroll of the framed page, which only the overlay's own listener on
    // the frame's window can carry to the badge layer.
    const scrolledBy = 1200;
    await frame.evaluate((element, by) => {
      if (element instanceof HTMLIFrameElement) element.contentWindow?.scrollTo(0, by);
    }, scrolledBy);
    await expect
      .poll(() => overlayAlignment(frame), {
        message: 'the framed page scrolled and its badges stayed where they were',
      })
      .toEqual({
        framedPageScrolledBy: scrolledBy,
        layerPastTheDocument: 0,
        layerHeightPastTheDocument: 0,
      });

    // The framed page growing on its own, which nothing on this screen does:
    // only the overlay's resize observer on the framed document can notice it.
    await frame.evaluate((element) => {
      if (!(element instanceof HTMLIFrameElement) || element.contentDocument === null) return;
      const block = element.contentDocument.createElement('div');
      block.style.height = '1500px';
      element.contentDocument.body.append(block);
    });
    await expect
      .poll(() => overlayAlignment(frame), {
        message: 'the framed page grew and the badge layer kept the height it used to have',
      })
      .toMatchObject({ layerPastTheDocument: 0, layerHeightPastTheDocument: 0 });

    // The frame itself resized, which lays the framed page out again.
    await adminPage
      .getByRole('group', { name: 'Device' })
      .getByRole('radio', { name: 'Phone' })
      .click();
    await expect
      .poll(() => overlayAlignment(frame), {
        message: 'the frame was resized and the badges were left where the wider page put them',
      })
      .toMatchObject({ layerPastTheDocument: 0, layerHeightPastTheDocument: 0 });
    await expect
      .poll(() => badgeCount(frame), { message: 'the resized page carries no badge' })
      .toBeGreaterThan(0);

    // The framed page runs no theme bootstrap of its own, so it is in this
    // screen's theme only because the overlay put it there, and it follows a
    // switch.
    const before = await themes(adminPage);
    expect(before.framed, 'the framed page is not in the theme this screen is in').toBe(
      before.screen
    );
    await adminPage.getByTestId(TEST_IDS.themeToggle).click();
    await expect
      .poll(() => themes(adminPage), {
        message: 'the screen switched theme and the framed page stayed in the old one',
      })
      .toEqual({ screen: !before.screen, framed: !before.screen });
  });
});
