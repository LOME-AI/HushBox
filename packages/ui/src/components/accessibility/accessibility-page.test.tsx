import { render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// AccessibilityPanel transitively imports kokoro-js / phonemizer (large WASM at
// import time). Replace it with a lightweight stub so this page-level test
// stays fast and focused on the page composition.
vi.mock('./accessibility-panel', () => ({
  AccessibilityPanel: (): React.JSX.Element => (
    <section aria-labelledby="mock-panel-heading" data-testid="mock-accessibility-panel">
      <h2 id="mock-panel-heading">Accessibility settings</h2>
    </section>
  ),
}));

// Default useIsMobile to desktop layout for predictable landmark queries.
vi.mock('../../hooks/use-is-mobile', () => ({
  useIsMobile: vi.fn(() => false),
}));

import * as React from 'react';
import { useIsMobile } from '../../hooks/use-is-mobile';
import { AccessibilityPage } from './accessibility-page';

const mockUseIsMobile = vi.mocked(useIsMobile);

describe('AccessibilityPage', () => {
  beforeEach(() => {
    mockUseIsMobile.mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders the SettingsLayout with the "Accessibility" page title', () => {
    render(<AccessibilityPage />);
    expect(screen.getByRole('heading', { name: 'Accessibility', level: 1 })).toBeInTheDocument();
  });

  it('renders a navigation landmark from SettingsLayout', () => {
    render(<AccessibilityPage />);
    expect(screen.getByRole('navigation')).toBeInTheDocument();
  });

  it('renders a main landmark from SettingsLayout', () => {
    render(<AccessibilityPage />);
    expect(screen.getByRole('main')).toBeInTheDocument();
  });

  it('renders a single nav button labelled "Accessibility"', () => {
    render(<AccessibilityPage />);
    const nav = screen.getByRole('navigation');
    const buttons = within(nav).getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent('Accessibility');
  });

  it('marks the single nav item as the current page', () => {
    render(<AccessibilityPage />);
    const nav = screen.getByRole('navigation');
    const button = within(nav).getByRole('button', { name: 'Accessibility' });
    expect(button).toHaveAttribute('aria-current', 'page');
  });

  it('renders the AccessibilityPanel inside the main landmark', () => {
    render(<AccessibilityPage />);
    const main = screen.getByRole('main');
    expect(within(main).getByTestId('mock-accessibility-panel')).toBeInTheDocument();
  });

  it('exposes the panel section heading', () => {
    render(<AccessibilityPage />);
    expect(
      screen.getByRole('heading', { name: 'Accessibility settings', level: 2 })
    ).toBeInTheDocument();
  });

  it('does not throw when the nav button is clicked (single-item nav, no-op handler)', () => {
    render(<AccessibilityPage />);
    const button = screen.getByRole('button', { name: 'Accessibility' });
    expect(() => {
      button.click();
    }).not.toThrow();
  });

  it('renders correctly under the mobile layout too', () => {
    mockUseIsMobile.mockReturnValue(true);
    render(<AccessibilityPage />);
    expect(screen.getByRole('heading', { name: 'Accessibility', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('navigation')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByTestId('mock-accessibility-panel')).toBeInTheDocument();
  });
});
