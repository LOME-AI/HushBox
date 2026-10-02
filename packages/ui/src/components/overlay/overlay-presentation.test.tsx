import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useOverlayPresentation as publishedUseOverlayPresentation } from '@hushbox/ui/overlay';
import { Overlay } from './overlay';
import { useOverlayPresentation } from './overlay-presentation';

const originalMatchMedia = globalThis.matchMedia;

function installWidth(width: number): void {
  Object.defineProperty(globalThis, 'matchMedia', {
    writable: true,
    value: (query: string): MediaQueryList => {
      const maxWidth = /^\(max-width: (\d+)px\)$/.exec(query);
      const list: Pick<
        MediaQueryList,
        'matches' | 'media' | 'addEventListener' | 'removeEventListener'
      > = {
        matches: maxWidth?.[1] !== undefined && width <= Number(maxWidth[1]),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      // The band and pointer hooks read only `matches` and the change-listener pair.
      return list as MediaQueryList;
    },
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, 'matchMedia', { writable: true, value: originalMatchMedia });
});

function Probe(): React.JSX.Element {
  const presentation = useOverlayPresentation();
  return <span data-testid="presentation">{presentation ?? 'none'}</span>;
}

function presentationInsideOverlay(): string | null {
  render(
    <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Test">
      <Probe />
    </Overlay>
  );
  return screen.getByTestId('presentation').textContent;
}

describe('useOverlayPresentation', () => {
  it('returns null outside an overlay', () => {
    render(<Probe />);

    expect(screen.getByTestId('presentation')).toHaveTextContent('none');
  });

  it('returns sheet inside an overlay at 767px', () => {
    installWidth(767);

    expect(presentationInsideOverlay()).toBe('sheet');
  });

  it('returns dialog inside an overlay at 768px', () => {
    installWidth(768);

    expect(presentationInsideOverlay()).toBe('dialog');
  });

  it('is published from the overlay door', () => {
    expect(publishedUseOverlayPresentation).toBe(useOverlayPresentation);
  });
});
