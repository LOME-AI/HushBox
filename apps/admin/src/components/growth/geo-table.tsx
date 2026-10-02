import * as React from 'react';
import { ScrollRegion } from '@hushbox/ui';
import { ceilingReachedColumn } from './csv.js';
import { formatRate } from './format-rate.js';
import { formatVisitorCount } from './funnel-math.js';
import { summedCountLabel } from './summed-label.js';
import type { RegionReading } from './choropleth.js';
import type { CsvColumn } from './csv.js';
import type { GeoTotal } from './marketing-rows.js';
import type { SummedBucketing } from './summed-label.js';

/** A country with no region reads as the country; the US carries its state. */
function placeOf(total: GeoTotal): string {
  if (total.country === '') return '(unknown)';
  return total.region === '' ? total.country : `${total.country} · ${total.region}`;
}

/** One place's figure before it is ranked against the others. */
export interface GeoPlaceCount {
  /** The code the map's shading is keyed by, or the empty string for a place it has none for. */
  readonly code: string;
  /** What the table calls the place. */
  readonly place: string;
  readonly visitors: number;
  readonly overflow: boolean;
}

/**
 * One place as the table lists it and the map reads it out: the figure, its
 * share of every figure the range counted, and its rank among them. One row
 * shape for both surfaces, so the map cannot read out a figure the table beside
 * it does not hold.
 */
export interface GeoPlace extends GeoPlaceCount, RegionReading {}

/**
 * The places of one range, largest first, each carrying its share and its rank.
 *
 * The share is taken against every figure in the set, the places the map has no
 * shape for included, so a share is of what was counted rather than of what
 * could be drawn.
 */
export function geoPlaces(counts: readonly GeoPlaceCount[]): readonly GeoPlace[] {
  const ordered = counts.toSorted((left, right) => right.visitors - left.visitors);
  const counted = ordered.reduce((sum, place) => sum + place.visitors, 0);
  return ordered.map((place, index) => ({
    ...place,
    share: counted === 0 ? null : place.visitors / counted,
    rank: index + 1,
    of: ordered.length,
  }));
}

/** What this table's columns are called, on screen and in the exported file. */
export interface GeoColumnHeaders {
  readonly place: string;
  readonly device: string;
  readonly visitors: string;
}

/**
 * The column names, from one definition every surface reads. Two spellings of
 * one figure read as two figures, so neither the table nor the exported file
 * writes its own: the table names the figure with `visitors` and the file names
 * all three, the device among them, because the device dimension is the file's
 * to carry.
 */
export function geoColumnHeaders(bucketing: SummedBucketing): GeoColumnHeaders {
  return {
    place: 'Place',
    device: 'Device',
    visitors: summedCountLabel('Visitors', bucketing),
  };
}

/**
 * This table as a file: the place as the table spells it, the device, the
 * summed figure and whether a bucket behind it hit its set ceiling.
 */
export function geoColumns(bucketing: SummedBucketing): readonly CsvColumn<GeoTotal>[] {
  const headers = geoColumnHeaders(bucketing);
  return [
    { header: headers.place, value: (total) => placeOf(total) },
    { header: headers.device, value: (total) => total.device },
    { header: headers.visitors, value: (total) => total.visitors },
    ceilingReachedColumn<GeoTotal>(),
  ];
}

/**
 * The sorted place table beside the map.
 *
 * This is the accessible surface for the geo panel, and the only surface at all
 * for places the geometry has no polygon for: every microstate, the three
 * shapes the world file leaves without an id, and Antarctica, which the
 * projection leaves out. It holds the rank and the share the map reads out as
 * well as the figure, so a reader who never sees the map, or never hovers it,
 * loses nothing.
 */
export function GeoTable({
  places,
  bucketing,
  keyLabel,
  shareColumn,
}: Readonly<{
  readonly places: readonly GeoPlace[];
  readonly bucketing: SummedBucketing;
  /** What the places are: countries on the world map, states inside one country. */
  readonly keyLabel: string;
  /**
   * What the share column is a share of, composed by the share-label vocabulary
   * in `apps/admin/src/components/growth/choropleth.tsx`: the set a share was
   * taken against moves with the map, so the column says which set it is rather
   * than leaving the reader the one they last saw.
   */
  readonly shareColumn: string;
}>): React.JSX.Element {
  if (places.length === 0) {
    return <p className="text-muted-foreground text-sm">Nothing was counted in this range.</p>;
  }
  const headers = geoColumnHeaders(bucketing);
  const caption = `${keyLabel} by ${headers.visitors}, largest first`;
  return (
    <ScrollRegion label={caption} className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="text-muted-foreground text-xs uppercase">
            <th scope="col" className="py-1 pr-2 text-right font-semibold">
              #
            </th>
            <th scope="col" className="py-1 pr-2 font-semibold">
              {keyLabel}
            </th>
            <th scope="col" className="py-1 pl-2 text-right font-semibold">
              {headers.visitors}
            </th>
            <th scope="col" className="py-1 pl-2 text-right font-semibold">
              {shareColumn}
            </th>
          </tr>
        </thead>
        <tbody>
          {places.map((place) => (
            <tr key={place.code} className="border-border border-b">
              <td className="text-muted-foreground py-1 pr-2 text-right tabular-nums">
                {place.rank}
              </td>
              <th scope="row" className="py-1 pr-2 font-mono text-xs font-normal">
                {place.place}
              </th>
              <td className="py-1 pl-2 text-right tabular-nums">
                {formatVisitorCount(place.visitors, place.overflow)}
              </td>
              <td className="py-1 pl-2 text-right tabular-nums">{formatRate(place.share)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}
