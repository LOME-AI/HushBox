import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderRoute } from '@/test-utils/render';
import { Route } from './accessibility';

// renderRoute renders through the real provider stack, which pulls A11yProvider
// and MotionProvider from this module — so keep the actual exports and override
// only AccessibilityPanel (whose internals are out of scope for this route).
vi.mock('@hushbox/ui/accessibility', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui/accessibility')>();
  return {
    ...actual,
    AccessibilityPanel: (): React.JSX.Element => (
      <section data-testid="accessibility-panel-mock">Panel</section>
    ),
  };
});

describe('/accessibility route', () => {
  it('renders the PageHeader with title "Accessibility"', () => {
    renderRoute(Route);
    expect(screen.getByText('Accessibility')).toBeInTheDocument();
  });

  it('renders the ThemeToggle in the header right slot', () => {
    renderRoute(Route);
    expect(screen.getByTestId('theme-toggle')).toBeInTheDocument();
  });

  it('renders the AccessibilityPanel below the header', () => {
    renderRoute(Route);
    expect(screen.getByTestId('accessibility-panel-mock')).toBeInTheDocument();
  });
});
