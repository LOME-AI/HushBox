import { DELETE_FALL, DELETE_WORDS, DOUBT, DROP_FALL, HEAP, LAPSE_DROPS, LOL_DELETE, LOL_FALL, WISH, WISH_DROP, bf } from './beats.js';
import { P, TAU, clamp, hash, hs, lerp, outCubic } from './kit.js';
import { glyph } from './type.js';

import type { G } from './kit.js';
import type { Ctx } from './type.js';

/** One letter's resting place on the heap, in letter units from the heap's base centre; y runs down. */
export interface Slot {
  ch: string;
  x: number;
  y: number;
  rot: number;
  size: number;
  /** The wish's letters, which rest warm. */
  warm: boolean;
}

const LETTERS = DOUBT.replaceAll(' ', '');
const WISH_LETTERS = WISH.replaceAll(' ', '');

/** Every slot's letter, in the order the letters land. */
function sequence(): { ch: string; warm: boolean }[] {
  // Slots 0–2 are "lol", the first word she ever deleted.
  const out: { ch: string; warm: boolean }[] = [...LOL].map((ch) => ({ ch, warm: false }));
  for (const [word] of DELETE_WORDS) {
    for (const ch of word) {
      out.push({ ch, warm: false });
    }
  }
  while (out.length < HEAP.wishDrop) {
    for (const ch of LETTERS) {
      if (out.length < HEAP.wishDrop) {
        out.push({ ch, warm: false });
      }
    }
  }
  for (const ch of WISH_LETTERS) {
    out.push({ ch, warm: true });
  }
  return out;
}

const LOL = 'lol';
/**
 * "lol" lies whole at the bottom of the heap, large, each letter's x, turn and
 * size in letter units; every later letter piles on top of it.
 */
const LOL_REST: readonly (readonly [x: number, rot: number])[] = [
  [-0.3, -0.1],
  [1.5, 0.06],
  [3.35, 0.28],
];
const LOL_SIZE = 3;
/** Each lol letter's visible height as a share of its size: an ascender for l, the x-height for o. */
const LOL_HEIGHT: Readonly<Record<string, number>> = { l: 0.74, o: 0.54 };

const COLS = 25;
const COL_W = 0.6;
/** The steepest step between neighbouring columns before a letter rolls down to the lower one. */
const REPOSE = 0.55;

let cache: { seed: number; slots: Slot[] } | null = null;

/** The heap's slots: each letter drops on a column near the middle and rolls down any slope steeper than repose. */
export function heapSlots(seedProbe: number): Slot[] {
  if (cache !== null && cache.seed === seedProbe) {
    return cache.slots;
  }
  const heights = Array.from({ length: COLS }, () => 0);
  const at = (c: number): number => (c < 0 || c >= COLS ? Number.POSITIVE_INFINITY : (heights[c] ?? 0));
  const colOf = (x: number): number => Math.round(x / COL_W + (COLS - 1) / 2);
  const slots = sequence().map(({ ch, warm }, k) => {
    const rest = LOL_REST[k];
    if (rest !== undefined) {
      const h = (LOL_HEIGHT[ch] ?? 0.6) * LOL_SIZE;
      const [x, rot] = rest;
      for (let c = colOf(x - LOL_SIZE * 0.28); c <= colOf(x + LOL_SIZE * 0.28); c++) {
        if (c >= 0 && c < COLS) {
          heights[c] = Math.max(heights[c] ?? 0, h * 0.9);
        }
      }
      return { ch, warm, x, y: -h / 2 + 0.05, rot, size: LOL_SIZE };
    }
    // The first letters land close together and the spread widens as the heap grows, so it reads as a pile from the first word.
    const spread = Math.min(1, 0.3 + k / 110);
    const r = 0.5 + ((hash(k, 1) + hash(k, 2) + hash(k, 3)) / 3 - 0.5) * spread;
    let c = Math.min(COLS - 1, Math.floor(r * COLS));
    for (let step = 0; step < 10; step++) {
      const here = at(c);
      if (at(c - 1) < here - REPOSE && at(c - 1) <= at(c + 1)) {
        c -= 1;
      } else if (at(c + 1) < here - REPOSE) {
        c += 1;
      } else {
        break;
      }
    }
    const base = at(c);
    heights[c] = base + 0.5 + hash(k, 5) * 0.14;
    const flat = hash(k, 7) < 0.22 ? (hash(k, 9) < 0.5 ? -1 : 1) * (Math.PI / 2) : 0;
    return {
      ch,
      warm,
      x: (c - (COLS - 1) / 2) * COL_W + hs(k, 4) * 0.16,
      y: -(base + 0.4),
      rot: hs(k, 6) * 0.75 + flat,
      size: 0.92 + hash(k, 8) * 0.26,
    };
  });
  cache = { seed: seedProbe, slots };
  return slots;
}

/** The frame a slot's letter lands on in a shot that shows it falling; null for a letter that landed off screen. */
export function landFrame(k: number): number | null {
  if (k < LOL.length) {
    return bf(LOL_DELETE) + LOL_FALL;
  }
  let offset = HEAP.first;
  for (const [word, beat] of DELETE_WORDS) {
    if (k < offset + word.length) {
      return bf(beat) + DELETE_FALL;
    }
    offset += word.length;
  }
  const [first, second] = HEAP.lapseDrops;
  if (k >= first && k < first + LETTERS.length) {
    return bf(LAPSE_DROPS[0]) + DROP_FALL;
  }
  if (k >= second && k < second + LETTERS.length) {
    return bf(LAPSE_DROPS[1]) + DROP_FALL;
  }
  if (k >= HEAP.wishDrop && k < HEAP.wishDrop + WISH_LETTERS.length) {
    return bf(WISH_DROP) + DROP_FALL;
  }
  return null;
}

/** The colour a heap letter rests in: cream with a seeded shade, the wish's letters amber. */
export function slotColor(k: number, warm: boolean): string {
  if (warm) {
    return P.amber;
  }
  if (k < LOL.length) {
    return P.cream;
  }
  const v = hash(k, 21);
  return v < 0.6 ? P.cream : v < 0.85 ? '#d9cfe9' : '#bfb6dd';
}

export interface HeapView {
  /** Screen position of the heap's base centre, in the current space. */
  x: number;
  y: number;
  /** Pixels per letter unit. */
  unit: number;
  /** Slots below this index exist in the shot. */
  count: number;
  /** Slots drawn elsewhere this frame: in flight, or taken. */
  skip?: (k: number) => boolean;
  /** Shading towards the room's dark, 0 none. */
  shade?: number;
}

/** A slot's place in the current space. */
export function slotAt(slot: Slot, view: HeapView): { x: number; y: number; size: number } {
  return { x: view.x + slot.x * view.unit, y: view.y + slot.y * view.unit, size: slot.size * view.unit };
}

/**
 * The heap: every slot below the count whose letter has landed by `frame`,
 * mono letters at their resting turn; a letter that just landed squashes
 * flat and springs back.
 */
export function drawHeap(g: G, ctx: Ctx, frame: number, time: number, view: HeapView): void {
  const slots = heapSlots(hashProbe());
  for (let k = 0; k < Math.min(view.count, slots.length); k++) {
    const slot = slots[k];
    if (slot === undefined || (view.skip?.(k) ?? false)) {
      continue;
    }
    const land = landFrame(k);
    if (land !== null && frame < land) {
      continue;
    }
    const since = land === null ? 99 : time - land;
    const squash = since < 14 ? Math.exp(-since / 4) * Math.cos(since * 0.5) : 0;
    const p = slotAt(slot, view);
    const color = slotColor(k, slot.warm);
    glyph(g, ctx, slot.ch, p.x, p.y + squash * p.size * 0.12, p.size, {
      face: 'mono',
      weight: 800,
      color: view.shade !== undefined && view.shade > 0 ? shadeOf(color, view.shade) : color,
      rot: slot.rot,
      sx: 1 + 0.3 * squash,
      sy: 1 - 0.38 * squash,
    });
  }
}

function shadeOf(color: string, shade: number): string {
  const n = Number.parseInt(color.slice(1), 16);
  const k = 1 - clamp(shade);
  const c = (s: number): number => Math.round(((n >> s) & 255) * k);
  return `#${((c(16) << 16) | (c(8) << 8) | c(0)).toString(16).padStart(6, '0')}`;
}

/** The probe of the take's seed the slot cache keys on. */
function hashProbe(): number {
  return Math.floor(hash(7, 12345) * 1e9);
}

export interface Faller {
  ch: string;
  /** Where it leaves from and lands, in the current space. */
  from: { x: number; y: number; size: number; rot: number };
  to: { x: number; y: number; size: number; rot: number };
  start: number;
  fall: number;
  color: string;
  key: number;
}

/**
 * A letter in flight, closed-form in the frame: it hops up, falls on a
 * parabola to its slot, tumbling, and stretches along its speed. Before its
 * start and after it lands it is not drawn here.
 */
export function drawFaller(g: G, ctx: Ctx, time: number, f: Faller): void {
  const t = time - f.start;
  // Gone on its landing frame's every sub-frame, so the landing reads as one crisp hit, never a double.
  if (t < 0 || Math.round(time) - f.start >= f.fall) {
    return;
  }
  const u = t / f.fall;
  const pop = 5 + 3 * hash(f.key, 31);
  const dy = f.to.y - f.from.y;
  const gravity = (2 * (dy + pop * f.fall)) / (f.fall * f.fall);
  const y = f.from.y - pop * t + 0.5 * gravity * t * t;
  const x = lerp(f.from.x, f.to.x, outCubic(u * 0.85 + 0.15 * u));
  const vy = -pop + gravity * t;
  const spin = (hash(f.key, 32) < 0.5 ? -1 : 1) * TAU * (0.25 + 0.5 * hash(f.key, 33));
  const rot = lerp(f.from.rot, f.to.rot + spin, u);
  const size = lerp(f.from.size, f.to.size, u);
  const stretch = clamp(Math.abs(vy) / 40, 0, 0.35);
  glyph(g, ctx, f.ch, x, y, size, {
    face: 'mono',
    weight: 800,
    color: f.color,
    rot: rot * (1 - stretch) ,
    sx: 1 - stretch * 0.35,
    sy: 1 + stretch,
  });
}
