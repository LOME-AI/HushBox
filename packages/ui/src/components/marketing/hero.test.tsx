import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Hero } from './hero';

describe('Hero', () => {
  it('renders title', { timeout: 15_000 }, () => {
    render(<Hero title="Welcome to HushBox" />);
    expect(screen.getByRole('heading', { name: 'Welcome to HushBox' })).toBeInTheDocument();
  });

  it('renders subtitle when provided', () => {
    render(<Hero title="Title" subtitle="A subtitle" />);
    expect(screen.getByText('A subtitle')).toBeInTheDocument();
  });

  it('does not render subtitle when not provided', () => {
    const { container } = render(<Hero title="Title" />);
    expect(container.querySelector('[data-slot="hero-subtitle"]')).toBeNull();
  });

  it('has data-slot attribute', () => {
    render(<Hero title="Title" data-testid="hero" />);
    expect(screen.getByTestId('hero')).toHaveAttribute('data-slot', 'hero');
  });

  it('applies custom className', () => {
    render(<Hero title="Title" className="custom-class" data-testid="hero" />);
    expect(screen.getByTestId('hero')).toHaveClass('custom-class');
  });

  it('renders children', () => {
    render(<Hero title="Title">Extra content</Hero>);
    expect(screen.getByText('Extra content')).toBeInTheDocument();
  });

  it('applies size as data attribute', () => {
    render(<Hero title="Title" size="compact" data-testid="hero" />);
    expect(screen.getByTestId('hero')).toHaveAttribute('data-size', 'compact');
  });

  it('defaults to full size', () => {
    render(<Hero title="Title" data-testid="hero" />);
    expect(screen.getByTestId('hero')).toHaveAttribute('data-size', 'full');
  });
});
