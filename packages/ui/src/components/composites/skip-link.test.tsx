import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SkipLink } from './skip-link';

describe('SkipLink', () => {
  it('links to the main landmark as "Skip to content"', () => {
    render(<SkipLink />);

    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute('href', '#main');
  });

  it('stays visually hidden until it takes focus', () => {
    render(<SkipLink />);

    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveClass(
      'sr-only',
      'focus:not-sr-only'
    );
  });

  it('draws the focus-visible ring of the shared primitives', () => {
    render(<SkipLink />);

    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveClass(
      'focus-visible:ring-[3px]',
      'focus-visible:ring-ring/50'
    );
  });

  it('hides the browser outline only where forced colors cannot repaint it', () => {
    render(<SkipLink />);

    // `outline-none` would leave no indicator in forced colors, which drop the ring.
    const link = screen.getByRole('link', { name: 'Skip to content' });
    expect(link).toHaveClass('outline-hidden');
    expect(link).not.toHaveClass('outline-none');
  });
});
