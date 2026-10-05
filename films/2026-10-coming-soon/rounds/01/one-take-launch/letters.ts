import { FLOOR_Y, Z_FACADE, Z_HER, onLayer, onScreen, proj, scaleAt, visible } from './camera.js';
import { INK, PLAYFUL, SNAPPY, TAU, bf, clamp, hash, hs, lerp, mix, prog, rgba, spring } from './kit.js';
import { BEAT, Q1, RAIN } from './score.js';
import { fontOf } from './type.js';
import { BOARD, nightness } from './world.js';

import type { Cam } from './camera.js';
import type { G } from './kit.js';
import type { LookContext, TextBox } from '../../../../engine/look/index.js';

type Ctx = LookContext<'2d'>;

/** Where the pile sits on her layer, beside her. */
export const PILE_X = 486;

interface Slot {
  x: number;
  y: number;
  rot: number;
  size: number;
}

/** Places in the heap, bottom layers first: a mound beside her. */
function slots(): Slot[] {
  const out: Slot[] = [];
  const half = 66;
  const peak = 62;
  for (let row = 0; row < 14; row++) {
    const y = FLOOR_Y - 8 - row * 6.2;
    const lift = row * 6.2;
    const reach = half * Math.sqrt(Math.max(0, 1 - lift / peak));
    const step = 11.5;
    const offset = (row % 2) * (step / 2);
    for (let x = -reach + offset; x <= reach; x += step) {
      const id = out.length;
      out.push({
        x: PILE_X + x + hs(id, 31) * 2.5,
        y: y + hs(id, 32) * 2,
        rot: hs(id, 33) * 0.9,
        size: 15 + hash(id, 34) * 4,
      });
    }
  }
  return out;
}
const SLOTS = slots();
function slotAt(i: number): Slot {
  const s = SLOTS[i];
  if (s === undefined) {
    throw new Error(`one-take-launch: the pile has no slot ${String(i)}; it holds ${String(SLOTS.length)}`);
  }
  return s;
}

/** Letters already deleted before the film: the pile she has been building, night after night. */
const OLD_COUNT = 44;
const ALPHABET = 'etaoinshrdlucmfwypvbgkqjxz';
function oldGlyph(i: number): string {
  // Weighted towards common letters, as typed words are.
  const u = hash(i, 41);
  return ALPHABET.charAt(Math.floor(u * u * ALPHABET.length));
}

/**
 * The deletion of the question, in the groups the backspace takes, last first:
 * job, my, quit, then "crazy to" and "is it" together as the key repeats.
 * Each group's `start` is the index of its first character in the line.
 */
export const POPS: { start: number; end: number }[] = [
  { start: 23, end: 26 },
  { start: 20, end: 22 },
  { start: 15, end: 19 },
  { start: 6, end: 14 },
  { start: 0, end: 5 },
];

interface Falling {
  ch: string;
  /** Which line it fell from, and its index in that line. */
  line: 'rain' | 'q1';
  index: number;
  launch: number;
  land: number;
  slot: number;
}

/** How many of the earlier attempt's letters land on each rain beat. */
const RAIN_GROUPS = [5, 5, 4, 4] as const;
/** Frames a rained letter is in the air. */
const RAIN_FLIGHT = 26;

const FALLING: Falling[] = (() => {
  const out: Falling[] = [];
  let next = OLD_COUNT;
  // The earlier attempt: its letters are already falling on frame 0.
  const rain = [...RAIN].map((ch, index) => ({ ch, index })).filter(({ ch }) => ch !== ' ');
  let group = 0;
  let inGroup = 0;
  for (const { ch, index } of rain) {
    const land = bf(BEAT.rain[group] ?? 0);
    out.push({ ch, line: 'rain', index, launch: land - RAIN_FLIGHT - (inGroup % 3) * 2, land, slot: next });
    next += 1;
    inGroup += 1;
    if (inGroup === (RAIN_GROUPS[group] ?? 4)) {
      group += 1;
      inGroup = 0;
    }
  }
  POPS.forEach(({ start, end }, g) => {
    const launch = bf(BEAT.pops[g] ?? 0);
    for (let index = start; index < end; index++) {
      const ch = Q1.charAt(index);
      if (ch !== ' ') {
        out.push({ ch, line: 'q1', index, launch, land: launch + 30, slot: next });
        next += 1;
      }
    }
  });
  return out;
})();

/** O, P, E and N leave the pile from where the earlier attempt's "open" landed. */
const OPEN_FROM: { ch: string; slot: number }[] = (() => {
  const rain = FALLING.filter((f) => f.line === 'rain');
  const word = RAIN.indexOf('open');
  return [...'open'].map((ch, i) => ({ ch, slot: rain.find((f) => f.index === word + i)?.slot ?? 0 }));
})();

function glyphAt(slot: number): string {
  const falling = FALLING.find((f) => f.slot === slot);
  return falling?.ch ?? oldGlyph(slot);
}

/** The frame a group of words leaves the line. */
export function popFrame(group: number): number {
  return bf(BEAT.pops[group] ?? 0);
}

/** The frame each letter of OPEN leaves the pile, and lands on the board. */
function openLaunch(i: number): number {
  return bf((BEAT.letters[i] ?? 0) - 1);
}
function openLand(i: number): number {
  return bf(BEAT.letters[i] ?? 0);
}

function letterFill(time: number): string {
  return mix('#efe6d4', '#fbf4e6', 1 - nightness(time));
}

/** One letter as a physical piece: a cream glyph with a darker edge, so it reads as a thing, not type. */
function glyph(g: G, ctx: Ctx, ch: string, size: number, fill: string): void {
  g.font = fontOf(ctx, 'sans', 800, size);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = size * 0.12;
  g.strokeStyle = rgba('#3a3040', 0.55);
  g.strokeText(ch, 0, 0);
  g.fillStyle = fill;
  g.fillText(ch, 0, 0);
}

/** The pile on her layer: every letter that has landed, minus those OPEN has taken. */
export function drawPile(g: G, ctx: Ctx, cam: Cam, time: number): void {
  if (!visible(cam, Z_HER)) {
    return;
  }
  onLayer(g, cam, Z_HER);
  // A soft shadow under the heap.
  g.fillStyle = rgba('#000000', 0.28);
  g.beginPath();
  g.ellipse(PILE_X, FLOOR_Y - 2, 76, 9, 0, 0, TAU);
  g.fill();
  const fill = letterFill(time);
  for (let i = 0; i < OLD_COUNT + FALLING.length; i++) {
    const falling = FALLING.find((f) => f.slot === i);
    let squash = 0;
    if (falling !== undefined) {
      if (time < falling.land) {
        continue;
      }
      // It lands flat and springs back, overshooting tall before it settles.
      squash = 1 - spring(time, falling.land, PLAYFUL);
    }
    const open = OPEN_FROM.findIndex((o) => o.slot === i);
    if (open >= 0 && time >= openLaunch(open)) {
      continue;
    }
    const s = slotAt(i);
    g.save();
    g.translate(s.x, s.y + squash * 6);
    g.rotate(s.rot * (1 - 0.5 * squash));
    g.scale(1 + 0.75 * squash, 1 - 0.62 * squash);
    glyph(g, ctx, glyphAt(i), s.size, fill);
    g.restore();
  }
}

/** Where a character of a composer line sits on screen, as the composer sets it. */
export interface LineLayout {
  x: (line: 'rain' | 'q1', index: number) => number;
  y: number;
  size: number;
}

/**
 * The falling letters: the earlier attempt's, already in the air on frame 0,
 * and then the question's, each group leaving the line on its pop. Each
 * letter lifts, breaks loose and falls on its own arc, stretching as it
 * speeds up, into its place in the pile; from its land frame the pile draws
 * it, squashed. Drawn in screen space.
 */
export function drawFalling(g: G, ctx: Ctx, cam: Cam, time: number, line: LineLayout): void {
  const fill = letterFill(time);
  onScreen(g, null);
  const k = scaleAt(cam, Z_HER);
  for (const f of FALLING) {
    if (time < f.launch || time >= f.land) {
      continue;
    }
    const u = (time - f.launch) / (f.land - f.launch);
    const s = slotAt(f.slot);
    const [tx, ty] = proj(cam, s.x, s.y, Z_HER);
    const sx = line.x(f.line, f.index);
    const sy = line.y;
    const lift = f.line === 'q1' ? 150 : 60;
    const x = lerp(sx, tx, 1 - (1 - u) * (1 - u)) + hs(f.slot, 51) * 40 * Math.sin(Math.PI * u);
    const y = sy + (ty - sy) * u * u - lift * u * (1 - u) * 2;
    const size = lerp(line.size, s.size * k, u) * (1 + 0.3 * Math.sin(Math.PI * Math.min(1, u * 3)));
    const spin = Math.round(hs(f.slot, 52) * 1.5);
    // Stretched along its fall as it speeds up.
    const stretch = 0.45 * u * u;
    g.save();
    g.translate(x, y);
    g.scale(1 - 0.3 * stretch, 1 + stretch);
    g.rotate(lerp(0, s.rot + spin * TAU, u * u));
    glyph(g, ctx, f.ch, size, fill);
    g.restore();
  }
}

/** The board's letters, centred on the felt: O, P, E, N. */
const OPEN_SIZE = 98;
const OPEN_PITCH = 92;
function boardSpot(i: number): [number, number] {
  return [540 + (i - 1.5) * OPEN_PITCH, BOARD.y + BOARD.h / 2 + 4];
}

/**
 * O, P, E and N leave the pile on their beats, swing out through the open
 * doorway and up onto the board, flipping to capitals on the way, and clack
 * into place. `front` draws the part of the flight in front of the wall; the
 * rest is drawn behind it, inside the doorway.
 */
export function drawOpenFlight(g: G, ctx: Ctx, cam: Cam, time: number, front: boolean): void {
  const fill = letterFill(time);
  OPEN_FROM.forEach(({ ch, slot }, i) => {
    const launch = openLaunch(i);
    const land = openLand(i);
    if (time < launch || time >= land) {
      return;
    }
    const u = (time - launch) / (land - launch);
    const s = slotAt(slot);
    const [bx, by] = boardSpot(i);
    // Out through the doorway (z dips towards the street), then up onto the board.
    const z = lerp(Z_HER, Z_FACADE, u) - 240 * Math.sin(Math.PI * u);
    if ((z < Z_FACADE) !== front || !visible(cam, z)) {
      return;
    }
    const e = 1 - (1 - u) * (1 - u);
    // Over the top of its arc and down onto the board still moving, so it lands with a bounce.
    const x = lerp(s.x, bx, Math.min(1, u * 1.15));
    const y = lerp(s.y, by, u) - 160 * Math.sin(Math.PI * u);
    const [px, py] = proj(cam, x, y, z);
    // It swells as soon as it leaves the pile, so it reads all the way up.
    const size = lerp(s.size, OPEN_SIZE, 1 - (1 - u) ** 3) * scaleAt(cam, z);
    // A flip about the vertical: lower case before its edge, capital after.
    const flip = Math.cos(Math.PI * clamp((u - 0.3) / 0.4));
    onScreen(g, cam);
    g.save();
    g.translate(px, py);
    g.rotate(lerp(s.rot, 0, e) + 0.6 * Math.sin(Math.PI * u));
    g.scale(Math.max(0.04, Math.abs(flip)), 1);
    glyph(g, ctx, flip > 0 ? ch : ch.toUpperCase(), size, fill);
    g.restore();
  });
}

/** The letters on the board, each from its landing, with a clack; reported as one line once all four are up. */
export function drawBoardLetters(g: G, ctx: Ctx, cam: Cam, time: number, report: { from: number; to: number }): TextBox[] {
  if (!visible(cam, Z_FACADE)) {
    return [];
  }
  const s = onLayer(g, cam, Z_FACADE);
  const fill = letterFill(time);
  const lit = clamp(spring(time, bf(BEAT.open), SNAPPY));
  const boxes: TextBox[] = [];
  let x0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  OPEN_FROM.forEach(({ ch }, i) => {
    const land = openLand(i);
    if (time < land) {
      return;
    }
    const [bx, by] = boardSpot(i);
    // It lands squashed and bounces back up past its height before it settles.
    const clack = 1 - spring(time, land, PLAYFUL);
    g.save();
    g.translate(bx, by + 10 * clack);
    g.scale(1 + 0.3 * clack, 1 - 0.32 * clack);
    if (!ctx.hideText) {
      if (lit > 0) {
        g.shadowColor = rgba('#fff3d0', 0.8 * lit);
        g.shadowBlur = 24 * s * lit;
      }
      glyph(g, ctx, ch.toUpperCase(), OPEN_SIZE, mix(fill, '#ffffff', lit * 0.6));
      g.shadowBlur = 0;
    }
    g.font = fontOf(ctx, 'sans', 800, OPEN_SIZE);
    const m = g.measureText(ch.toUpperCase());
    const t = g.getTransform();
    const a = t.transformPoint({ x: -m.actualBoundingBoxLeft, y: -m.actualBoundingBoxAscent });
    const b = t.transformPoint({ x: m.actualBoundingBoxRight, y: m.actualBoundingBoxDescent });
    x0 = Math.min(x0, a.x, b.x);
    x1 = Math.max(x1, a.x, b.x);
    y0 = Math.min(y0, a.y, b.y);
    y1 = Math.max(y1, a.y, b.y);
    g.restore();
  });
  const frame = Math.round(time);
  if (Number.isFinite(x0) && frame >= report.from && frame < report.to) {
    boxes.push({ id: 'open', text: 'OPEN', role: 'headline', box: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, fontSizePx: OPEN_SIZE * s });
  }
  return boxes;
}

void prog;
void INK;
