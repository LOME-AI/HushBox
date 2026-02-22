import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ThinkingIndicator } from './thinking-indicator';

describe('ThinkingIndicator', () => {
  it('renders model name with "is thinking" text', () => {
    render(<ThinkingIndicator modelName="GPT-4 Turbo" />);
    expect(screen.getByText('GPT-4 Turbo is thinking')).toBeInTheDocument();
  });

  it('has role="status" for screen reader live region', () => {
    render(<ThinkingIndicator modelName="Claude" />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('has descriptive aria-label', () => {
    render(<ThinkingIndicator modelName="GPT-4 Turbo" />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'GPT-4 Turbo is thinking');
  });

  it('renders three animated dots with animate-dot-pulse class', () => {
    render(<ThinkingIndicator modelName="Claude" />);
    const dots = screen.getByTestId('thinking-indicator').querySelectorAll('.animate-dot-pulse');
    expect(dots).toHaveLength(3);
  });

  it('dots container has aria-hidden="true"', () => {
    render(<ThinkingIndicator modelName="Claude" />);
    const dots = screen.getByTestId('thinking-indicator').querySelectorAll('.animate-dot-pulse');
    const dotsContainer = dots[0]!.parentElement!;
    expect(dotsContainer).toHaveAttribute('aria-hidden', 'true');
  });

  it('each dot has staggered animation-delay', () => {
    render(<ThinkingIndicator modelName="Claude" />);
    const dots = screen.getByTestId('thinking-indicator').querySelectorAll('.animate-dot-pulse');
    expect(dots[0]).toHaveStyle({ animationDelay: '0s' });
    expect(dots[1]).toHaveStyle({ animationDelay: '0.16s' });
    expect(dots[2]).toHaveStyle({ animationDelay: '0.32s' });
  });

  it('has data-testid="thinking-indicator"', () => {
    render(<ThinkingIndicator modelName="Claude" />);
    expect(screen.getByTestId('thinking-indicator')).toBeInTheDocument();
  });

  it('uses muted foreground text color', () => {
    render(<ThinkingIndicator modelName="Claude" />);
    expect(screen.getByTestId('thinking-indicator')).toHaveClass('text-muted-foreground');
  });

  it('falls back to "AI" when modelName is empty string', () => {
    render(<ThinkingIndicator modelName="" />);
    expect(screen.getByText('AI is thinking')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'AI is thinking');
  });
});
