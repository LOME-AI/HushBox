import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('./accessibility-panel', () => ({
  AccessibilityPanel: (): React.JSX.Element => (
    <section data-testid="mock-accessibility-panel">
      <h2>Accessibility settings</h2>
    </section>
  ),
}));

import { AccessibilityPage } from './accessibility-page';

describe('AccessibilityPage', () => {
  it('renders an h1 "Accessibility" title', () => {
    render(<AccessibilityPage />);
    expect(screen.getByRole('heading', { name: 'Accessibility', level: 1 })).toBeInTheDocument();
  });

  it('renders the AccessibilityPanel below the title', () => {
    render(<AccessibilityPage />);
    expect(screen.getByTestId('mock-accessibility-panel')).toBeInTheDocument();
  });
});
