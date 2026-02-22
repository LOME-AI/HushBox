import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { useCipherWall, readThemeColors } from './use-cipher-wall';

// --- Test component that wires the hook to a real canvas ---

function TestCanvas(): React.JSX.Element {
  const canvasRef = useCipherWall();
  return (
    <div style={{ width: 800, height: 600 }}>
      <canvas ref={canvasRef} data-testid="test-canvas" />
    </div>
  );
}

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

const originalMatchMedia = globalThis.matchMedia;
const originalRAF = globalThis.requestAnimationFrame;
const originalCAF = globalThis.cancelAnimationFrame;
const originalGetComputedStyle = globalThis.getComputedStyle;

function setupMatchMedia(matches: boolean): void {
  Object.defineProperty(globalThis, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

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
    setupMatchMedia(false);
    setupRAF();
    setupGetComputedStyle();

    HTMLCanvasElement.prototype.getContext = vi.fn(() => mockCtx) as never;
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'matchMedia', {
      writable: true,
      value: originalMatchMedia,
    });
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

  it('checks prefers-reduced-motion media query', () => {
    render(<TestCanvas />);
    expect(globalThis.matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
  });

  it('calls requestAnimationFrame on mount when motion is allowed', () => {
    setupMatchMedia(false);
    render(<TestCanvas />);
    expect(globalThis.requestAnimationFrame).toHaveBeenCalled();
  });

  it('does not start rAF loop when reduced-motion matches', () => {
    setupMatchMedia(true);
    render(<TestCanvas />);
    expect(globalThis.requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('calls cancelAnimationFrame on unmount', () => {
    setupMatchMedia(false);
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
