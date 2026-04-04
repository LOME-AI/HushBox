import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Overlay } from './overlay';

describe('Overlay', () => {
  it('renders children when open', () => {
    render(
      <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Test modal">
        <div>Modal content</div>
      </Overlay>
    );
    expect(screen.getByText('Modal content')).toBeInTheDocument();
  });

  it('does not render children when closed', () => {
    render(
      <Overlay open={false} onOpenChange={vi.fn()} ariaLabel="Test modal">
        <div>Modal content</div>
      </Overlay>
    );
    expect(screen.queryByText('Modal content')).not.toBeInTheDocument();
  });

  it('calls onOpenChange with false when overlay is clicked', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <Overlay open={true} onOpenChange={onOpenChange} ariaLabel="Test modal">
        <div>Modal content</div>
      </Overlay>
    );

    // Click the overlay (outside the content)
    const overlay = screen.getByTestId('overlay-backdrop');
    await user.click(overlay);

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('closes on Escape key press', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <Overlay open={true} onOpenChange={onOpenChange} ariaLabel="Test modal">
        <div>Modal content</div>
      </Overlay>
    );

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('has blur effect on overlay', () => {
    render(
      <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Test modal">
        <div>Modal content</div>
      </Overlay>
    );

    const overlay = screen.getByTestId('overlay-backdrop');
    expect(overlay).toHaveClass('backdrop-blur-sm');
  });

  it('applies custom className to content wrapper', () => {
    render(
      <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Test modal" className="custom-class">
        <div>Modal content</div>
      </Overlay>
    );

    const content = screen.getByTestId('overlay-content');
    expect(content).toHaveClass('custom-class');
  });

  it('centers content on screen', () => {
    render(
      <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Test modal">
        <div>Modal content</div>
      </Overlay>
    );

    const content = screen.getByTestId('overlay-content');
    expect(content).toHaveClass('fixed');
    expect(content).toHaveClass('top-[50%]');
    expect(content).toHaveClass('left-[50%]');
  });

  it('has top padding on content', () => {
    render(
      <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Test modal">
        <div>Modal content</div>
      </Overlay>
    );

    const content = screen.getByTestId('overlay-content');
    expect(content).toHaveClass('pt-2');
  });

  it('has data-slot attributes', () => {
    render(
      <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Test modal">
        <div>Modal content</div>
      </Overlay>
    );

    expect(screen.getByTestId('overlay-backdrop')).toHaveAttribute('data-slot', 'overlay-backdrop');
    expect(screen.getByTestId('overlay-content')).toHaveAttribute('data-slot', 'overlay-content');
  });

  it('renders visually hidden accessible title', () => {
    render(
      <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="My accessible title">
        <div>Modal content</div>
      </Overlay>
    );

    const title = screen.getByText('My accessible title');
    expect(title).toBeInTheDocument();
    expect(title).toHaveClass('sr-only');
  });

  it('calls onOpenAutoFocus when modal opens', async () => {
    const onOpenAutoFocus = vi.fn();
    render(
      <Overlay
        open={true}
        onOpenChange={vi.fn()}
        ariaLabel="Test modal"
        onOpenAutoFocus={onOpenAutoFocus}
      >
        <div>Modal content</div>
      </Overlay>
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
      <Overlay
        open={true}
        onOpenChange={vi.fn()}
        ariaLabel="Test modal"
        onOpenAutoFocus={handleOpenAutoFocus}
      >
        <input data-testid="test-input" />
      </Overlay>
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
        <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Test modal">
          <div>Modal content</div>
        </Overlay>
      );

      expect(screen.getByRole('button', { name: /close/i })).toBeInTheDocument();
    });

    it('calls onOpenChange with false when close button is clicked', async () => {
      const user = userEvent.setup();
      const onOpenChange = vi.fn();
      render(
        <Overlay open={true} onOpenChange={onOpenChange} ariaLabel="Test modal">
          <div>Modal content</div>
        </Overlay>
      );

      await user.click(screen.getByRole('button', { name: /close/i }));

      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('positions close button in top-right corner with absolute positioning', () => {
      render(
        <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Test modal">
          <div>Modal content</div>
        </Overlay>
      );

      const closeButton = screen.getByRole('button', { name: /close/i });
      expect(closeButton).toHaveClass('absolute');
      expect(closeButton).toHaveClass('top-5');
      expect(closeButton).toHaveClass('right-3');
    });

    it('has cursor-pointer on close button', () => {
      render(
        <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Test modal">
          <div>Modal content</div>
        </Overlay>
      );

      const closeButton = screen.getByRole('button', { name: /close/i });
      expect(closeButton).toHaveClass('cursor-pointer');
    });

    it('can be hidden with showCloseButton=false', () => {
      render(
        <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Test modal" showCloseButton={false}>
          <div>Modal content</div>
        </Overlay>
      );

      expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument();
    });
  });

  describe('multi-step flow', () => {
    it('does not render back button when currentStep is undefined', () => {
      render(
        <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Test modal">
          <div>Modal content</div>
        </Overlay>
      );

      expect(screen.queryByRole('button', { name: /back/i })).not.toBeInTheDocument();
    });

    it('does not render back button when currentStep is 1', () => {
      render(
        <Overlay
          open={true}
          onOpenChange={vi.fn()}
          ariaLabel="Test modal"
          currentStep={1}
          onBack={vi.fn()}
        >
          <div>Modal content</div>
        </Overlay>
      );

      expect(screen.queryByRole('button', { name: /back/i })).not.toBeInTheDocument();
    });

    it('renders back button when currentStep > 1', () => {
      render(
        <Overlay
          open={true}
          onOpenChange={vi.fn()}
          ariaLabel="Test modal"
          currentStep={2}
          onBack={vi.fn()}
        >
          <div>Modal content</div>
        </Overlay>
      );

      expect(screen.getByRole('button', { name: /back/i })).toBeInTheDocument();
    });

    it('calls onBack when back button is clicked', async () => {
      const user = userEvent.setup();
      const onBack = vi.fn();
      render(
        <Overlay
          open={true}
          onOpenChange={vi.fn()}
          ariaLabel="Test modal"
          currentStep={2}
          onBack={onBack}
        >
          <div>Modal content</div>
        </Overlay>
      );

      await user.click(screen.getByRole('button', { name: /back/i }));

      expect(onBack).toHaveBeenCalledTimes(1);
    });

    it('positions back button in top-left corner with absolute positioning', () => {
      render(
        <Overlay
          open={true}
          onOpenChange={vi.fn()}
          ariaLabel="Test modal"
          currentStep={2}
          onBack={vi.fn()}
        >
          <div>Modal content</div>
        </Overlay>
      );

      const backButton = screen.getByRole('button', { name: /back/i });
      expect(backButton).toHaveClass('absolute');
      expect(backButton).toHaveClass('top-5');
      expect(backButton).toHaveClass('left-3');
    });

    it('has cursor-pointer on back button', () => {
      render(
        <Overlay
          open={true}
          onOpenChange={vi.fn()}
          ariaLabel="Test modal"
          currentStep={2}
          onBack={vi.fn()}
        >
          <div>Modal content</div>
        </Overlay>
      );

      const backButton = screen.getByRole('button', { name: /back/i });
      expect(backButton).toHaveClass('cursor-pointer');
    });

    it('does not render back button when currentStep > 1 but onBack is not provided', () => {
      render(
        <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Test modal" currentStep={2}>
          <div>Modal content</div>
        </Overlay>
      );

      expect(screen.queryByRole('button', { name: /back/i })).not.toBeInTheDocument();
    });
  });
});
