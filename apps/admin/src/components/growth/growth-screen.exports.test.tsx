import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { DAY_MS, HOUR_MS, isoAt } from '@hushbox/shared/test-time';
import { NO_LADDER_ROW_REASON, NO_MARGINAL_ROW_REASON } from './headline-figures.js';
import {
  WEEK_START,
  FUNNEL_WEEK,
  campaignRow,
  stubFetch,
  renderScreen,
  screenReady,
  chooseCampaigns,
  chooseWeek,
  panelNamed,
  HEADLINE_PANEL,
  headlineTiles,
  installGrowthScreenHarness,
} from './test-support/growth-screen-harness.setup.js';
import type { GrowthEventRowWire, GrowthMarketingRowWire } from '@hushbox/shared';

vi.mock('@/components/ops/op-modal-provider', () => ({
  useRunOp: () => vi.fn(),
}));

vi.mock('recharts', async (importOriginal) => {
  const { rechartsWithFixedContainer } =
    await import('./test-support/recharts-fixed-container.setup.js');
  return rechartsWithFixedContainer(await importOriginal<typeof import('recharts')>());
});

installGrowthScreenHarness();

describe('GrowthScreen exports', () => {
  it('offers a CSV export on each exportable panel', async () => {
    stubFetch();
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'Export CSV' }).length).toBeGreaterThan(1);
    });
  });
});

describe('GrowthScreen panel exports', () => {
  beforeEach(() => {
    // Spied rather than stubbed wholesale: replacing the URL global with a
    // plain object takes the constructor with it, and the typed client builds
    // every request URL through it.
    Object.assign(URL, {
      createObjectURL: () => 'blob:export',
      revokeObjectURL: () => undefined,
    });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:export');
    vi.spyOn(URL, 'revokeObjectURL');
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Every file the screen handed over during a test, in the order it wrote them. */
  function capturedExports(): Blob[] {
    const written: Blob[] = [];
    vi.mocked(URL.createObjectURL).mockImplementation((blob: Blob | MediaSource) => {
      written.push(blob as Blob);
      return 'blob:export';
    });
    return written;
  }

  /** The line an export whose read answered in one page, unnarrowed, opens with. */
  function preamble(name: string): string {
    return `${name}: the read behind this export answered in one page. No campaign selection narrowed these rows.`;
  }

  /** The file one panel's export button writes, as the text a reader opens. */
  async function exportedText(panelTitle: string, written: readonly Blob[]): Promise<string> {
    await userEvent.click(
      within(panelNamed(panelTitle)).getByRole('button', { name: 'Export CSV' })
    );
    const file = written.at(-1);
    if (file === undefined) throw new Error(`no file was written for ${panelTitle}`);
    return file.text();
  }

  /** One referrer-family marketing row, the family the referrers panel is built from. */
  function referrerRow(visitors: number, overflow: boolean): GrowthMarketingRowWire {
    return {
      bucket: isoAt(WEEK_START),
      family: 'referrer',
      path: '/welcome',
      referrerHost: 'news.ycombinator.com',
      campaign: null,
      country: null,
      region: null,
      device: null,
      visitors,
      landings: null,
      overflow,
    };
  }

  it('writes a referring host whose figure is exact as not having reached the ceiling', async () => {
    const written = capturedExports();
    stubFetch({ marketingRows: [referrerRow(412, false)] });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByText('Campaign: hn-launch')).toBeInTheDocument();
    });
    expect(await exportedText('Referrers', written)).toBe(
      `${preamble('growth-referrers')}\n` +
        'Host,"Visitors (daily uniques, summed)",Ceiling reached\nnews.ycombinator.com,412,false'
    );
  });

  it('writes a referring host whose figure is a floor as having reached the ceiling', async () => {
    const written = capturedExports();
    stubFetch({ marketingRows: [referrerRow(100_000, true)] });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByText('Campaign: hn-launch')).toBeInTheDocument();
    });
    expect(await exportedText('Referrers', written)).toBe(
      `${preamble('growth-referrers')}\n` +
        'Host,"Visitors (daily uniques, summed)",Ceiling reached\nnews.ycombinator.com,100000,true'
    );
  });

  it('writes a named event under the same ceiling column the other panels use', async () => {
    const written = capturedExports();
    stubFetch();
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByText('Campaign: hn-launch')).toBeInTheDocument();
    });
    expect(await exportedText('Named events', written)).toBe(
      `${preamble('growth-events')}\nHour,Campaign,Event,Page,People (hourly uniques),Ceiling reached\n${isoAt(WEEK_START + 10 * HOUR_MS)},hn-launch,link:/signup,/welcome,121,false`
    );
  });

  /** One hour of one named event on one page, as the events read returns it. */
  function eventRow(hour: number, visitors: number): GrowthEventRowWire {
    return {
      hour: isoAt(hour),
      campaign: 'hn-launch',
      eventName: 'link:/signup',
      path: '/welcome',
      visitors,
      overflow: false,
    };
  }

  it('writes each hour of a named event as its own row', async () => {
    const written = capturedExports();
    stubFetch({
      eventRows: [
        eventRow(WEEK_START + 10 * HOUR_MS, 121),
        eventRow(WEEK_START + 11 * HOUR_MS, 34),
      ],
    });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByText('Campaign: hn-launch')).toBeInTheDocument();
    });
    expect(await exportedText('Named events', written)).toBe(
      `${preamble('growth-events')}\nHour,Campaign,Event,Page,People (hourly uniques),Ceiling reached\n` +
        `${isoAt(WEEK_START + 10 * HOUR_MS)},hn-launch,link:/signup,/welcome,121,false\n` +
        `${isoAt(WEEK_START + 11 * HOUR_MS)},hn-launch,link:/signup,/welcome,34,false`
    );
  });

  it('says which page it holds where the read had more pages behind it', async () => {
    const written = capturedExports();
    stubFetch({ eventRows: [eventRow(WEEK_START + 10 * HOUR_MS, 121)], eventsHaveMore: true });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByText('Campaign: hn-launch')).toBeInTheDocument();
    });
    const file = await exportedText('Named events', written);
    const [line] = file.split('\n');
    expect(line).toBe(
      'growth-events: the rows below are page 1 of what the read behind this export ' +
        'answered; its other pages are not in this file. No campaign selection narrowed ' +
        'these rows.'
    );
  });

  it('writes a reach journey whose figure is exact as not having reached the ceiling', async () => {
    const written = capturedExports();
    stubFetch({
      reachRows: [
        {
          landingPath: '/welcome',
          reachedPath: '/pricing',
          visitorsDailySummed: 402,
          overflow: false,
        },
      ],
    });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByText('Campaign: hn-launch')).toBeInTheDocument();
    });
    expect(await exportedText('Landed on, then reached', written)).toBe(
      `${preamble('growth-reach')}\n` +
        'Landing,Reached,"Visitors (daily uniques, summed)",Ceiling reached\n/welcome,/pricing,402,false'
    );
  });

  it('writes a reach journey whose figure is a floor as having reached the ceiling', async () => {
    const written = capturedExports();
    stubFetch({
      reachRows: [
        {
          landingPath: '/welcome',
          reachedPath: '/pricing',
          visitorsDailySummed: 100_000,
          overflow: true,
        },
      ],
    });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByText('Campaign: hn-launch')).toBeInTheDocument();
    });
    expect(await exportedText('Landed on, then reached', written)).toBe(
      `${preamble('growth-reach')}\n` +
        'Landing,Reached,"Visitors (daily uniques, summed)",Ceiling reached\n/welcome,/pricing,100000,true'
    );
  });

  /** One page-family marketing row, the family the pages panel is built from. */
  function pathRow(visitors: number, overflow: boolean): GrowthMarketingRowWire {
    return {
      bucket: isoAt(WEEK_START),
      family: 'path',
      path: '/welcome',
      referrerHost: null,
      campaign: null,
      country: null,
      region: null,
      device: null,
      visitors,
      landings: 300,
      overflow,
    };
  }

  it('writes a page whose figure is exact as not having reached the ceiling', async () => {
    const written = capturedExports();
    stubFetch({ marketingRows: [pathRow(480, false)] });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByText('Campaign: hn-launch')).toBeInTheDocument();
    });
    expect(await exportedText('Top pages', written)).toBe(
      `${preamble('growth-pages')}\n` +
        'Path,"Visitors (daily uniques, summed)","Landings (daily uniques, summed)",Ceiling reached\n/welcome,480,300,false'
    );
  });

  it('writes a page whose figure is a floor as having reached the ceiling', async () => {
    const written = capturedExports();
    stubFetch({ marketingRows: [pathRow(100_000, true)] });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByText('Campaign: hn-launch')).toBeInTheDocument();
    });
    expect(await exportedText('Top pages', written)).toBe(
      `${preamble('growth-pages')}\n` +
        'Path,"Visitors (daily uniques, summed)","Landings (daily uniques, summed)",Ceiling reached\n/welcome,100000,300,true'
    );
  });

  it('exports the pages panel under the same column names it displays', async () => {
    const written: Blob[] = [];
    vi.mocked(URL.createObjectURL).mockImplementation((blob: Blob | MediaSource) => {
      written.push(blob as Blob);
      return 'blob:export';
    });
    stubFetch();
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByText('Campaign: hn-launch')).toBeInTheDocument();
    });
    const pages = panelNamed('Top pages');
    const displayed = within(pages)
      .getAllByRole('columnheader')
      .map((cell) => cell.textContent);
    await userEvent.click(within(pages).getByRole('button', { name: 'Export CSV' }));
    const [file] = written;
    if (file === undefined) throw new Error('no file was written');
    const csv = await file.text();
    const [, header] = csv.split('\n');
    for (const name of displayed) {
      expect(header).toContain(name);
    }
  });

  it('writes the ladder steps under the names the bars beside them use', async () => {
    const written = capturedExports();
    stubFetch();
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByText('Campaign: hn-launch')).toBeInTheDocument();
    });
    const file = await exportedText('Funnel', written);
    const [, header] = file.split('\n');
    expect(header).toBe(
      'Week,Campaign,"Visited (daily uniques, summed)",' +
        '"Visited (daily uniques, summed): Ceiling reached",' +
        '"Clicked into the product (hourly uniques, summed)",' +
        '"Clicked into the product (hourly uniques, summed): Ceiling reached",' +
        '"Started registration (hourly uniques, summed)",' +
        '"Started registration (hourly uniques, summed): Ceiling reached",' +
        'Account created,Email verified,' +
        'Sent a message,Returned week 1,First payment,Revenue (nano USD)'
    );
  });

  it('writes the ceiling flag of a step whose figure is a floor beside that figure', async () => {
    const written = capturedExports();
    stubFetch({ funnelWeeks: [{ ...FUNNEL_WEEK, visitorsOverflow: true }] });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByText('Campaign: hn-launch')).toBeInTheDocument();
    });
    const file = await exportedText('Funnel', written);
    const [row] = file.split('\n').slice(2);
    expect(row).toBe(
      `${isoAt(WEEK_START)},hn-launch,1284,true,143,false,97,false,41,36,29,17,6,184000000000`
    );
  });

  it('writes no ceiling column for a step whose table records no flag', async () => {
    const written = capturedExports();
    stubFetch();
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByText('Campaign: hn-launch')).toBeInTheDocument();
    });
    const file = await exportedText('Funnel', written);
    const [, header] = file.split('\n');
    expect(header).not.toContain('Account created: Ceiling reached');
  });

  it('writes the figures the tiles state, marginals included, under the tiles’ own names', async () => {
    const written = capturedExports();
    stubFetch();
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(within(headlineTiles()).getByText('500')).toBeInTheDocument();
    });
    expect(await exportedText(HEADLINE_PANEL, written)).toBe(
      `${preamble('growth-headline')}\n` +
        'Week,"Visitors (daily uniques, summed)",' +
        '"Visitors (daily uniques, summed): Ceiling reached",' +
        '"Product entry clicks (hourly uniques, summed)",' +
        '"Product entry clicks (hourly uniques, summed): Ceiling reached",' +
        'Accounts created,First payments\n' +
        `${isoAt(WEEK_START)},500,false,77,false,41,6`
    );
  });

  it('names a marginal figure absent under the reason its tile shows', async () => {
    const written = capturedExports();
    stubFetch({ marketingRows: [] });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(within(headlineTiles()).getAllByText(NO_MARGINAL_ROW_REASON).length).toBe(2);
    });
    expect(await exportedText(HEADLINE_PANEL, written)).toBe(
      `"${preamble('growth-headline')} ` +
        `The week selected when this file was written began ${isoAt(WEEK_START)}. ` +
        `Visitors (daily uniques, summed) has no column here: ${NO_MARGINAL_ROW_REASON} ` +
        'Product entry clicks (hourly uniques, summed) has no column here: ' +
        `${NO_MARGINAL_ROW_REASON}"\n` +
        'Week,Accounts created,First payments\n' +
        `${isoAt(WEEK_START)},41,6`
    );
  });

  it('states every leading figure as a column where the page could state them all', async () => {
    const written = capturedExports();
    stubFetch({ campaigns: [campaignRow('hn-launch')] });
    renderScreen();
    await screenReady();
    await chooseCampaigns('hn-launch');
    expect(await exportedText(HEADLINE_PANEL, written)).toBe(
      'growth-headline: the read behind this export answered in one page. A campaign ' +
        'selection narrowed these rows to hn-launch when this file was written; rows for ' +
        'other campaigns are not in this file.\n' +
        'Week,"Visitors (daily uniques, summed)",' +
        '"Visitors (daily uniques, summed): Ceiling reached",' +
        '"Product entry clicks (hourly uniques, summed)",' +
        '"Product entry clicks (hourly uniques, summed): Ceiling reached",' +
        'Accounts created,First payments\n' +
        `${isoAt(WEEK_START)},1284,false,143,false,41,6`
    );
  });

  it('says in the file which leading figures a multi-campaign selection does not reach', async () => {
    const written = capturedExports();
    stubFetch({
      funnelWeeks: [
        { ...FUNNEL_WEEK, campaign: 'hn-launch', finished: 41, firstPaid: 6 },
        { ...FUNNEL_WEEK, campaign: 'x-thread', finished: 1, firstPaid: 0 },
        { ...FUNNEL_WEEK, campaign: 'direct', finished: 25, firstPaid: 3 },
      ],
      campaigns: [campaignRow('hn-launch'), campaignRow('x-thread'), campaignRow('direct')],
    });
    renderScreen();
    await screenReady();
    await chooseCampaigns('hn-launch', 'x-thread');
    await waitFor(() => {
      expect(within(headlineTiles()).getByText('42')).toBeInTheDocument();
    });
    expect(await exportedText(HEADLINE_PANEL, written)).toBe(
      '"growth-headline: the read behind this export answered in one page. ' +
        'A campaign selection narrowed these rows to hn-launch, x-thread when this file was ' +
        'written; rows for other campaigns are not in this file. That selection does not reach ' +
        'Visitors (daily uniques, summed) and Product entry clicks (hourly uniques, summed), ' +
        'which count every campaign."\n' +
        'Week,"Visitors (daily uniques, summed)",' +
        '"Visitors (daily uniques, summed): Ceiling reached",' +
        '"Product entry clicks (hourly uniques, summed)",' +
        '"Product entry clicks (hourly uniques, summed): Ceiling reached",' +
        'Accounts created,First payments\n' +
        `${isoAt(WEEK_START)},500,false,77,false,42,6`
    );
  });

  it('writes no ceiling column for a leading figure counted from accounts', async () => {
    const written = capturedExports();
    stubFetch();
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByText('Campaign: hn-launch')).toBeInTheDocument();
    });
    const file = await exportedText(HEADLINE_PANEL, written);
    const [, header] = file.split('\n');
    expect(header).not.toContain('Accounts created: Ceiling reached');
    expect(header).not.toContain('First payments: Ceiling reached');
  });

  it('writes every week the ladder rows carry, even where no figure can be stated', async () => {
    const written = capturedExports();
    const earlier = isoAt(WEEK_START - 7 * DAY_MS);
    stubFetch({
      marketingRows: [],
      funnelWeeks: [
        FUNNEL_WEEK,
        { ...FUNNEL_WEEK, week: earlier },
        { ...FUNNEL_WEEK, week: earlier, campaign: 'x-thread' },
      ],
    });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByText('Campaign: hn-launch')).toBeInTheDocument();
    });
    await chooseWeek(WEEK_START - 5 * 7 * DAY_MS);
    await waitFor(() => {
      expect(screen.getAllByText(NO_LADDER_ROW_REASON).length).toBeGreaterThan(0);
    });
    expect(await exportedText(HEADLINE_PANEL, written)).toBe(
      `"${preamble('growth-headline')} ` +
        'The week selected when this file was written began ' +
        `${isoAt(WEEK_START - 5 * 7 * DAY_MS)}. ` +
        `Visitors (daily uniques, summed) has no column here: ${NO_MARGINAL_ROW_REASON} ` +
        'Product entry clicks (hourly uniques, summed) has no column here: ' +
        `${NO_MARGINAL_ROW_REASON} ` +
        `Accounts created has no column here: ${NO_LADDER_ROW_REASON} ` +
        `First payments has no column here: ${NO_LADDER_ROW_REASON}"\n` +
        `Week\n${earlier}\n${isoAt(WEEK_START)}`
    );
  });

  it('writes each cohort under the step names the grid displays', async () => {
    const written = capturedExports();
    stubFetch();
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByText('Campaign: hn-launch')).toBeInTheDocument();
    });
    expect(await exportedText('Cohorts', written)).toBe(
      `${preamble('growth-cohorts')}\n` +
        'Cohort,Account created,Email verified,Sent a message,Returned week 1,First payment\n' +
        `${isoAt(WEEK_START)},41,36,29,17,6`
    );
  });

  it('writes each visitor bucket as its own row, named for one bucket rather than a sum', async () => {
    const written = capturedExports();
    stubFetch();
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByText('Campaign: hn-launch')).toBeInTheDocument();
    });
    expect(await exportedText('Visitors', written)).toBe(
      `${preamble('growth-visitors')}\nBucket,Visitors (daily uniques),Ceiling reached\n` +
        `${isoAt(WEEK_START)},500,false`
    );
  });

  it('writes a visitor bucket the ceiling cut off as a floor', async () => {
    const written = capturedExports();
    stubFetch({
      marketingRows: [
        {
          bucket: isoAt(WEEK_START),
          family: 'total',
          path: null,
          referrerHost: null,
          campaign: null,
          country: null,
          region: null,
          device: null,
          visitors: 100_000,
          landings: null,
          overflow: true,
        },
      ],
    });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByText('Campaign: hn-launch')).toBeInTheDocument();
    });
    expect(await exportedText('Visitors', written)).toBe(
      `${preamble('growth-visitors')}\nBucket,Visitors (daily uniques),Ceiling reached\n` +
        `${isoAt(WEEK_START)},100000,true`
    );
  });

  it('writes each place and device under the names the table beside the map uses', async () => {
    const written = capturedExports();
    stubFetch();
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByText('Campaign: hn-launch')).toBeInTheDocument();
    });
    expect(await exportedText('Where visitors are', written)).toBe(
      `${preamble('growth-geo')}\n` +
        'Place,Device,"Visitors (daily uniques, summed)",Ceiling reached\n' +
        'US · CA,desktop,201,false'
    );
  });

  it('writes each self-reported source as the read counted it', async () => {
    const written = capturedExports();
    stubFetch();
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByText('Campaign: hn-launch')).toBeInTheDocument();
    });
    expect(await exportedText('Where people said they heard of us', written)).toBe(
      `${preamble('growth-sources')}\n` +
        'Created week,Campaign,Channel,Asked at,Primary source,Accounts\n' +
        `${isoAt(WEEK_START)},hn-launch,podcast,post_signup,podcast,7`
    );
  });

  it('writes each campaign with the link an operator shares', async () => {
    vi.stubEnv('VITE_WEB_URL', 'https://site.example');
    const written = capturedExports();
    stubFetch();
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByText('Campaign: hn-launch')).toBeInTheDocument();
    });
    expect(await exportedText('Campaigns', written)).toBe(
      `${preamble('growth-campaigns')}\nTag,Label,Status,Link\n` +
        'hn-launch,Hacker News launch post,active,https://site.example/welcome?c=hn-launch'
    );
  });

  it('says in the file that a campaign selection dropped rows the read returned', async () => {
    const written = capturedExports();
    stubFetch({ campaigns: [campaignRow('hn-launch'), campaignRow('x-thread')] });
    renderScreen();
    await screenReady();
    await chooseCampaigns('hn-launch');
    const file = await exportedText('Funnel', written);
    const [line] = file.split('\n');
    expect(line).toBe(
      'growth-funnel: the read behind this export answered in one page. A campaign ' +
        'selection narrowed these rows to hn-launch when this file was written; rows for ' +
        'other campaigns are not in this file.'
    );
  });

  it('claims nothing about campaigns when no selection narrowed the rows', async () => {
    const written = capturedExports();
    stubFetch();
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByText('Campaign: hn-launch')).toBeInTheDocument();
    });
    const file = await exportedText('Funnel', written);
    const [line] = file.split('\n');
    expect(line).toBe(preamble('growth-funnel'));
  });

  it('writes a file from every panel that offers one', async () => {
    stubFetch();
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByText('Campaign: hn-launch')).toBeInTheDocument();
    });
    const buttons = screen.getAllByRole('button', { name: 'Export CSV' });
    for (const button of buttons) {
      await userEvent.click(button);
    }
    expect(URL.createObjectURL).toHaveBeenCalledTimes(buttons.length);
  });
});
