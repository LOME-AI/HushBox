import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { TEST_IDS } from '@hushbox/shared';
import { Overlay } from './overlay';
import { OverlayContent } from './overlay-content';
import { OverlayHeader } from './overlay-header';
import { useOverlayPresentation } from './overlay-presentation';

const originalMatchMedia = globalThis.matchMedia;

interface MediaListStub {
  readonly matches: boolean;
  readonly media: string;
  readonly addEventListener: (type: string, listener: (event: MediaQueryListEvent) => void) => void;
  readonly removeEventListener: (
    type: string,
    listener: (event: MediaQueryListEvent) => void
  ) => void;
}

/** Stubs `matchMedia` for a window `width` wide under a fine pointer. */
function setWindowWidth(width: number): void {
  Object.defineProperty(globalThis, 'matchMedia', {
    writable: true,
    value: (query: string): MediaQueryList => {
      const maxWidth = /^\(max-width: (\d+)px\)$/.exec(query);
      const list: MediaListStub = {
        matches: maxWidth?.[1] !== undefined && width <= Number(maxWidth[1]),
        media: query,
        addEventListener: (): void => {},
        removeEventListener: (): void => {},
      };
      // The band and pointer hooks read only `matches` and the change-listener pair.
      return list as MediaQueryList;
    },
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, 'matchMedia', { writable: true, value: originalMatchMedia });
});

function Presentation(): React.JSX.Element {
  return <span>{useOverlayPresentation()}</span>;
}

describe('Overlay phonePresentation', () => {
  it('renders a sheet below 768 by default', () => {
    setWindowWidth(767);
    render(
      <Overlay open onOpenChange={vi.fn()} ariaLabel="Palette">
        <p>content</p>
      </Overlay>
    );

    expect(screen.getByTestId(TEST_IDS.overlayContent)).toHaveAttribute(
      'data-overlay-variant',
      'bottom-sheet'
    );
  });

  describe('fullscreen below 768', () => {
    function renderFullscreen(): void {
      setWindowWidth(767);
      render(
        <Overlay open onOpenChange={vi.fn()} ariaLabel="Palette" phonePresentation="fullscreen">
          <OverlayContent data-testid="panel">
            <Presentation />
          </OverlayContent>
        </Overlay>
      );
    }

    it('renders a dialog', () => {
      renderFullscreen();

      expect(screen.getByTestId(TEST_IDS.overlayContent)).toHaveAttribute(
        'data-overlay-variant',
        'dialog'
      );
    });

    it('sizes the dialog to the viewport', () => {
      renderFullscreen();

      const dialog = screen.getByTestId(TEST_IDS.overlayContent);
      expect(dialog).toHaveClass('inset-0', 'h-dvh', 'w-full');
      expect(dialog).not.toHaveClass('top-[50%]');
      expect(dialog).not.toHaveClass('pt-2');
    });

    it('draws no handle', () => {
      renderFullscreen();

      expect(screen.getByTestId(TEST_IDS.overlayContent).querySelector('.rounded-full')).toBeNull();
    });

    it('draws its content edge to edge', () => {
      renderFullscreen();

      expect(screen.getByTestId('panel')).toHaveClass(
        'h-full',
        'w-full',
        'rounded-none',
        'border-0'
      );
    });

    it('tells its content it is a dialog', () => {
      renderFullscreen();

      expect(screen.getByTestId('panel')).toHaveTextContent('dialog');
    });
  });

  it('renders a centred dialog from 768 when fullscreen below it', () => {
    setWindowWidth(768);
    render(
      <Overlay open onOpenChange={vi.fn()} ariaLabel="Palette" phonePresentation="fullscreen">
        <OverlayContent data-testid="panel">x</OverlayContent>
      </Overlay>
    );

    expect(screen.getByTestId(TEST_IDS.overlayContent)).toHaveClass('top-[50%]', 'pt-2');
    expect(screen.getByTestId('panel')).toHaveClass('rounded-lg', 'border', 'shadow-lg');
  });
});

describe('OverlayContent placement', () => {
  it('places the dialog 12vh down at 1024 wide', () => {
    setWindowWidth(1024);
    render(
      <Overlay open onOpenChange={vi.fn()} ariaLabel="Palette">
        <OverlayContent placement="top">x</OverlayContent>
      </Overlay>
    );

    const dialog = screen.getByTestId(TEST_IDS.overlayContent);
    // The dialog's own 0.5rem top padding sits above the panel, so the panel's top is at 12vh.
    expect(dialog).toHaveClass('top-[calc(12vh-0.5rem)]', 'translate-y-0');
    expect(dialog).not.toHaveClass('top-[50%]');
    expect(dialog).not.toHaveClass('translate-y-[-50%]');
  });

  it('centres the dialog by default', () => {
    setWindowWidth(1024);
    render(
      <Overlay open onOpenChange={vi.fn()} ariaLabel="Palette">
        <OverlayContent>x</OverlayContent>
      </Overlay>
    );

    expect(screen.getByTestId(TEST_IDS.overlayContent)).toHaveClass(
      'top-[50%]',
      'translate-y-[-50%]'
    );
  });

  it('centres the dialog again once the top-placed content leaves', () => {
    setWindowWidth(1024);
    function Stepped({ top }: Readonly<{ top: boolean }>): React.JSX.Element {
      return (
        <Overlay open onOpenChange={vi.fn()} ariaLabel="Palette">
          {top ? (
            <OverlayContent placement="top">a</OverlayContent>
          ) : (
            <OverlayContent>b</OverlayContent>
          )}
        </Overlay>
      );
    }
    const { rerender } = render(<Stepped top />);

    rerender(<Stepped top={false} />);

    expect(screen.getByTestId(TEST_IDS.overlayContent)).toHaveClass('top-[50%]');
  });

  it('keeps a sheet at the bottom below 768', () => {
    setWindowWidth(767);
    render(
      <Overlay open onOpenChange={vi.fn()} ariaLabel="Palette">
        <OverlayContent placement="top">x</OverlayContent>
      </Overlay>
    );

    expect(screen.getByTestId(TEST_IDS.overlayContent)).toHaveClass('bottom-0');
  });
});

describe('Overlay role', () => {
  it.each([
    ['dialog', 768],
    ['sheet', 767],
  ])('announces an alert dialog as a %s', (_presentation, width) => {
    setWindowWidth(width);
    render(
      <Overlay open onOpenChange={vi.fn()} ariaLabel="Delete?" role="alertdialog">
        <OverlayContent>
          <OverlayHeader title="Delete conversation?" />
        </OverlayContent>
      </Overlay>
    );

    expect(screen.getByRole('alertdialog')).toHaveAccessibleName('Delete conversation?');
  });

  it.each([
    ['dialog', 768],
    ['sheet', 767],
  ])('announces a plain dialog as a %s by default', (_presentation, width) => {
    setWindowWidth(width);
    render(
      <Overlay open onOpenChange={vi.fn()} ariaLabel="Rename">
        <p>x</p>
      </Overlay>
    );

    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('OverlayHeader inside an Overlay', () => {
  it('names the dialog by its title, not its step', () => {
    setWindowWidth(768);
    render(
      <Overlay open onOpenChange={vi.fn()} ariaLabel="Recovery phrase">
        <OverlayContent>
          <OverlayHeader title="Verify your phrase" step={{ current: 2, total: 4 }} />
        </OverlayContent>
      </Overlay>
    );

    expect(screen.getByRole('dialog')).toHaveAccessibleName('Verify your phrase');
  });

  it.each([
    ['dialog', 768],
    ['sheet', 767],
  ])('raises no missing-description warning in a %s', async (_presentation, width) => {
    setWindowWidth(width);
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');
    render(
      <Overlay open onOpenChange={vi.fn()} ariaLabel="Change password">
        <OverlayContent>
          <OverlayHeader title="Change password" description="Other devices sign out." />
        </OverlayContent>
      </Overlay>
    );
    await screen.findByRole('dialog');

    await waitFor(() => {
      const printed = [...warn.mock.calls, ...error.mock.calls].map((call) => String(call[0]));
      expect(printed.filter((line) => line.includes('Description'))).toEqual([]);
    });
    warn.mockRestore();
    error.mockRestore();
  });
});
