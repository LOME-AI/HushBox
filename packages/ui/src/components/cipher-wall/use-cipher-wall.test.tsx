import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import * as engine from './cipher-wall-engine';
import { EXCLUSION_STRIDE } from './cipher-wall-engine';
import { useCipherWall, readThemeColor, readThemeColors } from './use-cipher-wall';
import { useA11yStore } from '../accessibility/store';
import type { CipherWallOptions } from './use-cipher-wall';
import type { ThemeColors } from './cipher-wall-engine';

const TEST_MESSAGES_FOR_HOOK: readonly string[] = ['Test One', 'Test Two', 'Test Three'];

function TestCanvas(props: Readonly<Partial<CipherWallOptions>>): React.JSX.Element {
  const ref = useCipherWall({ messages: TEST_MESSAGES_FOR_HOOK, ...props });
  return (
    <div style={{ width: 800, height: 600 }}>
      <canvas ref={ref} data-testid="test-canvas" />
    </div>
  );
}

const DARK_THEME: ThemeColors = {
  background: '#0a0a0a',
  foreground: '#fafafa',
  brandRed: '#ec4755',
  foregroundMuted: '#888888',
};

let mutationCallbacks: MutationCallback[];
let mutationObserveArgs: { target: Node; options: MutationObserverInit }[];
let mutationDisconnected: boolean;

class MockMutationObserver {
  callback: MutationCallback;

  constructor(callback: MutationCallback) {
    this.callback = callback;
    mutationCallbacks.push(callback);
  }

  observe(target: Node, options: MutationObserverInit): void {
    mutationObserveArgs.push({ target, options });
  }

  disconnect(): void {
    mutationDisconnected = true;
    const index = mutationCallbacks.indexOf(this.callback);
    if (index !== -1) mutationCallbacks.splice(index, 1);
  }

  takeRecords(): MutationRecord[] {
    return [];
  }
}

const originalRAF = globalThis.requestAnimationFrame;
const originalCAF = globalThis.cancelAnimationFrame;
const originalGetComputedStyle = globalThis.getComputedStyle;

function setupRAF(): void {
  globalThis.requestAnimationFrame = vi.fn((_callback: FrameRequestCallback) => {
    return 42;
  });
  globalThis.cancelAnimationFrame = vi.fn();
}

interface DocumentTokens {
  '--brand-red': string;
  '--background': string;
  '--foreground': string;
  '--border': string;
  '--foreground-muted': string;
}

const DEFAULT_DOCUMENT_TOKENS: DocumentTokens = {
  '--brand-red': '#ec4755',
  '--background': '#1a1816',
  '--foreground': '#f2f1ef',
  '--border': '#3d3a36',
  '--foreground-muted': '#888888',
};

/**
 * What the stubbed cascade currently resolves. Reassignable, and read on every
 * `getPropertyValue` call, so a test can repaint the document mid-run — without
 * that, nothing can tell a re-read apart from a stale value.
 */
let documentTokens: DocumentTokens = DEFAULT_DOCUMENT_TOKENS;

function themeFromTokens(tokens: DocumentTokens): ThemeColors {
  return {
    background: tokens['--background'],
    foreground: tokens['--foreground'],
    brandRed: tokens['--brand-red'],
    foregroundMuted: tokens['--foreground-muted'],
  };
}

function setupGetComputedStyle(): void {
  documentTokens = DEFAULT_DOCUMENT_TOKENS;
  globalThis.getComputedStyle = vi.fn().mockReturnValue({
    getPropertyValue: vi.fn((property: string) => {
      const entry = Object.entries(documentTokens).find(([token]) => token === property);
      return entry?.[1] ?? '';
    }),
  });
}

const mockCtx = {
  clearRect: vi.fn(),
  beginPath: vi.fn(),
  closePath: vi.fn(),
  arc: vi.fn(),
  fill: vi.fn(),
  stroke: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  fillText: vi.fn(),
  measureText: vi.fn(() => ({ width: 50 })),
  createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
  save: vi.fn(),
  restore: vi.fn(),
  scale: vi.fn(),
  setTransform: vi.fn(),
  fillStyle: '',
  strokeStyle: '',
  lineWidth: 1,
  globalAlpha: 1,
  font: '',
  textAlign: 'start',
  textBaseline: 'alphabetic',
  shadowBlur: 0,
  shadowColor: '',
};

const originalGetContext = HTMLCanvasElement.prototype.getContext;
const originalAddEventListener = window.addEventListener;
const originalRemoveEventListener = window.removeEventListener;

describe('useCipherWall', () => {
  beforeEach(() => {
    mutationCallbacks = [];
    mutationObserveArgs = [];
    mutationDisconnected = false;

    vi.stubGlobal('MutationObserver', MockMutationObserver);
    setupRAF();
    setupGetComputedStyle();

    HTMLCanvasElement.prototype.getContext = vi.fn(() => mockCtx) as never;
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRAF;
    globalThis.cancelAnimationFrame = originalCAF;
    globalThis.getComputedStyle = originalGetComputedStyle;
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    vi.restoreAllMocks();
  });

  it('sets up MutationObserver on documentElement', () => {
    render(<TestCanvas />);

    const observed = mutationObserveArgs.find((a) => a.target === document.documentElement);
    expect(observed).toBeDefined();
    expect(observed!.options).toEqual(expect.objectContaining({ attributes: true }));
  });

  it('calls requestAnimationFrame on mount', () => {
    render(<TestCanvas />);
    expect(globalThis.requestAnimationFrame).toHaveBeenCalled();
  });

  it('calls cancelAnimationFrame on unmount', () => {
    const { unmount } = render(<TestCanvas />);
    unmount();
    expect(globalThis.cancelAnimationFrame).toHaveBeenCalled();
  });

  it('disconnects MutationObserver on unmount', () => {
    const { unmount } = render(<TestCanvas />);
    unmount();
    expect(mutationDisconnected).toBe(true);
  });
});

describe('useCipherWall reduced motion', () => {
  beforeEach(() => {
    mutationCallbacks = [];
    mutationObserveArgs = [];
    mutationDisconnected = false;

    vi.stubGlobal('MutationObserver', MockMutationObserver);
    setupRAF();
    setupGetComputedStyle();

    HTMLCanvasElement.prototype.getContext = vi.fn(() => mockCtx) as never;

    useA11yStore.getState().update({ stopAnimations: true });
  });

  afterEach(() => {
    useA11yStore.getState().update({ stopAnimations: false });
    globalThis.requestAnimationFrame = originalRAF;
    globalThis.cancelAnimationFrame = originalCAF;
    globalThis.getComputedStyle = originalGetComputedStyle;
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    vi.restoreAllMocks();
  });

  it('does not start the animation loop when motion is reduced', () => {
    render(<TestCanvas />);
    expect(globalThis.requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('renders a single static frame when motion is reduced', () => {
    const renderSpy = vi.spyOn(engine, 'renderFrame');
    render(<TestCanvas />);
    expect(renderSpy).toHaveBeenCalledTimes(1);
    renderSpy.mockRestore();
  });

  it('repaints in the new palette when the theme class mutates under reduced motion', () => {
    const repainted: DocumentTokens = {
      ...DEFAULT_DOCUMENT_TOKENS,
      '--background': '#101010',
      '--foreground': '#eeeeee',
      '--foreground-muted': '#777777',
    };
    const renderSpy = vi.spyOn(engine, 'renderFrame');
    render(<TestCanvas />);

    // The animation loop is paused, so no frame follows the mutation to carry
    // the palette: the observer's own repaint is the only thing that can.
    documentTokens = repainted;
    renderSpy.mockClear();
    act(() => {
      mutationCallbacks[0]?.([], {} as MutationObserver);
    });

    expect(globalThis.requestAnimationFrame).not.toHaveBeenCalled();
    expect(renderSpy.mock.calls.at(-1)?.[0].colors).toEqual(themeFromTokens(repainted));
    renderSpy.mockRestore();
  });
});

describe('useCipherWall frozen mode', () => {
  let addedListeners: { type: string; handler: EventListenerOrEventListenerObject }[];
  let removedListeners: { type: string; handler: EventListenerOrEventListenerObject }[];

  beforeEach(() => {
    mutationCallbacks = [];
    mutationObserveArgs = [];
    mutationDisconnected = false;
    addedListeners = [];
    removedListeners = [];

    vi.stubGlobal('MutationObserver', MockMutationObserver);
    setupRAF();
    setupGetComputedStyle();

    HTMLCanvasElement.prototype.getContext = vi.fn(() => mockCtx) as never;

    window.addEventListener = vi.fn((type: string, handler: EventListenerOrEventListenerObject) => {
      addedListeners.push({ type, handler });
    }) as never;
    window.removeEventListener = vi.fn(
      (type: string, handler: EventListenerOrEventListenerObject) => {
        removedListeners.push({ type, handler });
      }
    ) as never;
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRAF;
    globalThis.cancelAnimationFrame = originalCAF;
    globalThis.getComputedStyle = originalGetComputedStyle;
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    window.addEventListener = originalAddEventListener;
    window.removeEventListener = originalRemoveEventListener;
    vi.restoreAllMocks();
  });

  it('does not start rAF loop when frozen is true', () => {
    render(<TestCanvas frozen />);
    expect(globalThis.requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('adds window resize listener when frozen', () => {
    render(<TestCanvas frozen />);
    expect(addedListeners.some((l) => l.type === 'resize')).toBe(true);
  });

  it('removes window resize listener on unmount when frozen', () => {
    const { unmount } = render(<TestCanvas frozen />);
    unmount();
    expect(removedListeners.some((l) => l.type === 'resize')).toBe(true);
  });

  it('observes the document theme class when frozen', () => {
    render(<TestCanvas frozen />);
    const observed = mutationObserveArgs.find((a) => a.target === document.documentElement);
    expect(observed?.options).toEqual(expect.objectContaining({ attributeFilter: ['class'] }));
  });

  it('uses themeOverride when provided instead of reading CSS', () => {
    render(<TestCanvas frozen themeOverride={DARK_THEME} />);
    expect(globalThis.requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('accepts cipherOpacity option without error', () => {
    render(<TestCanvas frozen themeOverride={DARK_THEME} cipherOpacity={0.5} />);
    expect(globalThis.requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('forwards messageRowOffset and messageColOffset to the frozen snapshot', () => {
    const snapshotSpy = vi.spyOn(engine, 'createFrozenSnapshot');
    render(
      <TestCanvas frozen themeOverride={DARK_THEME} messageRowOffset={-2} messageColOffset={4} />
    );
    expect(snapshotSpy).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Number),
      TEST_MESSAGES_FOR_HOOK,
      {
        row: -2,
        col: 4,
      }
    );
  });
});

describe('useCipherWall exclusionZone', () => {
  beforeEach(() => {
    mutationCallbacks = [];
    mutationObserveArgs = [];
    mutationDisconnected = false;

    vi.stubGlobal('MutationObserver', MockMutationObserver);
    setupRAF();
    setupGetComputedStyle();

    HTMLCanvasElement.prototype.getContext = vi.fn(() => mockCtx) as never;
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRAF;
    globalThis.cancelAnimationFrame = originalCAF;
    globalThis.getComputedStyle = originalGetComputedStyle;
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    vi.restoreAllMocks();
  });

  it('accepts exclusionZone in options without error', () => {
    const zone = new Set([3 * EXCLUSION_STRIDE + 5, 3 * EXCLUSION_STRIDE + 6]);
    render(<TestCanvas themeOverride={DARK_THEME} exclusionZone={zone} />);
    expect(globalThis.requestAnimationFrame).toHaveBeenCalled();
  });

  it('accepts null exclusionZone in options without error', () => {
    render(<TestCanvas themeOverride={DARK_THEME} exclusionZone={null} />);
    expect(globalThis.requestAnimationFrame).toHaveBeenCalled();
  });

  it('paints the canvas held by an external canvasRef', () => {
    const getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');

    function TestExternalRef(): React.JSX.Element {
      const externalRef = React.useRef<HTMLCanvasElement | null>(null);
      useCipherWall({ messages: TEST_MESSAGES_FOR_HOOK, themeOverride: DARK_THEME }, externalRef);
      return (
        <div style={{ width: 800, height: 600 }}>
          <canvas ref={externalRef} data-testid="external-ref-canvas" />
        </div>
      );
    }

    const { getByTestId } = render(<TestExternalRef />);
    expect(getContextSpy.mock.contexts).toContain(getByTestId('external-ref-canvas'));
  });

  it('creates its own ref when external canvasRef is not provided', () => {
    let firstReturned: React.RefObject<HTMLCanvasElement | null> | undefined;
    let latestReturned: React.RefObject<HTMLCanvasElement | null> | undefined;

    function TestInternalRef(): React.JSX.Element {
      const canvasRef = useCipherWall({
        messages: TEST_MESSAGES_FOR_HOOK,
        themeOverride: DARK_THEME,
      });
      firstReturned ??= canvasRef;
      latestReturned = canvasRef;
      return (
        <div style={{ width: 800, height: 600 }}>
          <canvas ref={canvasRef} data-testid="internal-ref-canvas" />
        </div>
      );
    }

    const { rerender, getByTestId } = render(<TestInternalRef />);
    rerender(<TestInternalRef />);

    expect(latestReturned).toBe(firstReturned);
    expect(firstReturned?.current).toBe(getByTestId('internal-ref-canvas'));
  });

  it('syncs a changed exclusionZone onto the engine state', () => {
    const zone1 = new Set([3 * EXCLUSION_STRIDE + 5]);
    const zone2 = new Set([4 * EXCLUSION_STRIDE + 10, 4 * EXCLUSION_STRIDE + 11]);
    const seedSpy = vi.spyOn(engine, 'seedInitialReveals');

    function TestExclusionSync({
      zone,
    }: Readonly<{ zone: Set<number> | null }>): React.JSX.Element {
      const canvasRef = useCipherWall({
        messages: TEST_MESSAGES_FOR_HOOK,
        themeOverride: DARK_THEME,
        exclusionZone: zone,
      });
      return (
        <div style={{ width: 800, height: 600 }}>
          <canvas ref={canvasRef} data-testid="sync-canvas" />
        </div>
      );
    }

    const { rerender } = render(<TestExclusionSync zone={zone1} />);
    const state = seedSpy.mock.calls[0]?.[0];

    rerender(<TestExclusionSync zone={zone2} />);
    expect(state?.exclusionZone).toBe(zone2);

    rerender(<TestExclusionSync zone={null} />);
    expect(state?.exclusionZone).toBeNull();
  });

  it('sets exclusionZone on state before seedInitialReveals runs', () => {
    const zone = new Set([3 * EXCLUSION_STRIDE + 5, 3 * EXCLUSION_STRIDE + 6]);
    let capturedZone: Set<number> | null | undefined;

    const seedSpy = vi.spyOn(engine, 'seedInitialReveals').mockImplementation((state) => {
      capturedZone = state.exclusionZone;
    });

    render(<TestCanvas themeOverride={DARK_THEME} exclusionZone={zone} />);

    expect(seedSpy).toHaveBeenCalled();
    expect(capturedZone).toBe(zone);

    seedSpy.mockRestore();
  });

  it('calls pruneExcludedReveals when exclusionZone changes from null to a Set', () => {
    const pruneSpy = vi.spyOn(engine, 'pruneExcludedReveals');

    function TestExclusionPrune({
      zone,
    }: Readonly<{ zone: Set<number> | null }>): React.JSX.Element {
      const canvasRef = useCipherWall({
        messages: TEST_MESSAGES_FOR_HOOK,
        themeOverride: DARK_THEME,
        exclusionZone: zone,
      });
      return (
        <div style={{ width: 800, height: 600 }}>
          <canvas ref={canvasRef} data-testid="prune-canvas" />
        </div>
      );
    }

    const { rerender } = render(<TestExclusionPrune zone={null} />);

    const zone = new Set([3 * EXCLUSION_STRIDE + 5]);
    rerender(<TestExclusionPrune zone={zone} />);

    expect(pruneSpy).toHaveBeenCalled();

    pruneSpy.mockRestore();
  });
});

describe('useCipherWall animation, resize, and theme observation', () => {
  let rafCallbacks: FrameRequestCallback[];
  let widthValue: number;
  let heightValue: number;
  const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  const originalClientHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'clientHeight'
  );

  beforeEach(() => {
    mutationCallbacks = [];
    mutationObserveArgs = [];
    mutationDisconnected = false;
    useA11yStore.getState().update({ stopAnimations: false });
    vi.stubGlobal('MutationObserver', MockMutationObserver);
    setupGetComputedStyle();
    HTMLCanvasElement.prototype.getContext = vi.fn(() => mockCtx) as never;
    rafCallbacks = [];
    globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      rafCallbacks.push(callback);
      return rafCallbacks.length;
    }) as never;
    globalThis.cancelAnimationFrame = vi.fn();
    widthValue = 800;
    heightValue = 600;
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => widthValue,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => heightValue,
    });
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRAF;
    globalThis.cancelAnimationFrame = originalCAF;
    globalThis.getComputedStyle = originalGetComputedStyle;
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    if (originalClientWidth)
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
    if (originalClientHeight)
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight);
    useA11yStore.getState().update({ stopAnimations: false });
    vi.restoreAllMocks();
  });

  it('runs the animation tick and repaints each frame', () => {
    render(<TestCanvas themeOverride={DARK_THEME} />);
    expect(rafCallbacks.length).toBeGreaterThan(0);
    mockCtx.clearRect.mockClear();
    act(() => {
      rafCallbacks[0]?.(16);
    });
    // A first frame ran the tick, which updated state and repainted.
    expect(mockCtx.clearRect).toHaveBeenCalled();
    // A second frame at the same size skips the canvas resize but still paints.
    act(() => {
      rafCallbacks.at(-1)?.(32);
    });
  });

  it('resizes the grid when the viewport dimensions change between frames', () => {
    const resizeSpy = vi.spyOn(engine, 'resizeCells');
    render(<TestCanvas themeOverride={DARK_THEME} />);
    act(() => {
      rafCallbacks[0]?.(16);
    });
    widthValue = 400;
    heightValue = 300;
    act(() => {
      rafCallbacks.at(-1)?.(48);
    });
    expect(resizeSpy).toHaveBeenCalled();
    resizeSpy.mockRestore();
  });

  describe('while its box has no area', () => {
    let pendingFrames: Set<number>;
    let nextFrameId: number;
    let reportResize: (() => void) | undefined;

    beforeEach(() => {
      pendingFrames = new Set();
      nextFrameId = 0;
      reportResize = undefined;
      globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
        rafCallbacks.push(callback);
        nextFrameId += 1;
        pendingFrames.add(nextFrameId);
        return nextFrameId;
      }) as never;
      globalThis.cancelAnimationFrame = vi.fn((id: number) => {
        pendingFrames.delete(id);
      });
      class ReportingResizeObserver {
        constructor(callback: ResizeObserverCallback) {
          reportResize = (): void => {
            callback([], this as unknown as ResizeObserver);
          };
        }
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
      }
      vi.stubGlobal('ResizeObserver', ReportingResizeObserver);
    });

    it('schedules no animation frame when it mounts with zero width', () => {
      widthValue = 0;
      render(<TestCanvas themeOverride={DARK_THEME} />);
      expect(pendingFrames.size).toBe(0);
    });

    it('schedules no animation frame when it mounts with zero height', () => {
      heightValue = 0;
      render(<TestCanvas themeOverride={DARK_THEME} />);
      expect(pendingFrames.size).toBe(0);
    });

    it('stops scheduling animation frames once its box is observed at zero size', () => {
      render(<TestCanvas themeOverride={DARK_THEME} />);
      expect(pendingFrames.size).toBe(1);
      widthValue = 0;
      heightValue = 0;
      act(() => {
        reportResize?.();
      });
      expect(pendingFrames.size).toBe(0);
    });

    it('schedules animation frames again once its box is observed with a size', () => {
      widthValue = 0;
      heightValue = 0;
      render(<TestCanvas themeOverride={DARK_THEME} />);
      widthValue = 800;
      heightValue = 600;
      act(() => {
        reportResize?.();
      });
      expect(pendingFrames.size).toBe(1);
    });
  });

  it('keeps a scoped themeOverride when the document theme class mutates', () => {
    const renderSpy = vi.spyOn(engine, 'renderFrame');
    render(<TestCanvas themeOverride={DARK_THEME} />);
    act(() => {
      rafCallbacks[0]?.(16);
    });

    act(() => {
      mutationCallbacks[0]?.([], {} as MutationObserver);
    });
    renderSpy.mockClear();
    act(() => {
      rafCallbacks.at(-1)?.(32);
    });

    expect(renderSpy).toHaveBeenCalled();
    expect(renderSpy.mock.calls.at(-1)?.[0].colors).toEqual(DARK_THEME);
    renderSpy.mockRestore();
  });

  it('re-reads the document theme colors when the class mutates and no override is set', () => {
    const repainted: DocumentTokens = {
      ...DEFAULT_DOCUMENT_TOKENS,
      '--background': '#101010',
      '--foreground': '#eeeeee',
      '--foreground-muted': '#777777',
    };
    const renderSpy = vi.spyOn(engine, 'renderFrame');
    render(<TestCanvas />);
    act(() => {
      rafCallbacks[0]?.(16);
    });
    expect(renderSpy.mock.calls.at(-1)?.[0].colors).toEqual(
      themeFromTokens(DEFAULT_DOCUMENT_TOKENS)
    );

    // The theme toggle rewrites the tokens before the class change is observed.
    documentTokens = repainted;
    act(() => {
      mutationCallbacks[0]?.([], {} as MutationObserver);
    });
    renderSpy.mockClear();
    act(() => {
      rafCallbacks.at(-1)?.(32);
    });

    expect(renderSpy.mock.calls.at(-1)?.[0].colors).toEqual(themeFromTokens(repainted));
    renderSpy.mockRestore();
  });

  it('repaints a frozen wall in the new palette when the document theme class mutates', () => {
    const repainted: DocumentTokens = {
      ...DEFAULT_DOCUMENT_TOKENS,
      '--background': '#101010',
      '--foreground': '#eeeeee',
      '--foreground-muted': '#777777',
    };
    const renderSpy = vi.spyOn(engine, 'renderFrame');
    render(<TestCanvas frozen />);
    expect(renderSpy.mock.calls.at(-1)?.[0].colors).toEqual(
      themeFromTokens(DEFAULT_DOCUMENT_TOKENS)
    );

    // No frame ever runs on the frozen path, so the observer's own repaint is
    // the only thing that can carry the new palette onto the canvas.
    documentTokens = repainted;
    renderSpy.mockClear();
    act(() => {
      mutationCallbacks[0]?.([], {} as MutationObserver);
    });

    expect(renderSpy.mock.calls.at(-1)?.[0].colors).toEqual(themeFromTokens(repainted));
    renderSpy.mockRestore();
  });

  it('keeps a frozen wall on its scoped themeOverride when the document theme class mutates', () => {
    const renderSpy = vi.spyOn(engine, 'renderFrame');
    render(<TestCanvas frozen themeOverride={DARK_THEME} />);

    documentTokens = { ...DEFAULT_DOCUMENT_TOKENS, '--background': '#101010' };
    renderSpy.mockClear();
    act(() => {
      mutationCallbacks[0]?.([], {} as MutationObserver);
    });

    expect(renderSpy).toHaveBeenCalled();
    expect(renderSpy.mock.calls.at(-1)?.[0].colors).toEqual(DARK_THEME);
    renderSpy.mockRestore();
  });

  it('disconnects the theme observer when a frozen wall unmounts', () => {
    const { unmount } = render(<TestCanvas frozen themeOverride={DARK_THEME} />);
    unmount();
    expect(mutationDisconnected).toBe(true);
  });

  it('rebuilds the frozen snapshot when a resize changes the grid dimensions', () => {
    const snapshotSpy = vi.spyOn(engine, 'createFrozenSnapshot');
    render(<TestCanvas frozen themeOverride={DARK_THEME} />);
    const initialCalls = snapshotSpy.mock.calls.length;
    widthValue = 400;
    heightValue = 300;
    act(() => {
      globalThis.dispatchEvent(new Event('resize'));
    });
    expect(snapshotSpy.mock.calls.length).toBeGreaterThan(initialCalls);
    snapshotSpy.mockRestore();
  });

  it('only repaints on a frozen resize that leaves the grid dimensions unchanged', () => {
    const snapshotSpy = vi.spyOn(engine, 'createFrozenSnapshot');
    render(<TestCanvas frozen themeOverride={DARK_THEME} />);
    const initialCalls = snapshotSpy.mock.calls.length;
    // Same dimensions → no new snapshot, just a repaint.
    act(() => {
      globalThis.dispatchEvent(new Event('resize'));
    });
    expect(snapshotSpy.mock.calls.length).toBe(initialCalls);
    snapshotSpy.mockRestore();
  });

  it('bails out of the effect when the canvas has no 2d context', () => {
    HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;
    const renderSpy = vi.spyOn(engine, 'renderFrame');
    render(<TestCanvas themeOverride={DARK_THEME} />);
    // No context means the render pipeline never runs.
    expect(renderSpy).not.toHaveBeenCalled();
    renderSpy.mockRestore();
  });

  it('bails out of the effect when the canvas ref is never attached', () => {
    const nullRef = { current: null } as React.RefObject<HTMLCanvasElement | null>;
    function Probe(): null {
      useCipherWall({ messages: TEST_MESSAGES_FOR_HOOK, themeOverride: DARK_THEME }, nullRef);
      return null;
    }
    const renderSpy = vi.spyOn(engine, 'renderFrame');
    render(<Probe />);
    expect(renderSpy).not.toHaveBeenCalled();
    renderSpy.mockRestore();
  });

  it('tolerates a detached canvas with no parent element (animated)', () => {
    const detached = document.createElement('canvas');
    const detachedRef = { current: detached } as React.RefObject<HTMLCanvasElement | null>;
    function Probe(): null {
      useCipherWall({ messages: TEST_MESSAGES_FOR_HOOK, themeOverride: DARK_THEME }, detachedRef);
      return null;
    }
    render(<Probe />);
    // The tick runs with no parent — the parent-less branches must not throw.
    expect(() => {
      act(() => rafCallbacks[0]?.(16));
    }).not.toThrow();
  });

  it('tolerates a detached canvas with no parent element (frozen resize)', () => {
    const detached = document.createElement('canvas');
    const detachedRef = { current: detached } as React.RefObject<HTMLCanvasElement | null>;
    function Probe(): null {
      useCipherWall(
        { messages: TEST_MESSAGES_FOR_HOOK, frozen: true, themeOverride: DARK_THEME },
        detachedRef
      );
      return null;
    }
    render(<Probe />);
    expect(() => act(() => globalThis.dispatchEvent(new Event('resize')))).not.toThrow();
  });
});

describe('readThemeColors', () => {
  afterEach(() => {
    globalThis.getComputedStyle = originalGetComputedStyle;
    document.documentElement.classList.remove('dark');
    vi.restoreAllMocks();
  });

  it('returns CSS variable values when available', () => {
    globalThis.getComputedStyle = vi.fn().mockReturnValue({
      getPropertyValue: vi.fn((property: string) => {
        const values: Record<string, string> = {
          '--background': '#faf9f6',
          '--foreground': '#1a1a1a',
          '--brand-red': '#ec4755',
          '--foreground-muted': '#525252',
        };
        return values[property] ?? '';
      }),
    });

    const colors = readThemeColors();
    expect(colors.background).toBe('#faf9f6');
    expect(colors.foreground).toBe('#1a1a1a');
    expect(colors.brandRed).toBe('#ec4755');
    expect(colors.foregroundMuted).toBe('#525252');
  });

  it('resolves the tokens against a scope element rather than the document root', () => {
    const sheet = document.createElement('style');
    sheet.textContent = `
      :root { --background: #010101; --foreground: #020202;
              --brand-red: #030303; --foreground-muted: #040404; }
      .dark { --background: #050505; --foreground: #060606;
              --brand-red: #070707; --foreground-muted: #080808; }
    `;
    document.head.append(sheet);
    const scope = document.createElement('div');
    scope.className = 'dark';
    document.body.append(scope);

    const colors = readThemeColors(scope);

    expect(colors).toEqual({
      background: '#050505',
      foreground: '#060606',
      brandRed: '#070707',
      foregroundMuted: '#080808',
    });
    sheet.remove();
    scope.remove();
  });

  it('throws naming the token the stylesheet does not define, never a substitute value', () => {
    globalThis.getComputedStyle = vi.fn().mockReturnValue({
      getPropertyValue: vi.fn((property: string) => (property === '--brand-red' ? '' : '#111111')),
    });

    expect(() => readThemeColors()).toThrow('--brand-red');
  });

  it('throws when the scope resolves no tokens at all', () => {
    globalThis.getComputedStyle = vi.fn().mockReturnValue({
      getPropertyValue: vi.fn(() => ''),
    });

    expect(() => readThemeColors()).toThrow('--background');
  });
});

describe('readThemeColor', () => {
  afterEach(() => {
    globalThis.getComputedStyle = originalGetComputedStyle;
    vi.restoreAllMocks();
  });

  it('returns the one token it was asked for while the rest of the palette is undefined', () => {
    globalThis.getComputedStyle = vi.fn().mockReturnValue({
      getPropertyValue: vi.fn((property: string) => (property === '--brand-red' ? '#070707' : '')),
    });

    expect(readThemeColor('--brand-red')).toBe('#070707');
  });

  it('throws naming the requested token when that token is the missing one', () => {
    globalThis.getComputedStyle = vi.fn().mockReturnValue({
      getPropertyValue: vi.fn((property: string) => (property === '--brand-red' ? '' : '#111111')),
    });

    expect(() => readThemeColor('--brand-red')).toThrow('--brand-red');
  });

  it('resolves against a scope element rather than the document root', () => {
    const sheet = document.createElement('style');
    sheet.textContent = `
      :root { --background: #010101; }
      .dark { --background: #050505; }
    `;
    document.head.append(sheet);
    const scope = document.createElement('div');
    scope.className = 'dark';
    document.body.append(scope);

    expect(readThemeColor('--background', scope)).toBe('#050505');

    sheet.remove();
    scope.remove();
  });
});
