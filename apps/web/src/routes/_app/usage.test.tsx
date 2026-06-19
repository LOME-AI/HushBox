import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderRoute } from '@/test-utils/render';
import { Route } from './usage';

vi.mock('@/components/usage/usage-content', () => ({
  UsageContent: (): React.JSX.Element => <div data-testid="usage-content" />,
}));

describe('/_app/usage route', () => {
  it('renders the Usage page header', () => {
    renderRoute(Route);
    expect(screen.getByText('Usage')).toBeInTheDocument();
  });

  it('renders the usage content region', () => {
    renderRoute(Route);
    expect(screen.getByTestId('usage-content')).toBeInTheDocument();
  });
});
