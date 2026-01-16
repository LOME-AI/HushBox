import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { ModalOverlay } from './modal-overlay';

describe('ModalOverlay', () => {
  it('renders children when open', () => {
    render(
      <ModalOverlay open={true} onOpenChange={vi.fn()} ariaLabel="Test modal">
        <div>Modal content</div>
      </ModalOverlay>
    );
    expect(screen.getByText('Modal content')).toBeInTheDocument();
  });

  it('does not render children when closed', () => {
    render(
      <ModalOverlay open={false} onOpenChange={vi.fn()} ariaLabel="Test modal">
        <div>Modal content</div>
      </ModalOverlay>
    );
    expect(screen.queryByText('Modal content')).not.toBeInTheDocument();
  });

  it('calls onOpenChange with false when overlay is clicked', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <ModalOverlay open={true} onOpenChange={onOpenChange} ariaLabel="Test modal">
        <div>Modal content</div>
      </ModalOverlay>
    );

    // Click the overlay (outside the content)
    const overlay = screen.getByTestId('modal-overlay-backdrop');
    await user.click(overlay);

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('closes on Escape key press', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <ModalOverlay open={true} onOpenChange={onOpenChange} ariaLabel="Test modal">
        <div>Modal content</div>
      </ModalOverlay>
    );

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('has blur effect on overlay', () => {
    render(
      <ModalOverlay open={true} onOpenChange={vi.fn()} ariaLabel="Test modal">
        <div>Modal content</div>
      </ModalOverlay>
    );

    const overlay = screen.getByTestId('modal-overlay-backdrop');
    expect(overlay).toHaveClass('backdrop-blur-sm');
  });

  it('applies custom className to content wrapper', () => {
    render(
      <ModalOverlay
        open={true}
        onOpenChange={vi.fn()}
        ariaLabel="Test modal"
        className="custom-class"
      >
        <div>Modal content</div>
      </ModalOverlay>
    );

    const content = screen.getByTestId('modal-overlay-content');
    expect(content).toHaveClass('custom-class');
  });

  it('centers content on screen', () => {
    render(
      <ModalOverlay open={true} onOpenChange={vi.fn()} ariaLabel="Test modal">
        <div>Modal content</div>
      </ModalOverlay>
    );

    const content = screen.getByTestId('modal-overlay-content');
    expect(content).toHaveClass('fixed');
    expect(content).toHaveClass('top-[50%]');
    expect(content).toHaveClass('left-[50%]');
  });

  it('has data-slot attributes', () => {
    render(
      <ModalOverlay open={true} onOpenChange={vi.fn()} ariaLabel="Test modal">
        <div>Modal content</div>
      </ModalOverlay>
    );

    expect(screen.getByTestId('modal-overlay-backdrop')).toHaveAttribute(
      'data-slot',
      'modal-overlay-backdrop'
    );
    expect(screen.getByTestId('modal-overlay-content')).toHaveAttribute(
      'data-slot',
      'modal-overlay-content'
    );
  });

  it('renders visually hidden accessible title', () => {
    render(
      <ModalOverlay open={true} onOpenChange={vi.fn()} ariaLabel="My accessible title">
        <div>Modal content</div>
      </ModalOverlay>
    );

    const title = screen.getByText('My accessible title');
    expect(title).toBeInTheDocument();
    expect(title).toHaveClass('sr-only');
  });

  it('calls onOpenAutoFocus when modal opens', async () => {
    const onOpenAutoFocus = vi.fn();
    render(
      <ModalOverlay
        open={true}
        onOpenChange={vi.fn()}
        ariaLabel="Test modal"
        onOpenAutoFocus={onOpenAutoFocus}
      >
        <div>Modal content</div>
      </ModalOverlay>
    );

    await waitFor(() => {
      expect(onOpenAutoFocus).toHaveBeenCalledTimes(1);
    });
  });

  it('allows preventing auto-focus via onOpenAutoFocus', async () => {
    const handleOpenAutoFocus = vi.fn((event: Event) => {
      event.preventDefault();
    });
    render(
      <ModalOverlay
        open={true}
        onOpenChange={vi.fn()}
        ariaLabel="Test modal"
        onOpenAutoFocus={handleOpenAutoFocus}
      >
        <input data-testid="test-input" />
      </ModalOverlay>
    );

    await waitFor(() => {
      expect(handleOpenAutoFocus).toHaveBeenCalled();
    });

    // The input should not be focused because we prevented the default behavior
    const input = screen.getByTestId('test-input');
    expect(input).not.toHaveFocus();
  });
});
