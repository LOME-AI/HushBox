import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@hushbox/ui';
import { alpha2ForGeometryId } from '@/lib/geo/iso-numeric-to-alpha2';
import { uspsForGeometryId } from '@/lib/geo/fips-to-usps';
import { Choropleth, shareLabels } from './choropleth.js';
import { GeoTable, geoPlaces } from './geo-table.js';
import { countryTotals, geoTotals, stateTotals } from './marketing-rows.js';
import { summedCountLabel } from './summed-label.js';
import type { GeoPlace, GeoPlaceCount } from './geo-table.js';
import type { GeoTotal, RegionCount } from './marketing-rows.js';
import type { SummedBucketing } from './summed-label.js';
import type { GrowthMarketingRowWire } from '@hushbox/shared';
import type { Topology } from 'topojson-specification';

/**
 * The vendored geometry, served as a static asset from this application's own
 * origin — the admin content policy allows no other host, and the files are
 * kept out of the bundle so a screen that never opens the map never pays for
 * them. Their provenance and licence sit beside them in `public/geo/`.
 */
const GEOMETRY = {
  world: { file: '/geo/countries-110m.json', layer: 'countries' },
  states: { file: '/geo/states-albers-10m.json', layer: 'states' },
} as const;

function useTopology(file: string): ReturnType<typeof useQuery<Topology>> {
  return useQuery<Topology>({
    queryKey: ['admin', 'growth', 'geometry', file],
    queryFn: async () => {
      const response = await fetch(file);
      if (!response.ok) throw new Error('GEOMETRY_UNAVAILABLE');
      return (await response.json()) as Topology;
    },
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

/** The country whose regions the counts carry, and so the only drill-down there is. */
const DRILL_DOWN_COUNTRY = 'US';

/** Everything that differs between the world and the drilled-in United States. */
interface GeoView {
  readonly file: string;
  readonly layer: string;
  readonly projection: 'naturalEarth1' | 'identity';
  readonly codeForId: (id: string) => string | null;
  readonly title: string;
  /** What the places are, for the table's first column. */
  readonly keyLabel: string;
  /**
   * The set every share on this view is taken against, named for a reader: the
   * world's places on the world map, one country's on the drilled one. The
   * denominator moves with the drill, so the label the map and the table state
   * it in moves with it too.
   */
  readonly shareSet: string;
}

function viewOf(drilled: boolean): GeoView {
  return drilled
    ? {
        ...GEOMETRY.states,
        projection: 'identity',
        codeForId: uspsForGeometryId,
        title: 'Visitors across the United States',
        keyLabel: 'State',
        shareSet: 'the United States',
      }
    : {
        ...GEOMETRY.world,
        projection: 'naturalEarth1',
        codeForId: alpha2ForGeometryId,
        title: 'Visitors across the world',
        keyLabel: 'Country',
        shareSet: 'the world',
      };
}

/**
 * The visitors this view has no place for, as a row of its own: a visit whose
 * country the request could not resolve, or, inside the United States, one
 * whose state it could not. The shading is keyed by place, so without this row
 * those visitors would be in no figure on the panel at all.
 */
function unplaced(totals: readonly GeoTotal[], drilled: boolean): readonly GeoPlaceCount[] {
  const rows = totals.filter((total) =>
    drilled
      ? total.country === DRILL_DOWN_COUNTRY && total.region === ''
      : total.country === '' && total.region === ''
  );
  if (rows.length === 0) return [];
  return [
    {
      code: '',
      place: drilled ? '(state unknown)' : '(country unknown)',
      visitors: rows.reduce((sum, total) => sum + total.visitors, 0),
      overflow: rows.some((total) => total.overflow),
    },
  ];
}

/** The shaded places and the unplaceable ones, as one ranked set. */
function placesOf(
  shading: ReadonlyMap<string, RegionCount>,
  totals: readonly GeoTotal[],
  drilled: boolean
): readonly GeoPlace[] {
  const shaded = [...shading.entries()].map(([code, count]) => ({
    code,
    place: code,
    visitors: count.visitors,
    overflow: count.overflow,
  }));
  return geoPlaces([...shaded, ...unplaced(totals, drilled)]);
}

/**
 * What the panel's figures do and do not claim, in view and without interaction.
 *
 * Each sentence is load-bearing: the table follows the map's own granularity, so
 * it says where the granularity the reader is not looking at has gone; a place
 * the geometry cannot draw is in the table and nowhere else; an unshaded place
 * was not counted rather than counted as none; and the device dimension, which
 * the table no longer carries, is in the exported file.
 *
 * The drill is named only while a map is drawn, because the region paths are the
 * only affordance that reaches it: with the geometry in flight or unreachable the
 * column is empty and the table's cells are plain, so the sentence would promise
 * a click the panel cannot take. The way back out needs no such condition, since
 * {@link GeoPanel} renders its button in every state of the drilled view.
 */
function panelNote(drilled: boolean, approximate: boolean, mapDrawn: boolean): string {
  const world = mapDrawn
    ? 'Every counted country, largest first, with the states inside the United States one click away.'
    : 'Every counted country, largest first.';
  const scope = drilled
    ? 'Every counted state inside the United States, largest first. Back to world lists the countries again.'
    : world;
  const absence = drilled
    ? 'Places the map has no shape for appear in the table only, and a place with no row was not counted rather than counted as none.'
    : 'Places the map has no shape for, and Antarctica, which the projection leaves out, appear in the table only, and a place with no row was not counted rather than counted as none.';
  const ceiling = approximate
    ? ' A figure that hit its counting ceiling is shown as a floor, so a share taken against it is approximate.'
    : '';
  return `${scope} ${absence} The device split is in the exported file.${ceiling}`;
}

/**
 * Where visitors are: a shaded map with the ranked table beside it.
 *
 * The table is rendered from the counts alone and never waits for geometry, so
 * a map that fails to load costs the panel its illustration and none of its
 * figures. Both read the same ranked places, so every figure the map reads out
 * under the pointer is a row of the table as well.
 */
export function GeoPanel({
  rows,
  bucketing,
}: Readonly<{
  readonly rows: readonly GrowthMarketingRowWire[];
  readonly bucketing: SummedBucketing;
}>): React.JSX.Element {
  const [drilled, setDrilled] = React.useState(false);
  const view = viewOf(drilled);
  const topology = useTopology(view.file);
  const places = placesOf(
    drilled ? stateTotals(rows) : countryTotals(rows),
    geoTotals(rows),
    drilled
  );
  const shares = shareLabels(view.shareSet);
  const readings = new Map(
    places.filter((place) => place.code !== '').map((place) => [place.code, place])
  );
  const mapDrawn = topology.data !== undefined;

  return (
    <figure className="m-0">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div>
          {drilled && (
            <Button
              size="sm"
              variant="outline"
              className="mb-2"
              onClick={() => {
                setDrilled(false);
              }}
            >
              Back to world
            </Button>
          )}
          {topology.isError && (
            <p className="text-muted-foreground text-sm">
              The map could not be drawn. Every figure is in the table.
            </p>
          )}
          {mapDrawn && (
            <Choropleth
              topology={topology.data}
              objectName={view.layer}
              projection={view.projection}
              readings={readings}
              countLabel={summedCountLabel('Visitors', bucketing)}
              shareLabel={shares.full}
              codeForId={view.codeForId}
              title={view.title}
              {...(drilled
                ? {}
                : {
                    onSelect: (code: string) => {
                      if (code === DRILL_DOWN_COUNTRY) setDrilled(true);
                    },
                  })}
            />
          )}
        </div>
        <GeoTable
          places={places}
          bucketing={bucketing}
          keyLabel={view.keyLabel}
          shareColumn={shares.column}
        />
      </div>
      <figcaption className="text-muted-foreground mt-2 text-xs">
        {panelNote(
          drilled,
          places.some((place) => place.overflow),
          mapDrawn
        )}
      </figcaption>
    </figure>
  );
}
