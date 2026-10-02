import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CostCard } from './CostCard';

const COST = { avgUsd: '0.0051', medianUsd: '0.0030', p90Usd: '0.02' };

describe('CostCard', () => {
  it('renders the average as the hero figure', () => {
    render(<CostCard cost={COST} />);
    expect(screen.getByText('$0.0051')).toBeInTheDocument();
    expect(screen.getByText('average cost per message')).toBeInTheDocument();
  });

  it('renders the median and p90 figures', () => {
    render(<CostCard cost={COST} />);
    expect(screen.getByText('$0.003')).toBeInTheDocument();
    expect(screen.getByText('median')).toBeInTheDocument();
    expect(screen.getByText('$0.02')).toBeInTheDocument();
    expect(screen.getByText('p90')).toBeInTheDocument();
  });

  it('caps the average figure at the size its characters fit across the card', () => {
    const { container } = render(<CostCard cost={COST} />);
    expect(container.firstElementChild).toHaveClass('@container');
    const figure = screen.getByText('$0.0051');
    expect(figure.style.getPropertyValue('--figure-chars')).toBe('7');
    expect(figure).toHaveClass(
      'text-[length:min(2.25rem,calc(100cqi/var(--figure-chars)/0.72))]',
      'whitespace-nowrap'
    );
  });

  it('lets the median and p90 figures stack when they cannot sit side by side', () => {
    render(<CostCard cost={COST} />);
    expect(screen.getByText('median').closest('dl')).toHaveClass('flex-wrap');
  });
});
