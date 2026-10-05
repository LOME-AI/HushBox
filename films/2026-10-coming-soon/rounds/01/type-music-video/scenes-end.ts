import { CARD_REST, FINAL, TAG_BEATS, WORDMARK, bf } from './beats.js';
import { drawMark, hex, markAtRest } from './brand.js';
import { CX, H, SNAPPY, W, clamp, hash, outCubic, prog, rgba, smooth, springOf } from './kit.js';
import { fontOf, glyph, screenBox, screenScale, textLine } from './type.js';

import type { G } from './kit.js';
import type { Ctx } from './type.js';
import type { LookBox, TextBox } from '../../../../engine/look/index.js';

const PLACE = { x: CX, y: 590, size: 330 };
const WORDMARK_Y = 905;
const TAG_Y = [1012, 1104, 1196] as const;
const TAGS = ['One interface.', 'Every feature.', 'Private.'] as const;

/**
 * Beats 56–64, the end card on warm charcoal: a Signal Red dot, out of the
 * dive through the O, throws the mark's arcs out on their own arcs to rest on
 * the logo; the wordmark lands and is read alone, then each tagline line lands
 * on its own beat, and the card holds near still, a few faint letters rising
 * behind it.
 */
export function endCard(g: G, ctx: Ctx, frame: number, time: number): LookBox[] {
  const bg = hex(ctx.brand.background);
  const fg = hex(ctx.brand.foreground);
  const red = hex(ctx.brand.brandRed);
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  const land = bf(FINAL);
  // Faint letters drifting up behind the card, each on its own slow cycle: the heap, let go.
  for (let k = 0; k < 22; k++) {
    const cycle = ((time - land) / 60) * (0.05 + 0.04 * hash(k, 141)) + hash(k, 142);
    const life = cycle - Math.floor(cycle);
    const x = 60 + hash(k, 143) * (W - 120);
    const y = H + 40 - life * (H + 80);
    const ch = 'isitcrazytoquitmyjobopen'.charAt(k % 24);
    glyph(g, ctx, ch, x, y, 40 + 30 * hash(k, 144), { face: 'mono', weight: 700, color: fg, alpha: 0.05 * Math.sin(Math.PI * life), rot: hash(k, 145) * 2 - 1 });
  }
  const boxes: LookBox[] = [];
  const rest = bf(CARD_REST);
  // Near still: the whole card pushes in by two and a half per cent over its hold.
  const push = 1 + 0.025 * smooth(prog(time, rest, bf(64)));
  g.save();
  g.translate(CX, 960);
  g.scale(push, push);
  g.translate(-CX, -960);
  if (frame >= rest) {
    // The mark breathes: a slow swell and ease about its centre, so it never freezes; at every size it is the logo exactly.
    const breath = 1 + 0.02 * Math.sin(((time - rest) / 96) * Math.PI * 2);
    g.save();
    g.translate(PLACE.x, PLACE.y);
    g.scale(breath, breath);
    g.translate(-PLACE.x, -PLACE.y);
    boxes.push(markAtRest(g, ctx, PLACE, red, 'end-mark'));
    g.restore();
  } else {
    // The dot is there from the cut, grown from the O's counter; each arc flies out on its own delay.
    const grow = outCubic(prog(time, land, land + 6));
    drawMark(g, ctx, { ...PLACE, size: PLACE.size * (0.6 + 0.4 * grow) }, red, (i, dot) => {
      const w = dot ? 1 : Math.max(0, springOf(time, land + 2 + i * 1.5, SNAPPY));
      return { w, spin: 1.3 + 0.25 * (i % 3) };
    });
    if (time < land + 24) {
      const ring = (time - land) / 24;
      g.strokeStyle = rgba(red, 0.45 * (1 - ring));
      g.lineWidth = 5;
      g.beginPath();
      g.arc(PLACE.x, PLACE.y, 30 + PLACE.size * 0.9 * ring, 0, Math.PI * 2);
      g.stroke();
    }
  }
  const mark = bf(WORDMARK);
  if (frame >= mark) {
    boxes.push(wordmark(g, ctx, time - mark, fg, red));
  }
  // Each tagline line lands on its own beat: it springs up from below and from a size larger, overshoots, and
  // settles; no fade, and never under the headline size floor.
  TAGS.forEach((words, i) => {
    const tag = bf(TAG_BEATS[i] ?? 60);
    if (frame >= tag) {
      const k = springOf(time, tag, SNAPPY);
      const y = (TAG_Y[i] ?? 1100) + (1 - k) * 24;
      const sc = 1.1 - 0.1 * k;
      g.save();
      g.translate(CX, y);
      g.scale(sc, sc);
      const box = textLine(g, ctx, words, 0, 0, { face: 'sans', weight: 800, size: 86, color: i === 2 ? red : fg, align: 'center' }, { id: `tag-${String(i + 1)}`, words, role: 'headline' });
      g.restore();
      if (box !== null) {
        boxes.push(box);
      }
    }
  });
  g.restore();
  return boxes;
}

/** The wordmark as the brand sets it: Hush in the foreground colour and Box in Signal Red, its tracking closing as it lands. */
function wordmark(g: G, ctx: Ctx, since: number, fg: string, red: string): TextBox {
  const size = 136;
  const k = clamp(since / 10);
  g.save();
  g.font = fontOf(ctx, 'serif', 900, size);
  g.letterSpacing = `${String((0.3 * (1 - outCubic(k)) + 0.01) * size)}px`;
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  const a = g.measureText('Hush');
  const b = g.measureText('Box');
  const width = a.width + b.width;
  const x = CX - width / 2;
  if (!ctx.hideText) {
    g.fillStyle = fg;
    g.fillText('Hush', x, WORDMARK_Y);
    g.fillStyle = red;
    g.fillText('Box', x + a.width, WORDMARK_Y);
  }
  const ascent = Math.max(a.actualBoundingBoxAscent, b.actualBoundingBoxAscent);
  const descent = Math.max(a.actualBoundingBoxDescent, b.actualBoundingBoxDescent);
  const box = screenBox(g, x, WORDMARK_Y - ascent, width, ascent + descent);
  const sizePx = size * screenScale(g);
  g.restore();
  g.letterSpacing = '0px';
  return { id: 'wordmark', text: 'HushBox', box, fontSizePx: sizePx, role: 'headline' };
}
