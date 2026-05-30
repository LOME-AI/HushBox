import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProgressBar } from './ProgressBar';

describe('ProgressBar', () => {
  it('renders the done and total counts', () => {
    render(<ProgressBar done={3} total={4} />);
    expect(screen.getByText(/3 of 4/i)).toBeInTheDocument();
  });

  it('renders the percentage rounded to a whole number', () => {
    render(<ProgressBar done={3} total={4} />);
    expect(screen.getByText(/75%/)).toBeInTheDocument();
  });

  it('renders 0% when nothing is done', () => {
    render(<ProgressBar done={0} total={3} />);
    expect(screen.getByText(/0%/)).toBeInTheDocument();
    expect(screen.getByText(/0 of 3/i)).toBeInTheDocument();
  });

  it('renders 100% when fully done', () => {
    render(<ProgressBar done={5} total={5} />);
    expect(screen.getByText(/100%/)).toBeInTheDocument();
  });

  it('renders an aria-valued progressbar role', () => {
    render(<ProgressBar done={3} total={4} />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '3');
    expect(bar).toHaveAttribute('aria-valuemax', '4');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
  });

  it('renders gracefully when total is zero', () => {
    render(<ProgressBar done={0} total={0} />);
    expect(screen.getByText(/0 of 0/i)).toBeInTheDocument();
    expect(screen.getByText(/0%/)).toBeInTheDocument();
  });

  it('rounds percentages to the nearest integer', () => {
    render(<ProgressBar done={1} total={3} />);
    expect(screen.getByText(/33%/)).toBeInTheDocument();
  });

  it('exposes the percentage via a data attribute so layouts can read it', () => {
    render(<ProgressBar done={1} total={4} />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('data-percent', '25');
  });
});
