import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useScrollIntoView } from './use-scroll-into-view';

function rect(top: number, height: number): DOMRect {
  return { top, height, bottom: top + height } as DOMRect;
}

interface Scene {
  readonly pane: HTMLElement;
  readonly element: HTMLElement;
  readonly ref: { current: HTMLElement | null };
  readonly scrollIntoView: ReturnType<typeof vi.fn>;
  readonly rerender: (props: { anchor: string }) => void;
}

function setup(
  anchor: string,
  options: {
    block?: 'start' | 'nearest';
    paneTop?: number;
    paneHeight?: number;
    elementTop?: number;
    elementHeight?: number;
    scrollTop?: number;
    scrollable?: boolean;
  } = {}
): Scene {
  const {
    block = 'start',
    paneTop = 100,
    paneHeight = 400,
    elementTop = 340,
    elementHeight = 60,
    scrollTop = 0,
    scrollable = true,
  } = options;

  const pane = document.createElement('div');
  if (scrollable) pane.style.overflowY = 'auto';
  const element = document.createElement('div');
  const scrollIntoView = vi.fn();
  element.scrollIntoView = scrollIntoView;
  pane.append(element);
  document.body.append(pane);

  pane.getBoundingClientRect = () => rect(paneTop, paneHeight);
  Object.defineProperty(pane, 'clientHeight', { value: paneHeight, configurable: true });
  element.getBoundingClientRect = () => rect(elementTop, elementHeight);
  Object.defineProperty(element, 'offsetHeight', { value: elementHeight, configurable: true });
  pane.scrollTop = scrollTop;

  const ref: { current: HTMLElement | null } = { current: element };
  const view = renderHook(
    ({ anchor: current }: { anchor: string }) => {
      useScrollIntoView(ref, current, block);
    },
    { initialProps: { anchor } }
  );
  return { pane, element, ref, scrollIntoView, rerender: view.rerender };
}

describe('useScrollIntoView', () => {
  it('brings what the reader landed on to the top of its own pane', () => {
    const { pane } = setup('A-1', { scrollTop: 500 });

    expect(pane.scrollTop).toBe(740);
  });

  it('never asks the browser to scroll the ancestors the console fixes in place', () => {
    const { scrollIntoView } = setup('A-1');

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('brings the next finding into view when the reader steps to it', () => {
    const { pane, rerender } = setup('A-1');

    pane.scrollTop = 90;
    rerender({ anchor: 'A-2' });

    expect(pane.scrollTop).toBe(330);
  });

  it('leaves the pane alone while the reader stays on the same finding', () => {
    const { pane, rerender } = setup('A-1');

    pane.scrollTop = 17;
    rerender({ anchor: 'A-1' });

    expect(pane.scrollTop).toBe(17);
  });

  it('leaves a row that is already fully in view where it is', () => {
    const { pane } = setup('A-1', {
      block: 'nearest',
      elementTop: 150,
      elementHeight: 40,
      scrollTop: 300,
    });

    expect(pane.scrollTop).toBe(300);
  });

  it('lifts a row that sits above the pane just far enough to show it', () => {
    const { pane } = setup('A-1', {
      block: 'nearest',
      elementTop: 40,
      elementHeight: 40,
      scrollTop: 300,
    });

    expect(pane.scrollTop).toBe(240);
  });

  it('pulls a row that sits below the pane just far enough to show it', () => {
    const { pane } = setup('A-1', {
      block: 'nearest',
      elementTop: 480,
      elementHeight: 40,
      scrollTop: 300,
    });

    expect(pane.scrollTop).toBe(320);
  });

  it('does nothing when no ancestor of the finding scrolls', () => {
    const { pane } = setup('A-1', { scrollable: false, scrollTop: 500 });

    expect(pane.scrollTop).toBe(500);
  });

  it('does nothing when there is nothing on screen to scroll to', () => {
    const ref = { current: null };

    expect(() => {
      renderHook(() => {
        useScrollIntoView(ref, 'A-1', 'nearest');
      });
    }).not.toThrow();
  });
});

/**
 * The brand fonts swap in after the first paint. Everything above the finding
 * re-measures, and a deep link into a section with a tall lead above the card
 * landed 34px past the top of it, cutting the identity row in half.
 */
describe('useScrollIntoView while the web fonts are still loading', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis.document, 'fonts');

  function fontsLoadAfter(): { settle: () => Promise<void> } {
    let landed = (): void => undefined;
    const ready = new Promise<void>((resolve) => {
      landed = () => {
        resolve();
      };
    });
    Object.defineProperty(globalThis.document, 'fonts', {
      configurable: true,
      value: { status: 'loading', ready },
    });
    return {
      settle: async () => {
        landed();
        await ready;
      },
    };
  }

  afterEach(() => {
    if (original === undefined) {
      Reflect.deleteProperty(globalThis.document, 'fonts');
    } else {
      Object.defineProperty(globalThis.document, 'fonts', original);
    }
  });

  it('lands the finding again once the fonts have moved everything above it', async () => {
    const fonts = fontsLoadAfter();
    const { pane, element } = setup('A-1', { scrollTop: 0 });
    element.getBoundingClientRect = () => rect(66, 60);

    await act(async () => {
      await fonts.settle();
    });

    expect(pane.scrollTop).toBe(206);
  });

  it('corrects where the reader is now, not every finding they passed on the way', async () => {
    const fonts = fontsLoadAfter();
    const { pane, rerender } = setup('A-1', { scrollTop: 0 });
    rerender({ anchor: 'A-2' });
    pane.scrollTop = 17;

    await act(async () => {
      await fonts.settle();
    });

    expect(pane.scrollTop).toBe(257);
  });

  it('waits for nothing once the fonts are already in', () => {
    Object.defineProperty(globalThis.document, 'fonts', {
      configurable: true,
      value: {
        status: 'loaded',
        get ready(): never {
          throw new Error('a loaded font set is never waited on');
        },
      },
    });

    expect(() => setup('A-1')).not.toThrow();
  });

  it('gives up when the finding has left the screen by the time they land', async () => {
    const fonts = fontsLoadAfter();
    const { pane, ref } = setup('A-1', { scrollTop: 0 });
    ref.current = null;

    await act(async () => {
      await fonts.settle();
    });

    expect(pane.scrollTop).toBe(240);
  });
});
