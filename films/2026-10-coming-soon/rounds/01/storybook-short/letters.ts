import { fontOf } from './ink.js';
import { TAU, clamp, hs, lerp, rgba } from './kit.js';
import { DELETE_AT, EARLIER, FALLEN, FALL_FRAMES, LAND_AT } from './score.js';

import type { G, Pt } from './kit.js';
import type { Glyph } from './phone.js';
import type { LookContext } from '../../../../engine/look/index.js';

type Ctx = LookContext<'2d'>;

/** Letter-board plastic: off-white, with an ink edge. */
export const PLASTIC = '#f7f2e7';

/**
 * A letter-board letter: the uppercase glyph in white plastic with an ink edge.
 * `typed` draws the composer's own glyph instead; `squash` flattens it on an impact.
 */
export function drawTile(g: G, ctx: Ctx, ch: string, x: number, y: number, size: number, rot: number, ink: string, typed = false, alpha = 1, squash = 0): void {
  g.save();
  g.globalAlpha = alpha;
  g.translate(x, y);
  g.rotate(rot);
  if (squash !== 0) {
    g.translate(0, size * 0.3);
    g.scale(1 + 0.35 * squash, 1 - 0.35 * squash);
    g.translate(0, -size * 0.3);
  }
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  if (typed) {
    g.font = fontOf(ctx, 'sans', 500, size);
    g.fillStyle = PLASTIC;
    g.fillText(ch, 0, 0);
  } else {
    g.font = fontOf(ctx, 'sans', 800, size);
    g.lineJoin = 'round';
    g.lineWidth = Math.max(2, size * 0.09);
    g.strokeStyle = ink;
    g.strokeText(ch.toUpperCase(), 0, 0);
    g.fillStyle = PLASTIC;
    g.fillText(ch.toUpperCase(), 0, 0);
  }
  g.restore();
}

/** The pile's letters in landing order: the earlier deletions already there, then this one's. */
export const PILE_CHARS: readonly string[] = [...EARLIER, ...FALLEN.map((l) => l.char)];
const FIRST_NEW = EARLIER.length;

/** Where a pile letter rests, relative to the pile's centre at scale 1. */
export interface Slot {
  x: number;
  y: number;
  rot: number;
}

let slotCache: Slot[] | null = null;

/** The heap: wide at the floor, each course narrower and higher, the letters overlapping. */
export function pileSlots(): Slot[] {
  if (slotCache !== null) {
    return slotCache;
  }
  const courses = [15, 13, 11, 9, 7, 5, 3, 1];
  const slots: Slot[] = [];
  let placed = 0;
  courses.forEach((across, row) => {
    const width = (across - 1) * 30;
    for (let k = 0; k < across && placed < PILE_CHARS.length; k++) {
      const u = across === 1 ? 0.5 : k / (across - 1);
      slots.push({
        x: -width / 2 + u * width + hs(placed, 51) * 9,
        y: -row * 19 + hs(placed, 52) * 5 + Math.abs(u - 0.5) * 16,
        rot: hs(placed, 53) * 0.9,
      });
      placed += 1;
    }
  });
  slotCache = slots;
  return slots;
}

/** A pile letter's resting place in the world, for a pile centred at `at` and drawn at `scale`. */
export function slotAt(i: number, at: Pt, scale: number): Slot {
  const s = pileSlots()[i] ?? { x: 0, y: 0, rot: 0 };
  return { x: at[0] + s.x * scale, y: at[1] + s.y * scale, rot: s.rot };
}

/** Letter size on the pile at scale 1. */
export const PILE_SIZE = 40;

/** The landing frame of a pile letter: the earlier ones were there before the film. */
export function landOf(i: number): number {
  return i < FIRST_NEW ? -1000 : (LAND_AT[i - FIRST_NEW] ?? -1000);
}

/**
 * The pile on a frame, centred at `at`, every letter that has landed, each
 * squashing and bouncing as it lands. `skip` holds letters drawn elsewhere
 * (picked up).
 */
export function drawPile(g: G, ctx: Ctx, time: number, ink: string, at: Pt, scale: number, skip: ReadonlySet<number> = new Set()): void {
  g.fillStyle = rgba('#05060f', 0.3);
  g.beginPath();
  g.ellipse(at[0], at[1] + 22 * scale, 250 * scale, 34 * scale, 0, 0, TAU);
  g.fill();
  PILE_CHARS.forEach((ch, i) => {
    if (skip.has(i)) {
      return;
    }
    const t = time - landOf(i);
    if (t < 0) {
      return;
    }
    const s = slotAt(i, at, scale);
    const bounce = t < 20 ? 12 * scale * Math.exp(-0.25 * t) * Math.abs(Math.sin(0.45 * t)) : 0;
    const squash = t < 12 ? Math.exp(-0.35 * t) * Math.cos(0.7 * t) : 0;
    drawTile(g, ctx, ch, s.x, s.y - bounce, PILE_SIZE * scale, s.rot, ink, false, 1, squash);
  });
}

/** Frames a popped letter takes to turn from typed glyph to board capital. */
const TURN = 14;

/**
 * The deleted letters in flight in the close-up: each pops up from its place in
 * the composer when the backspace takes it, turns into a board capital as it
 * tumbles, and falls on an arc onto its place on the pile at `at` (in the same
 * space), landing on its frame.
 */
export function drawFalling(g: G, ctx: Ctx, glyphs: readonly Glyph[], time: number, ink: string, at: Pt, scale: number): void {
  FALLEN.forEach(({ char, index }, i) => {
    const born = DELETE_AT[index] ?? 0;
    const t = time - born;
    const gl = glyphs[index];
    if (t < 0 || t >= FALL_FRAMES || gl === undefined) {
      return;
    }
    const u = t / FALL_FRAMES;
    const slot = slotAt(FIRST_NEW + i, at, scale);
    const x0 = gl.x + gl.w / 2;
    const y0 = gl.y - 18;
    // A pop up, then a fall that accelerates onto the slot: a parabola through both ends.
    const lift = 140 + 60 * hs(i, 44);
    const x = lerp(x0, slot.x, u) + hs(i, 41) * 40 * Math.sin(Math.PI * u);
    const y = lerp(y0, slot.y, u * u) - lift * 4 * u * (1 - u) * (1 - u);
    const spin = hs(i, 43) * 5 * u + slot.rot * u;
    const turn = clamp(t / TURN);
    const sx = Math.abs(Math.cos(Math.PI * turn));
    const size = lerp(56, PILE_SIZE * scale, u);
    g.save();
    g.translate(x, y);
    g.rotate(spin);
    g.scale(Math.max(0.08, sx), 1);
    drawTile(g, ctx, char, 0, 0, size, 0, ink, turn < 0.5);
    g.restore();
  });
}

/** The letters she takes at dawn, by their place in the pile: O, P, E and N of the deleted "open". */
export function pickedSlots(): number[] {
  const want = ['o', 'p', 'e', 'n'];
  const taken = new Set<number>();
  return want.map((ch) => {
    let best = -1;
    for (let i = PILE_CHARS.length - 1; i >= FIRST_NEW; i--) {
      if (!taken.has(i) && PILE_CHARS[i]?.toLowerCase() === ch) {
        best = i;
        break;
      }
    }
    taken.add(best);
    return best;
  });
}
