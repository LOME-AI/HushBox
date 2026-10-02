import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, onTestFinished } from 'vitest';
import { TEST_IDS, TOUCH_QUERY } from '@hushbox/shared';
import { Overlay } from './overlay';
import { TouchDeviceOverrideContext } from '../../hooks/touch-device-override-context';
import { PortalContainerProvider } from '../primitives/portal-container';

function portalTarget(): HTMLElement {
  const target = document.createElement('div');
  document.body.append(target);
  onTestFinished(() => {
    target.remove();
  });
  return target;
}

describe('Overlay router', () => {
  const originalMatchMedia = globalThis.matchMedia;

  const installViewport = (width: number, pointer: 'fine' | 'coarse'): void => {
    Object.defineProperty(globalThis, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => {
        const maxWidth = /^\(max-width: (\d+)px\)$/.exec(query);
        const matches =
          maxWidth?.[1] === undefined
            ? query === TOUCH_QUERY && pointer === 'coarse'
            : width <= Number(maxWidth[1]);
        return {
          matches,
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        };
      }),
    });
  };

  afterEach(() => {
    Object.defineProperty(globalThis, 'matchMedia', {
      writable: true,
      value: originalMatchMedia,
    });
    vi.restoreAllMocks();
  });

  function renderedVariant(override: boolean | null): string | null {
    render(
      <TouchDeviceOverrideContext value={override}>
        <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Test">
          <div>Content</div>
        </Overlay>
      </TouchDeviceOverrideContext>
    );
    return screen.getByTestId(TEST_IDS.overlayContent).dataset['overlayVariant'] ?? null;
  }

  it('renders a bottom sheet at 767px with a fine pointer', () => {
    installViewport(767, 'fine');

    expect(renderedVariant(null)).toBe('bottom-sheet');
  });

  it('renders a dialog at 768px with a fine pointer', () => {
    installViewport(768, 'fine');

    expect(renderedVariant(null)).toBe('dialog');
  });

  it('renders a dialog at 768px with a coarse pointer', () => {
    installViewport(768, 'coarse');

    expect(renderedVariant(null)).toBe('dialog');
  });

  it('renders a bottom sheet at 767px with a coarse pointer', () => {
    installViewport(767, 'coarse');

    expect(renderedVariant(null)).toBe('bottom-sheet');
  });

  it('renders a dialog at 768px with the touch override on', () => {
    installViewport(768, 'fine');

    expect(renderedVariant(true)).toBe('dialog');
  });

  it('renders a bottom sheet at 767px with the touch override off', () => {
    installViewport(767, 'coarse');

    expect(renderedVariant(false)).toBe('bottom-sheet');
  });

  it('renders a bottom sheet at 767px with the touch override on', () => {
    installViewport(767, 'fine');

    expect(renderedVariant(true)).toBe('bottom-sheet');
  });

  it('renders a dialog at 768px with the touch override off', () => {
    installViewport(768, 'coarse');

    expect(renderedVariant(false)).toBe('dialog');
  });

  it('portals the dialog into the element its provider gives at 768px', () => {
    installViewport(768, 'fine');
    const target = portalTarget();
    render(
      <PortalContainerProvider container={target}>
        <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Test">
          <div>Content</div>
        </Overlay>
      </PortalContainerProvider>
    );

    expect(target).toContainElement(screen.getByTestId(TEST_IDS.overlayContent));
  });

  it('portals the bottom sheet into the element its provider gives at 767px', () => {
    installViewport(767, 'fine');
    const target = portalTarget();
    render(
      <PortalContainerProvider container={target}>
        <Overlay open={true} onOpenChange={vi.fn()} ariaLabel="Test">
          <div>Content</div>
        </Overlay>
      </PortalContainerProvider>
    );

    expect(target).toContainElement(screen.getByTestId(TEST_IDS.overlayContent));
  });
});
