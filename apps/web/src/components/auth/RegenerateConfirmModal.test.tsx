import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { RegenerateConfirmModal } from './RegenerateConfirmModal';

vi.mock('@/hooks/use-is-mobile', () => ({
  useIsMobile: vi.fn(() => false),
}));

describe('RegenerateConfirmModal', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    onConfirm: vi.fn(),
  };

  it('renders warning title and description when open', () => {
    render(<RegenerateConfirmModal {...defaultProps} />);

    expect(screen.getByText('Regenerate Recovery Phrase?')).toBeInTheDocument();
    expect(
      screen.getByText(
        'You already have a recovery phrase. If you generate a new one, your previous phrase will no longer work.'
      )
    ).toBeInTheDocument();
  });

  it('renders Cancel and Generate New buttons', () => {
    render(<RegenerateConfirmModal {...defaultProps} />);

    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /generate new/i })).toBeInTheDocument();
  });

  it('calls onOpenChange(false) when Cancel is clicked', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<RegenerateConfirmModal {...defaultProps} onOpenChange={onOpenChange} />);

    await user.click(screen.getByRole('button', { name: /cancel/i }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('calls onConfirm when Generate New is clicked', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<RegenerateConfirmModal {...defaultProps} onConfirm={onConfirm} />);

    await user.click(screen.getByRole('button', { name: /generate new/i }));

    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('renders Generate New button with destructive variant', () => {
    render(<RegenerateConfirmModal {...defaultProps} />);

    expect(screen.getByRole('button', { name: /generate new/i })).toHaveAttribute(
      'data-variant',
      'destructive'
    );
  });

  it('renders amber warning icon container', () => {
    render(<RegenerateConfirmModal {...defaultProps} />);

    const iconWrapper = document.querySelector('.bg-amber-100');
    expect(iconWrapper).toBeInTheDocument();
  });

  it('does not render content when closed', () => {
    render(<RegenerateConfirmModal {...defaultProps} open={false} />);

    expect(screen.queryByText('Regenerate Recovery Phrase?')).not.toBeInTheDocument();
  });
});
