import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Filters } from './Filters';
import type { FilterState } from './use-filter-state';

function makeState(overrides: Partial<FilterState> = {}): FilterState {
  return {
    statuses: new Set(['in_progress', 'planned', 'shipped']),
    types: new Set(['feature', 'bug']),
    toggleStatus: vi.fn(),
    toggleType: vi.fn(),
    ...overrides,
  };
}

describe('Filters', () => {
  it('renders a chip for each status and type', () => {
    render(<Filters state={makeState()} />);
    expect(screen.getByText('In progress')).toBeInTheDocument();
    expect(screen.getByText('Planned')).toBeInTheDocument();
    expect(screen.getByText('Shipped')).toBeInTheDocument();
    expect(screen.getByText('Features')).toBeInTheDocument();
    expect(screen.getByText('Bugs')).toBeInTheDocument();
  });

  it('marks active chips with aria-pressed=true', () => {
    const state = makeState({ statuses: new Set(['in_progress']) });
    render(<Filters state={state} />);
    expect(screen.getByText('In progress').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Planned').getAttribute('aria-pressed')).toBe('false');
  });

  it('calls toggleStatus when a status chip is clicked', async () => {
    const toggleStatus = vi.fn();
    render(<Filters state={makeState({ toggleStatus })} />);
    await userEvent.click(screen.getByText('Shipped'));
    expect(toggleStatus).toHaveBeenCalledWith('shipped');
  });

  it('calls toggleType when a type chip is clicked', async () => {
    const toggleType = vi.fn();
    render(<Filters state={makeState({ toggleType })} />);
    await userEvent.click(screen.getByText('Bugs'));
    expect(toggleType).toHaveBeenCalledWith('bug');
  });
});
