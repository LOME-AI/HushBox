import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Checkbox } from './checkbox';

describe('Checkbox', () => {
  it('renders as a checkbox', { timeout: 15_000 }, () => {
    render(<Checkbox aria-label="Accept terms" />);
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
  });

  it('can be checked by clicking', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Checkbox aria-label="Accept terms" onCheckedChange={onCheckedChange} />);

    await user.click(screen.getByRole('checkbox'));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('can be unchecked by clicking when checked', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Checkbox aria-label="Accept terms" checked onCheckedChange={onCheckedChange} />);

    await user.click(screen.getByRole('checkbox'));
    expect(onCheckedChange).toHaveBeenCalledWith(false);
  });

  it('shows checked state', () => {
    render(<Checkbox aria-label="Accept terms" checked />);
    expect(screen.getByRole('checkbox')).toHaveAttribute('data-state', 'checked');
  });

  it('shows unchecked state', () => {
    render(<Checkbox aria-label="Accept terms" checked={false} />);
    expect(screen.getByRole('checkbox')).toHaveAttribute('data-state', 'unchecked');
  });

  it('is disabled when disabled prop is true', () => {
    render(<Checkbox aria-label="Accept terms" disabled />);
    expect(screen.getByRole('checkbox')).toBeDisabled();
  });

  it('does not fire onCheckedChange when disabled', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Checkbox aria-label="Accept terms" disabled onCheckedChange={onCheckedChange} />);

    await user.click(screen.getByRole('checkbox'));
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it('applies custom className', () => {
    render(<Checkbox aria-label="Accept terms" className="custom-class" />);
    expect(screen.getByRole('checkbox')).toHaveClass('custom-class');
  });

  it('has data-slot attribute for styling', () => {
    render(<Checkbox aria-label="Accept terms" />);
    expect(screen.getByRole('checkbox')).toHaveAttribute('data-slot', 'checkbox');
  });

  it('can be controlled', () => {
    const { rerender } = render(<Checkbox aria-label="Accept terms" checked={false} />);
    expect(screen.getByRole('checkbox')).toHaveAttribute('data-state', 'unchecked');

    rerender(<Checkbox aria-label="Accept terms" checked={true} />);
    expect(screen.getByRole('checkbox')).toHaveAttribute('data-state', 'checked');
  });

  it('forwards additional props', () => {
    render(<Checkbox aria-label="Accept terms" data-testid="my-checkbox" />);
    expect(screen.getByTestId('my-checkbox')).toBeInTheDocument();
  });
});
