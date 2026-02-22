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

  it('has top padding on content', () => {
    render(
      <ModalOverlay open={true} onOpenChange={vi.fn()} ariaLabel="Test modal">
        <div>Modal content</div>
      </ModalOverlay>
    );

    const content = screen.getByTestId('modal-overlay-content');
    expect(content).toHaveClass('pt-2');
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

  describe('close button', () => {
    it('renders close button by default', () => {
      render(
        <ModalOverlay open={true} onOpenChange={vi.fn()} ariaLabel="Test modal">
          <div>Modal content</div>
        </ModalOverlay>
      );

      expect(screen.getByRole('button', { name: /close/i })).toBeInTheDocument();
    });

    it('calls onOpenChange with false when close button is clicked', async () => {
      const user = userEvent.setup();
      const onOpenChange = vi.fn();
      render(
        <ModalOverlay open={true} onOpenChange={onOpenChange} ariaLabel="Test modal">
          <div>Modal content</div>
        </ModalOverlay>
      );

      await user.click(screen.getByRole('button', { name: /close/i }));

      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('positions close button in top-right corner with absolute positioning', () => {
      render(
        <ModalOverlay open={true} onOpenChange={vi.fn()} ariaLabel="Test modal">
          <div>Modal content</div>
        </ModalOverlay>
      );

      const closeButton = screen.getByRole('button', { name: /close/i });
      expect(closeButton).toHaveClass('absolute');
      expect(closeButton).toHaveClass('top-5');
      expect(closeButton).toHaveClass('right-3');
    });

    it('has cursor-pointer on close button', () => {
      render(
        <ModalOverlay open={true} onOpenChange={vi.fn()} ariaLabel="Test modal">
          <div>Modal content</div>
        </ModalOverlay>
      );

      const closeButton = screen.getByRole('button', { name: /close/i });
      expect(closeButton).toHaveClass('cursor-pointer');
    });

    it('can be hidden with showCloseButton=false', () => {
      render(
        <ModalOverlay
          open={true}
          onOpenChange={vi.fn()}
          ariaLabel="Test modal"
          showCloseButton={false}
        >
          <div>Modal content</div>
        </ModalOverlay>
      );

      expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument();
    });
  });

  describe('multi-step flow', () => {
    it('does not render back button when currentStep is undefined', () => {
      render(
        <ModalOverlay open={true} onOpenChange={vi.fn()} ariaLabel="Test modal">
          <div>Modal content</div>
        </ModalOverlay>
      );

      expect(screen.queryByRole('button', { name: /back/i })).not.toBeInTheDocument();
    });

    it('does not render back button when currentStep is 1', () => {
      render(
        <ModalOverlay
          open={true}
          onOpenChange={vi.fn()}
          ariaLabel="Test modal"
          currentStep={1}
          onBack={vi.fn()}
        >
          <div>Modal content</div>
        </ModalOverlay>
      );

      expect(screen.queryByRole('button', { name: /back/i })).not.toBeInTheDocument();
    });

    it('renders back button when currentStep > 1', () => {
      render(
        <ModalOverlay
          open={true}
          onOpenChange={vi.fn()}
          ariaLabel="Test modal"
          currentStep={2}
          onBack={vi.fn()}
        >
          <div>Modal content</div>
        </ModalOverlay>
      );

      expect(screen.getByRole('button', { name: /back/i })).toBeInTheDocument();
    });

    it('calls onBack when back button is clicked', async () => {
      const user = userEvent.setup();
      const onBack = vi.fn();
      render(
        <ModalOverlay
          open={true}
          onOpenChange={vi.fn()}
          ariaLabel="Test modal"
          currentStep={2}
          onBack={onBack}
        >
          <div>Modal content</div>
        </ModalOverlay>
      );

      await user.click(screen.getByRole('button', { name: /back/i }));

      expect(onBack).toHaveBeenCalledTimes(1);
    });

    it('positions back button in top-left corner with absolute positioning', () => {
      render(
        <ModalOverlay
          open={true}
          onOpenChange={vi.fn()}
          ariaLabel="Test modal"
          currentStep={2}
          onBack={vi.fn()}
        >
          <div>Modal content</div>
        </ModalOverlay>
      );

      const backButton = screen.getByRole('button', { name: /back/i });
      expect(backButton).toHaveClass('absolute');
      expect(backButton).toHaveClass('top-5');
      expect(backButton).toHaveClass('left-3');
    });

    it('has cursor-pointer on back button', () => {
      render(
        <ModalOverlay
          open={true}
          onOpenChange={vi.fn()}
          ariaLabel="Test modal"
          currentStep={2}
          onBack={vi.fn()}
        >
          <div>Modal content</div>
        </ModalOverlay>
      );

      const backButton = screen.getByRole('button', { name: /back/i });
      expect(backButton).toHaveClass('cursor-pointer');
    });

    it('does not render back button when currentStep > 1 but onBack is not provided', () => {
      render(
        <ModalOverlay open={true} onOpenChange={vi.fn()} ariaLabel="Test modal" currentStep={2}>
          <div>Modal content</div>
        </ModalOverlay>
      );

      expect(screen.queryByRole('button', { name: /back/i })).not.toBeInTheDocument();
    });
  });
});
