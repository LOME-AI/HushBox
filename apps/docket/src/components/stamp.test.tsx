import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Stamp } from './stamp';

describe('Stamp', () => {
  // A stored moment is already a day, so input equals output is the whole
  // specification: this fails the moment anything formats the value again.
  it('renders the stamp it was given, with nothing formatted away', () => {
    render(<Stamp at="2026-08-01" />);

    expect(screen.getByText('2026-08-01')).toBeInTheDocument();
  });

  it('keeps the stamp it was given for anything reading the markup', () => {
    render(<Stamp at="2026-08-01" />);

    expect(screen.getByText('2026-08-01')).toHaveAttribute('datetime', '2026-08-01');
  });
});
