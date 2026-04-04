import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { OverlayBottomSheet } from './overlay-bottom-sheet';

describe('OverlayBottomSheet', () => {
  it('renders children when open', () => {
    render(
      <OverlayBottomSheet open={true} onOpenChange={vi.fn()} ariaLabel="Test sheet">
        <div>Sheet content</div>
      </OverlayBottomSheet>
    );
    expect(screen.getByText('Sheet content')).toBeInTheDocument();
  });

  it('does not render children when closed', () => {
    render(
      <OverlayBottomSheet open={false} onOpenChange={vi.fn()} ariaLabel="Test sheet">
        <div>Sheet content</div>
      </OverlayBottomSheet>
    );
    expect(screen.queryByText('Sheet content')).not.toBeInTheDocument();
  });

  it('renders drag handle indicator', () => {
    render(
      <OverlayBottomSheet open={true} onOpenChange={vi.fn()} ariaLabel="Test sheet">
        <div>Sheet content</div>
      </OverlayBottomSheet>
    );
    const content = screen.getByTestId('overlay-content');
    const handle = content.querySelector('.rounded-full');
    expect(handle).toBeInTheDocument();
  });

  it('renders visually hidden accessible title', () => {
    render(
      <OverlayBottomSheet open={true} onOpenChange={vi.fn()} ariaLabel="My sheet title">
        <div>Sheet content</div>
      </OverlayBottomSheet>
    );
    const title = screen.getByText('My sheet title');
    expect(title).toBeInTheDocument();
    expect(title).toHaveClass('sr-only');
  });

  it('renders close button by default', () => {
    render(
      <OverlayBottomSheet open={true} onOpenChange={vi.fn()} ariaLabel="Test sheet">
        <div>Sheet content</div>
      </OverlayBottomSheet>
    );
    expect(screen.getByRole('button', { name: /close/i })).toBeInTheDocument();
  });

  it('hides close button when showCloseButton is false', () => {
    render(
      <OverlayBottomSheet
        open={true}
        onOpenChange={vi.fn()}
        ariaLabel="Test sheet"
        showCloseButton={false}
      >
        <div>Sheet content</div>
      </OverlayBottomSheet>
    );
    expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument();
  });

  it('renders back button when currentStep > 1 and onBack provided', () => {
    render(
      <OverlayBottomSheet
        open={true}
        onOpenChange={vi.fn()}
        ariaLabel="Test sheet"
        currentStep={2}
        onBack={vi.fn()}
      >
        <div>Sheet content</div>
      </OverlayBottomSheet>
    );
    expect(screen.getByRole('button', { name: /back/i })).toBeInTheDocument();
  });

  it('does not render back button when currentStep is 1', () => {
    render(
      <OverlayBottomSheet
        open={true}
        onOpenChange={vi.fn()}
        ariaLabel="Test sheet"
        currentStep={1}
        onBack={vi.fn()}
      >
        <div>Sheet content</div>
      </OverlayBottomSheet>
    );
    expect(screen.queryByRole('button', { name: /back/i })).not.toBeInTheDocument();
  });

  it('calls onBack when back button is clicked', () => {
    const onBack = vi.fn();
    render(
      <OverlayBottomSheet
        open={true}
        onOpenChange={vi.fn()}
        ariaLabel="Test sheet"
        currentStep={2}
        onBack={onBack}
      >
        <div>Sheet content</div>
      </OverlayBottomSheet>
    );

    // Use fireEvent instead of userEvent — vaul's pointer event handling
    // throws in JSDOM because getComputedStyle returns no transform value.
    fireEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('suppresses auto-focus by default', async () => {
    const onOpenAutoFocus = vi.fn();
    render(
      <OverlayBottomSheet
        open={true}
        onOpenChange={vi.fn()}
        ariaLabel="Test sheet"
        onOpenAutoFocus={onOpenAutoFocus}
      >
        <input data-testid="test-input" />
      </OverlayBottomSheet>
    );

    await waitFor(() => {
      expect(onOpenAutoFocus).toHaveBeenCalled();
    });

    const input = screen.getByTestId('test-input');
    expect(input).not.toHaveFocus();
  });

  it('has data-slot attributes', () => {
    render(
      <OverlayBottomSheet open={true} onOpenChange={vi.fn()} ariaLabel="Test sheet">
        <div>Sheet content</div>
      </OverlayBottomSheet>
    );

    expect(screen.getByTestId('overlay-backdrop')).toHaveAttribute('data-slot', 'overlay-backdrop');
    expect(screen.getByTestId('overlay-content')).toHaveAttribute('data-slot', 'overlay-content');
  });

  it('has blur effect on overlay', () => {
    render(
      <OverlayBottomSheet open={true} onOpenChange={vi.fn()} ariaLabel="Test sheet">
        <div>Sheet content</div>
      </OverlayBottomSheet>
    );

    const overlay = screen.getByTestId('overlay-backdrop');
    expect(overlay).toHaveClass('backdrop-blur-sm');
  });

  it('applies bottom sheet positioning', () => {
    render(
      <OverlayBottomSheet open={true} onOpenChange={vi.fn()} ariaLabel="Test sheet">
        <div>Sheet content</div>
      </OverlayBottomSheet>
    );

    const content = screen.getByTestId('overlay-content');
    expect(content).toHaveClass('bottom-0');
    expect(content).toHaveClass('rounded-t-xl');
  });
});
