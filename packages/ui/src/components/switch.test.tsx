import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Switch } from './switch';

describe('Switch', () => {
  it('renders as a switch', () => {
    render(<Switch aria-label="Enable notifications" />);
    expect(screen.getByRole('switch')).toBeInTheDocument();
  });

  it('toggles state when clicked (uncontrolled)', async () => {
    const user = userEvent.setup();
    render(<Switch aria-label="Enable notifications" />);

    const sw = screen.getByRole('switch');
    expect(sw).toHaveAttribute('data-state', 'unchecked');

    await user.click(sw);
    expect(sw).toHaveAttribute('data-state', 'checked');

    await user.click(sw);
    expect(sw).toHaveAttribute('data-state', 'unchecked');
  });

  it('fires onCheckedChange when clicked', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Switch aria-label="Enable notifications" onCheckedChange={onCheckedChange} />);

    await user.click(screen.getByRole('switch'));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('respects controlled checked prop', () => {
    const { rerender } = render(
      <Switch aria-label="Enable" checked={false} onCheckedChange={() => {}} />
    );
    expect(screen.getByRole('switch')).toHaveAttribute('data-state', 'unchecked');

    rerender(<Switch aria-label="Enable" checked={true} onCheckedChange={() => {}} />);
    expect(screen.getByRole('switch')).toHaveAttribute('data-state', 'checked');
  });

  it('does not change state when controlled and onCheckedChange omitted from a click handler', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Switch aria-label="Enable" checked={false} onCheckedChange={onCheckedChange} />);

    await user.click(screen.getByRole('switch'));
    // controlled: parent owns state, our onChange callback was invoked but data-state stays put
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole('switch')).toHaveAttribute('data-state', 'unchecked');
  });

  it('is disabled when disabled prop is true', () => {
    render(<Switch aria-label="Enable" disabled />);
    expect(screen.getByRole('switch')).toBeDisabled();
  });

  it('does not fire onCheckedChange when disabled', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Switch aria-label="Enable" disabled onCheckedChange={onCheckedChange} />);

    await user.click(screen.getByRole('switch'));
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it('supports aria-label', () => {
    render(<Switch aria-label="Enable notifications" />);
    expect(screen.getByRole('switch')).toHaveAccessibleName('Enable notifications');
  });

  it('applies custom className', () => {
    render(<Switch aria-label="Enable" className="custom-class" />);
    expect(screen.getByRole('switch')).toHaveClass('custom-class');
  });

  it('has data-slot attribute for styling', () => {
    render(<Switch aria-label="Enable" />);
    expect(screen.getByRole('switch')).toHaveAttribute('data-slot', 'switch');
  });

  it('renders the thumb with data-slot attribute', () => {
    render(<Switch aria-label="Enable" />);
    expect(screen.getByRole('switch').querySelector('[data-slot="switch-thumb"]')).not.toBeNull();
  });

  it('forwards additional props', () => {
    render(<Switch aria-label="Enable" data-testid="my-switch" />);
    expect(screen.getByTestId('my-switch')).toBeInTheDocument();
  });

  it('supports defaultChecked for uncontrolled use', () => {
    render(<Switch aria-label="Enable" defaultChecked />);
    expect(screen.getByRole('switch')).toHaveAttribute('data-state', 'checked');
  });
});
