import * as React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { TEST_IDS, TOUCH_QUERY } from '@hushbox/shared';
import { TouchDeviceOverrideContext } from '../../hooks/touch-device-override-context';
import { Overlay } from './overlay';
import { OverlayHeader } from './overlay-header';
import { useOverlayPresentation } from './overlay-presentation';
import { SCRIM_BASE_CLASS, SCRIM_BLUR_CLASS } from './scrim';

type ChangeListener = (event: MediaQueryListEvent) => void;

interface MediaListStub {
  readonly matches: boolean;
  readonly media: string;
  readonly addEventListener: (type: string, listener: ChangeListener) => void;
  readonly removeEventListener: (type: string, listener: ChangeListener) => void;
}

interface Viewport {
  readonly resize: (width: number) => void;
}

const originalMatchMedia = globalThis.matchMedia;

/** Stubs `matchMedia` for a window `width` wide with the given primary pointer. */
function installViewport(initialWidth: number, pointer: 'fine' | 'coarse' = 'fine'): Viewport {
  let width = initialWidth;
  const listeners = new Map<string, Set<ChangeListener>>();
  const matchesQuery = (query: string): boolean => {
    const maxWidth = /^\(max-width: (\d+)px\)$/.exec(query);
    if (maxWidth?.[1] !== undefined) return width <= Number(maxWidth[1]);
    return query === TOUCH_QUERY && pointer === 'coarse';
  };
  Object.defineProperty(globalThis, 'matchMedia', {
    writable: true,
    value: (query: string): MediaQueryList => {
      const set = listeners.get(query) ?? new Set<ChangeListener>();
      listeners.set(query, set);
      const list: MediaListStub = {
        matches: matchesQuery(query),
        media: query,
        addEventListener: (_type: string, listener: ChangeListener): void => {
          set.add(listener);
        },
        removeEventListener: (_type: string, listener: ChangeListener): void => {
          set.delete(listener);
        },
      };
      // The band and pointer hooks read only `matches` and the change-listener pair.
      return list as MediaQueryList;
    },
  });
  return {
    resize: (next): void => {
      width = next;
      for (const [query, set] of listeners) {
        // The band and pointer listeners read only `matches`.
        const event = { matches: matchesQuery(query), media: query } as MediaQueryListEvent;
        for (const listener of set) listener(event);
      }
    },
  };
}

afterEach(() => {
  Object.defineProperty(globalThis, 'matchMedia', { writable: true, value: originalMatchMedia });
});

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
    const overlay = screen.getByTestId(TEST_IDS.overlayBackdrop);
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

    const overlay = screen.getByTestId(TEST_IDS.overlayBackdrop);
    expect(overlay).toHaveClass('backdrop-blur-sm');
  });

  it('applies custom className to content wrapper', () => {
    render(
      <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Test modal" className="custom-class">
        <div>Modal content</div>
      </Overlay>
    );

    const content = screen.getByTestId(TEST_IDS.overlayContent);
    expect(content).toHaveClass('custom-class');
  });

  it('centers content on screen', () => {
    render(
      <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Test modal">
        <div>Modal content</div>
      </Overlay>
    );

    const content = screen.getByTestId(TEST_IDS.overlayContent);
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

    const content = screen.getByTestId(TEST_IDS.overlayContent);
    expect(content).toHaveClass('pt-2');
  });

  it('has data-slot attributes', () => {
    render(
      <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Test modal">
        <div>Modal content</div>
      </Overlay>
    );

    expect(screen.getByTestId(TEST_IDS.overlayBackdrop)).toHaveAttribute(
      'data-slot',
      'overlay-backdrop'
    );
    expect(screen.getByTestId(TEST_IDS.overlayContent)).toHaveAttribute(
      'data-slot',
      'overlay-content'
    );
  });

  it('has data-overlay-variant="dialog" on content', () => {
    render(
      <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Test modal">
        <div>Modal content</div>
      </Overlay>
    );

    expect(screen.getByTestId(TEST_IDS.overlayContent)).toHaveAttribute(
      'data-overlay-variant',
      'dialog'
    );
  });

  it('renders a visually hidden title when no heading is rendered', () => {
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

  describe('dismissible=false locks user-initiated dismissal', () => {
    it('does not call onOpenChange when Escape is pressed', async () => {
      const user = userEvent.setup();
      const onOpenChange = vi.fn();
      render(
        <Overlay open={true} onOpenChange={onOpenChange} ariaLabel="Test modal" dismissible={false}>
          <div>Modal content</div>
        </Overlay>
      );

      await user.keyboard('{Escape}');

      // Give Radix a tick to process the event before asserting.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(onOpenChange).not.toHaveBeenCalled();
    });

    it('does not call onOpenChange when backdrop is clicked', async () => {
      const user = userEvent.setup();
      const onOpenChange = vi.fn();
      render(
        <Overlay open={true} onOpenChange={onOpenChange} ariaLabel="Test modal" dismissible={false}>
          <div>Modal content</div>
        </Overlay>
      );

      const overlay = screen.getByTestId(TEST_IDS.overlayBackdrop);
      await user.click(overlay);

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(onOpenChange).not.toHaveBeenCalled();
    });

    it('hides the close button so the user has no manual escape hatch', () => {
      render(
        <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Test modal" dismissible={false}>
          <div>Modal content</div>
        </Overlay>
      );

      expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument();
    });

    it('preserves back button (back is navigation, not dismissal)', () => {
      render(
        <Overlay
          open={true}
          onOpenChange={vi.fn()}
          ariaLabel="Test modal"
          dismissible={false}
          currentStep={2}
          onBack={vi.fn()}
        >
          <div>Modal content</div>
        </Overlay>
      );

      expect(screen.getByRole('button', { name: /back/i })).toBeInTheDocument();
    });

    it('dismissible defaults to true so existing call sites are unchanged', async () => {
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

    it("drops a dialog's header 1.5rem below the back button's row", () => {
      render(
        <Overlay
          open={true}
          onOpenChange={vi.fn()}
          ariaLabel="Test modal"
          currentStep={2}
          onBack={vi.fn()}
        >
          <OverlayHeader title="Scan QR Code" />
        </Overlay>
      );

      expect(screen.getByRole('heading', { level: 2 }).parentElement).toHaveClass('pt-6');
    });

    it("drops a bottom sheet's header 1.5rem below the back button's row", () => {
      installViewport(767);
      render(
        <Overlay
          open={true}
          onOpenChange={vi.fn()}
          ariaLabel="Test modal"
          currentStep={2}
          onBack={vi.fn()}
        >
          <OverlayHeader title="Scan QR Code" />
        </Overlay>
      );

      expect(screen.getByRole('heading', { level: 2 }).parentElement).toHaveClass('pt-6');
    });

    it("drops a full screen's header 1.5rem below the back button's row", () => {
      installViewport(767);
      render(
        <Overlay
          open={true}
          onOpenChange={vi.fn()}
          ariaLabel="Test modal"
          phonePresentation="fullscreen"
          currentStep={2}
          onBack={vi.fn()}
        >
          <OverlayHeader title="Scan QR Code" />
        </Overlay>
      );

      expect(screen.getByRole('heading', { level: 2 }).parentElement).toHaveClass('pt-6');
    });

    it('gives the header no top padding on a first step', () => {
      render(
        <Overlay
          open={true}
          onOpenChange={vi.fn()}
          ariaLabel="Test modal"
          currentStep={1}
          onBack={vi.fn()}
        >
          <OverlayHeader title="Set up two-factor" />
        </Overlay>
      );

      expect(screen.getByRole('heading', { level: 2 }).parentElement?.className).not.toMatch(
        /\bp[ty]-/
      );
    });

    it('gives the header no top padding on a later step with no back handler', () => {
      installViewport(767);
      render(
        <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Test modal" currentStep={2}>
          <OverlayHeader title="Set up two-factor" />
        </Overlay>
      );

      expect(screen.getByRole('heading', { level: 2 }).parentElement?.className).not.toMatch(
        /\bp[ty]-/
      );
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
  describe('accessible name', () => {
    it('names the dialog with the visible header title', () => {
      render(
        <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Fallback name">
          <OverlayHeader title="Visible Title" />
        </Overlay>
      );

      expect(screen.getByRole('dialog')).toHaveAccessibleName('Visible Title');
    });

    it('renders a single heading for the dialog title', () => {
      render(
        <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Fallback name">
          <OverlayHeader title="Visible Title" />
        </Overlay>
      );

      expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(1);
    });

    it('names the bottom sheet with the visible header title', () => {
      installViewport(767);
      render(
        <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Fallback name">
          <OverlayHeader title="Visible Title" />
        </Overlay>
      );

      expect(screen.getByRole('dialog')).toHaveAccessibleName('Visible Title');
    });

    it('renders a single heading for the bottom sheet title', () => {
      installViewport(767);
      render(
        <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Fallback name">
          <OverlayHeader title="Visible Title" />
        </Overlay>
      );

      expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(1);
    });

    it('renames the dialog when one step heading replaces another', () => {
      function StepFlow({ step }: Readonly<{ step: 1 | 2 | 3 }>): React.JSX.Element {
        return (
          <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Fallback name">
            {step === 1 && <OverlayHeader title="First Step" />}
            {step === 2 && <OverlayHeader title="Second Step" description="More" />}
            {step === 3 && <div>No heading here</div>}
          </Overlay>
        );
      }

      const { rerender } = render(<StepFlow step={1} />);
      expect(screen.getByRole('dialog')).toHaveAccessibleName('First Step');

      rerender(<StepFlow step={2} />);
      expect(screen.getByRole('dialog')).toHaveAccessibleName('Second Step');
      expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(1);

      rerender(<StepFlow step={3} />);
      expect(screen.getByRole('dialog')).toHaveAccessibleName('Fallback name');
    });

    it('names the dialog with ariaLabel when no header is rendered', () => {
      render(
        <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Fallback name">
          <div>Modal content</div>
        </Overlay>
      );

      expect(screen.getByRole('dialog')).toHaveAccessibleName('Fallback name');
    });

    it('names the bottom sheet with ariaLabel when no header is rendered', () => {
      installViewport(767);
      render(
        <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Fallback name">
          <div>Modal content</div>
        </Overlay>
      );

      expect(screen.getByRole('dialog')).toHaveAccessibleName('Fallback name');
    });

    it('renames the dialog when the header title changes', () => {
      const { rerender } = render(
        <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Fallback name">
          <OverlayHeader title="First Step" />
        </Overlay>
      );
      expect(screen.getByRole('dialog')).toHaveAccessibleName('First Step');

      rerender(
        <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Fallback name">
          <OverlayHeader title="Second Step" />
        </Overlay>
      );

      expect(screen.getByRole('dialog')).toHaveAccessibleName('Second Step');
    });
  });

  describe('autofocus policy', () => {
    function FieldOverlay({
      onOpenAutoFocus,
      named = false,
    }: Readonly<{ onOpenAutoFocus?: (event: Event) => void; named?: boolean }>): React.JSX.Element {
      const nameRef = React.useRef<HTMLInputElement>(null);
      return (
        <Overlay
          open={true}
          onOpenChange={vi.fn()}
          ariaLabel="Rename"
          showCloseButton={false}
          {...(onOpenAutoFocus !== undefined && { onOpenAutoFocus })}
          {...(named && { initialFocus: nameRef })}
        >
          <input aria-label="First" />
          <input aria-label="Name" ref={nameRef} />
        </Overlay>
      );
    }

    it('focuses the sheet itself, not its first field', async () => {
      installViewport(767);
      render(<FieldOverlay />);

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.overlayContent)).toHaveFocus();
      });
    });

    it('focuses the dialog itself, not its first field, under a coarse pointer', async () => {
      installViewport(768, 'coarse');
      render(<FieldOverlay />);

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.overlayContent)).toHaveFocus();
      });
    });

    it('focuses the dialog itself, not its first field, under the touch override', async () => {
      installViewport(768);
      render(
        <TouchDeviceOverrideContext value={true}>
          <FieldOverlay />
        </TouchDeviceOverrideContext>
      );

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.overlayContent)).toHaveFocus();
      });
    });

    it('focuses the first field of a dialog under a fine pointer', async () => {
      installViewport(768);
      render(<FieldOverlay />);

      await waitFor(() => {
        expect(screen.getByRole('textbox', { name: 'First' })).toHaveFocus();
      });
    });

    it('focuses the dialog itself, not the field it names, under a coarse pointer', async () => {
      installViewport(768, 'coarse');
      render(<FieldOverlay named />);

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.overlayContent)).toHaveFocus();
      });
    });

    it('focuses the field it names in a dialog under a fine pointer', async () => {
      installViewport(768);
      render(<FieldOverlay named />);

      await waitFor(() => {
        expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus();
      });
    });

    it.each([
      { case: 'a sheet', width: 767, pointer: 'fine' as const },
      { case: 'a dialog under a coarse pointer', width: 768, pointer: 'coarse' as const },
      { case: 'a dialog under a fine pointer', width: 768, pointer: 'fine' as const },
    ])("calls the caller's onOpenAutoFocus in $case", async ({ width, pointer }) => {
      installViewport(width, pointer);
      const onOpenAutoFocus = vi.fn();
      render(<FieldOverlay onOpenAutoFocus={onOpenAutoFocus} />);

      await waitFor(() => {
        expect(onOpenAutoFocus).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('a window resize while open', () => {
    const DIRECTIONS = [
      { name: 'widening from 767 to 768', from: 767, to: 768, opened: 'bottom-sheet' },
      { name: 'narrowing from 768 to 767', from: 768, to: 767, opened: 'dialog' },
    ] as const;

    function variant(): string | null {
      return screen.getByTestId(TEST_IDS.overlayContent).dataset['overlayVariant'] ?? null;
    }

    function Counter(): React.JSX.Element {
      const [count, setCount] = React.useState(0);
      return (
        <button
          type="button"
          onClick={() => {
            setCount((previous) => previous + 1);
          }}
        >
          Pressed {count}
        </button>
      );
    }

    function PresentationProbe(): React.JSX.Element {
      return <span data-testid="presentation">{useOverlayPresentation()}</span>;
    }

    it.each(DIRECTIONS)('keeps the shape it opened with when $name', ({ from, to, opened }) => {
      const viewport = installViewport(from);
      render(
        <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Test">
          <div>Content</div>
        </Overlay>
      );

      act(() => {
        viewport.resize(to);
      });

      expect(variant()).toBe(opened);
    });

    it.each(DIRECTIONS)(
      'reports the presentation it opened with when $name',
      ({ from, to, opened }) => {
        const viewport = installViewport(from);
        render(
          <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Test">
            <PresentationProbe />
          </Overlay>
        );

        act(() => {
          viewport.resize(to);
        });

        expect(screen.getByTestId('presentation')).toHaveTextContent(
          opened === 'dialog' ? 'dialog' : 'sheet'
        );
      }
    );

    it.each(DIRECTIONS)("keeps its children's own state when $name", async ({ from, to }) => {
      const viewport = installViewport(from);
      render(
        <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Test">
          <Counter />
        </Overlay>
      );
      act(() => {
        screen.getByRole('button', { name: 'Pressed 0' }).focus();
      });
      await userEvent.keyboard('{Enter}');

      act(() => {
        viewport.resize(to);
      });

      expect(screen.getByRole('button', { name: /^Pressed/ })).toHaveTextContent('Pressed 1');
    });

    it.each(DIRECTIONS)('keeps focus in the focused field when $name', ({ from, to }) => {
      const viewport = installViewport(from);
      render(
        <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Test">
          <input aria-label="Code" />
        </Overlay>
      );
      const field = screen.getByRole('textbox', { name: 'Code' });
      act(() => {
        field.focus();
      });
      expect(field).toHaveFocus();

      act(() => {
        viewport.resize(to);
      });

      expect(screen.getByRole('textbox', { name: 'Code' })).toHaveFocus();
    });

    it.each(DIRECTIONS)('does not ask to close when $name', ({ from, to }) => {
      const viewport = installViewport(from);
      const onOpenChange = vi.fn();
      render(
        <Overlay open={true} onOpenChange={onOpenChange} ariaLabel="Test">
          <div>Content</div>
        </Overlay>
      );

      act(() => {
        viewport.resize(to);
      });

      expect(onOpenChange).not.toHaveBeenCalled();
    });

    it.each(DIRECTIONS)(
      'still refuses Escape when undismissible after $name',
      async ({ from, to }) => {
        const viewport = installViewport(from);
        const onOpenChange = vi.fn();
        render(
          <Overlay open={true} onOpenChange={onOpenChange} ariaLabel="Test" dismissible={false}>
            <button type="button">Inside</button>
          </Overlay>
        );
        act(() => {
          viewport.resize(to);
        });

        await userEvent.keyboard('{Escape}');

        expect(onOpenChange).not.toHaveBeenCalled();
        expect(screen.getByTestId(TEST_IDS.overlayContent)).toBeInTheDocument();
      }
    );

    it.each(DIRECTIONS)(
      'still refuses a scrim press when undismissible after $name',
      async ({ from, to }) => {
        const viewport = installViewport(from);
        const onOpenChange = vi.fn();
        render(
          <Overlay open={true} onOpenChange={onOpenChange} ariaLabel="Test" dismissible={false}>
            <button type="button">Inside</button>
          </Overlay>
        );
        act(() => {
          viewport.resize(to);
        });

        await userEvent.click(screen.getByTestId(TEST_IDS.overlayBackdrop));

        expect(onOpenChange).not.toHaveBeenCalled();
        expect(screen.getByTestId(TEST_IDS.overlayContent)).toBeInTheDocument();
      }
    );

    it('picks its shape by width again on the next open', () => {
      const viewport = installViewport(767);
      const { rerender } = render(
        <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Test">
          <div>Content</div>
        </Overlay>
      );
      rerender(
        <Overlay open={false} onOpenChange={vi.fn()} ariaLabel="Test">
          <div>Content</div>
        </Overlay>
      );
      act(() => {
        viewport.resize(768);
      });

      rerender(
        <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Test">
          <div>Content</div>
        </Overlay>
      );

      expect(variant()).toBe('dialog');
    });

    it('keeps the state its opener passes in when the window widens', async () => {
      const viewport = installViewport(767);
      function Opener(): React.JSX.Element {
        const [name, setName] = React.useState('');
        return (
          <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Test">
            <input
              aria-label="Name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          </Overlay>
        );
      }
      render(<Opener />);
      act(() => {
        screen.getByRole('textbox', { name: 'Name' }).focus();
      });
      await userEvent.keyboard('Ada');

      act(() => {
        viewport.resize(768);
      });

      expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Ada');
    });
  });

  describe('scrim', () => {
    it.each([
      ['dialog', 768],
      ['sheet', 767],
    ])("draws the %s scrim from the recipe's base and blur", (_presentation, width) => {
      installViewport(width);
      render(
        <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Test">
          <div>Content</div>
        </Overlay>
      );

      const backdrop = screen.getByTestId(TEST_IDS.overlayBackdrop);
      const recipe = `${SCRIM_BASE_CLASS} ${SCRIM_BLUR_CLASS}`.split(' ');
      expect(backdrop).toHaveClass(...recipe);
    });
  });
});
