import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DAY_MS } from '@hushbox/shared/test-time';
import {
  WEEK_START,
  stubFetch,
  renderScreen,
  screenReady,
  chooseWeek,
  panelNamed,
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

describe('GrowthScreen reach panel', () => {
  it('draws the journeys the read returned', async () => {
    stubFetch();
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(
        within(panelNamed('Landed on, then reached')).getByRole('cell', { name: '/pricing' })
      ).toBeInTheDocument();
    });
  });
});

describe('GrowthScreen funnel', () => {
  it('draws a ladder for the campaign in range', async () => {
    stubFetch();
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByText('Campaign: hn-launch')).toBeInTheDocument();
    });
  });

  it('states the ladder steps', async () => {
    stubFetch();
    renderScreen();
    await screenReady();
    await waitFor(() => {
      const bar = screen.getByRole('listitem', { name: /Account created/ });
      expect(within(bar).getByText('41')).toBeInTheDocument();
    });
  });
});

describe('GrowthScreen with a week that has no ladder', () => {
  it('says so rather than drawing an empty ladder', async () => {
    stubFetch();
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByText('Campaign: hn-launch')).toBeInTheDocument();
    });
    await chooseWeek(WEEK_START - 5 * 7 * DAY_MS);
    await waitFor(() => {
      expect(screen.getByText('No ladder for this week.')).toBeInTheDocument();
    });
  });
});
