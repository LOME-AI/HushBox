import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { GeoPanel } from './geo-panel.js';
import type { SummedBucketing } from './summed-label.js';
import type { GrowthMarketingRowWire } from '@hushbox/shared';

afterEach(() => {
  vi.unstubAllGlobals();
});

const TOPOLOGY = {
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
    states: {
      type: 'GeometryCollection',
      geometries: [{ type: 'Polygon', id: '06', arcs: [[0]], properties: { name: 'California' } }],
    },
  },
};

function geoRow(over: Partial<GrowthMarketingRowWire>): GrowthMarketingRowWire {
  return {
    bucket: isoAt(TEST_DAY_START),
    family: 'geo',
    path: null,
    referrerHost: null,
    campaign: null,
    country: 'US',
    region: 'CA',
    device: 'desktop',
    visitors: 10,
    landings: null,
    overflow: false,
    ...over,
  };
}

function renderPanel(
  rows: readonly GrowthMarketingRowWire[],
  bucketing: SummedBucketing = 'daily'
): ReturnType<typeof render> {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(Response.json(TOPOLOGY, { status: 200 })))
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <GeoPanel rows={rows} bucketing={bucketing} />
    </QueryClientProvider>
  );
}

describe('GeoPanel', () => {
  it('lists the places in a table without waiting for any geometry', () => {
    renderPanel([geoRow({})]);
    expect(screen.getByRole('rowheader', { name: 'US' })).toBeInTheDocument();
  });

  it('lists one row per place, with the device dimension left to the export', () => {
    renderPanel([
      geoRow({ device: 'desktop', visitors: 7 }),
      geoRow({ device: 'mobile', visitors: 3 }),
    ]);
    expect(screen.getAllByRole('rowheader', { name: 'US' })).toHaveLength(1);
    expect(screen.getByRole('cell', { name: '10' })).toBeInTheDocument();
  });

  it('folds the states into their country while the world is shown', () => {
    renderPanel([geoRow({ region: 'CA', visitors: 4 }), geoRow({ region: 'NY', visitors: 6 })]);
    expect(screen.getAllByRole('rowheader', { name: 'US' })).toHaveLength(1);
    expect(screen.getByRole('cell', { name: '10' })).toBeInTheDocument();
  });

  it('gives each place its share of every figure counted', () => {
    renderPanel([geoRow({ visitors: 75 }), geoRow({ country: 'DE', region: '', visitors: 25 })]);
    expect(screen.getByRole('cell', { name: '75.0%' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '25.0%' })).toBeInTheDocument();
  });

  it('gives the visitors it could place in no country a row of their own', () => {
    renderPanel([geoRow({ visitors: 9 }), geoRow({ country: '', region: '', visitors: 2 })]);
    expect(screen.getByRole('rowheader', { name: '(country unknown)' })).toBeInTheDocument();
  });

  it('lists the states once the map is drilled into the United States', async () => {
    renderPanel([geoRow({ region: 'CA', visitors: 4 }), geoRow({ region: 'NY', visitors: 6 })]);
    await waitFor(() => {
      expect(screen.getByRole('group', { name: /world/i })).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('img', { name: /United States/ }));
    expect(await screen.findByRole('columnheader', { name: 'State' })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: 'NY' })).toBeInTheDocument();
  });

  it('draws the world map once its geometry arrives', async () => {
    renderPanel([geoRow({})]);
    await waitFor(() => {
      expect(screen.getByRole('group', { name: /world/i })).toBeInTheDocument();
    });
  });

  it('fetches the geometry from the application origin', async () => {
    renderPanel([geoRow({})]);
    await waitFor(() => {
      expect(screen.getByRole('group', { name: /world/i })).toBeInTheDocument();
    });
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(String(calls[0]?.[0])).toBe('/geo/countries-110m.json');
  });

  it('drills into the states when the United States is activated', async () => {
    renderPanel([geoRow({})]);
    await waitFor(() => {
      expect(screen.getByRole('group', { name: /world/i })).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('img', { name: /United States/ }));
    await waitFor(() => {
      expect(screen.getByRole('group', { name: /United States/i })).toBeInTheDocument();
    });
  });

  it('offers a way back to the world map from the states', async () => {
    renderPanel([geoRow({})]);
    await waitFor(() => {
      expect(screen.getByRole('group', { name: /world/i })).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('img', { name: /United States/ }));
    expect(await screen.findByRole('button', { name: 'Back to world' })).toBeInTheDocument();
  });

  it('stays on the world map when a country with no drill-down is activated', async () => {
    renderPanel([geoRow({ country: 'DE', region: '' })]);
    await waitFor(() => {
      expect(screen.getByRole('group', { name: /world/i })).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('img', { name: /United States/ }));
    await waitFor(() => {
      expect(screen.getByRole('group', { name: /United States/i })).toBeInTheDocument();
    });
  });

  it('names a country whose figure is exact with the figure alone', async () => {
    renderPanel([geoRow({ visitors: 201 })]);
    await waitFor(() => {
      expect(
        screen.getByRole('img', {
          name: 'United States. Visitors (daily uniques, summed): 201. Share of all counted in the world: 100.0%. Rank 1 of 1.',
        })
      ).toBeInTheDocument();
    });
  });

  it('names a country with the bucketing the table beside it names', async () => {
    renderPanel([geoRow({ visitors: 201 })]);
    await waitFor(() => {
      expect(
        screen.getByRole('img', { name: /Visitors \(daily uniques, summed\)/ })
      ).toBeInTheDocument();
    });
    expect(screen.getByRole('columnheader', { name: /daily uniques, summed/ })).toBeInTheDocument();
  });

  it('names a country under the hourly bucketing when that is what was counted', async () => {
    renderPanel([geoRow({ visitors: 201 })], 'hourly');
    await waitFor(() => {
      expect(
        screen.getByRole('img', {
          name: 'United States. Visitors (hourly uniques, summed): 201. Share of all counted in the world: 100.0%. Rank 1 of 1.',
        })
      ).toBeInTheDocument();
    });
  });

  it('marks a country whose figure is a floor on the map as the table does', async () => {
    renderPanel([geoRow({ visitors: 100_000, overflow: true })]);
    await waitFor(() => {
      expect(
        screen.getByRole('img', {
          name: /United States\. Visitors \(daily uniques, summed\): 100,000\+/,
        })
      ).toBeInTheDocument();
    });
  });

  it('marks a state whose figure is a floor on the drilled-in map', async () => {
    renderPanel([geoRow({ visitors: 100_000, overflow: true })]);
    await waitFor(() => {
      expect(screen.getByRole('group', { name: /world/i })).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('img', { name: /United States/ }));
    await waitFor(() => {
      expect(
        screen.getByRole('img', {
          name: /California\. Visitors \(daily uniques, summed\): 100,000\+/,
        })
      ).toBeInTheDocument();
    });
  });

  it('keeps the table when the geometry cannot be loaded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('nope', { status: 500 })))
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <GeoPanel rows={[geoRow({})]} bucketing="daily" />
      </QueryClientProvider>
    );
    await waitFor(() => {
      expect(screen.getByText(/map could not be drawn/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('rowheader', { name: 'US' })).toBeInTheDocument();
  });
});

describe('GeoPanel caption', () => {
  it('says where a place the map cannot draw is to be found', () => {
    renderPanel([geoRow({})]);
    expect(screen.getByRole('figure')).toHaveTextContent(/Antarctica/);
    expect(screen.getByRole('figure')).toHaveTextContent(/exported file/);
  });

  it('says how to get back to the countries once it is drilled in', async () => {
    renderPanel([geoRow({})]);
    await waitFor(() => {
      expect(screen.getByRole('group', { name: /world/i })).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('img', { name: /United States/ }));
    expect(await screen.findByText(/Back to world lists the countries again/)).toBeInTheDocument();
  });

  it('gives the visitors it could place in no state a row of their own once drilled in', async () => {
    renderPanel([geoRow({ region: 'CA', visitors: 4 }), geoRow({ region: '', visitors: 2 })]);
    await waitFor(() => {
      expect(screen.getByRole('group', { name: /world/i })).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('img', { name: /United States/ }));
    expect(await screen.findByRole('rowheader', { name: '(state unknown)' })).toBeInTheDocument();
  });

  it('says a share taken from a figure the ceiling cut off is approximate', () => {
    renderPanel([geoRow({ visitors: 100_000, overflow: true })]);
    expect(screen.getByRole('figure')).toHaveTextContent(/counting ceiling/);
  });

  it('claims no such approximation where every figure is exact', () => {
    renderPanel([geoRow({})]);
    expect(screen.getByRole('figure')).not.toHaveTextContent(/counting ceiling/);
  });

  it('claims no drill into the states while the geometry has not arrived', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined))
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <GeoPanel rows={[geoRow({})]} bucketing="daily" />
      </QueryClientProvider>
    );
    expect(screen.getByRole('figure')).toHaveTextContent('Every counted country, largest first.');
    expect(screen.getByRole('figure')).not.toHaveTextContent(/one click away/);
  });

  it('claims no drill into the states once the geometry has failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('nope', { status: 500 })))
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <GeoPanel rows={[geoRow({})]} bucketing="daily" />
      </QueryClientProvider>
    );
    await waitFor(() => {
      expect(screen.getByText(/map could not be drawn/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('figure')).toHaveTextContent('Every counted country, largest first.');
    expect(screen.getByRole('figure')).not.toHaveTextContent(/one click away/);
  });

  it('offers the drill in its scope sentence once the map is drawn', async () => {
    renderPanel([geoRow({})]);
    await waitFor(() => {
      expect(screen.getByRole('group', { name: /world/i })).toBeInTheDocument();
    });
    expect(screen.getByRole('figure')).toHaveTextContent(/one click away/);
  });

  it('keeps the way back in its scope sentence when the drilled geometry fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown) =>
        Promise.resolve(
          String(input).includes('states')
            ? new Response('nope', { status: 500 })
            : Response.json(TOPOLOGY, { status: 200 })
        )
      )
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <GeoPanel rows={[geoRow({})]} bucketing="daily" />
      </QueryClientProvider>
    );
    await waitFor(() => {
      expect(screen.getByRole('group', { name: /world/i })).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('img', { name: /United States/ }));
    await waitFor(() => {
      expect(screen.getByText(/map could not be drawn/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('figure')).toHaveTextContent(/Back to world lists the countries again/);
    expect(screen.getByRole('button', { name: 'Back to world' })).toBeInTheDocument();
  });
});

describe('GeoPanel share denominator', () => {
  it('names the world as the set a share on the world map is taken against', async () => {
    renderPanel([geoRow({})]);
    await waitFor(() => {
      expect(screen.getByRole('group', { name: /world/i })).toBeInTheDocument();
    });
    expect(screen.getByRole('columnheader', { name: 'Share of the world' })).toBeInTheDocument();
  });

  it('names the country as the set once the map is drilled into it', async () => {
    renderPanel([geoRow({ region: 'CA' })]);
    await waitFor(() => {
      expect(screen.getByRole('group', { name: /world/i })).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('img', { name: /United States/ }));
    expect(
      await screen.findByRole('columnheader', { name: 'Share of the United States' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: /Share of all counted in the United States: / })
    ).toBeInTheDocument();
  });
});

describe('GeoPanel drill-down control', () => {
  it('returns to the world map when the back control is used', async () => {
    renderPanel([geoRow({})]);
    await waitFor(() => {
      expect(screen.getByRole('group', { name: /world/i })).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('img', { name: /United States/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Back to world' }));
    await waitFor(() => {
      expect(screen.getByRole('group', { name: /world/i })).toBeInTheDocument();
    });
  });

  it('ignores a country that has no state geometry behind it', async () => {
    renderPanel([geoRow({ country: 'DE', region: '' })]);
    await waitFor(() => {
      expect(screen.getByRole('group', { name: /world/i })).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: 'Back to world' })).not.toBeInTheDocument();
  });
});
