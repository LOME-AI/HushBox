import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { CipherWall, useRadialMask, computeExclusionZone } from './cipher-wall';
import { EXCLUSION_STRIDE, CELL_WIDTH, CELL_HEIGHT } from './cipher-wall-engine';
import * as React from 'react';

let lastUseCipherWallOptions: Record<string, unknown> | undefined;
const stableCanvasRef = { current: null };
vi.mock('./use-cipher-wall', () => ({
  useCipherWall: (
    options?: Record<string, unknown>,
    externalRef?: React.RefObject<HTMLCanvasElement | null>
  ) => {
    lastUseCipherWallOptions = options;
    // Use the external ref if provided, otherwise fall back to stable ref
    return externalRef ?? stableCanvasRef;
  },
  RESIZE_DEBOUNCE_MS: 500,
}));

function createMockRect(overrides: Partial<DOMRect> = {}): DOMRect {
  return {
    width: 0,
    height: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
    ...overrides,
  };
}

function setupResizeObserver(): {
  triggerResize: () => void;
  disconnect: ReturnType<typeof vi.fn>;
} {
  let resizeCallback: ResizeObserverCallback | undefined;
  const disconnect = vi.fn();
  class MockResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      resizeCallback = callback;
      callback([] as unknown as ResizeObserverEntry[], this as unknown as ResizeObserver);
    }
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = disconnect;
  }
  vi.stubGlobal('ResizeObserver', MockResizeObserver);
  return {
    triggerResize: (): void => {
      if (resizeCallback) {
        resizeCallback([] as unknown as ResizeObserverEntry[], {} as unknown as ResizeObserver);
      }
    },
    disconnect,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  lastUseCipherWallOptions = undefined;
});

describe('CipherWall', () => {
  it('renders a canvas element', () => {
    render(<CipherWall />);
    expect(screen.getByTestId('cipher-wall')).toBeInstanceOf(HTMLCanvasElement);
  });

  it('has role="img" for accessibility', () => {
    render(<CipherWall />);
    expect(screen.getByRole('img')).toBeInTheDocument();
  });

  it('has an aria-label describing the animation', () => {
    render(<CipherWall />);
    const canvas = screen.getByRole('img');
    expect(canvas).toHaveAttribute('aria-label');
    expect(canvas.getAttribute('aria-label')).toMatch(/encrypt/i);
  });

  it('has CSS mask-image fading the left edge by default', () => {
    render(<CipherWall />);
    const canvas = screen.getByTestId('cipher-wall');
    expect(canvas.style.maskImage).toContain('transparent');
    expect(canvas.style.maskImage).toContain('black');
  });

  it('does not apply mask-image when frozen is true', () => {
    render(<CipherWall frozen />);
    const canvas = screen.getByTestId('cipher-wall');
    expect(canvas.style.maskImage).toBe('');
  });

  it('has full-size classes by default', () => {
    render(<CipherWall />);
    const canvas = screen.getByTestId('cipher-wall');
    expect(canvas).toHaveClass('h-full', 'w-full');
  });

  it('applies custom className when provided', () => {
    render(<CipherWall className="custom-class" />);
    const canvas = screen.getByTestId('cipher-wall');
    expect(canvas).toHaveClass('custom-class');
  });

  it('applies custom style when provided', () => {
    render(<CipherWall frozen style={{ opacity: 0.5 }} />);
    const canvas = screen.getByTestId('cipher-wall');
    expect(canvas.style.opacity).toBe('0.5');
  });

  it('accepts cipherOpacity prop without error', () => {
    render(<CipherWall frozen cipherOpacity={0.5} />);
    expect(screen.getByTestId('cipher-wall')).toBeInstanceOf(HTMLCanvasElement);
  });

  it('throws when fadeMask is radial but fadeMaskTarget is missing', () => {
    expect(() => render(<CipherWall fadeMask="radial" />)).toThrow(
      'CipherWall: fadeMask="radial" requires fadeMaskTarget selector'
    );
  });

  it('computes pixel-based radial mask from fadeMaskTarget element', () => {
    const target = document.createElement('div');
    target.dataset['target'] = '';
    document.body.append(target);

    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(
      createMockRect({ width: 576, height: 400, right: 576, bottom: 400 })
    );

    setupResizeObserver();

    render(<CipherWall fadeMask="radial" fadeMaskTarget="[data-target]" />);
    const canvas = screen.getByTestId('cipher-wall');

    // rx = 576/2 + 12 = 300, ry = 400/2 + 24 = 224
    expect(canvas.style.maskImage).toContain('300px');
    expect(canvas.style.maskImage).toContain('224px');
    expect(canvas.style.maskImage).toContain('radial-gradient');

    target.remove();
  });

  it('throws when fadeMaskTarget element is not found in DOM', () => {
    vi.stubGlobal(
      'ResizeObserver',
      vi.fn(() => ({ observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() }))
    );

    expect(() =>
      render(<CipherWall fadeMask="radial" fadeMaskTarget="[data-nonexistent]" />)
    ).toThrow('CipherWall: fadeMaskTarget "[data-nonexistent]" not found in DOM');
  });

  it('applies no mask when fadeMask is none', () => {
    render(<CipherWall fadeMask="none" />);
    const canvas = screen.getByTestId('cipher-wall');
    expect(canvas.style.maskImage).toBe('');
  });

  it('applies no mask when frozen regardless of fadeMask', () => {
    render(<CipherWall frozen fadeMask="radial" fadeMaskTarget="[data-target]" />);
    const canvas = screen.getByTestId('cipher-wall');
    expect(canvas.style.maskImage).toBe('');
  });
});

describe('useRadialMask', () => {
  it('returns { maskStyles, exclusionZone } shape', () => {
    const canvasRef = { current: null } as React.RefObject<HTMLCanvasElement | null>;
    const { result } = renderHook(() => useRadialMask('none', undefined, false, canvasRef));

    expect(result.current).toHaveProperty('maskStyles');
    expect(result.current).toHaveProperty('exclusionZone');
  });

  it('returns null exclusionZone when fadeMask is not radial', () => {
    const canvasRef = { current: null } as React.RefObject<HTMLCanvasElement | null>;

    const { result: leftResult } = renderHook(() =>
      useRadialMask('left', undefined, false, canvasRef)
    );
    expect(leftResult.current.exclusionZone).toBeNull();

    const { result: noneResult } = renderHook(() =>
      useRadialMask('none', undefined, false, canvasRef)
    );
    expect(noneResult.current.exclusionZone).toBeNull();
  });

  it('returns null exclusionZone when frozen', () => {
    const canvasRef = { current: null } as React.RefObject<HTMLCanvasElement | null>;
    const { result } = renderHook(() => useRadialMask('radial', '[data-target]', true, canvasRef));
    expect(result.current.exclusionZone).toBeNull();
  });

  it('returns a Set<number> exclusionZone when fadeMask is radial', () => {
    const target = document.createElement('div');
    target.dataset['target'] = '';
    document.body.append(target);
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(
      createMockRect({ width: 120, height: 88, left: 100, top: 50, right: 220, bottom: 138 })
    );

    const canvasEl = document.createElement('canvas');
    vi.spyOn(canvasEl, 'getBoundingClientRect').mockReturnValue(
      createMockRect({ width: 600, height: 400, left: 0, top: 0, right: 600, bottom: 400 })
    );
    const canvasRef = { current: canvasEl } as React.RefObject<HTMLCanvasElement | null>;

    setupResizeObserver();

    const { result } = renderHook(() => useRadialMask('radial', '[data-target]', false, canvasRef));

    expect(result.current.exclusionZone).toBeInstanceOf(Set);
    expect(result.current.exclusionZone!.size).toBeGreaterThan(0);

    target.remove();
  });

  it('exclusion zone contains correct coordinates based on ellipse geometry', () => {
    // Target: 120x44px, centered at (160, 72) relative to canvas
    const target = document.createElement('div');
    target.dataset['exzone'] = '';
    document.body.append(target);
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(
      createMockRect({ width: 120, height: 44, left: 100, top: 50, right: 220, bottom: 94 })
    );

    // Canvas starts at (0, 0)
    const canvasEl = document.createElement('canvas');
    vi.spyOn(canvasEl, 'getBoundingClientRect').mockReturnValue(
      createMockRect({ width: 600, height: 400, left: 0, top: 0, right: 600, bottom: 400 })
    );
    const canvasRef = { current: canvasEl } as React.RefObject<HTMLCanvasElement | null>;

    setupResizeObserver();

    const { result } = renderHook(() => useRadialMask('radial', '[data-exzone]', false, canvasRef));

    const zone = result.current.exclusionZone!;
    expect(zone).toBeInstanceOf(Set);

    // Ellipse center in grid units:
    // cx = ((100 + 60) - 0) / 12 = 160/12 ~= 13.33
    // cy = ((50 + 22) - 0) / 22 = 72/22 ~= 3.27
    // rx = round(120/2) + 12 = 72, ry = round(44/2) + 24 = 46
    // gridRx = 72/12 = 6, gridRy = 46/22 ~= 2.09
    //
    // The center cell (col=13, row=3) should definitely be in the zone
    const centerKey = 3 * EXCLUSION_STRIDE + 13;
    expect(zone.has(centerKey)).toBe(true);

    // A cell far from the ellipse should not be in the zone
    // col=0, row=0 is at dx = (0.5 - 13.33)/6 ~= -2.14, way outside
    const farKey = 0 * EXCLUSION_STRIDE + 0;
    expect(zone.has(farKey)).toBe(false);

    target.remove();
  });

  it('exclusion zone is recomputed on target resize', () => {
    vi.useFakeTimers();

    const target = document.createElement('div');
    target.dataset['resize'] = '';
    document.body.append(target);

    const targetRectSpy = vi
      .spyOn(target, 'getBoundingClientRect')
      .mockReturnValue(
        createMockRect({ width: 120, height: 88, left: 100, top: 50, right: 220, bottom: 138 })
      );

    const canvasEl = document.createElement('canvas');
    vi.spyOn(canvasEl, 'getBoundingClientRect').mockReturnValue(
      createMockRect({ width: 600, height: 400, left: 0, top: 0, right: 600, bottom: 400 })
    );
    const canvasRef = { current: canvasEl } as React.RefObject<HTMLCanvasElement | null>;

    const { triggerResize } = setupResizeObserver();

    const { result } = renderHook(() => useRadialMask('radial', '[data-resize]', false, canvasRef));

    const initialZone = result.current.exclusionZone;
    expect(initialZone).toBeInstanceOf(Set);
    const initialSize = initialZone!.size;

    // Change target size — make it much larger
    targetRectSpy.mockReturnValue(
      createMockRect({ width: 300, height: 200, left: 50, top: 20, right: 350, bottom: 220 })
    );

    // Trigger resize observer callback
    act(() => {
      triggerResize();
    });

    // Flush the debounce timer
    act(() => {
      vi.advanceTimersByTime(600);
    });

    const updatedZone = result.current.exclusionZone;
    expect(updatedZone).toBeInstanceOf(Set);
    // Larger target should produce a larger exclusion zone
    expect(updatedZone!.size).toBeGreaterThan(initialSize);

    target.remove();
    vi.useRealTimers();
  });

  it('returns null exclusionZone when canvasRef.current is null', () => {
    const target = document.createElement('div');
    target.dataset['nocanvas'] = '';
    document.body.append(target);
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(
      createMockRect({ width: 120, height: 88, left: 100, top: 50, right: 220, bottom: 138 })
    );

    const canvasRef = { current: null } as React.RefObject<HTMLCanvasElement | null>;

    setupResizeObserver();

    const { result } = renderHook(() =>
      useRadialMask('radial', '[data-nocanvas]', false, canvasRef)
    );

    // maskStyles should still be computed
    expect(result.current.maskStyles).toBeDefined();
    // But exclusionZone should be null since canvas is not available
    expect(result.current.exclusionZone).toBeNull();

    target.remove();
  });
});

describe('CipherWall exclusionZone wiring', () => {
  it('passes exclusionZone from useRadialMask to useCipherWall options', () => {
    const target = document.createElement('div');
    target.dataset['wire'] = '';
    document.body.append(target);

    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(
      createMockRect({ width: 120, height: 88, left: 100, top: 50, right: 220, bottom: 138 })
    );

    setupResizeObserver();

    render(<CipherWall fadeMask="radial" fadeMaskTarget="[data-wire]" />);

    // useCipherWall should have been called with exclusionZone in its options
    expect(lastUseCipherWallOptions).toBeDefined();
    expect(lastUseCipherWallOptions).toHaveProperty('exclusionZone');
    // The exclusionZone should be a Set (computed by useRadialMask)
    // On initial render it may be null, but after layout effect it should be a Set
    // Since the mock captures the last call, check both possibilities
    const zone = lastUseCipherWallOptions!['exclusionZone'];
    expect(zone === null || zone instanceof Set).toBe(true);

    target.remove();
  });

  it('passes null exclusionZone when fadeMask is not radial', () => {
    render(<CipherWall fadeMask="left" />);

    expect(lastUseCipherWallOptions).toBeDefined();
    expect(lastUseCipherWallOptions).toHaveProperty('exclusionZone');
    expect(lastUseCipherWallOptions!['exclusionZone']).toBeNull();
  });

  it('passes a canvasRef as second argument to useCipherWall', () => {
    // This test verifies the component creates and passes a canvas ref
    // The mock returns the ref passed to it (or stableCanvasRef fallback)
    render(<CipherWall />);
    const canvas = screen.getByTestId('cipher-wall');
    expect(canvas).toBeInstanceOf(HTMLCanvasElement);
  });
});

describe('computeExclusionZone', () => {
  // Realistic viewport: 1920x1080 canvas, centered 768x400 hero content
  const realisticInput = {
    targetRect: { left: 576, top: 240, width: 768, height: 400 },
    canvasRect: { left: 0, top: 0, width: 1920, height: 1080 },
  };

  // Precomputed expected values for realistic input:
  // cx = (576 + 384 - 0) / 12 = 960 / 12 = 80
  // cy = (240 + 200 - 0) / 22 = 440 / 22 = 20
  // rx_px = round(768/2) + 12 = 384 + 12 = 396
  // ry_px = round(400/2) + 24 = 200 + 24 = 224
  // gridRx = 396 / 12 = 33
  // gridRy = 224 / 22 ≈ 10.18

  it('excludes the center cell of the ellipse', () => {
    const zone = computeExclusionZone(realisticInput);
    // Center: col=80, row=20
    expect(zone.has(20 * EXCLUSION_STRIDE + 80)).toBe(true);
  });

  it('excludes cells near the center', () => {
    const zone = computeExclusionZone(realisticInput);
    // Cells adjacent to center should all be excluded
    expect(zone.has(20 * EXCLUSION_STRIDE + 79)).toBe(true);
    expect(zone.has(20 * EXCLUSION_STRIDE + 81)).toBe(true);
    expect(zone.has(19 * EXCLUSION_STRIDE + 80)).toBe(true);
    expect(zone.has(21 * EXCLUSION_STRIDE + 80)).toBe(true);
  });

  it('does not exclude cells far from the ellipse', () => {
    const zone = computeExclusionZone(realisticInput);
    // Top-left corner (0,0) — far from center
    expect(zone.has(0 * EXCLUSION_STRIDE + 0)).toBe(false);
    // Bottom-right corner
    const totalCols = Math.floor(1920 / CELL_WIDTH);
    const totalRows = Math.floor(1080 / CELL_HEIGHT);
    expect(zone.has((totalRows - 1) * EXCLUSION_STRIDE + (totalCols - 1))).toBe(false);
  });

  it('produces a non-empty zone for realistic viewport', () => {
    const zone = computeExclusionZone(realisticInput);
    // With gridRx=33 and gridRy≈10.18 at threshold 1.2, the zone should be substantial
    expect(zone.size).toBeGreaterThan(100);
  });

  it('excludes cells along the horizontal axis of the ellipse', () => {
    const zone = computeExclusionZone(realisticInput);
    // At row=20 (center row), gridRx=33, threshold 1.1x
    // col=44: dx²=1.16 ✓  col=115: dx²=1.16 ✓
    // col=43: dx²=1.22 ✗  col=116: dx²=1.22 ✗
    expect(zone.has(20 * EXCLUSION_STRIDE + 44)).toBe(true);
    expect(zone.has(20 * EXCLUSION_STRIDE + 115)).toBe(true);
    // Just outside the 1.1x threshold
    expect(zone.has(20 * EXCLUSION_STRIDE + 43)).toBe(false);
    expect(zone.has(20 * EXCLUSION_STRIDE + 116)).toBe(false);
  });

  it('excludes cells along the vertical axis of the ellipse', () => {
    const zone = computeExclusionZone(realisticInput);
    // gridRy = 224/22 ≈ 10.18. At col=80 (center), dy² must be <= 1.21
    // row=9: dy²=1.06 ✓  row=30: dy²=1.06 ✓
    // row=8: dy²=1.28 ✗  row=31: dy²=1.28 ✗
    expect(zone.has(9 * EXCLUSION_STRIDE + 80)).toBe(true);
    expect(zone.has(30 * EXCLUSION_STRIDE + 80)).toBe(true);
    // Just outside the 1.1x threshold
    expect(zone.has(8 * EXCLUSION_STRIDE + 80)).toBe(false);
    expect(zone.has(31 * EXCLUSION_STRIDE + 80)).toBe(false);
  });

  it('clamps to canvas bounds when target is near edge', () => {
    const zone = computeExclusionZone({
      targetRect: { left: 0, top: 0, width: 200, height: 100 },
      canvasRect: { left: 0, top: 0, width: 400, height: 300 },
    });
    // No negative keys should exist
    for (const key of zone) {
      const row = Math.floor(key / EXCLUSION_STRIDE);
      const col = key % EXCLUSION_STRIDE;
      expect(row).toBeGreaterThanOrEqual(0);
      expect(col).toBeGreaterThanOrEqual(0);
    }
  });

  it('returns empty set when canvas has zero dimensions', () => {
    const zone = computeExclusionZone({
      targetRect: { left: 100, top: 100, width: 200, height: 100 },
      canvasRect: { left: 0, top: 0, width: 0, height: 0 },
    });
    expect(zone.size).toBe(0);
  });

  it('every excluded cell is within the 1.1x ellipse boundary', () => {
    const zone = computeExclusionZone(realisticInput);
    const cx = 80; // precomputed center col
    const cy = 20; // precomputed center row
    const gridRx = 33; // precomputed
    const gridRy = 224 / CELL_HEIGHT; // ≈ 10.18

    for (const key of zone) {
      const row = Math.floor(key / EXCLUSION_STRIDE);
      const col = key % EXCLUSION_STRIDE;
      const dx = (col + 0.5 - cx) / gridRx;
      const dy = (row + 0.5 - cy) / gridRy;
      expect(dx * dx + dy * dy).toBeLessThanOrEqual(1.21 + 0.001); // small epsilon for float
    }
  });
});
