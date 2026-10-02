import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CardTitle } from './card-title';

describe('CardTitle', () => {
  it.each([2, 3, 4] as const)('renders an h%i at level %i', (level) => {
    render(<CardTitle level={level}>Current Balance</CardTitle>);

    expect(screen.getByRole('heading', { level, name: 'Current Balance' })).toBeInTheDocument();
  });

  it('draws the title red by itself, with no colour class from the caller', () => {
    render(<CardTitle level={2}>Current Balance</CardTitle>);

    expect(screen.getByRole('heading', { level: 2 })).toHaveClass('text-brand-red');
  });

  it('sets the title in the UI sans, not the heading serif', () => {
    render(<CardTitle level={3}>Purchase History</CardTitle>);

    expect(screen.getByRole('heading', { level: 3 })).toHaveClass('font-sans');
  });

  it('sizes the title by the third title role', () => {
    render(<CardTitle level={3}>Purchase History</CardTitle>);

    expect(screen.getByRole('heading', { level: 3 })).toHaveClass('text-title-3');
  });

  it('marks itself as the card title slot', () => {
    render(<CardTitle level={2}>Current Balance</CardTitle>);

    expect(screen.getByRole('heading', { level: 2 })).toHaveAttribute('data-slot', 'card-title');
  });
});
