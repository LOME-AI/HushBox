import type { G } from './kit.js';
import type { LookContext, TextBox } from '../../../../engine/look/index.js';

type Ctx = LookContext<'2d'>;

export type Face = 'sans' | 'serif' | 'mono';

export function fontOf(ctx: Ctx, face: Face, weight: number, size: number, italic = false): string {
  const stack = ctx.fonts[face];
  if (stack === undefined) {
    throw new Error(`one-take-launch: the look host loaded no ${face} stack`);
  }
  return `${italic ? 'italic ' : ''}${String(weight)} ${String(size)}px ${stack}`;
}

export interface TextSpec {
  id: string;
  text: string;
  x: number;
  y: number;
  size: number;
  face: Face;
  weight: number;
  fill: string;
  role: TextBox['role'];
  align?: CanvasTextAlign;
  tracking?: number;
  italic?: boolean;
}

/** The box of `text` set at (x, y) in the current transform, on screen. */
function screenBox(g: G, m: TextMetrics, x: number, y: number): TextBox['box'] {
  const t = g.getTransform();
  const x0 = x - m.actualBoundingBoxLeft;
  const y0 = y - m.actualBoundingBoxAscent;
  const x1 = x + m.actualBoundingBoxRight;
  const y1 = y + m.actualBoundingBoxDescent;
  const corners = [
    t.transformPoint({ x: x0, y: y0 }),
    t.transformPoint({ x: x1, y: y0 }),
    t.transformPoint({ x: x0, y: y1 }),
    t.transformPoint({ x: x1, y: y1 }),
  ];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const bx = Math.min(...xs);
  const by = Math.min(...ys);
  return { x: bx, y: by, width: Math.max(...xs) - bx, height: Math.max(...ys) - by };
}

/**
 * One line of text drawn at (x, y) in the current transform and reported as a
 * box on screen, at the size it lands on screen. Copy is left out when the
 * contrast pass hides text.
 */
export function drawText(g: G, ctx: Ctx, spec: TextSpec): TextBox {
  g.save();
  g.font = fontOf(ctx, spec.face, spec.weight, spec.size, spec.italic === true);
  g.letterSpacing = `${String((spec.tracking ?? 0) * spec.size)}px`;
  g.textAlign = spec.align ?? 'left';
  g.textBaseline = 'alphabetic';
  const m = g.measureText(spec.text);
  if (!ctx.hideText) {
    g.fillStyle = spec.fill;
    g.fillText(spec.text, spec.x, spec.y);
  }
  const box = screenBox(g, m, spec.x, spec.y);
  const t = g.getTransform();
  g.restore();
  g.letterSpacing = '0px';
  return { id: spec.id, text: spec.text, box, fontSizePx: Math.max(0.01, spec.size * Math.hypot(t.a, t.b)), role: spec.role };
}

/** The advance of `text` at a font, with tracking. */
export function measure(g: G, ctx: Ctx, text: string, face: Face, weight: number, size: number, tracking = 0, italic = false): number {
  g.save();
  g.font = fontOf(ctx, face, weight, size, italic);
  g.letterSpacing = `${String(tracking * size)}px`;
  const width = g.measureText(text).width;
  g.restore();
  g.letterSpacing = '0px';
  return width;
}

/** Several boxes of one text row merged into the box covering them all. */
export function unionBox(id: string, text: string, role: TextBox['role'], boxes: readonly TextBox[]): TextBox | null {
  if (boxes.length === 0) {
    return null;
  }
  const x0 = Math.min(...boxes.map((b) => b.box.x));
  const y0 = Math.min(...boxes.map((b) => b.box.y));
  const x1 = Math.max(...boxes.map((b) => b.box.x + b.box.width));
  const y1 = Math.max(...boxes.map((b) => b.box.y + b.box.height));
  return { id, text, role, box: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, fontSizePx: Math.min(...boxes.map((b) => b.fontSizePx)) };
}
