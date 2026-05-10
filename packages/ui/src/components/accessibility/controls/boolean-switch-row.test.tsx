import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { BooleanSwitchRow } from './boolean-switch-row';

describe('BooleanSwitchRow', () => {
  it('renders the label', () => {
    render(<BooleanSwitchRow label="Stop animations" checked={false} onCheckedChange={() => {}} />);
    expect(screen.getByText('Stop animations')).toBeInTheDocument();
  });

  it('renders the switch in the unchecked state when checked=false', () => {
    render(<BooleanSwitchRow label="X" checked={false} onCheckedChange={() => {}} />);
    expect(screen.getByRole('switch', { name: 'X' })).toHaveAttribute('aria-checked', 'false');
  });

  it('renders the switch in the checked state when checked=true', () => {
    render(<BooleanSwitchRow label="Y" checked={true} onCheckedChange={() => {}} />);
    expect(screen.getByRole('switch', { name: 'Y' })).toHaveAttribute('aria-checked', 'true');
  });

  it('fires onCheckedChange with !checked when the switch is clicked', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn<(next: boolean) => void>();
    render(<BooleanSwitchRow label="Z" checked={false} onCheckedChange={onCheckedChange} />);
    await user.click(screen.getByRole('switch', { name: 'Z' }));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('fires onCheckedChange with !checked from the on state', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn<(next: boolean) => void>();
    render(<BooleanSwitchRow label="Q" checked={true} onCheckedChange={onCheckedChange} />);
    await user.click(screen.getByRole('switch', { name: 'Q' }));
    expect(onCheckedChange).toHaveBeenCalledWith(false);
  });

  it('clicking the row label toggles the switch', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn<(next: boolean) => void>();
    render(<BooleanSwitchRow label="Toggle me" checked={false} onCheckedChange={onCheckedChange} />);
    await user.click(screen.getByText('Toggle me'));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });
});
