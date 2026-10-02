import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  GROWTH_READ_OPS,
  stubFetch,
  renderScreen,
  screenReady,
  installGrowthScreenHarness,
} from './test-support/growth-screen-harness.setup.js';

vi.mock('@/components/ops/op-modal-provider', () => ({
  useRunOp: () => vi.fn(),
}));

vi.mock('recharts', async (importOriginal) => {
  const { rechartsWithFixedContainer } =
    await import('./test-support/recharts-fixed-container.setup.js');
  return rechartsWithFixedContainer(await importOriginal<typeof import('recharts')>());
});

installGrowthScreenHarness();

describe('GrowthScreen reads', () => {
  it('issues one read per operation, and per window and grain where an operation is asked twice', async () => {
    const fetchMock = stubFetch();
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByText('Campaign: hn-launch')).toBeInTheDocument();
    });
    const callsPer = (op: string): number =>
      fetchMock.mock.calls.filter((call) => String(call[0]).includes(`/ops/${op}/execute`)).length;
    // The marketing relation answers three different questions on this page: the
    // visitor series over the range at the grain toggled, and the two
    // campaign-free marginals over the week selected, one at each grain.
    expect(callsPer('growth.marketing.read')).toBe(3);
    for (const op of GROWTH_READ_OPS.filter((each) => each !== 'growth.marketing.read')) {
      expect(callsPer(op)).toBe(1);
    }
  });

  it('spends nine of the operation budget per load, not more', async () => {
    const fetchMock = stubFetch();
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByText('Campaign: hn-launch')).toBeInTheDocument();
    });
    const reads = fetchMock.mock.calls.filter((call) => String(call[0]).includes('/execute'));
    expect(reads).toHaveLength(9);
  });

  it('offers a control to spend another round of reads deliberately', async () => {
    stubFetch();
    renderScreen();
    await screenReady();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
  });

  it('re-reads only when the refresh control is used', async () => {
    const fetchMock = stubFetch();
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByText('Campaign: hn-launch')).toBeInTheDocument();
    });
    const before = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes('/execute')
    ).length;
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => {
      const after = fetchMock.mock.calls.filter((call) =>
        String(call[0]).includes('/execute')
      ).length;
      expect(after).toBeGreaterThan(before);
    });
  });
});

describe('GrowthScreen per-panel degradation', () => {
  it('shows the failed panel as a stated failure', async () => {
    stubFetch({ failing: new Set(['growth.reach.read']) });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByText('UNAVAILABLE')).toBeInTheDocument();
    });
  });

  it('keeps every other panel rendering when one read fails', async () => {
    stubFetch({ failing: new Set(['growth.reach.read']) });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByText('Campaign: hn-launch')).toBeInTheDocument();
    });
    expect(screen.getByRole('listitem', { name: /news\.ycombinator\.com/ })).toBeInTheDocument();
  });

  it('never renders a failed panel as a zero', async () => {
    stubFetch({ failing: new Set(['growth.reach.read']) });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByText('UNAVAILABLE')).toBeInTheDocument();
    });
    expect(screen.queryByText(/No journeys were counted/)).not.toBeInTheDocument();
  });
});
