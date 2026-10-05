import type { G } from './kit.js';
import type { LookContext, TextBox } from '../../../../engine/look/index.js';

export type Ctx = LookContext<'2d'>;
export type Face = 'sans' | 'serif' | 'mono';

export function fontOf(ctx: Ctx, face: Face, weight: number, size: number, italic = false): string {
  const stack = ctx.fonts[face];
  if (stack === undefined) {
    throw new Error(`type-music-video: the look host loaded no ${face} stack`);
  }
  return `${italic ? 'italic ' : ''}${String(weight)} ${String(size)}px ${stack}`;
}

interface Metric {
  width: number;
  left: number;
  right: number;
  ascent: number;
  descent: number;
}

/** Glyph metrics by font and text: the same font draws the same metrics on every call, so caching keeps the look pure. */
const METRICS = new Map<string, Metric>();

export function metric(g: G, font: string, text: string): Metric {
  const key = `${font}|${text}`;
  const seen = METRICS.get(key);
  if (seen !== undefined) {
    return seen;
  }
  g.save();
  g.font = font;
  g.letterSpacing = '0px';
  const m = g.measureText(text);
  g.restore();
  const out = {
    width: m.width,
    left: m.actualBoundingBoxLeft,
    right: m.actualBoundingBoxRight,
    ascent: m.actualBoundingBoxAscent,
    descent: m.actualBoundingBoxDescent,
  };
  METRICS.set(key, out);
  return out;
}

export interface GlyphStyle {
  face?: Face;
  weight?: number;
  italic?: boolean;
  color: string;
  alpha?: number;
  rot?: number;
  sx?: number;
  sy?: number;
  /** A stroke instead of a fill, this many pixels wide at the glyph's size. */
  stroke?: number;
  /**
   * Anchor: the glyph's visual centre (default); its ink's top or bottom centre;
   * its ink's left edge; or `baseline`, the centre of its advance on the
   * baseline, so letters of one run share a line.
   */
  anchor?: 'center' | 'top' | 'bottom' | 'left' | 'baseline';
}

/** Metrics at this size, scaled to any other, so a glyph whose size moves every frame measures from one cache entry. */
const REF = 100;

export function metricAt(g: G, ctx: Ctx, face: Face, weight: number, italic: boolean, ch: string, size: number): Metric {
  const m = metric(g, fontOf(ctx, face, weight, REF, italic), ch);
  const k = size / REF;
  return { width: m.width * k, left: m.left * k, right: m.right * k, ascent: m.ascent * k, descent: m.descent * k };
}

/**
 * One letter drawn about its anchor, rotated and scaled about that point.
 * Text that `ctx.hideText` must leave out is copy, drawn with {@link textLine};
 * a glyph is imagery and is always drawn.
 */
export function glyph(g: G, ctx: Ctx, ch: string, x: number, y: number, size: number, s: GlyphStyle): void {
  if ((s.alpha ?? 1) <= 0.003 || size <= 0.5) {
    return;
  }
  const face = s.face ?? 'sans';
  const weight = s.weight ?? 900;
  const italic = s.italic ?? false;
  const m = metricAt(g, ctx, face, weight, italic, ch, size);
  let ax = (m.right - m.left) / 2;
  let oy = (m.ascent - m.descent) / 2;
  if (s.anchor === 'top') {
    oy = m.ascent;
  } else if (s.anchor === 'bottom') {
    oy = -m.descent;
  } else if (s.anchor === 'baseline') {
    oy = 0;
    ax = m.width / 2;
  }
  if (s.anchor === 'left') {
    ax = -m.left;
  }
  g.save();
  g.translate(x, y);
  if (s.rot !== undefined && s.rot !== 0) {
    g.rotate(s.rot);
  }
  if (s.sx !== undefined || s.sy !== undefined) {
    g.scale(s.sx ?? 1, s.sy ?? 1);
  }
  g.font = fontOf(ctx, face, weight, size, italic);
  g.globalAlpha *= s.alpha ?? 1;
  if (s.stroke !== undefined) {
    g.strokeStyle = s.color;
    g.lineWidth = s.stroke;
    g.lineJoin = 'round';
    g.strokeText(ch, -ax, oy);
  } else {
    g.fillStyle = s.color;
    g.fillText(ch, -ax, oy);
  }
  g.restore();
}

/** A rectangle in the current transform's space, as the screen box covering it. */
export function screenBox(g: G, x: number, y: number, width: number, height: number): TextBox['box'] {
  const t = g.getTransform();
  const corners = [
    t.transformPoint({ x, y }),
    t.transformPoint({ x: x + width, y }),
    t.transformPoint({ x, y: y + height }),
    t.transformPoint({ x: x + width, y: y + height }),
  ];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const bx = Math.min(...xs);
  const by = Math.min(...ys);
  return { x: bx, y: by, width: Math.max(...xs) - bx, height: Math.max(...ys) - by };
}

/** The current transform's scale: what a size in its space is on screen. */
export function screenScale(g: G): number {
  const t = g.getTransform();
  return Math.hypot(t.a, t.b);
}

export interface LineStyle {
  face: Face;
  weight: number;
  size: number;
  color: string;
  italic?: boolean;
  align?: CanvasTextAlign;
  tracking?: number;
  alpha?: number;
}

/** The ink box of a line of text drawn at (x, baseline y) with the style's alignment, in the current space. */
export function lineBox(g: G, ctx: Ctx, text: string, x: number, y: number, s: LineStyle): { x: number; y: number; width: number; height: number } {
  const font = fontOf(ctx, s.face, s.weight, s.size, s.italic ?? false);
  g.save();
  g.font = font;
  g.letterSpacing = `${String((s.tracking ?? 0) * s.size)}px`;
  g.textAlign = s.align ?? 'left';
  g.textBaseline = 'alphabetic';
  const m = g.measureText(text);
  g.restore();
  return { x: x - m.actualBoundingBoxLeft, y: y - m.actualBoundingBoxAscent, width: m.actualBoundingBoxLeft + m.actualBoundingBoxRight, height: m.actualBoundingBoxAscent + m.actualBoundingBoxDescent };
}

/**
 * A line of text at (x, baseline y). Copy is left out when `ctx.hideText` is
 * set; its box is reported either way, in screen space, with its size on screen.
 */
export function textLine(
  g: G,
  ctx: Ctx,
  text: string,
  x: number,
  y: number,
  s: LineStyle,
  report: { id: string; words: string; role: TextBox['role'] } | null
): TextBox | null {
  const font = fontOf(ctx, s.face, s.weight, s.size, s.italic ?? false);
  const hide = report !== null && report.role !== 'imagery' && ctx.hideText;
  if (!hide && (s.alpha ?? 1) > 0.003) {
    g.save();
    g.font = font;
    g.letterSpacing = `${String((s.tracking ?? 0) * s.size)}px`;
    g.textAlign = s.align ?? 'left';
    g.textBaseline = 'alphabetic';
    g.globalAlpha *= s.alpha ?? 1;
    g.fillStyle = s.color;
    g.fillText(text, x, y);
    g.restore();
  }
  if (report === null) {
    return null;
  }
  const b = lineBox(g, ctx, text, x, y, s);
  return { id: report.id, text: report.words, box: screenBox(g, b.x, b.y, Math.max(1, b.width), Math.max(1, b.height)), fontSizePx: s.size * screenScale(g), role: report.role };
}

/** The union of boxes, as one box. */
export function unionBox(boxes: readonly TextBox['box'][]): TextBox['box'] {
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.width));
  const y1 = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
