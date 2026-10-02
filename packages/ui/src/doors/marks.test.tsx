import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TEST_IDS } from '@hushbox/shared';
import { Badge, Kbd, Swatch, ThemeToggle, formatHotkey } from '@hushbox/ui/marks';

describe('@hushbox/ui/marks', () => {
  it('publishes Badge', () => {
    render(<Badge tone="success">Verified</Badge>);

    expect(screen.getByText('Verified')).toHaveClass('text-success-text');
  });

  it('publishes Swatch', () => {
    const { container } = render(<Swatch swatch={2} />);

    expect(container.firstElementChild).toHaveClass('bg-model-2');
  });

  it('publishes Kbd', () => {
    render(<Kbd combo="escape" />);

    expect(screen.getByText('Escape').tagName).toBe('KBD');
  });

  it('publishes formatHotkey', () => {
    expect(formatHotkey('mod+k', { apple: false })).toBe('Ctrl+K');
  });

  it('publishes ThemeToggle', () => {
    render(<ThemeToggle />);

    expect(screen.getByTestId(TEST_IDS.themeToggle)).toBeInTheDocument();
  });
});
