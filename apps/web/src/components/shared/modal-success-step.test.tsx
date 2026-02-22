import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { ModalSuccessStep } from './modal-success-step';

describe('ModalSuccessStep', () => {
  const defaultProps = {
    heading: 'Operation Complete',
    description: 'Everything went smoothly.',
    primaryLabel: 'Done',
    onDone: vi.fn(),
  };

  it('renders heading text', () => {
    render(<ModalSuccessStep {...defaultProps} />);

    expect(screen.getByRole('heading', { name: 'Operation Complete' })).toBeInTheDocument();
  });

  it('renders description text', () => {
    render(<ModalSuccessStep {...defaultProps} />);

    expect(screen.getByText('Everything went smoothly.')).toBeInTheDocument();
  });

  it('renders primary button with label', () => {
    render(<ModalSuccessStep {...defaultProps} />);

    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
  });

  it('calls onDone when button clicked', async () => {
    const onDone = vi.fn();
    const user = userEvent.setup();
    render(<ModalSuccessStep {...defaultProps} onDone={onDone} />);

    await user.click(screen.getByRole('button', { name: 'Done' }));

    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('renders success badge icon', () => {
    const { container } = render(<ModalSuccessStep {...defaultProps} />);

    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
  });
});
