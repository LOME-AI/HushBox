/**
 * The harness the `growth-screen.*.test.tsx` suites render the growth screen
 * through: the wire fixtures its reads answer with, the fetch stub that serves
 * them, the toolbar actions a case drives, and the queries a case asks of the
 * rendered screen.
 *
 * One module rather than a copy per suite: the fixtures are the suites' shared
 * account of what the screen's reads return, so copies would have to agree with
 * nothing watching them (`docs/CODE-RULES.md` §One Implementation, Shared).
 *
 * The `.setup.` name segment is what marks this a test-only module
 * (`packages/config/test-file-spellings.ts`). It keeps the file out of the
 * coverage scope, where under a plain name it is measured as product source
 * and fails the per-file branch threshold. It also matches the test-file glob
 * that every lint escape hatch reading the `test-support/` directory accepts
 * beside it, so the directory says where the module lives and adds no
 * exemption the name does not already carry.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, vi, afterEach, beforeAll, beforeEach } from 'vitest';
import { z } from 'zod';
import { GROWTH_PRODUCT_ENTRY_FAMILY } from '@hushbox/shared';
import { DAY_MS, HOUR_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { opCatalog } from '@/test-utils/op-catalog';
import { GrowthScreen } from '../growth-screen.js';
import { formatWeekLabel } from '../growth-window.js';
import type { GrowthWindow } from '../use-growth-reads.js';
import type {
  AdminOpContractName,
  AdminOpsCatalog,
  GrowthCampaignWire,
  GrowthEventRowWire,
  GrowthFreshnessWire,
  GrowthFunnelWeekWire,
  GrowthGrain,
  GrowthMarketingRowWire,
  GrowthReachRowWire,
  GrowthSourceCountWire,
} from '@hushbox/shared';

// The reference day is a Thursday, so the week the screen opens on began three days earlier.
const NOW = new Date(TEST_DAY_START);

export const WEEK_START = TEST_DAY_START - 3 * DAY_MS;

/** A one-region topology, so the map panel has geometry to draw in the test DOM. */
const GEOMETRY = {
  type: 'Topology',
  transform: { scale: [0.01, 0.01], translate: [0, 0] },
  arcs: [
    [
      [0, 0],
      [100, 0],
      [0, 100],
      [-100, 0],
      [0, -100],
    ],
  ],
  objects: {
    countries: {
      type: 'GeometryCollection',
      geometries: [
        { type: 'Polygon', id: '840', arcs: [[0]], properties: { name: 'United States' } },
      ],
    },
  },
};

/**
 * The test runtime's own handle on the DOM implementation, which the standard
 * `Window` type does not carry. Asserted rather than declared because it is the
 * implementation speaking about itself, not a contract this file stands in for.
 */
interface TestRuntimeWindow {
  readonly happyDOM: {
    readonly settings: {
      readonly navigation: {
        disableChildFrameNavigation: boolean;
        disableFallbackToSetURL: boolean;
      };
    };
  };
}

/**
 * Registers the lifecycle every suite over this screen runs under: the test
 * runtime's own navigation settings, the fixed clock, and the teardown that
 * puts both back. A suite calls this at its top level because a hook belongs to
 * the file that registers it, so a registration performed inside this module
 * would attach to nothing.
 */
export function installGrowthScreenHarness(): void {
  beforeAll(() => {
    // The DOM implementation fetches an iframe's `src` for real, and the overlay
    // frames one. Nothing serves the framed page here, so the request only aborts
    // noisily at teardown; navigation off leaves the frame its own blank document,
    // which the overlay cases below fill themselves.
    const navigation = (globalThis as unknown as TestRuntimeWindow).happyDOM.settings.navigation;
    navigation.disableChildFrameNavigation = true;
    navigation.disableFallbackToSetURL = true;
  });

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
  });

  afterEach(resetGrowthScreenHarness);
}

/**
 * Puts back what {@link installGrowthScreenHarness} changed for the duration of
 * one case. Exported so a case can exercise it, which the hook alone cannot be.
 *
 * The unmount is first and the clock second, and the order is load-bearing. A
 * chart's store batches its notifications behind `requestAnimationFrame` with a
 * 100ms timer as the fallback, and only one of that pair belongs to the DOM
 * implementation: the test runtime leaves Node's own `setTimeout` in place while
 * it installs the emulator's `requestAnimationFrame` and deletes it again at
 * teardown, so the frame is cancelled with the window and the fallback timer
 * outlives it, reaching a `cancelAnimationFrame` that no longer exists. Under
 * the fixed clock the pair is the clock's and is discarded with it; unmounting
 * after the clock is gone puts it on the real one, where it becomes an unhandled
 * error charged to whichever file was running.
 *
 * `@testing-library/react` also unmounts from a hook of its own, registered when
 * this module imports it — which is to say before the hook above, and therefore
 * after it, since the runner runs teardown hooks in reverse. That hook stays and
 * finds nothing to do.
 */
export function resetGrowthScreenHarness(): void {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
}

export const FUNNEL_WEEK: GrowthFunnelWeekWire = {
  week: isoAt(WEEK_START),
  campaign: 'hn-launch',
  visitorsDailySummed: 1284,
  visitorsOverflow: false,
  productEntryClicksHourlySummed: 143,
  productEntryClicksOverflow: false,
  started: 97,
  startedOverflow: false,
  finished: 41,
  verified: 36,
  activated: 29,
  returnedWeek1: 17,
  firstPaid: 6,
  revenueNanoUsd: '184000000000',
};

/**
 * What the marketing read answers with, family by family. The one relation
 * carries each family's buckets with the dimensions it does not own left null.
 */
export const MARKETING_ROWS: readonly GrowthMarketingRowWire[] = [
  {
    bucket: isoAt(WEEK_START),
    family: 'total',
    path: null,
    referrerHost: null,
    campaign: null,
    country: null,
    region: null,
    device: null,
    visitors: 500,
    landings: null,
    overflow: false,
  },
  {
    bucket: isoAt(WEEK_START),
    family: 'referrer',
    path: '/welcome',
    referrerHost: 'news.ycombinator.com',
    campaign: null,
    country: null,
    region: null,
    device: null,
    visitors: 412,
    landings: null,
    overflow: false,
  },
  {
    bucket: isoAt(WEEK_START),
    family: 'path',
    path: '/welcome',
    referrerHost: null,
    campaign: null,
    country: null,
    region: null,
    device: null,
    visitors: 480,
    landings: 300,
    overflow: false,
  },
  {
    bucket: isoAt(WEEK_START),
    family: 'geo',
    path: null,
    referrerHost: null,
    campaign: null,
    country: 'US',
    region: 'CA',
    device: 'desktop',
    visitors: 201,
    landings: null,
    overflow: false,
  },
];

/**
 * The campaign-free product-entry marginal, which only the hourly relation
 * carries: nothing counts entrants per day, so a day-grain read returns no row
 * of this family rather than a zero.
 */
export const PRODUCT_ENTRY_ROW: GrowthMarketingRowWire = {
  bucket: isoAt(WEEK_START + 10 * HOUR_MS),
  family: GROWTH_PRODUCT_ENTRY_FAMILY,
  path: null,
  referrerHost: null,
  campaign: null,
  country: null,
  region: null,
  device: null,
  visitors: 77,
  landings: null,
  overflow: false,
};

/**
 * How current each growth data set is, over the whole of that set. The two
 * signup-derived sets are grouped by week, so their newest value opens a week;
 * the other two answer the day their data runs through.
 */
const DEFAULT_FRESHNESS: GrowthFreshnessWire = {
  funnel: { grain: 'week', weekOpening: isoAt(WEEK_START).slice(0, 10) },
  sources: { grain: 'week', weekOpening: isoAt(WEEK_START).slice(0, 10) },
  marketing: { grain: 'day', runsThrough: isoAt(WEEK_START).slice(0, 10) },
  events: { grain: 'day', runsThrough: isoAt(WEEK_START).slice(0, 10) },
};

/** The one named-event row the events read answers with unless a test fixes its own. */
export const DEFAULT_EVENT_ROWS: readonly GrowthEventRowWire[] = [
  {
    hour: isoAt(WEEK_START + 10 * HOUR_MS),
    campaign: 'hn-launch',
    eventName: 'link:/signup',
    path: '/welcome',
    visitors: 121,
    overflow: false,
  },
];

const PAYLOADS: Record<string, unknown> = {
  'growth.freshness.read': { panels: { freshness: { ok: true, data: DEFAULT_FRESHNESS } } },
  'growth.funnel.read': { panels: { funnel: { ok: true, data: { weeks: [FUNNEL_WEEK] } } } },
  'growth.sources.read': {
    panels: {
      sources: {
        ok: true,
        data: {
          rows: [
            {
              userCreatedWeek: isoAt(WEEK_START),
              campaign: 'hn-launch',
              selfReportedChannel: 'podcast',
              selfReportedContext: 'post_signup',
              primarySource: 'podcast',
              accounts: 7,
            },
          ],
        },
      },
    },
  },
  'growth.campaigns.read': {
    panels: {
      campaigns: {
        ok: true,
        data: {
          rows: [
            {
              tag: 'hn-launch',
              label: 'Hacker News launch post',
              status: 'active',
              createdAt: isoAt(WEEK_START),
            },
          ],
        },
      },
    },
  },
  'growth.reach.read': {
    panels: {
      reach: {
        ok: true,
        data: {
          rows: [
            {
              landingPath: '/welcome',
              reachedPath: '/pricing',
              visitorsDailySummed: 402,
              overflow: false,
            },
          ],
        },
      },
    },
  },
};

export const GROWTH_READ_OPS: readonly AdminOpContractName[] = [
  'growth.freshness.read',
  'growth.funnel.read',
  'growth.marketing.read',
  'growth.sources.read',
  'growth.campaigns.read',
  'growth.events.read',
  'growth.reach.read',
];

function catalogFor(names: readonly AdminOpContractName[]): AdminOpsCatalog {
  return opCatalog(...names);
}

/** The payloads a test replaced, keyed by the read each one answers. */
function overriddenPayloads(options: StubOptions): Partial<Record<AdminOpContractName, unknown>> {
  const { freshness, funnelWeeks, campaigns, reachRows, sourceRows } = options;
  return {
    ...(freshness === undefined
      ? {}
      : { 'growth.freshness.read': { panels: { freshness: { ok: true, data: freshness } } } }),
    ...(funnelWeeks === undefined
      ? {}
      : {
          'growth.funnel.read': { panels: { funnel: { ok: true, data: { weeks: funnelWeeks } } } },
        }),
    ...(campaigns === undefined
      ? {}
      : {
          'growth.campaigns.read': {
            panels: { campaigns: { ok: true, data: { rows: campaigns } } },
          },
        }),
    ...(reachRows === undefined
      ? {}
      : { 'growth.reach.read': { panels: { reach: { ok: true, data: { rows: reachRows } } } } }),
    ...(sourceRows === undefined
      ? {}
      : {
          'growth.sources.read': { panels: { sources: { ok: true, data: { rows: sourceRows } } } },
        }),
  };
}

/** The payload a read answers with, with the fixtures a test may replace. */
function payloadFor(name: AdminOpContractName, options: StubOptions): unknown {
  return overriddenPayloads(options)[name] ?? PAYLOADS[name];
}

/** A campaign row shaped as the campaigns read returns one. */
export function campaignRow(tag: string): GrowthCampaignWire {
  return { tag, label: tag, status: 'active', createdAt: isoAt(WEEK_START) };
}

interface StubOptions {
  readonly catalogOps?: readonly AdminOpContractName[];
  readonly failing?: ReadonlySet<string>;
  /** Reads that never answer, so a panel drawing on one stays in flight. */
  readonly pending?: ReadonlySet<string>;
  /** How current each data set is, for the line that states the data's edge. */
  readonly freshness?: GrowthFreshnessWire;
  readonly funnelWeeks?: readonly GrowthFunnelWeekWire[];
  readonly campaigns?: readonly GrowthCampaignWire[];
  readonly eventRows?: readonly GrowthEventRowWire[];
  /** Whether the events read answers with pages after the one it returns. */
  readonly eventsHaveMore?: boolean;
  readonly marketingRows?: readonly GrowthMarketingRowWire[];
  /** Marketing rows chosen by the window the read asked for, so two ranges answer differently. */
  readonly marketingRowsByWindow?: (window: GrowthWindow) => readonly GrowthMarketingRowWire[];
  /** Marketing rows chosen by the grain the read asked for, so the two relations answer differently. */
  readonly marketingRowsByGrain?: (grain: GrowthGrain) => readonly GrowthMarketingRowWire[];
  readonly reachRows?: readonly GrowthReachRowWire[];
  readonly sourceRows?: readonly GrowthSourceCountWire[];
}

/** The body a windowed read is sent with, as the typed client serializes it. */
const readBodySchema = z.object({ input: z.object({ from: z.string(), to: z.string() }) });

/** The marketing read's own body, which names a grain as well as a window. */
const marketingBodySchema = z.object({
  input: z.object({ from: z.string(), to: z.string(), grain: z.enum(['hour', 'day']) }),
});

/** The body the typed client sent, as text. */
function bodyText(init: RequestInit | undefined): string {
  return typeof init?.body === 'string' ? init.body : '{}';
}

/** The window a read asked for, read back out of the body the typed client sent. */
export function requestedWindow(init: RequestInit | undefined): GrowthWindow {
  return readBodySchema.parse(JSON.parse(bodyText(init))).input;
}

/** The grain a marketing read asked for, read back out of its body. */
function requestedGrain(init: RequestInit | undefined): GrowthGrain {
  return marketingBodySchema.parse(JSON.parse(bodyText(init))).input.grain;
}

/** The events read's own body, which names the page as well as a window. */
const eventsBodySchema = z.object({ input: z.object({ page: z.number() }) });

/** The page an events read asked for, read back out of its body. */
export function requestedPage(init: RequestInit | undefined): number {
  return eventsBodySchema.parse(JSON.parse(bodyText(init))).input.page;
}

/**
 * What the events read answers with: the rows a test fixed, on the page the
 * read asked for. The page is echoed rather than fixed because the real read
 * echoes it, and a stub answering page 0 to every request leaves the pager
 * unable to advance past its first page at all.
 */
function eventsPayload(options: StubOptions, init: RequestInit | undefined): unknown {
  return {
    panels: {
      events: {
        ok: true,
        data: {
          page: requestedPage(init),
          pageSize: 200,
          hasMore: options.eventsHaveMore ?? false,
          rows: options.eventRows ?? DEFAULT_EVENT_ROWS,
        },
      },
    },
  };
}

/**
 * The rows a marketing read answers with: whatever a test fixed, or the default
 * families at the grain asked for. Only the hourly relation carries the
 * product-entry family, so the default follows the relation rather than
 * answering every read alike.
 */
function marketingRowsFor(
  options: StubOptions,
  init: RequestInit | undefined
): readonly GrowthMarketingRowWire[] {
  const byWindow = options.marketingRowsByWindow;
  if (byWindow !== undefined) return byWindow(requestedWindow(init));
  const byGrain = options.marketingRowsByGrain;
  if (byGrain !== undefined) return byGrain(requestedGrain(init));
  if (options.marketingRows !== undefined) return options.marketingRows;
  return requestedGrain(init) === 'hour' ? [...MARKETING_ROWS, PRODUCT_ENTRY_ROW] : MARKETING_ROWS;
}

/**
 * What one read answers with. The two reads whose answer depends on what was
 * asked for read it back off the request: the marketing relation answers by
 * window and grain, and the events read echoes the page.
 */
function payloadOf(
  name: AdminOpContractName,
  options: StubOptions,
  init: RequestInit | undefined
): unknown {
  if (name === 'growth.marketing.read') {
    return {
      panels: {
        marketing: { ok: true, data: { grain: 'day', rows: marketingRowsFor(options, init) } },
      },
    };
  }
  if (name === 'growth.events.read') return eventsPayload(options, init);
  return payloadFor(name, options);
}

export function stubFetch(options: StubOptions = {}): ReturnType<typeof vi.fn> {
  const {
    catalogOps = GROWTH_READ_OPS,
    failing = new Set<string>(),
    pending = new Set<string>(),
  } = options;
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(typeof input === 'object' && 'url' in input ? input.url : input);
    if (url.startsWith('/geo/')) {
      return Promise.resolve(Response.json(GEOMETRY, { status: 200 }));
    }
    if (url.includes('/admin/ops') && !url.includes('/execute')) {
      return Promise.resolve(Response.json(catalogFor(catalogOps), { status: 200 }));
    }
    const name = GROWTH_READ_OPS.find((op) => url.includes(`/ops/${op}/execute`));
    if (name === undefined)
      return Promise.resolve(Response.json({ code: 'NOT_FOUND' }, { status: 404 }));
    if (pending.has(name)) {
      return new Promise<Response>(() => undefined);
    }
    if (failing.has(name)) {
      return Promise.resolve(Response.json({ code: 'UNAVAILABLE' }, { status: 503 }));
    }
    const payload = payloadOf(name, options, init);
    return Promise.resolve(
      Response.json(
        { kind: 'read', auditId: '00000000-0000-7000-8000-000000000000', data: payload },
        { status: 200 }
      )
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

export function renderScreen(): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <GrowthScreen />
    </QueryClientProvider>
  );
}

export async function screenReady(): Promise<void> {
  await settleFrame();
  await waitFor(() => {
    expect(screen.getByRole('heading', { name: 'Growth', level: 1 })).toBeInTheDocument();
  });
  await settleFrame();
}

/**
 * Lets the overlay's frame report the document it holds, which it does on its
 * own and after the render call that mounted it has returned.
 */
export async function settleFrame(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

/**
 * Narrows the page to campaigns, through the popover the toolbar holds them in.
 * The list is out of the document while the trigger is closed, so a case that
 * narrows the page opens it, chooses, and closes it again; passing a tag twice
 * selects and then deselects it, exactly as two clicks on the box do.
 */
export async function chooseCampaigns(...tags: readonly string[]): Promise<void> {
  await userEvent.click(await screen.findByRole('button', { name: /^Campaigns/ }));
  for (const tag of tags) {
    await userEvent.click(await screen.findByRole('checkbox', { name: tag }));
  }
  await userEvent.keyboard('{Escape}');
}

/** Picks a week through the toolbar's week menu, by the week it opens on. */
export async function chooseWeek(weekOpeningMs: number): Promise<void> {
  await userEvent.click(screen.getByRole('combobox', { name: /^Week/ }));
  await userEvent.click(
    await screen.findByRole('option', { name: formatWeekLabel(new Date(weekOpeningMs)) })
  );
}

/** Puts the visitor series on a grain, through the toolbar's segmented control. */
export async function chooseGrain(grain: 'Day' | 'Hour'): Promise<void> {
  await userEvent.click(screen.getByRole('radio', { name: grain }));
}

/** One panel's own section, so an assertion cannot read a sibling panel's text. */
export function panelNamed(title: string): HTMLElement {
  const section = screen.getByRole('heading', { name: title }).closest('section');
  if (section === null) throw new Error(`no panel section around ${title}`);
  return section;
}

/** The sentence one panel states about the controls, as an operator reads it. */
export function scopeNoteOf(title: string): string {
  const note = panelNamed(title).querySelector('[data-slot="panel-scope-note"]');
  if (note === null) throw new Error(`no scope note on ${title}`);
  return note.textContent;
}

/** The panel the visitor series is drawn in, by its heading. */
export const SERIES_PANEL = 'Visitors';

/** What every panel carrying no campaign dimension states about the campaign selection. */
export const NO_CAMPAIGN_CLAUSE =
  'Counts every campaign, not the selection above: these counts carry no campaign.';

/** The panel the four leading figures are drawn in, by its heading. */
export const HEADLINE_PANEL = 'This week';

/**
 * The four tiles themselves, apart from the table of trend points below them —
 * the same figure appears in both, so an assertion about a tile has to say so.
 */
export function headlineTiles(): HTMLElement {
  const tiles = panelNamed(HEADLINE_PANEL).querySelector('[data-slot="headline-tiles"]');
  if (tiles === null) throw new Error('no tile grid in the leading figures');
  return tiles as HTMLElement;
}
