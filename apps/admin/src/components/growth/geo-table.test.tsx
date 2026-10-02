import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GeoTable, geoColumns, geoPlaces } from './geo-table.js';
import type { GeoPlaceCount } from './geo-table.js';
import type { GeoTotal } from './marketing-rows.js';

const COUNTS: readonly GeoPlaceCount[] = [
  { code: 'DE', place: 'DE', visitors: 140, overflow: false },
  { code: 'US', place: 'US', visitors: 201, overflow: false },
  { code: 'SG', place: 'SG', visitors: 12, overflow: false },
  { code: '', place: '(country unknown)', visitors: 3, overflow: false },
];

const PLACES = geoPlaces(COUNTS);

/** What the table's share column is a share of, which the panel names. */
const SHARE_COLUMN = 'Share of the world';

describe('geoPlaces', () => {
  it('orders the places largest first', () => {
    expect(PLACES.map((place) => place.code)).toEqual(['US', 'DE', 'SG', '']);
  });

  it('ranks each place among the places it was counted beside', () => {
    expect(PLACES.map((place) => place.rank)).toEqual([1, 2, 3, 4]);
    expect(PLACES.every((place) => place.of === 4)).toBe(true);
  });

  it('gives each place its share of every figure counted', () => {
    const [leader] = PLACES;
    expect(leader?.share).toBeCloseTo(201 / 356, 6);
    expect(PLACES.reduce((sum, place) => sum + (place.share ?? 0), 0)).toBeCloseTo(1, 6);
  });

  it('has no share to state where nothing at all was counted', () => {
    const [only] = geoPlaces([{ code: 'DE', place: 'DE', visitors: 0, overflow: false }]);
    expect(only?.share).toBeNull();
  });

  it('keeps a figure the ceiling cut off marked as a floor', () => {
    const [only] = geoPlaces([{ code: 'DE', place: 'DE', visitors: 9, overflow: true }]);
    expect(only?.overflow).toBe(true);
  });
});

describe('GeoTable', () => {
  it('lists every place it was given', () => {
    render(
      <GeoTable places={PLACES} bucketing="daily" keyLabel="Country" shareColumn={SHARE_COLUMN} />
    );
    expect(screen.getAllByRole('row')).toHaveLength(PLACES.length + 1);
  });

  it('heads each row with the place it is about', () => {
    render(
      <GeoTable places={PLACES} bucketing="daily" keyLabel="Country" shareColumn={SHARE_COLUMN} />
    );
    expect(screen.getByRole('rowheader', { name: 'US' })).toBeInTheDocument();
  });

  it('keeps a place the map cannot draw in the table', () => {
    render(
      <GeoTable places={PLACES} bucketing="daily" keyLabel="Country" shareColumn={SHARE_COLUMN} />
    );
    expect(screen.getByRole('rowheader', { name: 'SG' })).toBeInTheDocument();
  });

  it('names an unresolved place rather than leaving the row blank', () => {
    render(
      <GeoTable places={PLACES} bucketing="daily" keyLabel="Country" shareColumn={SHARE_COLUMN} />
    );
    expect(screen.getByRole('rowheader', { name: '(country unknown)' })).toBeInTheDocument();
  });

  it('states each place figure beside its share of the whole', () => {
    render(
      <GeoTable places={PLACES} bucketing="daily" keyLabel="Country" shareColumn={SHARE_COLUMN} />
    );
    expect(screen.getByRole('cell', { name: '201' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '56.5%' })).toBeInTheDocument();
  });

  it('states each place rank, so the figure the map reads out is in the table too', () => {
    render(
      <GeoTable places={PLACES} bucketing="daily" keyLabel="Country" shareColumn={SHARE_COLUMN} />
    );
    const [, leader] = screen.getAllByRole('row');
    expect(leader?.textContent).toMatch(/^1US201/);
  });

  it('says there is no share where nothing at all was counted', () => {
    render(
      <GeoTable
        places={geoPlaces([{ code: 'DE', place: 'DE', visitors: 0, overflow: false }])}
        bucketing="daily"
        keyLabel="Country"
        shareColumn={SHARE_COLUMN}
      />
    );
    expect(screen.getByRole('cell', { name: 'No rate' })).toBeInTheDocument();
  });

  it('marks a figure the ceiling cut off as a floor', () => {
    render(
      <GeoTable
        places={geoPlaces([{ code: 'US', place: 'US', visitors: 100_000, overflow: true }])}
        bucketing="daily"
        keyLabel="Country"
        shareColumn={SHARE_COLUMN}
      />
    );
    expect(screen.getByText('100,000+')).toBeInTheDocument();
  });

  it('says nothing was counted when there are no places', () => {
    render(
      <GeoTable places={[]} bucketing="daily" keyLabel="Country" shareColumn={SHARE_COLUMN} />
    );
    expect(screen.getByText(/Nothing was counted/i)).toBeInTheDocument();
  });

  it('leaves the device dimension to the exported file', () => {
    render(
      <GeoTable places={PLACES} bucketing="daily" keyLabel="Country" shareColumn={SHARE_COLUMN} />
    );
    expect(screen.queryByRole('columnheader', { name: 'Device' })).not.toBeInTheDocument();
  });
});

describe('GeoTable scroll region', () => {
  it('scrolls the table inside a box a keyboard can reach, named by what it holds', () => {
    render(
      <GeoTable places={PLACES} bucketing="daily" keyLabel="Country" shareColumn={SHARE_COLUMN} />
    );
    const region = screen.getByRole('group', { name: /^Country by .*, largest first$/ });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region).toContainElement(screen.getByRole('table'));
  });

  // The rows' rules run to the box's edge, so a rounded box would clip their ends.
  it('keeps the box square, so its corners cut nothing the table draws', () => {
    render(
      <GeoTable places={PLACES} bucketing="daily" keyLabel="Country" shareColumn={SHARE_COLUMN} />
    );
    expect(screen.getByRole('group', { name: /largest first$/ }).className).not.toMatch(
      /(^|\s)rounded(-|\s|$)/
    );
  });
});

describe('GeoTable column headings', () => {
  it('names its first column whatever the places are', () => {
    render(
      <GeoTable places={PLACES} bucketing="daily" keyLabel="State" shareColumn={SHARE_COLUMN} />
    );
    expect(screen.getByRole('columnheader', { name: 'State' })).toBeInTheDocument();
  });

  it('says which buckets the visitor figure was summed from', () => {
    render(
      <GeoTable places={PLACES} bucketing="daily" keyLabel="Country" shareColumn={SHARE_COLUMN} />
    );
    expect(
      screen.getByRole('columnheader', { name: 'Visitors (daily uniques, summed)' })
    ).toBeInTheDocument();
  });

  it('names the set its share column is a share of', () => {
    render(
      <GeoTable places={PLACES} bucketing="daily" keyLabel="Country" shareColumn={SHARE_COLUMN} />
    );
    expect(screen.getByRole('columnheader', { name: SHARE_COLUMN })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Share' })).not.toBeInTheDocument();
  });

  it('follows the hour grain into the heading', () => {
    render(
      <GeoTable places={PLACES} bucketing="hourly" keyLabel="Country" shareColumn={SHARE_COLUMN} />
    );
    expect(
      screen.getByRole('columnheader', { name: 'Visitors (hourly uniques, summed)' })
    ).toBeInTheDocument();
  });
});

describe('geoColumns', () => {
  function total(over: Partial<GeoTotal>): GeoTotal {
    return {
      country: 'US',
      region: 'CA',
      device: 'desktop',
      visitors: 201,
      overflow: false,
      ...over,
    };
  }

  function placeIn(row: GeoTotal): unknown {
    const [place] = geoColumns('daily');
    return place?.value(row);
  }

  it('writes a United States row as the country and its state', () => {
    expect(placeIn(total({}))).toBe('US · CA');
  });

  it('writes a country with no region as the country alone', () => {
    expect(placeIn(total({ country: 'DE', region: '' }))).toBe('DE');
  });

  it('names a place whose country was never resolved rather than leaving it blank', () => {
    expect(placeIn(total({ country: '', region: '' }))).toBe('(unknown)');
  });

  it('keeps the device dimension the table leaves to it', () => {
    expect(geoColumns('daily').map((column) => column.header)).toContain('Device');
  });

  it('writes the place, the device, the figure and the ceiling flag', () => {
    expect(geoColumns('daily').map((column) => column.value(total({})))).toEqual([
      'US · CA',
      'desktop',
      201,
      'false',
    ]);
  });
});
