import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ScrollReveal } from './scroll-reveal';

describe('ScrollReveal', () => {
  it('renders children', () => {
    render(<ScrollReveal>Reveal me</ScrollReveal>);
    expect(screen.getByText('Reveal me')).toBeInTheDocument();
  });

  it('has data-slot attribute', () => {
    render(<ScrollReveal data-testid="reveal">Content</ScrollReveal>);
    expect(screen.getByTestId('reveal')).toHaveAttribute('data-slot', 'scroll-reveal');
  });

  it('applies custom className', () => {
    render(
      <ScrollReveal className="custom-class" data-testid="reveal">
        Content
      </ScrollReveal>
    );
    expect(screen.getByTestId('reveal')).toHaveClass('custom-class');
  });

  it('applies animation class based on animation prop', () => {
    render(
      <ScrollReveal animation="fade-up" data-testid="reveal">
        Content
      </ScrollReveal>
    );
    expect(screen.getByTestId('reveal')).toHaveAttribute('data-animation', 'fade-up');
  });

  it('defaults to fade-up animation', () => {
    render(<ScrollReveal data-testid="reveal">Content</ScrollReveal>);
    expect(screen.getByTestId('reveal')).toHaveAttribute('data-animation', 'fade-up');
  });

  it('applies delay as CSS variable', () => {
    render(
      <ScrollReveal delay={200} data-testid="reveal">
        Content
      </ScrollReveal>
    );
    const el = screen.getByTestId('reveal');
    expect(el.style.getPropertyValue('--reveal-delay')).toBe('200ms');
  });
});
