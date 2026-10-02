import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Callout } from './callout';

describe('Callout', () => {
  it('renders children', () => {
    render(<Callout>Callout content</Callout>);
    expect(screen.getByText('Callout content')).toBeInTheDocument();
  });

  it('has data-slot attribute', () => {
    render(<Callout data-testid="callout">Content</Callout>);
    expect(screen.getByTestId('callout')).toHaveAttribute('data-slot', 'callout');
  });

  it('applies custom className', () => {
    render(
      <Callout className="custom-class" data-testid="callout">
        Content
      </Callout>
    );
    expect(screen.getByTestId('callout')).toHaveClass('custom-class');
  });

  it('renders title when provided', () => {
    render(<Callout title="Simply Put">Content</Callout>);
    expect(screen.getByText('Simply Put')).toBeInTheDocument();
  });

  it('draws its box in a tint of the brand red', () => {
    render(<Callout data-testid="callout">Content</Callout>);
    expect(screen.getByTestId('callout')).toHaveClass('border-brand-red/30', 'bg-brand-red/5');
  });

  it('sets its words at full ink', () => {
    render(<Callout title="Simply Put">Content</Callout>);
    expect(screen.getByText('Content')).toHaveClass('text-foreground');
    expect(screen.getByText('Simply Put')).toHaveClass('text-foreground');
  });
});
