import { HEIGHT, WIDTH } from '../time/grid.js';

import type { LoadedLook, LookCanvas, LookContext, LookSurface, RenderFrame } from './contract.js';

/** Everything `renderFrame` receives beside the canvases the painter owns. */
export type LookParts = Omit<LookContext, 'canvas' | 'context' | 'front'>;

/**
 * A look bound to its own canvases: each `paint` clears the look's canvas, and
 * the front canvas it lends that call, and draws one call into them.
 */
export interface LookPainter {
  canvas: HTMLCanvasElement;
  /** The canvas the browser shows in front of the UI layer; null for a look with no UI layer. */
  front: HTMLCanvasElement | null;
  /**
   * What `renderFrame` returned, unchecked. With `showsFront` the call draws the
   * shown front canvas; without, a front canvas nothing shows.
   */
  paint: (frame: number, parts: LookParts, showsFront: boolean) => unknown;
}

/** A canvas the frame's size, its context, and how to clear it before a call. */
interface Surface<K extends LookCanvas> extends LookSurface<K> {
  clear: () => void;
}

function frameCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  return canvas;
}

function missingContext(where: string, kind: string): Error {
  return new Error(`${where}: the browser gave the look no ${kind} context`);
}

/** A 2D canvas, reset whole before every call. */
function surface2d(where: string): Surface<'2d'> {
  const canvas = frameCanvas();
  // `willReadFrequently` makes Chrome rasterise the canvas in software. Its GPU
  // rasteriser antialiases the same drawing differently from one render to the
  // next, so a 2D look drawn there is not a pure function of its frame.
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (context === null) {
    throw missingContext(where, '2d');
  }
  return {
    canvas,
    context,
    clear: () => {
      context.reset();
    },
  };
}

/**
 * A WebGL2 canvas; before every call its default framebuffer is bound, the
 * full viewport set, the scissor test off, every channel writable and the
 * colour buffer cleared to transparent.
 */
function surfaceWebgl2(where: string): Surface<'webgl2'> {
  const canvas = frameCanvas();
  const context = canvas.getContext('webgl2', {
    alpha: true,
    antialias: true,
    premultipliedAlpha: true,
    preserveDrawingBuffer: true,
  });
  if (context === null) {
    throw missingContext(where, 'WebGL2');
  }
  return {
    canvas,
    context,
    clear: () => {
      context.bindFramebuffer(context.FRAMEBUFFER, null);
      context.viewport(0, 0, WIDTH, HEIGHT);
      context.disable(context.SCISSOR_TEST);
      context.colorMask(true, true, true, true);
      context.clearColor(0, 0, 0, 0);
      context.clear(context.COLOR_BUFFER_BIT);
    },
  };
}

function painterOf<K extends LookCanvas>(
  renderFrame: RenderFrame<K>,
  make: () => Surface<K>,
  withUi: boolean
): LookPainter {
  const back = make();
  const shown = withUi ? make() : null;
  let unshown: Surface<K> | null = null;
  /** The front canvas a call draws: the shown one, or for a call not shown one nothing shows. */
  const frontFor = (showsFront: boolean): Surface<K> | null => {
    if (shown === null || showsFront) {
      return shown;
    }
    unshown ??= make();
    return unshown;
  };
  return {
    canvas: back.canvas,
    front: shown?.canvas ?? null,
    paint: (frame, parts, showsFront) => {
      back.clear();
      const front = frontFor(showsFront);
      front?.clear();
      return renderFrame(frame, {
        ...parts,
        canvas: back.canvas,
        context: back.context,
        front: front === null ? null : { canvas: front.canvas, context: front.context },
      });
    },
  };
}

/**
 * The look's canvas, the frame's size, in the kind it chose, and for a look
 * with a UI layer a front canvas of the same kind. Before every call each
 * canvas the call draws is cleared whole, so nothing one call drew reaches the next.
 */
export function createLookPainter(where: string, look: LoadedLook): LookPainter {
  const withUi = look.Ui !== undefined;
  if (look.context === '2d') {
    return painterOf(look.renderFrame, () => surface2d(where), withUi);
  }
  return painterOf(look.renderFrame, () => surfaceWebgl2(where), withUi);
}
