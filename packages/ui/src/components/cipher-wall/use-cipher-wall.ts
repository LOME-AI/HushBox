import * as React from 'react';
import {
  createGrid,
  seedInitialReveals,
  createStaticSnapshot,
  createFrozenSnapshot,
  updateState,
  renderFrame,
  CELL_WIDTH,
  CELL_HEIGHT,
} from './cipher-wall-engine';
import type { CipherWallState, ThemeColors } from './cipher-wall-engine';

const DPR_CAP = 2;
export const RESIZE_DEBOUNCE_MS = 500;

export interface CipherWallOptions {
  frozen?: boolean;
  frozenMessageCount?: number;
  themeOverride?: ThemeColors;
  cipherOpacity?: number;
}

export function readThemeColors(): ThemeColors {
  const style = getComputedStyle(document.documentElement);
  const read = (property: string): string => style.getPropertyValue(property).trim();
  const isDark = document.documentElement.classList.contains('dark');

  return {
    background: read('--background') || (isDark ? '#1a1816' : '#faf9f6'),
    foreground: read('--foreground') || (isDark ? '#f2f1ef' : '#1a1a1a'),
    brandRed: read('--brand-red') || '#ec4755',
    foregroundMuted: read('--foreground-muted') || (isDark ? '#9a9894' : '#525252'),
  };
}

export function useCipherWall(
  options?: CipherWallOptions
): React.RefObject<HTMLCanvasElement | null> {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const stateRef = React.useRef<CipherWallState | null>(null);
  const colorsRef = React.useRef<ThemeColors | null>(null);
  const rafIdRef = React.useRef<number>(0);
  const logoMaskRef = React.useRef<boolean[][] | null>(null);

  const frozen = options?.frozen === true;
  const frozenMessageCount = options?.frozenMessageCount ?? 4;
  const themeOverride = options?.themeOverride;
  const cipherOpacity = options?.cipherOpacity ?? 1;

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const parent = canvas.parentElement;

    colorsRef.current = themeOverride ?? readThemeColors();

    // --- Reduced motion check ---
    const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
    const useStaticRender = frozen || motionQuery.matches;

    // --- Sizing ---
    const dpr = Math.min(devicePixelRatio, DPR_CAP);

    function computeGridSize(w: number, h: number): { cols: number; rows: number } {
      return {
        cols: Math.floor(w / CELL_WIDTH),
        rows: Math.floor(h / CELL_HEIGHT),
      };
    }

    function resize(): void {
      if (!canvas || !parent || !ctx) return;
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.scale(dpr, dpr);

      const { cols, rows } = computeGridSize(w, h);
      if (stateRef.current?.cols === cols && stateRef.current.rows === rows) return;

      if (frozen) {
        stateRef.current = createFrozenSnapshot(cols, rows, frozenMessageCount);
      } else if (useStaticRender) {
        stateRef.current = createStaticSnapshot(cols, rows);
      } else {
        const state = createGrid(cols, rows);
        seedInitialReveals(state);
        stateRef.current = state;
      }
    }

    function tryRender(): void {
      if (!ctx || !parent || !stateRef.current || !colorsRef.current) return;
      renderFrame({
        ctx,
        state: stateRef.current,
        colors: colorsRef.current,
        width: parent.clientWidth,
        height: parent.clientHeight,
        logoMask: logoMaskRef.current,
        cipherOpacity,
      });
    }

    resize();

    let resizeTimer: ReturnType<typeof setTimeout> | undefined;

    // --- Static render for frozen or reduced motion ---
    if (useStaticRender) {
      tryRender();

      const resizeObserver = new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          resize();
          tryRender();
        }, RESIZE_DEBOUNCE_MS);
      });
      if (parent) resizeObserver.observe(parent);

      // MutationObserver only needed for theme changes — skip when frozen
      // (frozen mode uses themeOverride, not CSS variables)
      if (!frozen) {
        const mutationObserver = new MutationObserver(() => {
          colorsRef.current = readThemeColors();
          tryRender();
        });
        mutationObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['class'],
        });

        return () => {
          clearTimeout(resizeTimer);
          resizeObserver.disconnect();
          mutationObserver.disconnect();
        };
      }

      return () => {
        clearTimeout(resizeTimer);
        resizeObserver.disconnect();
      };
    }

    // --- Animation loop ---
    let lastTime = 0;

    function animate(time: number): void {
      rafIdRef.current = requestAnimationFrame(animate);

      const delta = lastTime === 0 ? 0.016 : (time - lastTime) / 1000;
      lastTime = time;

      if (stateRef.current) {
        updateState(stateRef.current, Math.min(delta, 0.1));
      }
      tryRender();
    }

    rafIdRef.current = requestAnimationFrame(animate);

    // --- Observers ---
    const resizeObserver = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resize, RESIZE_DEBOUNCE_MS);
    });
    if (parent) resizeObserver.observe(parent);

    const mutationObserver = new MutationObserver(() => {
      colorsRef.current = readThemeColors();
    });
    mutationObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    return () => {
      clearTimeout(resizeTimer);
      cancelAnimationFrame(rafIdRef.current);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [frozen, frozenMessageCount, themeOverride, cipherOpacity]);

  return canvasRef;
}
