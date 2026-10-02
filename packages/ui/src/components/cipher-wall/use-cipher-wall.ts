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
import { useAnimationFrame } from '../../hooks/use-animation-frame';
import type { CipherWallState, ThemeColors } from './cipher-wall-engine';

const DPR_CAP = 2;

export interface CipherWallOptions {
  /**
   * Required pool of strings the wall reveals (animated) or bakes in
   * (frozen). Each caller declares its own list so the cipher copy stays
   * thematic to the page; there is no shared default. See PageHero.astro
   * (marketing) and splash-screen.tsx (native splash PNG) for examples.
   */
  messages: readonly string[];
  frozen?: boolean;
  themeOverride?: ThemeColors;
  cipherOpacity?: number;
  /**
   * Shift the frozen (baked-in) messages off the grid center: negative row
   * raises them toward the top, positive col moves them right. Default 0 — only
   * the frozen path reads these; the animated path is unaffected.
   */
  messageRowOffset?: number;
  messageColOffset?: number;
  exclusionZone?: Set<number> | null;
}

/** The step tokens of the sequential ramp, which a canvas shades by magnitude with. */
type SequentialToken = '--seq-1' | '--seq-2' | '--seq-3' | '--seq-4' | '--seq-5';

type ThemeToken =
  | '--background'
  | '--foreground'
  | '--brand-red'
  | '--foreground-muted'
  | SequentialToken;

/**
 * The single reader of the brand palette for everything that paints outside the
 * cascade — canvas fills, the native status bar. `packages/config/tailwind/index.css`
 * is the only place these colours are written down, so this returns whatever it
 * resolves to and substitutes nothing: a literal here would be a second palette
 * free to drift from the stylesheet.
 *
 * `scope` is the element the token is resolved against — pass one whenever the
 * theme is scoped to a subtree (a `dark`-classed wrapper) instead of the document.
 *
 * An unresolved token throws rather than returning the empty string: the callers
 * paint outside the cascade, so an empty colour is not a missing style but a
 * wrong one they hand on — a canvas fill silently keeps the previous colour, and
 * the native status bar takes `color: ''` into the plugin.
 *
 * One token per call, because the refusal is what a caller inherits: a reader
 * that resolved the whole palette would take a surface down over a colour that
 * surface never asked for.
 */
export function readThemeColor(
  token: ThemeToken,
  scope: HTMLElement = document.documentElement
): string {
  const value = getComputedStyle(scope).getPropertyValue(token).trim();
  if (value === '') {
    throw new Error(`readThemeColor: ${token} resolves to nothing on the given scope`);
  }
  return value;
}

/** The whole palette, for the callers that paint with all of it. */
export function readThemeColors(scope: HTMLElement = document.documentElement): ThemeColors {
  return {
    background: readThemeColor('--background', scope),
    foreground: readThemeColor('--foreground', scope),
    brandRed: readThemeColor('--brand-red', scope),
    foregroundMuted: readThemeColor('--foreground-muted', scope),
  };
}

export function useCipherWall(
  options: CipherWallOptions,
  externalCanvasRef?: React.RefObject<HTMLCanvasElement | null>
): React.RefObject<HTMLCanvasElement | null> {
  const internalCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const canvasRef = externalCanvasRef ?? internalCanvasRef;
  const stateRef = React.useRef<CipherWallState | null>(null);
  const colorsRef = React.useRef<ThemeColors | null>(null);
  const tickRef = React.useRef<((time: number) => void) | null>(null);
  const logoMaskRef = React.useRef<boolean[][] | null>(null);

  const messages = options.messages;
  const frozen = options.frozen === true;
  const themeOverride = options.themeOverride;
  const cipherOpacity = options.cipherOpacity ?? 1;
  const messageRowOffset = options.messageRowOffset ?? 0;
  const messageColOffset = options.messageColOffset ?? 0;
  const exclusionZone = options.exclusionZone ?? null;

  const exclusionZoneRef = React.useRef<Set<number> | null>(exclusionZone);
  exclusionZoneRef.current = exclusionZone;

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const parent = canvas.parentElement;

    colorsRef.current = themeOverride ?? readThemeColors();

    const dpr = Math.min(devicePixelRatio, DPR_CAP);

    function computeGridSize(w: number, h: number): { cols: number; rows: number } {
      return {
        cols: Math.floor(w / CELL_WIDTH),
        rows: Math.floor(h / CELL_HEIGHT),
      };
    }

    const sizeCanvas = (w: number, h: number): void => {
      const targetW = w * dpr;
      const targetH = h * dpr;
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    };

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

    const initW = parent?.clientWidth ?? 0;
    const initH = parent?.clientHeight ?? 0;
    sizeCanvas(initW, initH);
    const { cols: initCols, rows: initRows } = computeGridSize(initW, initH);

    let lastCols = initCols;
    let lastRows = initRows;

    // Repaints rather than only restamping the palette: the frozen path runs no
    // animation frame, so nothing else would ever carry the new colours onto the
    // canvas. A caller that passes `themeOverride` keeps its scoped palette and
    // redraws the identical frame.
    const mutationObserver = new MutationObserver(() => {
      colorsRef.current = themeOverride ?? readThemeColors();
      tryRender();
    });
    mutationObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    if (frozen) {
      stateRef.current = createFrozenSnapshot(initCols, initRows, messages, {
        row: messageRowOffset,
        col: messageColOffset,
      });
      tryRender();

      function handleFrozenResize(): void {
        if (!parent) return;
        const w = parent.clientWidth;
        const h = parent.clientHeight;
        sizeCanvas(w, h);
        const { cols, rows } = computeGridSize(w, h);
        if (cols !== lastCols || rows !== lastRows) {
          stateRef.current = createFrozenSnapshot(cols, rows, messages, {
            row: messageRowOffset,
            col: messageColOffset,
          });
          lastCols = cols;
          lastRows = rows;
        }
        tryRender();
      }

      window.addEventListener('resize', handleFrozenResize);

      return () => {
        window.removeEventListener('resize', handleFrozenResize);
        mutationObserver.disconnect();
      };
    }

    const state = createGrid(initCols, initRows, messages);
    state.exclusionZone = exclusionZoneRef.current;
    seedInitialReveals(state);
    stateRef.current = state;

    // Initial paint. Under reduced motion the rAF loop never runs, so this is
    // the only frame ever drawn; it doubles as the first frame otherwise.
    tryRender();

    let lastTime = 0;

    tickRef.current = (time: number): void => {
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
    };

    return () => {
      tickRef.current = null;
      mutationObserver.disconnect();
    };
  }, [frozen, messages, themeOverride, cipherOpacity, messageRowOffset, messageColOffset]);

  // A wall its layout hides (display: none leaves the box it renders in without area)
  // schedules no frames until that box has area again.
  const [hasArea, setHasArea] = React.useState(true);

  React.useLayoutEffect(() => {
    const parent = canvasRef.current?.parentElement;
    if (!parent) return;
    const measure = (): void => {
      setHasArea(parent.clientWidth > 0 && parent.clientHeight > 0);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => {
      observer.disconnect();
    };
  }, [canvasRef]);

  useAnimationFrame(
    (time) => {
      tickRef.current?.(time);
    },
    { paused: frozen || !hasArea }
  );

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
