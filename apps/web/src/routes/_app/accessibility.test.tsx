import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => options,
}));

vi.mock('@hushbox/ui/accessibility', () => ({
  AccessibilityPage: (): React.JSX.Element => (
    <div data-testid="accessibility-page-mock">Accessibility</div>
  ),
}));

import { Route } from './accessibility';

interface RouteShape {
  component: React.ComponentType;
}

describe('/accessibility route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exports a Route with a component', () => {
    expect((Route as unknown as RouteShape).component).toBeDefined();
  });

  it('renders the AccessibilityPage component', () => {
    const Component = (Route as unknown as RouteShape).component;
    render(<Component />);
    expect(screen.getByTestId('accessibility-page-mock')).toBeInTheDocument();
  });
});
