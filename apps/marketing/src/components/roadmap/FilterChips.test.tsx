import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FilterChips } from './FilterChips';
import type { FilterStatus, FilterType } from './use-filter-state';

const allStatuses = new Set<FilterStatus>(['in_progress', 'planned', 'shipped']);
const allTypes = new Set<FilterType>(['feature', 'bug']);

const defaultProps = {
  statuses: allStatuses,
  types: allTypes,
  statusCounts: { in_progress: 2, planned: 1, shipped: 1 },
  typeCounts: { feature: 10, bug: 2 },
  onToggleStatus: vi.fn(),
  onToggleType: vi.fn(),
};

describe('FilterChips', () => {
  it('renders one chip per status with its label and count', () => {
    render(<FilterChips {...defaultProps} />);
    expect(screen.getByRole('button', { name: /Shipping now/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Up next/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Shipped/i })).toBeInTheDocument();
  });

  it('renders one chip per type with its label and count', () => {
    render(<FilterChips {...defaultProps} />);
    expect(screen.getByRole('button', { name: /Features/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Bugs/i })).toBeInTheDocument();
  });

  it('shows the status count inside its chip', () => {
    render(<FilterChips {...defaultProps} />);
    const shipping = screen.getByRole('button', { name: /Shipping now/i });
    expect(shipping).toHaveTextContent('2');
  });

  it('shows the type count inside its chip', () => {
    render(<FilterChips {...defaultProps} />);
    const features = screen.getByRole('button', { name: /Features/i });
    expect(features).toHaveTextContent('10');
  });

  it('marks active chips with aria-pressed="true"', () => {
    render(<FilterChips {...defaultProps} />);
    expect(screen.getByRole('button', { name: /Shipping now/i })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('marks inactive chips with aria-pressed="false"', () => {
    const partial = { ...defaultProps, statuses: new Set<FilterStatus>(['in_progress']) };
    render(<FilterChips {...partial} />);
    expect(screen.getByRole('button', { name: /Shipped/i })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });

  it('calls onToggleStatus when a status chip is clicked', async () => {
    const user = userEvent.setup();
    const onToggleStatus = vi.fn();
    render(<FilterChips {...defaultProps} onToggleStatus={onToggleStatus} />);
    await user.click(screen.getByRole('button', { name: /Shipped/i }));
    expect(onToggleStatus).toHaveBeenCalledWith('shipped');
  });

  it('calls onToggleType when a type chip is clicked', async () => {
    const user = userEvent.setup();
    const onToggleType = vi.fn();
    render(<FilterChips {...defaultProps} onToggleType={onToggleType} />);
    await user.click(screen.getByRole('button', { name: /Bugs/i }));
    expect(onToggleType).toHaveBeenCalledWith('bug');
  });

  it('renders status chips with data-status attributes for testing/styling', () => {
    render(<FilterChips {...defaultProps} />);
    expect(screen.getByRole('button', { name: /Shipping now/i })).toHaveAttribute(
      'data-status',
      'in_progress'
    );
  });

  it('renders type chips with data-type attributes for testing/styling', () => {
    render(<FilterChips {...defaultProps} />);
    expect(screen.getByRole('button', { name: /Features/i })).toHaveAttribute(
      'data-type',
      'feature'
    );
  });

  it('groups status chips and type chips into labelled groups', () => {
    render(<FilterChips {...defaultProps} />);
    expect(screen.getByRole('group', { name: /status/i })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /type/i })).toBeInTheDocument();
  });

  it('renders a zero count without truncating the chip', () => {
    const props = {
      ...defaultProps,
      typeCounts: { feature: 10, bug: 0 },
    };
    render(<FilterChips {...props} />);
    const bugs = screen.getByRole('button', { name: /Bugs/i });
    expect(bugs).toHaveTextContent('0');
  });
});
