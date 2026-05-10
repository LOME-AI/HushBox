import { render, fireEvent, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Magnifier } from './magnifier';

// fireEvent expects a Node/Window target; the unicorn rule wants `globalThis`.
// This typed alias lets us pass `window` to fireEvent without violating either.
const win = globalThis as unknown as Window;

interface MockMutationObserver {
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  takeRecords: ReturnType<typeof vi.fn>;
  trigger: () => void;
}

let lastObserver: MockMutationObserver | null = null;

function installMutationObserver(): void {
  lastObserver = null;
  const ObserverImpl = vi.fn(function MockObserver(callback: MutationCallback) {
    const mock: MockMutationObserver = {
      observe: vi.fn(),
      disconnect: vi.fn(),
      takeRecords: vi.fn(() => []),
      trigger: () => {
        callback([], mock as unknown as MutationObserver);
      },
    };
    lastObserver = mock;
    return mock;
  });
  vi.stubGlobal('MutationObserver', ObserverImpl);
}

describe('Magnifier', () => {
  beforeEach(() => {
    installMutationObserver();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders nothing when disabled', () => {
    const { container } = render(<Magnifier enabled={false} />);
    expect(container.querySelector('[data-a11y-magnifier]')).toBeNull();
  });

  it('renders the lens when enabled', () => {
    const { container } = render(<Magnifier enabled />);
    expect(container.querySelector('[data-a11y-magnifier]')).not.toBeNull();
  });

  it('marks the lens as decorative for assistive tech', () => {
    const { container } = render(<Magnifier enabled />);
    const lens = container.querySelector<HTMLElement>('[data-a11y-magnifier]');
    expect(lens).not.toBeNull();
    expect(lens?.getAttribute('aria-hidden')).toBe('true');
  });

  it('renders the lens with pointer-events: none', () => {
    const { container } = render(<Magnifier enabled />);
    const lens = container.querySelector<HTMLElement>('[data-a11y-magnifier]');
    expect(lens?.style.pointerEvents).toBe('none');
  });

  it('renders the lens as a fixed-position circle with default size 200', () => {
    const { container } = render(<Magnifier enabled />);
    const lens = container.querySelector<HTMLElement>('[data-a11y-magnifier]');
    expect(lens?.style.position).toBe('fixed');
    expect(lens?.style.width).toBe('200px');
    expect(lens?.style.height).toBe('200px');
    expect(lens?.style.borderRadius).toBe('50%');
    expect(lens?.style.overflow).toBe('hidden');
  });

  it('honors a custom size', () => {
    const { container } = render(<Magnifier enabled size={300} />);
    const lens = container.querySelector<HTMLElement>('[data-a11y-magnifier]');
    expect(lens?.style.width).toBe('300px');
    expect(lens?.style.height).toBe('300px');
  });

  it('repositions the lens to follow the cursor', () => {
    const { container } = render(<Magnifier enabled size={200} />);

    fireEvent.mouseMove(win, { clientX: 500, clientY: 400 });

    const lens = container.querySelector<HTMLElement>('[data-a11y-magnifier]');
    // Lens is anchored top-left at (cursor - size/2) so the circle is centered on the cursor.
    expect(lens?.style.transform).toContain('translate(400px, 300px)');
  });

  it('contains a magnified clone of the body that uses the configured zoom', () => {
    const { container } = render(<Magnifier enabled zoom={2.5} />);

    const inner = container.querySelector<HTMLElement>('[data-a11y-magnifier-content]');
    expect(inner).not.toBeNull();
    expect(inner?.style.transform).toContain('scale(2.5)');
  });

  it('uses the default zoom of 2', () => {
    const { container } = render(<Magnifier enabled />);
    const inner = container.querySelector<HTMLElement>('[data-a11y-magnifier-content]');
    expect(inner?.style.transform).toContain('scale(2)');
  });

  it('updates the magnification origin to follow the cursor', () => {
    const { container } = render(<Magnifier enabled />);

    fireEvent.mouseMove(win, { clientX: 250, clientY: 175 });

    const inner = container.querySelector<HTMLElement>('[data-a11y-magnifier-content]');
    expect(inner?.style.transformOrigin).toBe('250px 175px');
  });

  it('observes document.body when mounted', () => {
    render(<Magnifier enabled />);
    expect(lastObserver?.observe).toHaveBeenCalled();
    const [target, options] = lastObserver?.observe.mock.calls[0] ?? [];
    expect(target).toBe(document.body);
    expect(options).toMatchObject({
      childList: true,
      subtree: true,
      characterData: true,
    });
  });

  it('debounces clone refreshes after MutationObserver ticks', () => {
    const { container } = render(<Magnifier enabled />);
    const inner = container.querySelector<HTMLElement>('[data-a11y-magnifier-content]');
    expect(inner).not.toBeNull();
    const initialHtml = inner!.innerHTML;

    document.body.append(
      Object.assign(document.createElement('span'), { textContent: 'fresh content' })
    );

    act(() => {
      lastObserver?.trigger();
    });

    // Before the debounce timer fires the clone has not been refreshed yet.
    const innerBeforeDebounce = container.querySelector<HTMLElement>(
      '[data-a11y-magnifier-content]'
    );
    expect(innerBeforeDebounce?.innerHTML).toBe(initialHtml);

    act(() => {
      vi.advanceTimersByTime(100);
    });

    const innerAfterDebounce = container.querySelector<HTMLElement>(
      '[data-a11y-magnifier-content]'
    );
    expect(innerAfterDebounce?.innerHTML).toContain('fresh content');
  });

  it('coalesces rapid MutationObserver ticks into a single debounced refresh', () => {
    const { container } = render(<Magnifier enabled />);
    const inner = container.querySelector<HTMLElement>('[data-a11y-magnifier-content]');
    const initialHtml = inner!.innerHTML;

    // First tick schedules a timer.
    act(() => {
      lastObserver?.trigger();
    });

    // Second tick within the debounce window must clear the prior timer (covers
    // the `if (debounceId !== null) clearTimeout(...)` branch).
    document.body.append(
      Object.assign(document.createElement('span'), { textContent: 'late content' })
    );
    act(() => {
      lastObserver?.trigger();
    });

    // Before the debounce finishes, content has not yet been written.
    expect(container.querySelector<HTMLElement>('[data-a11y-magnifier-content]')?.innerHTML).toBe(
      initialHtml
    );

    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(
      container.querySelector<HTMLElement>('[data-a11y-magnifier-content]')?.innerHTML
    ).toContain('late content');
  });

  it('disconnects the MutationObserver on unmount', () => {
    const { unmount } = render(<Magnifier enabled />);
    unmount();
    expect(lastObserver?.disconnect).toHaveBeenCalledTimes(1);
  });

  it('removes the mousemove listener on unmount', () => {
    const removeSpy = vi.spyOn(globalThis, 'removeEventListener');
    const { unmount } = render(<Magnifier enabled />);
    unmount();
    expect(removeSpy).toHaveBeenCalledWith('mousemove', expect.any(Function));
  });

  it('removes listeners and disconnects the observer when toggled to disabled', () => {
    const removeSpy = vi.spyOn(globalThis, 'removeEventListener');
    const { rerender } = render(<Magnifier enabled />);
    const observer = lastObserver;

    rerender(<Magnifier enabled={false} />);

    expect(removeSpy).toHaveBeenCalledWith('mousemove', expect.any(Function));
    expect(observer?.disconnect).toHaveBeenCalled();
  });
});
