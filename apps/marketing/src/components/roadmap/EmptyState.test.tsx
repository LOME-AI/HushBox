import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EmptyState } from './EmptyState';

describe('EmptyState', () => {
  it('renders a "no matches" message', () => {
    render(<EmptyState onReset={vi.fn()} />);
    expect(screen.getByText(/no projects match/i)).toBeInTheDocument();
  });

  it('renders a Reset filters button', () => {
    render(<EmptyState onReset={vi.fn()} />);
    expect(screen.getByRole('button', { name: /reset filters/i })).toBeInTheDocument();
  });

  it('calls onReset when the button is clicked', async () => {
    const user = userEvent.setup();
    const onReset = vi.fn();
    render(<EmptyState onReset={onReset} />);
    await user.click(screen.getByRole('button', { name: /reset filters/i }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('exposes a data-roadmap-empty attribute for E2E selectors', () => {
    const { container } = render(<EmptyState onReset={vi.fn()} />);
    expect(container.querySelector('[data-roadmap-empty]')).not.toBeNull();
  });
});
