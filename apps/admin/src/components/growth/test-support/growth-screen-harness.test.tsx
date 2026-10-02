import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  installGrowthScreenHarness,
  renderScreen,
  resetGrowthScreenHarness,
  screenReady,
  stubFetch,
} from './growth-screen-harness.setup.js';

vi.mock('@/components/ops/op-modal-provider', () => ({
  useRunOp: () => vi.fn(),
}));

vi.mock('recharts', async (importOriginal) => {
  const { rechartsWithFixedContainer } = await import('./recharts-fixed-container.setup.js');
  return rechartsWithFixedContainer(await importOriginal<typeof import('recharts')>());
});

installGrowthScreenHarness();

describe('the growth-screen harness reset', () => {
  it('unmounts the rendered screen', async () => {
    stubFetch();
    renderScreen();
    await screenReady();

    resetGrowthScreenHarness();

    expect(screen.queryByRole('heading', { name: 'Growth', level: 1 })).toBeNull();
  });
});
