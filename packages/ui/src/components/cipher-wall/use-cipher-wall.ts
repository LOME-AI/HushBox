import * as React from 'react';
import {
  createGrid,
  resizeCells,
  seedInitialReveals,
  createFrozenSnapshot,
  updateState,
  pruneExcludedReveals,
  renderFrame,
  CELL_WIDTH,
  CELL_HEIGHT,
} from './cipher-wall-engine';
import type { CipherWallState, ThemeColors } from './cipher-wall-engine';

const DPR_CAP = 2;

export interface CipherWallOptions {
  frozen?: boolean;
  frozenMessageCount?: number;
  themeOverride?: ThemeColors;
  cipherOpacity?: number;
  exclusionZone?: Set<number> | null;
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
  options?: CipherWallOptions,
  externalCanvasRef?: React.RefObject<HTMLCanvasElement | null>
): React.RefObject<HTMLCanvasElement | null> {
  const internalCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const canvasRef = externalCanvasRef ?? internalCanvasRef;
  const stateRef = React.useRef<CipherWallState | null>(null);
  const colorsRef = React.useRef<ThemeColors | null>(null);
  const rafIdRef = React.useRef<number>(0);
  const logoMaskRef = React.useRef<boolean[][] | null>(null);

  const frozen = options?.frozen === true;
  const frozenMessageCount = options?.frozenMessageCount ?? 4;
  const themeOverride = options?.themeOverride;
  const cipherOpacity = options?.cipherOpacity ?? 1;
  const exclusionZone = options?.exclusionZone ?? null;

  const exclusionZoneRef = React.useRef<Set<number> | null>(exclusionZone);
  exclusionZoneRef.current = exclusionZone;

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const parent = canvas.parentElement;

    colorsRef.current = themeOverride ?? readThemeColors();

    // --- Sizing ---
    const dpr = Math.min(devicePixelRatio, DPR_CAP);

    function computeGridSize(w: number, h: number): { cols: number; rows: number } {
      return {
        cols: Math.floor(w / CELL_WIDTH),
        rows: Math.floor(h / CELL_HEIGHT),
      };
    }

    function sizeCanvas(w: number, h: number): void {
      if (!canvas || !ctx) return;
      const targetW = w * dpr;
      const targetH = h * dpr;
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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

    // --- Initial setup ---
    const initW = parent?.clientWidth ?? 0;
    const initH = parent?.clientHeight ?? 0;
    sizeCanvas(initW, initH);
    const { cols: initCols, rows: initRows } = computeGridSize(initW, initH);

    let lastCols = initCols;
    let lastRows = initRows;

    // --- Static render for frozen mode ---
    if (frozen) {
      stateRef.current = createFrozenSnapshot(initCols, initRows, frozenMessageCount);
      tryRender();

      function handleFrozenResize(): void {
        if (!parent) return;
        const w = parent.clientWidth;
        const h = parent.clientHeight;
        sizeCanvas(w, h);
        const { cols, rows } = computeGridSize(w, h);
        if (cols !== lastCols || rows !== lastRows) {
          stateRef.current = createFrozenSnapshot(cols, rows, frozenMessageCount);
          lastCols = cols;
          lastRows = rows;
        }
        tryRender();
      }

      window.addEventListener('resize', handleFrozenResize);

      return () => {
        window.removeEventListener('resize', handleFrozenResize);
      };
    }

    // --- Animated mode ---
    const state = createGrid(initCols, initRows);
    state.exclusionZone = exclusionZoneRef.current;
    seedInitialReveals(state);
    stateRef.current = state;

    let lastTime = 0;

    function animate(time: number): void {
      rafIdRef.current = requestAnimationFrame(animate);

      // Poll dimensions each frame
      if (parent) {
        const w = parent.clientWidth;
        const h = parent.clientHeight;
        sizeCanvas(w, h);
        const { cols, rows } = computeGridSize(w, h);
        if (cols !== lastCols || rows !== lastRows) {
          if (stateRef.current) {
            resizeCells(stateRef.current, cols, rows);
          }
          lastCols = cols;
          lastRows = rows;
        }
      }

      const delta = lastTime === 0 ? 0.016 : (time - lastTime) / 1000;
      lastTime = time;

      if (stateRef.current) {
        updateState(stateRef.current, Math.min(delta, 0.1));
      }
      tryRender();
    }

    rafIdRef.current = requestAnimationFrame(animate);

    // --- Theme observer ---
    const mutationObserver = new MutationObserver(() => {
      colorsRef.current = readThemeColors();
    });
    mutationObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    return () => {
      cancelAnimationFrame(rafIdRef.current);
      mutationObserver.disconnect();
    };
  }, [frozen, frozenMessageCount, themeOverride, cipherOpacity]);

  React.useEffect(() => {
    if (stateRef.current) {
      stateRef.current.exclusionZone = exclusionZone;
      if (exclusionZone) {
        pruneExcludedReveals(stateRef.current);
      }
    }
  }, [exclusionZone]);

  return canvasRef;
}
