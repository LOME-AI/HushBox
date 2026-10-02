import { describe, expect, it } from 'vitest';
import { DAY_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { GROWTH_PRODUCT_ENTRY_FAMILY } from '@hushbox/shared';
import {
  totalSeries,
  referrerTotals,
  pageTotals,
  geoTotals,
  countryTotals,
  stateTotals,
  summedVisitorsLabel,
  totalVisitorsMarginal,
  productEntryMarginal,
} from './marketing-rows.js';
import type { GrowthMarketingRowWire } from '@hushbox/shared';

function row(over: Partial<GrowthMarketingRowWire>): GrowthMarketingRowWire {
  return {
    bucket: isoAt(TEST_DAY_START),
    family: 'total',
    path: null,
    referrerHost: null,
    campaign: null,
    country: null,
    region: null,
    device: null,
    visitors: 0,
    landings: null,
    overflow: false,
    ...over,
  };
}

describe('totalSeries', () => {
  it('keeps only the family that counts every visitor', () => {
    const series = totalSeries([
      row({ family: 'total', visitors: 100 }),
      row({ family: 'path', path: '/welcome', visitors: 90 }),
    ]);
    expect(series).toHaveLength(1);
    expect(series[0]?.visitors).toBe(100);
  });

  it('orders the buckets oldest first so a line reads left to right', () => {
    const series = totalSeries([
      row({ family: 'total', bucket: isoAt(TEST_DAY_START + DAY_MS), visitors: 2 }),
      row({ family: 'total', bucket: isoAt(TEST_DAY_START), visitors: 1 }),
    ]);
    expect(series.map((point) => point.visitors)).toEqual([1, 2]);
  });

  it('carries a bucket overflow through to the point', () => {
    const series = totalSeries([row({ family: 'total', visitors: 100_000, overflow: true })]);
    expect(series[0]?.overflow).toBe(true);
  });
});

describe('referrerTotals', () => {
  it('sums one host across the buckets in the window', () => {
    const totals = referrerTotals([
      row({ family: 'referrer', referrerHost: 'reddit.com', visitors: 10 }),
      row({
        family: 'referrer',
        referrerHost: 'reddit.com',
        bucket: isoAt(TEST_DAY_START + DAY_MS),
        visitors: 5,
      }),
    ]);
    expect(totals).toEqual([{ key: 'reddit.com', visitors: 15, overflow: false }]);
  });

  it('sorts the hosts by size, largest first', () => {
    const totals = referrerTotals([
      row({ family: 'referrer', referrerHost: 'a.com', visitors: 1 }),
      row({ family: 'referrer', referrerHost: 'b.com', visitors: 9 }),
    ]);
    expect(totals.map((total) => total.key)).toEqual(['b.com', 'a.com']);
  });

  it('marks a host overflowed when any of its buckets hit the ceiling', () => {
    const totals = referrerTotals([
      row({ family: 'referrer', referrerHost: 'a.com', visitors: 1 }),
      row({
        family: 'referrer',
        referrerHost: 'a.com',
        bucket: isoAt(TEST_DAY_START + DAY_MS),
        visitors: 100_000,
        overflow: true,
      }),
    ]);
    expect(totals[0]?.overflow).toBe(true);
  });

  it('ignores rows belonging to another family', () => {
    expect(referrerTotals([row({ family: 'total', visitors: 100 })])).toEqual([]);
  });
});

describe('pageTotals', () => {
  it('sums visitors and landings per path', () => {
    const totals = pageTotals([
      row({ family: 'path', path: '/welcome', visitors: 10, landings: 8 }),
      row({
        family: 'path',
        path: '/welcome',
        bucket: isoAt(TEST_DAY_START + DAY_MS),
        visitors: 4,
        landings: 3,
      }),
    ]);
    expect(totals).toEqual([{ key: '/welcome', visitors: 14, landings: 11, overflow: false }]);
  });

  it('treats an absent landing count as nothing to add rather than a zero', () => {
    const totals = pageTotals([
      row({ family: 'path', path: '/welcome', visitors: 5, landings: null }),
    ]);
    expect(totals[0]?.landings).toBeNull();
  });
});

describe('geoTotals', () => {
  it('sums one country, region and device triple across buckets', () => {
    const totals = geoTotals([
      row({ family: 'geo', country: 'US', region: 'CA', device: 'desktop', visitors: 100 }),
      row({
        family: 'geo',
        country: 'US',
        region: 'CA',
        device: 'desktop',
        bucket: isoAt(TEST_DAY_START + DAY_MS),
        visitors: 101,
      }),
    ]);
    expect(totals[0]).toEqual({
      country: 'US',
      region: 'CA',
      device: 'desktop',
      visitors: 201,
      overflow: false,
    });
  });

  it('keeps two devices in the same place apart', () => {
    const totals = geoTotals([
      row({ family: 'geo', country: 'US', region: 'CA', device: 'desktop', visitors: 1 }),
      row({ family: 'geo', country: 'US', region: 'CA', device: 'mobile', visitors: 2 }),
    ]);
    expect(totals).toHaveLength(2);
  });
});

describe('countryTotals', () => {
  it('folds every region and device into one figure per country', () => {
    const totals = countryTotals([
      row({ family: 'geo', country: 'US', region: 'CA', device: 'desktop', visitors: 1 }),
      row({ family: 'geo', country: 'US', region: 'TX', device: 'mobile', visitors: 2 }),
      row({ family: 'geo', country: 'DE', region: '', device: 'desktop', visitors: 4 }),
    ]);
    expect(totals.get('US')?.visitors).toBe(3);
    expect(totals.get('DE')?.visitors).toBe(4);
  });

  it('leaves a country nothing was counted for absent rather than zero', () => {
    const totals = countryTotals([row({ family: 'geo', country: 'US', visitors: 1 })]);
    expect(totals.has('FR')).toBe(false);
  });
});

describe('stateTotals', () => {
  it('counts only rows inside the United States', () => {
    const totals = stateTotals([
      row({ family: 'geo', country: 'US', region: 'CA', device: 'desktop', visitors: 5 }),
      row({ family: 'geo', country: 'DE', region: 'BE', device: 'desktop', visitors: 9 }),
    ]);
    expect(totals.get('CA')?.visitors).toBe(5);
    expect(totals.has('BE')).toBe(false);
  });

  it('drops a United States row carrying no region', () => {
    const totals = stateTotals([row({ family: 'geo', country: 'US', region: '', visitors: 5 })]);
    expect(totals.size).toBe(0);
  });
});

describe('summedVisitorsLabel', () => {
  it('names the bucketing the daily figures were summed from', () => {
    expect(summedVisitorsLabel('day')).toBe('Visitors (daily uniques, summed)');
  });

  it('names the bucketing the hourly figures were summed from', () => {
    expect(summedVisitorsLabel('hour')).toBe('Visitors (hourly uniques, summed)');
  });
});

describe('marketing selectors on rows with absent dimensions', () => {
  it('skips a referrer row carrying no host', () => {
    expect(referrerTotals([row({ family: 'referrer', referrerHost: null, visitors: 5 })])).toEqual(
      []
    );
  });

  it('skips a path row carrying no path', () => {
    expect(pageTotals([row({ family: 'path', path: null, visitors: 5 })])).toEqual([]);
  });

  it('adds a later landing figure onto buckets that carried none', () => {
    const totals = pageTotals([
      row({ family: 'path', path: '/a', visitors: 5, landings: null }),
      row({
        family: 'path',
        path: '/a',
        bucket: isoAt(TEST_DAY_START + DAY_MS),
        visitors: 5,
        landings: 3,
      }),
    ]);
    expect(totals[0]?.landings).toBe(3);
  });

  it('keeps a geo row with no country as its own unresolved place', () => {
    const totals = geoTotals([
      row({ family: 'geo', country: null, region: null, device: null, visitors: 2 }),
    ]);
    expect(totals[0]).toEqual({
      country: '',
      region: '',
      device: '',
      visitors: 2,
      overflow: false,
    });
  });

  it('leaves a geo row with no country out of the country shading', () => {
    expect(countryTotals([row({ family: 'geo', country: null, visitors: 2 })]).size).toBe(0);
  });

  it('leaves a geo row with an empty country out of the country shading', () => {
    expect(countryTotals([row({ family: 'geo', country: '', visitors: 2 })]).size).toBe(0);
  });

  it('leaves a United States row with a null region out of the state shading', () => {
    expect(
      stateTotals([row({ family: 'geo', country: 'US', region: null, visitors: 2 })]).size
    ).toBe(0);
  });
});

describe('totalVisitorsMarginal', () => {
  it('adds the buckets of the family that carries no campaign', () => {
    const marginal = totalVisitorsMarginal([
      row({ family: 'total', bucket: isoAt(TEST_DAY_START), visitors: 40 }),
      row({ family: 'total', bucket: isoAt(TEST_DAY_START + DAY_MS), visitors: 60 }),
    ]);
    expect(marginal?.count).toBe(100);
  });

  it('counts a visitor who saw two campaigns once, where the per-campaign rows count two', () => {
    const marginal = totalVisitorsMarginal([
      row({ family: 'total', visitors: 1 }),
      row({ family: 'campaign', campaign: 'hn-launch', path: '/welcome', visitors: 1 }),
      row({ family: 'campaign', campaign: 'bing-brand', path: '/welcome', visitors: 1 }),
    ]);
    expect(marginal?.count).toBe(1);
  });

  it('marks the figure a floor when a bucket it added had reached its ceiling', () => {
    const marginal = totalVisitorsMarginal([
      row({ family: 'total', visitors: 100_000, overflow: true }),
      row({ family: 'total', bucket: isoAt(TEST_DAY_START + DAY_MS), visitors: 3 }),
    ]);
    expect(marginal?.overflow).toBe(true);
  });

  it('answers with nothing where the read returned no bucket of that family', () => {
    expect(
      totalVisitorsMarginal([row({ family: 'path', path: '/welcome', visitors: 9 })])
    ).toBeNull();
  });
});

describe('productEntryMarginal', () => {
  it('adds the hour buckets of the campaign-free product-entry family', () => {
    const marginal = productEntryMarginal([
      row({ family: GROWTH_PRODUCT_ENTRY_FAMILY, visitors: 7 }),
      row({
        family: GROWTH_PRODUCT_ENTRY_FAMILY,
        bucket: isoAt(TEST_DAY_START + DAY_MS),
        visitors: 5,
      }),
    ]);
    expect(marginal?.count).toBe(12);
  });

  it('counts an entrant who clicked under two campaigns once', () => {
    const marginal = productEntryMarginal([
      row({ family: GROWTH_PRODUCT_ENTRY_FAMILY, visitors: 1 }),
      row({ family: 'campaign', campaign: 'hn-launch', path: '/welcome', visitors: 1 }),
      row({ family: 'campaign', campaign: 'bing-brand', path: '/welcome', visitors: 1 }),
    ]);
    expect(marginal?.count).toBe(1);
  });

  it('leaves the whole-site visitor family out of the entrant figure', () => {
    const marginal = productEntryMarginal([
      row({ family: GROWTH_PRODUCT_ENTRY_FAMILY, visitors: 7 }),
      row({ family: 'total', visitors: 900 }),
    ]);
    expect(marginal?.count).toBe(7);
  });

  it('answers with nothing at a grain whose relation carries the family no rows', () => {
    expect(productEntryMarginal([row({ family: 'total', visitors: 900 })])).toBeNull();
  });
});
