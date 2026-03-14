import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/hooks/use-is-settled', () => ({
  useIsSettled: vi.fn(),
}));

import { useIsSettled } from '@/hooks/use-is-settled';
import { SettledIndicator } from './settled-indicator.js';

const mockedUseIsSettled = vi.mocked(useIsSettled);

describe('SettledIndicator', () => {
  it('renders data-settled="false" when not settled', () => {
    mockedUseIsSettled.mockReturnValue(false);

    render(<SettledIndicator />);

    const el = screen.getByTestId('settled-indicator');
    expect(el).toHaveAttribute('data-settled', 'false');
  });

  it('renders data-settled="true" when settled', () => {
    mockedUseIsSettled.mockReturnValue(true);

    render(<SettledIndicator />);

    const el = screen.getByTestId('settled-indicator');
    expect(el).toHaveAttribute('data-settled', 'true');
  });

  it('is hidden from visual layout', () => {
    mockedUseIsSettled.mockReturnValue(true);

    render(<SettledIndicator />);

    const el = screen.getByTestId('settled-indicator');
    expect(el).not.toBeVisible();
  });
});
