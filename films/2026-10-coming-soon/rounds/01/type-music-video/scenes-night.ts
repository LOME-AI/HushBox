import {
  ASK_FROM,
  DELETE_FALL,
  DELETE_WORDS,
  DOUBT,
  DOUBT_LEAD,
  DOUBT_LINES,
  DROP_FALL,
  HEAP,
  LAPSE_DROPS,
  LOL_DELETE,
  LOL_FALL,
  OPENING_LINES,
  OPENING_TEXT,
  PRESS,
  TYPE_FRAMES,
  WISH,
  WISH_DROP,
  WISH_FAST_FROM,
  WISH_LINES,
  bf,
} from './beats.js';
import { CALM, PHONE, LOOK_UP, SIT, blend, blinking, figure } from './figure.js';
import { drawFaller, drawHeap, heapSlots, slotAt, slotColor } from './heap.js';
import { CX, CY, DEFAULT, P, SNAPPY, clamp, inCubic, outCubic, env, hash, lerp, prog, smooth, springOf } from './kit.js';
import { FLOOR, charAt, composer, composerHeight, phoneGlow, room, sendAt } from './room.js';
import { fontOf, glyph, metric } from './type.js';

import type { Faller, HeapView } from './heap.js';
import type { G } from './kit.js';
import type { Face, Pose } from './figure.js';
import type { ComposerLayout } from './room.js';
import type { Ctx } from './type.js';
import type { LookBox } from '../../../../engine/look/index.js';

export interface Cam {
  x: number;
  y: number;
  z: number;
  r?: number;
}

/** World to screen: the point (x, y) at the frame's centre, zoomed by z, rolled by r. */
export function camera(g: G, cam: Cam): void {
  g.translate(CX, CY);
  if (cam.r !== undefined && cam.r !== 0) {
    g.rotate(cam.r);
  }
  g.scale(cam.z, cam.z);
  g.translate(-cam.x, -cam.y);
}

/** A camera between two framings, zoom interpolated in log space. */
export function camLerp(a: Cam, b: Cam, u: number): Cam {
  return {
    x: lerp(a.x, b.x, u),
    y: lerp(a.y, b.y, u),
    z: Math.exp(lerp(Math.log(a.z), Math.log(b.z), u)),
    r: lerp(a.r ?? 0, b.r ?? 0, u),
  };
}

const ROOM_HEAP: Omit<HeapView, 'count'> = { x: 320, y: FLOOR + 6, unit: 46 };
const HER = { x: 745, s: 215 };
/** Where she stands through the opening and the deletion, nearer the heap, so the close frame holds her and "lol" together. */
const HER_OPENING_X = 640;

/** Her phone in her right hand: an I with a lit face. */
const PHONE_HELD = { ch: 'I', color: P.teal, size: 0.34 };

/** The hand that is typing taps up a little on every keystroke. */
function tapping(pose: Pose, time: number, keys: readonly number[]): Pose {
  const tap = env(time, keys, 1.6);
  return { ...pose, handR: [pose.handR[0], pose.handR[1] - 0.035 * clamp(tap)], holds: PHONE_HELD };
}

function handAt(pose: Pose, x = HER.x): { x: number; y: number } {
  return { x: x + pose.handR[0] * HER.s, y: FLOOR + pose.handR[1] * HER.s };
}

/** Index in the doubt of each word's first character. */
function wordStart(text: string, word: string, fromEnd: number): number {
  let index = text.length;
  for (let k = 0; k <= fromEnd; k++) {
    index = text.lastIndexOf(word, index - 1);
  }
  return index;
}

/** The opening's composer, low over her head, so its question, her and the floor share one close frame. */
const OPENING_LAYOUT: ComposerLayout = { x: 214, y: 860, width: 620, size: 64, lines: OPENING_LINES };
/** The room's window through the nights, high on the wall above the composer. */
const NIGHT_WINDOW = { x: 830, y: 430, size: 400 };

function typedAt(frame: number, from: number, step: number, length: number): number {
  return clamp(Math.floor((frame - from) / step) + 1, 0, length);
}

/** A pose that steps through keyframes, easing into each over `ease` frames from its frame. */
function keyed(time: number, keys: readonly (readonly [number, Pose])[], ease = 8): Pose {
  let pose = keys[0]?.[1] ?? PHONE;
  for (const [at, next] of keys.slice(1)) {
    const u = smooth(prog(time, at, at + ease));
    if (u > 0) {
      pose = blend(pose, next, u);
    }
  }
  return pose;
}

/** The frame character i of the opening's text appears. */
function doubtAppears(i: number): number {
  return -DOUBT_LEAD + i * TYPE_FRAMES;
}

const TYPING_FACE: Face = { eyes: 'dot', mouth: 'flat', brow: -0.25, look: [0.1, 0.9] };

/** The opening's camera: close on the question, a whip down with "lol" to the floor, then a slow push. */
function doubtCam(time: number): Cam {
  const close: Cam = { x: 487, y: 1000, z: 2.25 };
  const landed: Cam = { x: 523, y: 1242, z: 1.74 };
  const settled: Cam = { x: 521, y: 1232, z: 1.8 };
  const opening = camLerp({ ...close, z: 2.18 }, close, prog(time, 0, bf(LOL_DELETE)));
  const whip = smooth(prog(time, bf(LOL_DELETE) - 2, bf(1)));
  const settle = smooth(prog(time, bf(1) + 6, bf(4)));
  return camLerp(camLerp(opening, landed, whip), settled, settle);
}

/** Where the opening's text ends once "lol" is gone: after "job". */
const LOL_FROM = DOUBT.length + 1;

/**
 * Beats 0–4: close on the composer, she types the question and "lol" after it,
 * smirking; on the half beat she deletes "lol", the camera whips down with it
 * and it lands on the floor large and loud on 1; she flinches, looks up at the
 * question left behind, and hesitates.
 */
export function doubt(g: G, ctx: Ctx, frame: number, time: number): LookBox[] {
  const gone = bf(LOL_DELETE);
  const land = gone + LOL_FALL;
  g.save();
  camera(g, doubtCam(time));
  room(g, ctx, time, { moon: 0.25, window: NIGHT_WINDOW });
  const keys = [...OPENING_TEXT].map((_, i) => doubtAppears(i)).filter((f) => f <= time).concat(time >= gone ? [gone] : []);
  const typing = tapping({ ...PHONE, face: TYPING_FACE }, time, keys);
  const landed = clamp(env(time, [land], 4));
  const pose = keyed(time, [
    [0, { ...typing, face: { eyes: 'dot', mouth: 'smile', brow: 0.15, look: [0.15, 0.9] } }],
    [gone - 5, { ...typing, face: { eyes: 'dot', mouth: 'flat', brow: -0.45, look: [0.1, 0.9] } }],
    [gone, { ...typing, head: 0.06, face: { eyes: 'wince', mouth: 'wavy', brow: -0.6, look: [0, 0.5] } }],
    [gone + 6, { ...typing, head: 0.3, lean: -0.04, face: { eyes: 'wide', mouth: 'flat', brow: -0.3, look: [-0.9, 1], raise: 0.4 } }],
    [land, { ...typing, head: 0.36, lean: -0.07, face: { eyes: 'wide', mouth: 'o', brow: -0.2, look: [-1, 1], raise: 0.9 } }],
    [land + 18, { ...typing, head: 0.28, face: { eyes: 'dot', mouth: 'frown', brow: -0.6, look: [-1, 0.9] } }],
    [62, { ...LOOK_UP, holds: PHONE_HELD, handL: [-0.12, -0.5], handR: [0.18, -0.58], face: { eyes: 'wide', mouth: 'wavy', brow: -0.75, look: [-0.3, -1] } }],
    [90, { ...LOOK_UP, head: -0.12, holds: PHONE_HELD, handL: [-0.3, -0.42], handR: [0.26, -0.82], face: { eyes: 'dot', mouth: 'flat', brow: -0.5, look: [-0.9, -0.2] } }],
  ]);
  const wobble = time >= land ? 0.14 * Math.sin((time - land) * 0.9) * Math.exp(-(time - land) / 6) : 0;
  const shaken: Pose = { ...pose, head: pose.head + wobble, squash: 0.09 * landed - 0.03 * clamp(env(time, [100], 6)), face: blinking(pose.face ?? TYPING_FACE, time, 40) };
  const hand = handAt(shaken, HER_OPENING_X);
  phoneGlow(g, hand.x, hand.y, OPENING_LAYOUT.y + composerHeight(OPENING_LAYOUT), 1);
  drawHeap(g, ctx, frame, time, { ...ROOM_HEAP, count: HEAP.first });
  figure(g, ctx, HER_OPENING_X, FLOOR, HER.s, shaken);
  const shown = (i: number): { at: number | null } | false => {
    const at = doubtAppears(i);
    return frame >= at && (i < LOL_FROM || frame < gone) ? { at } : false;
  };
  let typed = 0;
  while (typed < OPENING_TEXT.length && shown(typed) !== false) {
    typed += 1;
  }
  // The question is the opening's read from the landing on; before it the close frame crops it like any picture.
  const boxes = composer(g, ctx, frame, time, OPENING_LAYOUT, {
    shown,
    cursor: frame >= gone ? DOUBT.length : typed,
    lit: 1,
    press: 0,
    report: { id: 'doubt', words: DOUBT, role: frame >= land ? 'headline' : 'imagery' },
  });
  // "lol" leaves the line as one word, hops, and falls with the camera to its place at the bottom of the heap.
  const slots = heapSlots(slotSeed());
  [...'lol'].forEach((ch, j) => {
    const from = charAt(g, ctx, OPENING_LAYOUT, LOL_FROM + j);
    const slot = slots[j];
    if (from !== null && slot !== undefined) {
      const to = slotAt(slot, { ...ROOM_HEAP, count: HEAP.first });
      drawFaller(g, ctx, time, faller(ch, from, OPENING_LAYOUT.size, to, slot.rot, gone, LOL_FALL, 0, slotColor(j, false)));
    }
  });
  // The thud: dots and stars thrown along the floor from under the word, and a dust line.
  const since = Math.round(time) - land;
  const mid = slots[1] === undefined ? null : slotAt(slots[1], { ...ROOM_HEAP, count: HEAP.first });
  if (mid !== null && since >= 0 && since < 22) {
    const spread = outCubic(since / 22);
    for (let d = 0; d < 14; d++) {
      const side = d % 2 === 0 ? -1 : 1;
      const a = (0.15 + 0.7 * hash(d, 61)) * Math.PI;
      const rr = 60 + 260 * spread * (0.6 + 0.4 * hash(d, 62));
      const x = mid.x + side * (90 + Math.abs(Math.cos(a)) * rr * 1.3);
      const y = FLOOR - 10 - Math.sin(a) * rr * 0.55 * (1 - inCubic(since / 22));
      glyph(g, ctx, d % 4 === 0 ? '*' : '·', x, y, d % 4 === 0 ? 40 : 70, { face: 'sans', weight: 900, color: P.cream, alpha: 0.9 * (1 - since / 22) });
    }
  }
  g.restore();
  return boxes;
}

/** The doubt's words as they are deleted from the end: each word's first index, its letters, its beat, its first slot. */
function deletions(): { start: number; word: string; beat: number; slot: number }[] {
  let slot = HEAP.first;
  const seen = new Map<string, number>();
  return DELETE_WORDS.map(([word, beat]) => {
    const n = seen.get(word) ?? 0;
    seen.set(word, n + 1);
    const out = { start: wordStart(DOUBT, word, n), word, beat, slot };
    slot += word.length;
    return out;
  });
}

/** Beats 4–8: backspace eats the doubt word by word; each word falls and lands on the heap at her feet; she watches each one go. */
export function deleteScene(g: G, ctx: Ctx, frame: number, time: number): LookBox[] {
  // The tilt's spring starts a frame early, so its whoosh frame is the first that moves.
  const tilt = springOf(time, bf(6) - 1, DEFAULT);
  const cam = camLerp({ x: 520, y: 1100, z: 1.2 }, { x: 450, y: 1330, z: 1.62, r: -0.07 }, tilt);
  g.save();
  camera(g, cam);
  room(g, ctx, time, { moon: 0.28, window: NIGHT_WINDOW });
  const dels = deletions();
  const gone = dels.filter((d) => frame >= bf(d.beat));
  const cut = gone.length === 0 ? DOUBT.length : Math.min(...gone.map((d) => d.start));
  const lands = dels.map((d) => bf(d.beat) + DELETE_FALL);
  const flinch = clamp(env(time, lands, 4));
  const deleting: Pose = tapping({ ...PHONE, face: { eyes: 'dot', mouth: 'frown', brow: -0.6, look: [-0.5, 0.9] } }, time, dels.map((d) => bf(d.beat)));
  const pose = keyed(time, [
    [bf(4), deleting],
    [bf(5.5), { ...deleting, head: 0.25, face: { eyes: 'dot', mouth: 'frown', brow: -0.8, look: [-1, 1] } }],
    [bf(6), { ...deleting, head: -0.32, lean: -0.06, handL: [-0.34, -0.36], face: { eyes: 'wide', mouth: 'o', brow: -0.4, look: [-1, 1], raise: 0.7 } }],
    [bf(7), { ...deleting, hipY: 0.34, head: -0.4, lean: -0.1, handL: [-0.36, -0.3], footL: [-0.22, 0], face: { eyes: 'dot', mouth: 'frown', brow: -0.85, look: [-1, 0.8] } }],
  ], 6);
  const watched: Pose = { ...pose, squash: 0.05 * flinch, face: blinking(pose.face ?? CALM, time, 70) };
  const hand = handAt(watched, HER_OPENING_X);
  phoneGlow(g, hand.x, hand.y, OPENING_LAYOUT.y + composerHeight(OPENING_LAYOUT), 1 - 0.4 * clamp(tilt));
  drawHeap(g, ctx, frame, time, { ...ROOM_HEAP, count: HEAP.first + 20 });
  figure(g, ctx, HER_OPENING_X, FLOOR, HER.s, watched);
  composer(g, ctx, frame, time, OPENING_LAYOUT, {
    shown: (i) => (i < cut ? { at: null } : false),
    cursor: cut === DOUBT.length ? cut : Math.max(0, cut - 1),
    lit: cut > 1 ? 1 : 0,
    press: 0,
    report: null,
  });
  const slots = heapSlots(slotSeed());
  for (const d of dels) {
    [...d.word].forEach((ch, j) => {
      const from = charAt(g, ctx, OPENING_LAYOUT, d.start + j);
      const slot = slots[d.slot + j];
      if (from === null || slot === undefined) {
        return;
      }
      const to = slotAt(slot, { ...ROOM_HEAP, count: HEAP.first + 20 });
      drawFaller(g, ctx, time, faller(ch, from, OPENING_LAYOUT.size, to, slot.rot, bf(d.beat), DELETE_FALL, d.slot + j, slotColor(d.slot + j, false)));
    });
  }
  g.restore();
  return [];
}

function faller(ch: string, from: { x: number; y: number }, size: number, to: { x: number; y: number; size: number }, rot: number, start: number, fall: number, key: number, color: string): Faller {
  return { ch, from: { ...from, size, rot: 0 }, to: { x: to.x, y: to.y, size: to.size, rot }, start, fall, color, key };
}

/** The seed probe the heap's slot cache is keyed on. */
export function slotSeed(): number {
  return Math.floor(hash(7, 12345) * 1e9);
}

/** Every letter of a composer's text dropped at once onto consecutive slots from `firstSlot`. */
function dropLine(g: G, ctx: Ctx, time: number, layout: ComposerLayout, text: string, firstSlot: number, start: number, view: HeapView): void {
  const slots = heapSlots(slotSeed());
  let slot = firstSlot;
  [...text].forEach((ch, i) => {
    if (ch === ' ') {
      return;
    }
    const from = charAt(g, ctx, layout, i);
    const s = slots[slot];
    if (from !== null && s !== undefined) {
      const to = slotAt(s, view);
      // Each letter leaves a frame or two after its neighbour, so the line peels off rather than dropping as a slab.
      const stagger = Math.floor(hash(slot, 51) * 3);
      drawFaller(g, ctx, time, faller(ch, from, layout.size, to, s.rot, start + stagger, DROP_FALL - stagger, slot, slotColor(slot, s.warm)));
    }
    slot += 1;
  });
}


/** A day passing in the time-lapse: the room floods with pale light and drains again, peaking on 9. */
function daySwell(time: number): number {
  const d = Math.abs(time - bf(9)) / 12;
  return d >= 1 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * d);
}

/** Beats 8–10: night after night, the line is typed and dropped whole; the heap jumps at the cut, the moon between drops. */
export function nights(g: G, ctx: Ctx, frame: number, time: number): LookBox[] {
  const u = prog(time, bf(8), bf(10));
  g.save();
  camera(g, camLerp({ x: 540, y: 1160, z: 0.88 }, { x: 590, y: 1140, z: 0.92 }, u));
  const second = frame >= bf(9);
  room(g, ctx, time, { moon: second ? 0.85 : 0.55, day: daySwell(time), window: NIGHT_WINDOW });
  const layout: ComposerLayout = { x: 110, y: 640, width: 860, size: 66, lines: DOUBT_LINES };
  const view = { ...ROOM_HEAP, count: HEAP.lapseDrops[1] + 20 };
  drawHeap(g, ctx, frame, time, view);
  const flinch = env(time, LAPSE_DROPS.map((b) => bf(b) + DROP_FALL), 4);
  const sad: Face = { eyes: 'dot', mouth: 'frown', brow: -0.7, look: [-0.9, 0.4] };
  const pose = second ? { ...SIT, squash: 0.05 * clamp(flinch), holds: PHONE_HELD, face: blinking(sad, time, 10) } : { ...PHONE, squash: 0.05 * clamp(flinch), holds: PHONE_HELD, face: { ...sad, look: [0, 0.9] as const } };
  const hand = handAt(pose);
  phoneGlow(g, hand.x, hand.y, layout.y + composerHeight(layout), 0.8);
  figure(g, ctx, HER.x + (second ? 30 : 0), FLOOR, HER.s, pose);
  const retype = bf(9);
  const shown = (i: number): { at: number | null } | false => {
    if (frame < bf(LAPSE_DROPS[0])) {
      return { at: null };
    }
    if (frame < retype) {
      return false;
    }
    const at = retype + Math.floor(i / 2);
    return frame < bf(LAPSE_DROPS[1]) && frame >= at ? { at } : false;
  };
  const typed = frame < bf(LAPSE_DROPS[0]) ? DOUBT.length : frame < retype ? 0 : frame < bf(LAPSE_DROPS[1]) ? Math.min(DOUBT.length, (frame - retype) * 2 + 2) : 0;
  composer(g, ctx, frame, time, layout, { shown, cursor: typed, lit: typed > 0 ? 1 : 0, press: 0, report: null });
  dropLine(g, ctx, time, layout, DOUBT, HEAP.lapseDrops[0], bf(LAPSE_DROPS[0]), view);
  dropLine(g, ctx, time, layout, DOUBT, HEAP.lapseDrops[1], bf(LAPSE_DROPS[1]), view);
  g.restore();
  return [];
}

/** Beats 10–12: the heap is over her head now; she types the wish, fast, and drops that too. */
export function wish(g: G, ctx: Ctx, frame: number, time: number): LookBox[] {
  const u = prog(time, bf(10), bf(12));
  g.save();
  camera(g, camLerp({ x: 470, y: 1180, z: 1.02 }, { x: 450, y: 1150, z: 1.12 }, u));
  room(g, ctx, time, { moon: 0.95, window: NIGHT_WINDOW });
  const layout: ComposerLayout = { x: 90, y: 660, width: 900, size: 72, lines: WISH_LINES };
  const view = { ...ROOM_HEAP, count: HEAP.total };
  drawHeap(g, ctx, frame, time, view);
  const landed = env(time, [bf(WISH_DROP) + DROP_FALL], 4);
  const lookUp = springOf(time, bf(WISH_DROP), DEFAULT);
  const keys = [...WISH].map((_, i) => WISH_FAST_FROM + i / 2).filter((f) => f <= time && f < bf(WISH_DROP));
  const typing = tapping({ ...PHONE, face: { eyes: 'dot', mouth: 'smile', brow: 0.15, look: [0.2, 0.9] } }, time, keys);
  const drop = keyed(time, [[0, typing], [bf(WISH_DROP) - 2, { ...typing, face: { eyes: 'wince', mouth: 'wavy', brow: -0.6, look: [0, 0.5] } }]], 4);
  const pose: Pose = { ...blend(drop, { ...LOOK_UP, face: { eyes: 'wide', mouth: 'o', brow: -0.5, look: [-0.7, -1], raise: 0.7 } }, lookUp), squash: -0.06 * clamp(landed), holds: PHONE_HELD };
  const hand = handAt(pose);
  phoneGlow(g, hand.x, hand.y, layout.y + composerHeight(layout), 1 - 0.5 * clamp(lookUp));
  figure(g, ctx, HER.x + 20, FLOOR, HER.s, pose);
  // Two characters a frame, so the whole wish is on screen for most of a beat before it drops.
  const typed = frame < bf(WISH_DROP) ? typedAt(frame, WISH_FAST_FROM, 0.5, WISH.length) : 0;
  composer(g, ctx, frame, time, layout, {
    shown: (i) => (i < typed ? { at: WISH_FAST_FROM + Math.floor(i / 2) } : false),
    cursor: typed,
    lit: typed > 0 ? 1 : 0,
    press: 0,
    report: null,
  });
  dropLine(g, ctx, time, layout, WISH, HEAP.wishDrop, bf(WISH_DROP), view);
  g.restore();
  return [];
}

/** Beats 12–16: close on the composer, her below it, big; she types the wish again and presses send on her phone. */
export function ask(g: G, ctx: Ctx, frame: number, time: number): LookBox[] {
  const u = prog(time, bf(12), bf(16));
  const inhale = prog(time, bf(PRESS), bf(16));
  g.save();
  const down = springOf(time, bf(14), DEFAULT);
  camera(g, camLerp(camLerp({ x: 540, y: 960, z: 1 }, { x: 545, y: 930, z: 1.05 + 0.04 * inhale }, u), { x: 545, y: 1100, z: 1.05 + 0.04 * inhale }, clamp(down, 0, 1.05)));
  g.save();
  camera(g, { x: 560, y: 760, z: 1.35 });
  room(g, ctx, time, { moon: 0.6, window: { x: 860, y: 1040, size: 520 } });
  g.restore();
  // The heap's top, close and dim at the left, its warm letters catching the light.
  drawHeap(g, ctx, frame, time, { x: 250, y: 2330, unit: 86, count: HEAP.total, shade: 0.35 });
  const layout: ComposerLayout = { x: 70, y: 480, width: 940, size: 88, lines: WISH_LINES };
  const typed = typedAt(frame, ASK_FROM, TYPE_FRAMES, WISH.length);
  const pressAt = bf(PRESS);
  const press = env(time, [pressAt], 3);
  // Her, close and low in the frame, the phone at her chest lighting her face; on 15 she lifts it, on 15.5 her thumb comes down on send.
  const keys = [...WISH].map((_, i) => ASK_FROM + i * TYPE_FRAMES).filter((f) => f <= time);
  const lift = springOf(time, bf(15), SNAPPY) - springOf(time, pressAt, SNAPPY);
  const set: Face = lift > 0.3 ? { eyes: 'wide', mouth: 'flat', brow: 0.5, look: [0.4, -1], raise: 0.3 } : { eyes: 'dot', mouth: 'flat', brow: 0.45, look: [0.5, -0.9] };
  const face: Face = press > 0.3 ? { eyes: 'wince', mouth: 'flat', brow: 0.6, look: [0, 0] } : blinking(set, time, 120);
  const base = tapping({ ...PHONE, head: -0.12, face }, time, keys);
  const pose: Pose = {
    ...base,
    handR: [base.handR[0] + 0.02, base.handR[1] - 0.12 * lift + 0.05 * clamp(press)],
    handL: [base.handL[0], base.handL[1] - 0.1 * lift],
    squash: 0.05 * clamp(press) - 0.03 * lift,
  };
  const herX = 760;
  const herY = 2240;
  const herS = 620;
  const hand = { x: herX + pose.handR[0] * herS, y: herY + pose.handR[1] * herS };
  phoneGlow(g, hand.x, hand.y, layout.y + composerHeight(layout), 1 + 0.8 * clamp(press));
  figure(g, ctx, herX, herY, herS, pose);
  if (press > 0.05) {
    // A ring off the phone as the message goes.
    const ring = (time - pressAt) / 14;
    glyph(g, ctx, 'O', hand.x, hand.y, 80 + 500 * ring, { face: 'sans', weight: 200, color: P.amberHot, alpha: clamp(1 - ring) * 0.8 });
  }
  const boxes = composer(g, ctx, frame, time, layout, {
    shown: (i) => (i < typed ? { at: ASK_FROM + i * TYPE_FRAMES } : false),
    cursor: typed,
    lit: typed > 0 ? 1 : 0,
    press: clamp(press),
    report: { id: 'ask', words: WISH, role: 'headline' },
  });
  g.restore();
  return boxes;
}

void CY;
void sendAt;
void metric;
void fontOf;
