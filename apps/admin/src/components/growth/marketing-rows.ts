import { GROWTH_PRODUCT_ENTRY_FAMILY } from '@hushbox/shared';
import { bucketingOfGrain, summedCountLabel } from './summed-label.js';
import type { SummedFigureLabel } from './summed-label.js';
import type { GrowthGrain, GrowthMarketingRowWire } from '@hushbox/shared';

/**
 * The marketing read returns marginals in one relation, each filling only the
 * dimensions it owns. Every selector here reads exactly one family: two
 * families are never joined, because a distinct count over a cross product is
 * not derivable from the counts of its projections.
 *
 * Where a selector adds buckets together the result is a sum of per-bucket
 * distinct counts, so a visitor who came back on another day is counted on each
 * one. Every figure derived that way is labelled as summed on screen; none is
 * presented as distinct people over the window.
 */

/** One point of the visitors-over-time series. */
export interface MarketingPoint {
  readonly bucket: string;
  readonly visitors: number;
  readonly overflow: boolean;
}

/** One dimension value's summed visitors, with landings where the family carries them. */
export interface MarketingTotal {
  readonly key: string;
  readonly visitors: number;
  readonly landings?: number | null;
  readonly overflow: boolean;
}

/**
 * One region's summed visitors on the map. The ceiling flag travels with the
 * figure rather than beside it, so a shading and the label naming it cannot be
 * assembled from different rows.
 */
export interface RegionCount {
  readonly visitors: number;
  readonly overflow: boolean;
}

/** One place-and-device row, as the geo table lists it. */
export interface GeoTotal {
  readonly country: string;
  readonly region: string;
  readonly device: string;
  readonly visitors: number;
  readonly overflow: boolean;
}

function ofFamily(
  rows: readonly GrowthMarketingRowWire[],
  family: string
): readonly GrowthMarketingRowWire[] {
  return rows.filter((row) => row.family === family);
}

/** The whole-site visitor series, oldest bucket first. */
export function totalSeries(rows: readonly GrowthMarketingRowWire[]): readonly MarketingPoint[] {
  return ofFamily(rows, 'total')
    .map((row) => ({ bucket: row.bucket, visitors: row.visitors, overflow: row.overflow }))
    .toSorted((left, right) => left.bucket.localeCompare(right.bucket));
}

/** Sum one family's buckets per dimension value, largest first. */
function sumByKey(
  rows: readonly GrowthMarketingRowWire[],
  keyOf: (row: GrowthMarketingRowWire) => string | null,
  withLandings: boolean
): readonly MarketingTotal[] {
  const totals = new Map<
    string,
    { visitors: number; landings: number | null; overflow: boolean }
  >();
  for (const row of rows) {
    const key = keyOf(row);
    if (key === null) continue;
    const seen = totals.get(key) ?? { visitors: 0, landings: null, overflow: false };
    totals.set(key, {
      visitors: seen.visitors + row.visitors,
      // An absent landing count is not a zero: the family does not carry the
      // figure for that bucket, so there is nothing to add.
      landings: row.landings === null ? seen.landings : (seen.landings ?? 0) + row.landings,
      overflow: seen.overflow || row.overflow,
    });
  }
  return [...totals.entries()]
    .map(([key, total]) => ({
      key,
      visitors: total.visitors,
      ...(withLandings ? { landings: total.landings } : {}),
      overflow: total.overflow,
    }))
    .toSorted((left, right) => right.visitors - left.visitors);
}

/** Referring hosts, summed over the window. */
export function referrerTotals(rows: readonly GrowthMarketingRowWire[]): readonly MarketingTotal[] {
  return sumByKey(ofFamily(rows, 'referrer'), (row) => row.referrerHost, false);
}

/** Pages, summed over the window, with the landings the family carries. */
export function pageTotals(rows: readonly GrowthMarketingRowWire[]): readonly MarketingTotal[] {
  return sumByKey(ofFamily(rows, 'path'), (row) => row.path, true);
}

/** A separator no dimension value can contain, so two tuples never share a key. */
const KEY_SEPARATOR = '\u0000';

/** Place and device rows, summed over the window, largest first. */
export function geoTotals(rows: readonly GrowthMarketingRowWire[]): readonly GeoTotal[] {
  const totals = new Map<string, GeoTotal>();
  for (const row of ofFamily(rows, 'geo')) {
    const country = row.country ?? '';
    const region = row.region ?? '';
    const device = row.device ?? '';
    const key = [country, region, device].join(KEY_SEPARATOR);
    const seen = totals.get(key);
    totals.set(key, {
      country,
      region,
      device,
      visitors: (seen?.visitors ?? 0) + row.visitors,
      overflow: (seen?.overflow ?? false) || row.overflow,
    });
  }
  return [...totals.values()].toSorted((left, right) => right.visitors - left.visitors);
}

/** One more bucket into a region's figure, carrying its ceiling flag with it. */
function addTo(seen: RegionCount | undefined, row: GrowthMarketingRowWire): RegionCount {
  return {
    visitors: (seen?.visitors ?? 0) + row.visitors,
    overflow: (seen?.overflow ?? false) || row.overflow,
  };
}

/**
 * Summed visitors per country, for the world map's fills. A country with no row
 * is absent from the map rather than shaded as zero — nothing was counted there,
 * which is not the same fact as nobody having come.
 */
export function countryTotals(
  rows: readonly GrowthMarketingRowWire[]
): ReadonlyMap<string, RegionCount> {
  const totals = new Map<string, RegionCount>();
  for (const row of ofFamily(rows, 'geo')) {
    if (row.country === null || row.country === '') continue;
    totals.set(row.country, addTo(totals.get(row.country), row));
  }
  return totals;
}

/** Summed visitors per US state. The region dimension is only populated for the US. */
export function stateTotals(
  rows: readonly GrowthMarketingRowWire[]
): ReadonlyMap<string, RegionCount> {
  const totals = new Map<string, RegionCount>();
  for (const row of ofFamily(rows, 'geo')) {
    if (row.country !== 'US' || row.region === null || row.region === '') continue;
    totals.set(row.region, addTo(totals.get(row.region), row));
  }
  return totals;
}

/** How a summed visitor figure is named, so the bucketing behind it is on screen. */
export function summedVisitorsLabel(grain: GrowthGrain): SummedFigureLabel {
  return summedCountLabel('Visitors', bucketingOfGrain(grain));
}

/**
 * One campaign-free marginal added over the buckets a read returned: a count
 * that carries no campaign dimension at all, so a visitor who saw two campaigns
 * is one member of each bucket's set rather than one member per campaign.
 */
export interface MarginalTotal {
  readonly count: number;
  readonly overflow: boolean;
}

/**
 * One family's buckets added together, or null where the read returned none of
 * that family. Null rather than a zero: no bucket is a measurement nobody took,
 * and a nought there would report that nobody was counted.
 */
function marginalOf(rows: readonly GrowthMarketingRowWire[], family: string): MarginalTotal | null {
  const ofIt = ofFamily(rows, family);
  if (ofIt.length === 0) return null;
  return {
    count: ofIt.reduce((total, row) => total + row.visitors, 0),
    overflow: ofIt.some((row) => row.overflow),
  };
}

/** The whole-site visitor marginal, added over the buckets the read returned. */
export function totalVisitorsMarginal(
  rows: readonly GrowthMarketingRowWire[]
): MarginalTotal | null {
  return marginalOf(rows, 'total');
}

/**
 * The campaign-free product-entry marginal, added over the buckets the read
 * returned. Only the hourly relation carries this family, so a read at day
 * grain finds no bucket and answers with nothing.
 */
export function productEntryMarginal(
  rows: readonly GrowthMarketingRowWire[]
): MarginalTotal | null {
  return marginalOf(rows, GROWTH_PRODUCT_ENTRY_FAMILY);
}
