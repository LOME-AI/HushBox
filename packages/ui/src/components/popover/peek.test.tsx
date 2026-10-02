import * as React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Peek } from './peek';

const originalMatchMedia = globalThis.matchMedia;

/** Stubs `matchMedia` for a window `width` wide; the band and pointer hooks read only `matches`. */
function installViewport(width: number): void {
  Object.defineProperty(globalThis, 'matchMedia', {
    writable: true,
    value: (query: string): MediaQueryList => {
      const maxWidth = /^\(max-width: (\d+)px\)$/.exec(query);
      const list = {
        matches: maxWidth?.[1] !== undefined && width <= Number(maxWidth[1]),
        media: query,
        addEventListener: (): void => {},
        removeEventListener: (): void => {},
      };
      // The hooks under test read only `matches` and the change-listener pair.
      return list as unknown as MediaQueryList;
    },
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, 'matchMedia', { writable: true, value: originalMatchMedia });
});

/**
 * An anchor that opens the peek while it holds focus and closes it once focus leaves, as a
 * caller previewing what the reader rests on does.
 */
function FocusHarness(): React.JSX.Element {
  const [anchor, setAnchor] = React.useState<HTMLElement | null>(null);
  return (
    <>
      <button
        type="button"
        onFocus={(event) => {
          setAnchor(event.currentTarget);
        }}
        onBlur={() => {
          setAnchor(null);
        }}
      >
        apps/api/src/index.ts:12
      </button>
      <Peek
        anchor={anchor}
        onDismiss={() => {
          setAnchor(null);
        }}
      >
        <div data-testid="peek-body">const cited = 3;</div>
      </Peek>
    </>
  );
}

/** The box the peek's children sit in, once the peek has opened. */
async function peekBox(): Promise<HTMLElement | null> {
  const body = await screen.findByTestId('peek-body');
  return body.parentElement;
}

function renderAnchored(onDismiss: () => void = vi.fn()): HTMLElement {
  const anchor = document.createElement('code');
  anchor.textContent = 'apps/api/src/index.ts:12';
  document.body.append(anchor);
  render(
    <Peek anchor={anchor} onDismiss={onDismiss}>
      <div data-testid="peek-body">const cited = 3;</div>
    </Peek>
  );
  return anchor;
}

describe('Peek', () => {
  it('a peek opened while its anchor holds focus leaves focus on the anchor and stays open', async () => {
    render(<FocusHarness />);
    const anchor = screen.getByRole('button', { name: 'apps/api/src/index.ts:12' });

    // Inside `act`, the open and the mount effects in which Radix would move focus all flush
    // before the peek is looked for, so no settle wait follows.
    act(() => {
      anchor.focus();
    });
    await screen.findByTestId('peek-body');

    expect(document.activeElement).toBe(anchor);
    expect(screen.getByTestId('peek-body')).toBeInTheDocument();
  });

  it('renders its children directly inside the height-capped box', async () => {
    renderAnchored();

    const box = await peekBox();

    expect(box).toHaveClass(
      'max-h-[min(85vh,var(--radix-popover-content-available-height))]',
      'overflow-hidden'
    );
  });

  it('takes no pointer events on its box', async () => {
    renderAnchored();

    const box = await peekBox();

    expect(box).toHaveClass('pointer-events-none');
  });

  it('leaves the wrapper that positions it click-transparent', async () => {
    renderAnchored();

    const body = await screen.findByTestId('peek-body');
    const wrapper = body.closest<HTMLElement>('[data-radix-popper-content-wrapper]');

    expect(wrapper?.style.pointerEvents).toBe('none');
  });

  it('sits above its anchor, aligned to its start', async () => {
    renderAnchored();

    const box = await peekBox();

    expect(box).toHaveAttribute('data-side', 'top');
    expect(box).toHaveAttribute('data-align', 'start');
  });

  it('draws no width of its own, so its content sets it', async () => {
    renderAnchored();

    const box = await peekBox();

    expect(box).not.toHaveClass('w-72');
  });

  it('renders nothing with no anchor', () => {
    render(
      <Peek anchor={null} onDismiss={vi.fn()}>
        <div data-testid="peek-body">const cited = 3;</div>
      </Peek>
    );

    expect(screen.queryByTestId('peek-body')).not.toBeInTheDocument();
  });

  it('asks to be dismissed on Escape', async () => {
    const onDismiss = vi.fn();
    renderAnchored(onDismiss);
    await screen.findByTestId('peek-body');

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });
  });

  it('stays anchored below 768, with no sheet and no scrim', async () => {
    installViewport(390);
    renderAnchored();

    const box = await peekBox();

    expect(box).toHaveAttribute('data-slot', 'popover-content');
    expect(document.querySelector('[data-slot="overlay-backdrop"]')).toBeNull();
  });
});
