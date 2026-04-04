import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Overlay } from './overlay';
import { TouchDeviceOverrideContext } from '../hooks/touch-device-override-context';

describe('Overlay router', () => {
  const originalMatchMedia = globalThis.matchMedia;

  const createMockMatchMedia = (matches: boolean): void => {
    Object.defineProperty(globalThis, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  };

  afterEach(() => {
    Object.defineProperty(globalThis, 'matchMedia', {
      writable: true,
      value: originalMatchMedia,
    });
    vi.restoreAllMocks();
  });

  it('renders OverlayDialog on non-touch devices (centered)', () => {
    createMockMatchMedia(false); // pointer: fine
    render(
      <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Test">
        <div>Content</div>
      </Overlay>
    );

    const content = screen.getByTestId('overlay-content');
    // Dialog uses centered positioning
    expect(content).toHaveClass('top-[50%]');
    expect(content).toHaveClass('left-[50%]');
  });

  it('renders OverlayBottomSheet on touch devices (bottom)', () => {
    createMockMatchMedia(true); // pointer: coarse
    render(
      <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Test">
        <div>Content</div>
      </Overlay>
    );

    const content = screen.getByTestId('overlay-content');
    // Bottom sheet uses bottom positioning
    expect(content).toHaveClass('bottom-0');
    expect(content).toHaveClass('rounded-t-xl');
  });

  it('forceBottomSheet=true renders bottom sheet on non-touch device', () => {
    createMockMatchMedia(false); // pointer: fine
    render(
      <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Test" forceBottomSheet={true}>
        <div>Content</div>
      </Overlay>
    );

    const content = screen.getByTestId('overlay-content');
    expect(content).toHaveClass('bottom-0');
  });

  it('forceBottomSheet=false renders dialog on touch device', () => {
    createMockMatchMedia(true); // pointer: coarse
    render(
      <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Test" forceBottomSheet={false}>
        <div>Content</div>
      </Overlay>
    );

    const content = screen.getByTestId('overlay-content');
    expect(content).toHaveClass('top-[50%]');
  });

  it('context override true renders bottom sheet on non-touch device', () => {
    createMockMatchMedia(false); // pointer: fine
    render(
      <TouchDeviceOverrideContext value={true}>
        <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Test">
          <div>Content</div>
        </Overlay>
      </TouchDeviceOverrideContext>
    );

    const content = screen.getByTestId('overlay-content');
    expect(content).toHaveClass('bottom-0');
  });

  it('context override false renders dialog on touch device', () => {
    createMockMatchMedia(true); // pointer: coarse
    render(
      <TouchDeviceOverrideContext value={false}>
        <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Test">
          <div>Content</div>
        </Overlay>
      </TouchDeviceOverrideContext>
    );

    const content = screen.getByTestId('overlay-content');
    expect(content).toHaveClass('top-[50%]');
  });
});
