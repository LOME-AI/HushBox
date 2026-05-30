import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Modality } from '@hushbox/shared';
import { ThinkingIndicator } from './thinking-indicator';

const activeModalityRef = { current: 'text' as Modality };

vi.mock('@/stores/model', () => ({
  useModelStore: <T,>(selector: (state: { activeModality: Modality }) => T): T =>
    selector({ activeModality: activeModalityRef.current }),
}));

describe('ThinkingIndicator', () => {
  beforeEach(() => {
    activeModalityRef.current = 'text';
  });
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

  it('strips provider prefix from model name', () => {
    render(<ThinkingIndicator modelName="deepseek/deepseek-r1" />);
    expect(screen.getByText('deepseek-r1 is thinking')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'deepseek-r1 is thinking');
  });

  it('replaces the "is thinking" text with stageLabel when provided', () => {
    render(<ThinkingIndicator modelName="GPT-4" stageLabel="Choosing the best model…" />);
    expect(screen.getByText('Choosing the best model…')).toBeInTheDocument();
    // Model name is suppressed when a stage label is active.
    expect(screen.queryByText('GPT-4 is thinking')).not.toBeInTheDocument();
  });

  it('uses the stageLabel as the aria-label when provided', () => {
    render(<ThinkingIndicator modelName="GPT-4" stageLabel="Choosing the best model…" />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Choosing the best model…');
  });

  describe('modality-aware copy', () => {
    it('shows "is generating an image..." for image modality', () => {
      activeModalityRef.current = 'image';
      render(<ThinkingIndicator modelName="Claude" />);
      expect(screen.getByText('Claude is generating an image...')).toBeInTheDocument();
    });

    it('shows "is generating a video..." for video modality', () => {
      activeModalityRef.current = 'video';
      render(<ThinkingIndicator modelName="Claude" />);
      expect(screen.getByText('Claude is generating a video...')).toBeInTheDocument();
    });

    it('shows "is generating audio..." for audio modality', () => {
      activeModalityRef.current = 'audio';
      render(<ThinkingIndicator modelName="Claude" />);
      expect(screen.getByText('Claude is generating audio...')).toBeInTheDocument();
    });

    it('sets aria-label to match for image modality', () => {
      activeModalityRef.current = 'image';
      render(<ThinkingIndicator modelName="Claude" />);
      expect(screen.getByRole('status')).toHaveAttribute(
        'aria-label',
        'Claude is generating an image...'
      );
    });

    it('preserves "is thinking" text for text modality', () => {
      activeModalityRef.current = 'text';
      render(<ThinkingIndicator modelName="Claude" />);
      expect(screen.getByText('Claude is thinking')).toBeInTheDocument();
    });

    it('stageLabel still wins over modality-aware text for image modality', () => {
      activeModalityRef.current = 'image';
      render(<ThinkingIndicator modelName="Claude" stageLabel="Choosing the best model…" />);
      expect(screen.getByText('Choosing the best model…')).toBeInTheDocument();
      expect(screen.queryByText('Claude is generating an image...')).not.toBeInTheDocument();
    });
  });
});
