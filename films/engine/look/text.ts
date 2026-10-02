import type { LookBox } from './contract.js';

/** The prefix of the console line carrying a frame's text boxes when the QA channel is on. */
export const LOOK_TEXT_PREFIX = 'films-look-text:';

function covering(a: LookBox['box'], b: LookBox['box']): LookBox['box'] {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

/** One id's boxes from two sub-frames as one; null when they report different words or roles. */
function mergedBox(seen: LookBox, next: LookBox): LookBox | null {
  const box = covering(seen.box, next.box);
  if (seen.role === 'logo' || next.role === 'logo') {
    return seen.role === next.role ? { ...seen, box } : null;
  }
  if (seen.text !== next.text || seen.role !== next.role) {
    return null;
  }
  return { ...seen, box, fontSizePx: Math.min(seen.fontSizePx, next.fontSizePx) };
}

/**
 * The boxes a frame drew, from those each of its calls returned: one call
 * without motion blur, one per sub-frame with it. A text or resting mark drawn
 * at several sub-frames reports the box covering everywhere it was drawn, and a
 * text the smallest size it was drawn at, so the frame's report holds all of
 * its blurred text.
 */
export function mergeFrameText(
  where: string,
  frame: number,
  calls: readonly (readonly LookBox[])[]
): LookBox[] {
  const byId = new Map<string, LookBox>();
  for (const next of calls.flat()) {
    const seen = byId.get(next.id);
    if (seen === undefined) {
      byId.set(next.id, next);
      continue;
    }
    const merged = mergedBox(seen, next);
    if (merged === null) {
      throw new Error(
        `${where}: frame ${String(frame)}: text box "${next.id}" reports different words or roles at the sub-frames of one frame`
      );
    }
    byId.set(next.id, merged);
  }
  return [...byId.values()];
}

/** A frame's text boxes as the one console line the QA channel writes for it. */
export function lookTextLine(frame: number, boxes: readonly LookBox[]): string {
  return `${LOOK_TEXT_PREFIX} ${JSON.stringify({ frame, boxes })}`;
}

interface TextCollectorOptions {
  where: string;
  /** How many calls draw one frame: its motion-blur samples, or 1. */
  samples: number;
  onFrame: (frame: number, boxes: LookBox[]) => void;
}

/** Gathers each call's boxes and hands over a frame's merged text once all its calls have drawn. */
export function createTextCollector({ where, samples, onFrame }: TextCollectorOptions): {
  add: (frame: number, boxes: readonly LookBox[]) => void;
} {
  let current = Number.NaN;
  let calls: (readonly LookBox[])[] = [];
  return {
    add(frame, boxes) {
      if (frame !== current) {
        current = frame;
        calls = [];
      }
      calls.push(boxes);
      if (calls.length === samples) {
        const merged = mergeFrameText(where, frame, calls);
        calls = [];
        onFrame(frame, merged);
      }
    },
  };
}
