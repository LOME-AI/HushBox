import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useHeaderLayout } from './use-header-layout';

type ResizeCallback = ResizeObserverCallback;

let resizeCallbacks: ResizeCallback[];
let observedElements: Element[];

class MockResizeObserver {
  callback: ResizeCallback;

  constructor(callback: ResizeCallback) {
    this.callback = callback;
    resizeCallbacks.push(callback);
  }

  observe(el: Element): void {
    observedElements.push(el);
  }

  unobserve(): void {
    // no-op for tests
  }

  disconnect(): void {
    const index = resizeCallbacks.indexOf(this.callback);
    if (index !== -1) resizeCallbacks.splice(index, 1);
  }
}

function setDimension(
  el: HTMLDivElement,
  property: 'offsetWidth' | 'clientWidth',
  value: number
): void {
  Object.defineProperty(el, property, { value, configurable: true });
}

function triggerResize(): void {
  for (const callback of resizeCallbacks) {
    callback([], {} as ResizeObserver);
  }
}

function createReferences(
  containerWidth: number,
  leftWidth: number,
  centerWidth: number,
  rightWidth: number
): {
  containerRef: { current: HTMLDivElement };
  leftRef: { current: HTMLDivElement };
  centerRef: { current: HTMLDivElement };
  rightRef: { current: HTMLDivElement };
} {
  const container = document.createElement('div');
  const left = document.createElement('div');
  const center = document.createElement('div');
  const right = document.createElement('div');

  setDimension(container, 'clientWidth', containerWidth);
  setDimension(left, 'offsetWidth', leftWidth);
  setDimension(center, 'offsetWidth', centerWidth);
  setDimension(right, 'offsetWidth', rightWidth);

  return {
    containerRef: { current: container },
    leftRef: { current: left },
    centerRef: { current: center },
    rightRef: { current: right },
  };
}

describe('useHeaderLayout', () => {
  beforeEach(() => {
    resizeCallbacks = [];
    observedElements = [];
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 1 when all groups fit in a single row', () => {
    // 200 + 266 + 100 = 566 ≤ 800
    const references = createReferences(800, 200, 266, 100);
    const { result } = renderHook(() =>
      useHeaderLayout(
        references.containerRef,
        references.leftRef,
        references.centerRef,
        references.rightRef
      )
    );
    expect(result.current).toBe(1);
  });

  it('returns 2 when total overflows but center + right fit together', () => {
    // 200 + 266 + 100 = 566 > 500, max(200, 366) = 366 ≤ 500
    const references = createReferences(500, 200, 266, 100);
    const { result } = renderHook(() =>
      useHeaderLayout(
        references.containerRef,
        references.leftRef,
        references.centerRef,
        references.rightRef
      )
    );
    expect(result.current).toBe(2);
  });

  it('returns 3 when center + right do not fit together', () => {
    // 200 + 266 + 100 = 566 > 300, max(200, 366) = 366 > 300
    const references = createReferences(300, 200, 266, 100);
    const { result } = renderHook(() =>
      useHeaderLayout(
        references.containerRef,
        references.leftRef,
        references.centerRef,
        references.rightRef
      )
    );
    expect(result.current).toBe(3);
  });

  it('returns 1 when widths exactly equal available space', () => {
    // 200 + 266 + 100 = 566 = 566
    const references = createReferences(566, 200, 266, 100);
    const { result } = renderHook(() =>
      useHeaderLayout(
        references.containerRef,
        references.leftRef,
        references.centerRef,
        references.rightRef
      )
    );
    expect(result.current).toBe(1);
  });

  it('recalculates when container resizes', () => {
    const references = createReferences(800, 200, 266, 100);
    const { result } = renderHook(() =>
      useHeaderLayout(
        references.containerRef,
        references.leftRef,
        references.centerRef,
        references.rightRef
      )
    );
    expect(result.current).toBe(1);

    // Simulate sidebar opening → container shrinks
    setDimension(references.containerRef.current, 'clientWidth', 400);
    act(() => {
      triggerResize();
    });
    expect(result.current).toBe(2);
  });

  it('recalculates when group content changes size', () => {
    const references = createReferences(600, 100, 266, 80);
    const { result } = renderHook(() =>
      useHeaderLayout(
        references.containerRef,
        references.leftRef,
        references.centerRef,
        references.rightRef
      )
    );
    // 100 + 266 + 80 = 446 ≤ 600 → 1 row
    expect(result.current).toBe(1);

    // Title gets longer (AI-generated title)
    setDimension(references.leftRef.current, 'offsetWidth', 250);
    act(() => {
      triggerResize();
    });
    // 250 + 266 + 80 = 596 ≤ 600 → still 1
    expect(result.current).toBe(1);

    // Title even longer
    setDimension(references.leftRef.current, 'offsetWidth', 300);
    act(() => {
      triggerResize();
    });
    // 300 + 266 + 80 = 646 > 600 → 2 rows
    expect(result.current).toBe(2);
  });

  it('returns 1 when refs are null', () => {
    const nullRef = { current: null };
    const { result } = renderHook(() => useHeaderLayout(nullRef, nullRef, nullRef, nullRef));
    expect(result.current).toBe(1);
  });

  it('observes the container and all three group elements', () => {
    const references = createReferences(800, 200, 266, 100);
    renderHook(() =>
      useHeaderLayout(
        references.containerRef,
        references.leftRef,
        references.centerRef,
        references.rightRef
      )
    );
    expect(observedElements).toContain(references.containerRef.current);
    expect(observedElements).toContain(references.leftRef.current);
    expect(observedElements).toContain(references.centerRef.current);
    expect(observedElements).toContain(references.rightRef.current);
  });

  it('disconnects observer on unmount', () => {
    const references = createReferences(800, 200, 266, 100);
    const { unmount } = renderHook(() =>
      useHeaderLayout(
        references.containerRef,
        references.leftRef,
        references.centerRef,
        references.rightRef
      )
    );
    expect(resizeCallbacks).toHaveLength(1);
    unmount();
    expect(resizeCallbacks).toHaveLength(0);
  });

  it('transitions back to fewer rows when container grows', () => {
    const references = createReferences(400, 200, 266, 100);
    const { result } = renderHook(() =>
      useHeaderLayout(
        references.containerRef,
        references.leftRef,
        references.centerRef,
        references.rightRef
      )
    );
    // 566 > 400, max(200, 366) = 366 ≤ 400 → 2 rows
    expect(result.current).toBe(2);

    // Sidebar closes → container grows
    setDimension(references.containerRef.current, 'clientWidth', 800);
    act(() => {
      triggerResize();
    });
    expect(result.current).toBe(1);
  });

  it('transitions from 3 rows back to 1 when container grows enough', () => {
    const references = createReferences(300, 200, 266, 100);
    const { result } = renderHook(() =>
      useHeaderLayout(
        references.containerRef,
        references.leftRef,
        references.centerRef,
        references.rightRef
      )
    );
    expect(result.current).toBe(3);

    setDimension(references.containerRef.current, 'clientWidth', 800);
    act(() => {
      triggerResize();
    });
    expect(result.current).toBe(1);
  });
});
