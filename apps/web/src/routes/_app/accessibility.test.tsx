import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => options,
}));

vi.mock('@hushbox/ui/accessibility', () => ({
  AccessibilityPanel: (): React.JSX.Element => (
    <section data-testid="accessibility-panel-mock">Panel</section>
  ),
}));

vi.mock('@/components/shared/page-header', () => ({
  PageHeader: ({
    title,
    right,
  }: {
    title?: string;
    right?: React.ReactNode;
  }): React.JSX.Element => (
    <header data-testid="page-header-mock">
      <span data-testid="page-header-title">{title}</span>
      <span data-testid="page-header-right">{right}</span>
    </header>
  ),
}));

vi.mock('@/components/shared/theme-toggle', () => ({
  ThemeToggle: (): React.JSX.Element => <button data-testid="theme-toggle-mock">Theme</button>,
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

  it('renders the PageHeader with title "Accessibility"', () => {
    const Component = (Route as unknown as RouteShape).component;
    render(<Component />);
    expect(screen.getByTestId('page-header-mock')).toBeInTheDocument();
    expect(screen.getByTestId('page-header-title').textContent).toBe('Accessibility');
  });

  it('renders the ThemeToggle in the header right slot', () => {
    const Component = (Route as unknown as RouteShape).component;
    render(<Component />);
    expect(screen.getByTestId('theme-toggle-mock')).toBeInTheDocument();
  });

  it('renders the AccessibilityPanel below the header', () => {
    const Component = (Route as unknown as RouteShape).component;
    render(<Component />);
    expect(screen.getByTestId('accessibility-panel-mock')).toBeInTheDocument();
  });
});
