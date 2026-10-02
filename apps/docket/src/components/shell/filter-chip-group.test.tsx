import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { FilterChipGroup } from './filter-chip-group';

describe('FilterChipGroup', () => {
  it('names the dimension and every value in it', () => {
    render(
      <FilterChipGroup
        label="Severity"
        options={['critical', 'high']}
        selected={[]}
        onChange={(): void => {}}
      />
    );

    expect(screen.getByText('Severity')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'critical' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'high' })).toBeInTheDocument();
  });

  it('shows which values are on', () => {
    render(
      <FilterChipGroup
        label="Severity"
        options={['critical', 'high']}
        selected={['high']}
        onChange={(): void => {}}
      />
    );

    expect(screen.getByRole('button', { name: 'high' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'critical' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });

  it('adds a value that was off', () => {
    const onChange = vi.fn();
    render(
      <FilterChipGroup
        label="Severity"
        options={['critical', 'high']}
        selected={['high']}
        onChange={onChange}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'critical' }));

    expect(onChange).toHaveBeenCalledWith(['high', 'critical']);
  });

  it('removes a value that was on', () => {
    const onChange = vi.fn();
    render(
      <FilterChipGroup
        label="Severity"
        options={['critical', 'high']}
        selected={['high', 'critical']}
        onChange={onChange}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'high' }));

    expect(onChange).toHaveBeenCalledWith(['critical']);
  });
});
