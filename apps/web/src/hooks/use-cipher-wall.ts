import * as React from 'react';
import {
  createGrid,
  seedInitialReveals,
  createStaticSnapshot,
  updateState,
  renderFrame,
  CELL_WIDTH,
  CELL_HEIGHT,
} from '@/components/auth/cipher-wall-engine';
import type { CipherWallState, ThemeColors } from '@/components/auth/cipher-wall-engine';

const DPR_CAP = 2;

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

export function useCipherWall(): React.RefObject<HTMLCanvasElement | null> {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const stateRef = React.useRef<CipherWallState | null>(null);
  const colorsRef = React.useRef<ThemeColors | null>(null);
  const rafIdRef = React.useRef<number>(0);
  const logoMaskRef = React.useRef<boolean[][] | null>(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const parent = canvas.parentElement;

    colorsRef.current = readThemeColors();

    // --- Reduced motion check ---
    const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
    const prefersReducedMotion = motionQuery.matches;

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
      canvas.style.width = `${String(w)}px`;
      canvas.style.height = `${String(h)}px`;
      ctx.scale(dpr, dpr);

      const { cols, rows } = computeGridSize(w, h);
      if (prefersReducedMotion) {
        stateRef.current = createStaticSnapshot(cols, rows);
      } else {
        const state = createGrid(cols, rows);
        seedInitialReveals(state);
        stateRef.current = state;
      }
    }

    resize();

    // --- Static render for reduced motion ---
    if (prefersReducedMotion) {
      if (stateRef.current && parent) {
        renderFrame({
          ctx,
          state: stateRef.current,
          colors: colorsRef.current,
          width: parent.clientWidth,
          height: parent.clientHeight,
          logoMask: logoMaskRef.current,
        });
      }

      const resizeObserver = new ResizeObserver(() => {
        resize();
        if (stateRef.current && parent && colorsRef.current) {
          renderFrame({
            ctx,
            state: stateRef.current,
            colors: colorsRef.current,
            width: parent.clientWidth,
            height: parent.clientHeight,
            logoMask: logoMaskRef.current,
          });
        }
      });
      if (parent) resizeObserver.observe(parent);

      const mutationObserver = new MutationObserver(() => {
        colorsRef.current = readThemeColors();
        if (stateRef.current && parent) {
          renderFrame({
            ctx,
            state: stateRef.current,
            colors: colorsRef.current,
            width: parent.clientWidth,
            height: parent.clientHeight,
            logoMask: logoMaskRef.current,
          });
        }
      });
      mutationObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class'],
      });

      return () => {
        resizeObserver.disconnect();
        mutationObserver.disconnect();
      };
    }

    // --- Animation loop ---
    let lastTime = 0;

    function animate(time: number): void {
      rafIdRef.current = requestAnimationFrame(animate);

      const delta = lastTime === 0 ? 0.016 : (time - lastTime) / 1000;
      lastTime = time;

      if (stateRef.current && parent && colorsRef.current && ctx) {
        updateState(stateRef.current, Math.min(delta, 0.1));
        renderFrame({
          ctx,
          state: stateRef.current,
          colors: colorsRef.current,
          width: parent.clientWidth,
          height: parent.clientHeight,
          logoMask: logoMaskRef.current,
        });
      }
    }

    rafIdRef.current = requestAnimationFrame(animate);

    // --- Observers ---
    const resizeObserver = new ResizeObserver(() => {
      resize();
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
      cancelAnimationFrame(rafIdRef.current);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, []);

  return canvasRef;
}
