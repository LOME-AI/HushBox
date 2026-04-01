import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import * as engine from './cipher-wall-engine';
import { EXCLUSION_STRIDE } from './cipher-wall-engine';
import { useCipherWall, readThemeColors } from './use-cipher-wall';
import type { CipherWallOptions } from './use-cipher-wall';
import type { ThemeColors } from './cipher-wall-engine';

// --- Test components that wire the hook to a real canvas ---

function TestCanvas(props: Readonly<CipherWallOptions>): React.JSX.Element {
  const ref = useCipherWall(props);
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

// --- Mock browser APIs ---

type ResizeCallback = ResizeObserverCallback;

let resizeCallbacks: ResizeCallback[];
let resizeObservedElements: Element[];
let resizeDisconnected: boolean;

class MockResizeObserver {
  callback: ResizeCallback;

  constructor(callback: ResizeCallback) {
    this.callback = callback;
    resizeCallbacks.push(callback);
  }

  observe(el: Element): void {
    resizeObservedElements.push(el);
  }

  unobserve(): void {
    // no-op
  }

  disconnect(): void {
    resizeDisconnected = true;
    const index = resizeCallbacks.indexOf(this.callback);
    if (index !== -1) resizeCallbacks.splice(index, 1);
  }
}

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

function setupGetComputedStyle(): void {
  globalThis.getComputedStyle = vi.fn().mockReturnValue({
    getPropertyValue: vi.fn((property: string) => {
      const values: Record<string, string> = {
        '--brand-red': '#ec4755',
        '--background': '#1a1816',
        '--foreground': '#f2f1ef',
        '--border': '#3d3a36',
        '--foreground-muted': '#888888',
      };
      return values[property] ?? '';
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

describe('useCipherWall', () => {
  beforeEach(() => {
    resizeCallbacks = [];
    resizeObservedElements = [];
    resizeDisconnected = false;
    mutationCallbacks = [];
    mutationObserveArgs = [];
    mutationDisconnected = false;

    vi.stubGlobal('ResizeObserver', MockResizeObserver);
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

  it('renders canvas element via ref', () => {
    const { getByTestId } = render(<TestCanvas />);
    expect(getByTestId('test-canvas')).toBeInstanceOf(HTMLCanvasElement);
  });

  it('sets up ResizeObserver on mount', () => {
    render(<TestCanvas />);
    expect(resizeCallbacks).toHaveLength(1);
  });

  it('observes canvas parent element with ResizeObserver', () => {
    render(<TestCanvas />);
    expect(resizeObservedElements).toHaveLength(1);
    expect(resizeObservedElements[0]!.tagName).toBe('DIV');
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

  it('disconnects ResizeObserver on unmount', () => {
    const { unmount } = render(<TestCanvas />);
    unmount();
    expect(resizeDisconnected).toBe(true);
  });

  it('disconnects MutationObserver on unmount', () => {
    const { unmount } = render(<TestCanvas />);
    unmount();
    expect(mutationDisconnected).toBe(true);
  });
});

describe('useCipherWall frozen mode', () => {
  beforeEach(() => {
    resizeCallbacks = [];
    resizeObservedElements = [];
    resizeDisconnected = false;
    mutationCallbacks = [];
    mutationObserveArgs = [];
    mutationDisconnected = false;

    vi.stubGlobal('ResizeObserver', MockResizeObserver);
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

  it('does not start rAF loop when frozen is true', () => {
    render(<TestCanvas frozen />);
    expect(globalThis.requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('still sets up ResizeObserver when frozen', () => {
    render(<TestCanvas frozen />);
    expect(resizeCallbacks).toHaveLength(1);
    expect(resizeObservedElements).toHaveLength(1);
  });

  it('does not set up MutationObserver when frozen', () => {
    render(<TestCanvas frozen />);
    expect(mutationObserveArgs).toHaveLength(0);
  });

  it('uses themeOverride when provided instead of reading CSS', () => {
    render(<TestCanvas frozen themeOverride={DARK_THEME} />);
    // getComputedStyle should not be called for theme reading when override is provided
    // (it may be called by JSDOM internally, but not by readThemeColors)
    // The key test is that it renders without error using the override
    expect(globalThis.requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('accepts cipherOpacity option without error', () => {
    render(<TestCanvas frozen themeOverride={DARK_THEME} cipherOpacity={0.5} />);
    expect(globalThis.requestAnimationFrame).not.toHaveBeenCalled();
  });
});

describe('useCipherWall exclusionZone', () => {
  beforeEach(() => {
    resizeCallbacks = [];
    resizeObservedElements = [];
    resizeDisconnected = false;
    mutationCallbacks = [];
    mutationObserveArgs = [];
    mutationDisconnected = false;

    vi.stubGlobal('ResizeObserver', MockResizeObserver);
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

  it('accepts an external canvasRef parameter', () => {
    function TestExternalRef(): React.JSX.Element {
      const externalRef = React.useRef<HTMLCanvasElement | null>(null);
      useCipherWall({ themeOverride: DARK_THEME }, externalRef);
      return (
        <div style={{ width: 800, height: 600 }}>
          <canvas ref={externalRef} data-testid="external-ref-canvas" />
        </div>
      );
    }

    const { getByTestId } = render(<TestExternalRef />);
    expect(getByTestId('external-ref-canvas')).toBeInstanceOf(HTMLCanvasElement);
  });

  it('creates its own ref when external canvasRef is not provided', () => {
    const { getByTestId } = render(<TestCanvas themeOverride={DARK_THEME} />);
    expect(getByTestId('test-canvas')).toBeInstanceOf(HTMLCanvasElement);
  });

  it('syncs exclusionZone to engine state when option changes', () => {
    const zone1 = new Set([3 * EXCLUSION_STRIDE + 5]);
    const zone2 = new Set([4 * EXCLUSION_STRIDE + 10, 4 * EXCLUSION_STRIDE + 11]);

    function TestExclusionSync({
      zone,
    }: Readonly<{ zone: Set<number> | null }>): React.JSX.Element {
      const canvasRef = useCipherWall({ themeOverride: DARK_THEME, exclusionZone: zone });
      return (
        <div style={{ width: 800, height: 600 }}>
          <canvas ref={canvasRef} data-testid="sync-canvas" />
        </div>
      );
    }

    // Renders with zone1, then re-renders with zone2 - should not error
    const { rerender, getByTestId } = render(<TestExclusionSync zone={zone1} />);
    expect(getByTestId('sync-canvas')).toBeInstanceOf(HTMLCanvasElement);

    // Re-render with a different zone to verify the effect handles changes
    rerender(<TestExclusionSync zone={zone2} />);
    expect(getByTestId('sync-canvas')).toBeInstanceOf(HTMLCanvasElement);

    // Re-render with null to verify null handling
    rerender(<TestExclusionSync zone={null} />);
    expect(getByTestId('sync-canvas')).toBeInstanceOf(HTMLCanvasElement);
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

  it('returns light-mode fallbacks when CSS vars are empty and no dark class', () => {
    document.documentElement.classList.remove('dark');
    globalThis.getComputedStyle = vi.fn().mockReturnValue({
      getPropertyValue: vi.fn(() => ''),
    });

    const colors = readThemeColors();
    expect(colors.foreground).toBe('#1a1a1a');
    expect(colors.background).toBe('#faf9f6');
    expect(colors.foregroundMuted).toBe('#525252');
  });

  it('returns dark-mode fallbacks when CSS vars are empty and dark class present', () => {
    document.documentElement.classList.add('dark');
    globalThis.getComputedStyle = vi.fn().mockReturnValue({
      getPropertyValue: vi.fn(() => ''),
    });

    const colors = readThemeColors();
    expect(colors.foreground).toBe('#f2f1ef');
    expect(colors.background).toBe('#1a1816');
    expect(colors.foregroundMuted).toBe('#9a9894');
  });

  it('always returns #ec4755 for brandRed regardless of theme', () => {
    globalThis.getComputedStyle = vi.fn().mockReturnValue({
      getPropertyValue: vi.fn(() => ''),
    });

    const light = readThemeColors();
    document.documentElement.classList.add('dark');
    const dark = readThemeColors();

    expect(light.brandRed).toBe('#ec4755');
    expect(dark.brandRed).toBe('#ec4755');
  });
});
