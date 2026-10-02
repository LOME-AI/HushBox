import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { PopoverFact } from './popover-fact';

function Glyph({ className }: Readonly<{ className?: string }>): React.JSX.Element {
  return <svg data-testid="glyph" className={className} />;
}

describe('PopoverFact', () => {
  it('shows its text', () => {
    render(<PopoverFact icon={Glyph}>Saved encrypted</PopoverFact>);

    expect(screen.getByText('Saved encrypted')).toBeInTheDocument();
  });

  it('centres its icon on the whole text', () => {
    render(<PopoverFact icon={Glyph}>Saved encrypted</PopoverFact>);

    expect(screen.getByText('Saved encrypted').parentElement).toHaveClass('items-center');
  });

  it('draws its icon in the muted ink', () => {
    render(<PopoverFact icon={Glyph}>Saved encrypted</PopoverFact>);

    expect(screen.getByTestId('glyph')).toHaveClass('text-muted-foreground');
  });

  it('keeps its icon out of the accessibility tree', () => {
    render(<PopoverFact icon={Glyph}>Saved encrypted</PopoverFact>);

    expect(screen.getByTestId('glyph').parentElement).toHaveAttribute('aria-hidden', 'true');
  });
});
