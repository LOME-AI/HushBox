import { blob, ellipsePts, fontOf, glow, line, poly, rectPts, scribble, sketchRect, wash } from './ink.js';
import { DAY, GOLD, GOLD_HOT, H, NIGHT, PLAYFUL, TAU, VELVET, VELVET_DEEP, W, clamp, hash, hs, impact, lerp, mix, prog, rgba, smooth, spring } from './kit.js';

import type { Boil } from './ink.js';
import type { G, Pt } from './kit.js';
import type { LookContext } from '../../../../engine/look/index.js';

type Ctx = LookContext<'2d'>;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---------------------------------------------------------------- the lobby, facing the glass doors from inside

export const LOBBY_DOORS: readonly Rect[] = [
  { x: 556, y: 516, w: 219, h: 914 },
  { x: 785, y: 516, w: 219, h: 914 },
];
const GLASS_INSET = 18;

export function glassOf(door: Rect): Rect {
  return { x: door.x + GLASS_INSET, y: door.y + GLASS_INSET, w: door.w - GLASS_INSET * 2, h: door.h - GLASS_INSET * 2 - 30 };
}

/** The six pages, three down each door's glass, in the order they paste: left, right, left, right... */
export function pageRect(k: number): Rect {
  const door = LOBBY_DOORS[k % 2] as Rect;
  const glass = glassOf(door);
  const row = Math.floor(k / 2);
  const h = glass.h / 3;
  return { x: glass.x - 2, y: glass.y + row * h - 2, w: glass.w + 4, h: h + 4 };
}

export const BOARD_LEANING: readonly Pt[] = [
  [110, 1440],
  [372, 1440],
  [394, 1040],
  [132, 1040],
];

interface LobbyState {
  /** 1 night, 0 day. */
  night: number;
  /** Whether the street outside has been laid. */
  street: boolean;
  /** Dawn light behind the glass, 0 to 1. */
  dawn: number;
  /** Each page's paste, 0 not there to 1 flat on the glass; the peel takes them past 1 to falling. */
  pages: readonly number[];
  /** Frames since each page slapped onto the glass, for its squash. */
  pageAge?: readonly number[];
  /** What the pages carry, facing in. */
  pageFace: (g: G, k: number, r: Rect, b: Boil) => void;
  /** The blank board leaning on the wall. */
  board: boolean;
}

/** The night street seen through the glass: the far kerb, the lamppost's pool, the houses opposite, the moon. */
function streetBeyond(g: G, s: LobbyState, b: Boil): void {
  const day = 1 - s.night;
  const sky = g.createLinearGradient(0, 500, 0, 1430);
  sky.addColorStop(0, mix(NIGHT.sky, DAY.skyHigh, day));
  sky.addColorStop(1, mix(NIGHT.skyLow, DAY.sky, day));
  g.fillStyle = sky;
  g.fillRect(540, 500, 480, 940);
  g.fillStyle = rgba(NIGHT.moon, 0.9 * s.night);
  g.beginPath();
  g.arc(930, 640, 34, 0, TAU);
  g.fill();
  if (!s.street) {
    return;
  }
  // The houses opposite, low and dark, with a lit window or two.
  const houses = mix('#10142c', '#c99f86', day);
  g.fillStyle = houses;
  g.beginPath();
  g.moveTo(540, 1180);
  g.lineTo(640, 1180);
  g.lineTo(640, 1120);
  g.lineTo(760, 1120);
  g.lineTo(760, 1160);
  g.lineTo(880, 1160);
  g.lineTo(880, 1090);
  g.lineTo(1010, 1090);
  g.lineTo(1010, 1440);
  g.lineTo(540, 1440);
  g.closePath();
  g.fill();
  g.fillStyle = rgba('#ffd27a', 0.8 * s.night);
  g.fillRect(680, 1140, 22, 26);
  g.fillRect(920, 1110, 22, 26);
  // The pavement and the lamp's pool.
  g.fillStyle = mix('#1b2045', '#d9c3a6', day);
  g.fillRect(540, 1300, 480, 140);
  line(g, [[540, 1300], [1010, 1300]], 3, mix(NIGHT.rimSoft, DAY.ink, day), b);
  glow(g, 640, 1300, 260, NIGHT.glow, 0.5 * s.night);
  line(g, [[640, 1300], [640, 900]], 6, mix('#0c0f20', DAY.ink, day), b);
  blob(g, [[620, 880], [660, 880], [668, 910], [612, 910]], mix('#ffdf9a', '#d9c3a6', day), mix('#0c0f20', DAY.ink, day), 3, b);
  glow(g, 640, 895, 140, NIGHT.glow, 0.7 * s.night);
}

/** The doors, the glass, the pages on it. */
export function drawDoors(g: G, s: LobbyState, b: Boil): void {
  const ink = mix(NIGHT.rim, DAY.ink, 1 - s.night);
  g.save();
  g.beginPath();
  for (const door of LOBBY_DOORS) {
    const gl = glassOf(door);
    g.rect(gl.x, gl.y, gl.w, gl.h);
  }
  g.clip();
  streetBeyond(g, s, b);
  // The glass's own sheen.
  g.fillStyle = rgba('#a9b8ff', 0.06 + 0.04 * s.night);
  g.fillRect(540, 500, 480, 940);
  g.restore();
  for (const door of LOBBY_DOORS) {
    const gl = glassOf(door);
    sketchRect(g, door.x, door.y, door.w, door.h, null, ink, 5, b);
    sketchRect(g, gl.x, gl.y, gl.w, gl.h, null, ink, 3, b);
    // The push bar.
    line(g, [[door.x + 30, door.y + 520], [door.x + door.w - 30, door.y + 520]], 9, mix('#3b3a52', '#b88a3e', 1 - s.night), b);
  }
  // The pages, pasted from inside, writing toward her; backlit by the lamp at night, by the sun at dawn.
  for (let k = 0; k < 6; k++) {
    const p = s.pages[k] ?? 0;
    if (p <= 0) {
      continue;
    }
    const r = pageRect(k);
    const back = lerp(0.12, 0.6, s.dawn);
    g.save();
    // On the slap the page spreads flat against the glass, then springs back past its size and settles.
    const age = s.pageAge?.[k] ?? 99;
    const sq = age < 30 ? impact(age) : 0;
    if (sq !== 0) {
      g.translate(r.x + r.w / 2, r.y + r.h / 2);
      g.scale(1 + 0.14 * sq, 1 - 0.16 * sq);
      g.translate(-(r.x + r.w / 2), -(r.y + r.h / 2));
    }
    g.globalAlpha = clamp(p * 3);
    const paper = mix('#efe2c7', '#ffe7c9', s.dawn);
    sketchRect(g, r.x, r.y, r.w, r.h, paper, '#6b5a48', 3, b);
    g.fillStyle = rgba(s.dawn > 0 ? '#ffb98a' : NIGHT.glow, back * (s.night > 0.5 ? 0.6 : 1));
    g.fillRect(r.x, r.y, r.w, r.h);
    s.pageFace(g, k, r, b);
    g.restore();
  }
}

/** The lobby: wall, floor, the doors and the street beyond, the blank board. */
export function drawLobby(g: G, s: LobbyState, b: Boil): void {
  const day = 1 - s.night;
  g.fillStyle = mix(NIGHT.wall, DAY.wall, day);
  g.fillRect(-300, -300, W + 600, H + 600);
  // Plaster: a few soft patches.
  for (let i = 0; i < 7; i++) {
    wash(g, ellipsePts(120 + hash(i, 9) * 840, 200 + hash(i, 10) * 1100, 90 + 60 * hash(i, 11), 60 + 40 * hash(i, 12), 10), mix(NIGHT.wallDeep, DAY.wallDeep, day), 0.12, b);
  }
  // The floor and its boards, running toward the doors.
  g.fillStyle = mix(NIGHT.floor, DAY.floor, day);
  g.fillRect(-300, 1430, W + 600, H);
  const ink = mix(NIGHT.rimSoft, DAY.ink, day);
  line(g, [[-40, 1430], [1120, 1430]], 5, mix(NIGHT.rim, DAY.ink, day), b);
  for (let i = -6; i <= 8; i++) {
    line(g, [[540 + i * 70, 1430], [540 + i * 210, 2000]], 2.5, rgba(ink, 0.55), b);
  }
  // The baseboard.
  line(g, [[-40, 1404], [540, 1404]], 3, rgba(ink, 0.8), b);
  // An empty poster frame and an old sconce: the room was a cinema once.
  const frameInk = mix(NIGHT.rim, DAY.ink, day);
  sketchRect(g, 150, 470, 250, 360, mix('#181d3c', '#ead2b0', day), frameInk, 5, b);
  sketchRect(g, 172, 492, 206, 316, null, rgba(frameInk, 0.6), 2.5, b);
  for (const [tx, ty] of [[172, 492], [378, 492], [172, 808], [378, 808]] as const) {
    g.fillStyle = frameInk;
    g.beginPath();
    g.arc(tx, ty, 5, 0, TAU);
    g.fill();
  }
  blob(g, [[440, 300], [500, 300], [490, 350], [450, 350]], mix('#232a52', '#e9c98f', day), frameInk, 3, b);
  line(g, [[470, 350], [470, 380]], 4, frameInk, b);
  drawDoors(g, s, b);
  if (s.board) {
    drawBoard(g, BOARD_LEANING, [], null, s.night, b);
  }
}

/** The letter board: black felt in a wooden frame, its grooves; the letters pressed on it. */
export function drawBoard(g: G, corners: readonly Pt[], letters: readonly { ch: string; x: number; y: number; a: number }[], ctx: Ctx | null, night: number, b: Boil): void {
  const ink = mix('#3e3550', DAY.ink, 1 - night);
  poly(g, corners, '#7a5634', ink, 5, b);
  const [a, c, d, e] = corners as [Pt, Pt, Pt, Pt];
  const inset = (p: Pt, q: Pt, k: number): Pt => [lerp(p[0], q[0], k), lerp(p[1], q[1], k)];
  const felt: Pt[] = [inset(a, d, 0.05), inset(c, e, 0.05), inset(d, a, 0.05), inset(e, c, 0.05)].map((p, i) => {
    const center: Pt = [(a[0] + c[0] + d[0] + e[0]) / 4, (a[1] + c[1] + d[1] + e[1]) / 4];
    return inset(p, center, 0.06 + 0 * i);
  });
  poly(g, felt, '#111015', null, 0, b);
  // The grooves.
  const [f0, f1, f2, f3] = felt as [Pt, Pt, Pt, Pt];
  for (let i = 1; i < 14; i++) {
    const u = i / 14;
    const l = inset(f3, f0, u);
    const r = inset(f2, f1, u);
    g.strokeStyle = rgba('#3a3846', 0.8);
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(l[0], l[1]);
    g.lineTo(r[0], r[1]);
    g.stroke();
  }
  if (ctx !== null) {
    for (const l of letters) {
      g.save();
      g.globalAlpha = l.a;
      g.translate(l.x, l.y);
      g.font = fontOf(ctx, 'sans', 800, 66);
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = '#f7f2e7';
      g.fillText(l.ch, 0, 0);
      g.restore();
    }
  }
}

// ---------------------------------------------------------------- the hall: the blank screen and the rows

export const HALL_ROWS = [
  { y: 1420, width: 1060, count: 9, h: 160 },
  { y: 1215, width: 900, count: 8, h: 130 },
  { y: 1060, width: 770, count: 7, h: 108 },
  { y: 942, width: 660, count: 6, h: 90 },
] as const;

/** The row's bar: where it lies across the floor once the chart's bar has tipped into it. */
export function rowBar(r: number): Rect {
  const row = HALL_ROWS[r] as (typeof HALL_ROWS)[number];
  return { x: 540 - row.width / 2, y: row.y - 22, w: row.width, h: 24 };
}

/** The hall: dark, the screen faintly lit, teal curtains, the raked floor. */
export function drawHall(g: G, b: Boil, screenGlow: number): void {
  g.fillStyle = NIGHT.wallDeep;
  g.fillRect(-300, -300, W + 600, H + 600);
  g.fillStyle = NIGHT.floor;
  g.beginPath();
  g.moveTo(-300, 760);
  g.lineTo(1380, 760);
  g.lineTo(1380, 2300);
  g.lineTo(-300, 2300);
  g.closePath();
  g.fill();
  // The screen, blank, a little light on it.
  sketchRect(g, 190, 230, 700, 390, mix('#2a3058', '#f3e6c9', 0.35 + 0.4 * screenGlow), NIGHT.rim, 5, b);
  glow(g, 540, 425, 520, '#f3e6c9', 0.12 + 0.2 * screenGlow);
  // Curtains, teal, in folds.
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const x = 540 + side * (380 + i * 24);
      line(g, [[x, 200], [x + side * 6, 420], [x - side * 4, 640], [x + side * 8, 760]], 10, rgba(VELVET, 0.9), b);
    }
  }
  line(g, [[-40, 760], [1120, 760]], 4, NIGHT.rimSoft, b);
}

/** One row of seats: its gold bar and the seat backs that stand up out of it. */
export function drawSeatRow(g: G, r: number, time: number, land: number, b: Boil): void {
  const row = HALL_ROWS[r] as (typeof HALL_ROWS)[number];
  const bar = rowBar(r);
  const seatW = (row.width / row.count) * 0.86;
  const gap = row.width / row.count;
  // Seats stand up out of the bar one after another from the middle out, and each settles from gold to velvet on its own.
  const mid = (row.count - 1) / 2;
  let rowSettle = 0;
  for (let k = 0; k < row.count; k++) {
    const order = Math.abs(k - mid) + (k < mid ? 0.4 : 0);
    const s = Math.max(0, spring(time, land + 1 + order * 2.6, PLAYFUL.hz, PLAYFUL.damp));
    const settle = smooth(prog(time, land + 14 + order * 4 + hash(k + r * 13, 91) * 6, land + 34 + order * 4 + hash(k + r * 13, 91) * 6));
    rowSettle += settle / row.count;
    if (s <= 0) {
      continue;
    }
    const edge = mix(GOLD_HOT, '#0d1222', settle);
    const x = bar.x + k * gap + (gap - seatW) / 2;
    const h = row.h * s;
    const top = bar.y - h;
    const cr = Math.min(16, seatW * 0.22);
    g.beginPath();
    g.moveTo(x, bar.y);
    g.lineTo(x, top + cr);
    g.quadraticCurveTo(x, top, x + cr, top);
    g.lineTo(x + seatW - cr, top);
    g.quadraticCurveTo(x + seatW, top, x + seatW, top + cr);
    g.lineTo(x + seatW, bar.y);
    g.closePath();
    g.fillStyle = mix(GOLD, VELVET, settle);
    g.fill();
    g.lineWidth = 4;
    g.strokeStyle = edge;
    g.stroke();
    // Tufting: a stitched line across the back and down its middle.
    line(g, [[x + 8, top + h * 0.35], [x + seatW - 8, top + h * 0.35]], 2.5, rgba(mix(GOLD_HOT, VELVET_DEEP, settle), 0.9), null);
    line(g, [[x + seatW / 2, top + h * 0.35], [x + seatW / 2, bar.y - 4]], 2.5, rgba(mix(GOLD_HOT, VELVET_DEEP, settle), 0.7), null);
    // The armrest to its right.
    if (k < row.count - 1) {
      const ax = x + seatW + (gap - seatW) / 2;
      line(g, [[ax, bar.y], [ax, bar.y - h * 0.45]], 7, mix(GOLD, '#11162e', settle), null);
      line(g, [[ax - 9, bar.y - h * 0.45], [ax + 9, bar.y - h * 0.45]], 7, mix(GOLD, '#b8892f', settle), null);
    }
  }
  // The row's base: the bar it grew from.
  sketchRect(g, bar.x, bar.y, bar.w, bar.h, mix(GOLD, '#2a2f55', rowSettle), mix(GOLD_HOT, '#0d1222', rowSettle), 3, b);
}

// ---------------------------------------------------------------- the front, from the street

export const FRONT = {
  sign: { x: 220, y: 560, w: 640, h: 220 },
  doors: [
    { x: 300, y: 860, w: 236, h: 590 },
    { x: 544, y: 860, w: 236, h: 590 },
  ],
  step: 1450,
  kerb: 1760,
};

export function frontGlass(door: Rect): Rect {
  return { x: door.x + 16, y: door.y + 16, w: door.w - 32, h: door.h - 60 };
}

/** The pavement's six slabs, two rows of three, in perspective. */
export function slabQuad(i: number): Pt[] {
  const row = Math.floor(i / 3);
  const col = i % 3;
  const ys = [1478, 1606, 1756];
  const xsTop = [[20, 360, 720, 1060], [-10, 350, 730, 1090]][row] as number[];
  const xsBot = [[-10, 350, 730, 1090], [-50, 335, 745, 1130]][row] as number[];
  const y0 = ys[row] as number;
  const y1 = ys[row + 1] as number;
  return [
    [xsTop[col] as number, y0],
    [xsTop[col + 1] as number, y0],
    [xsBot[col + 1] as number, y1],
    [xsBot[col] as number, y1],
  ];
}

export interface FrontState {
  night: number;
  /** Each slab laid, 0 to 1. */
  slabs: readonly number[];
  /** Frames since each slab landed, for its squash; negative before. */
  slabAge?: readonly number[];
  /** The lamppost's growth and its light. */
  lamp: number;
  lampLit: number;
  /** The sign: 0 not there, 1 hung; its bulbs lit; the name there; the name lit. */
  sign: number;
  bulbs: number;
  name: number;
  nameLit: number;
  /** The sign's bounce on landing, px. */
  signDrop?: number;
  /** The sign's squash on landing, from `impact`. */
  signSquash?: number;
  /** Frames since LANTERN lit, for each letter's pop. */
  nameAge?: number;
  /** The doors: 0 clear glass, 1 papered. */
  paper: number;
  /** The left door swung open, 0 to 1. */
  open: number;
  /** Whether `inside` draws the swung door itself, behind her as she stands in the doorway. */
  openDrawnInside?: boolean;
  /** What is inside the glass: her, the board, the glow. Drawn under the glass. */
  inside: (g: G) => void;
  ctx: Ctx;
}

function sky(g: G, s: FrontState): void {
  const day = 1 - s.night;
  const grad = g.createLinearGradient(0, -300, 0, 1200);
  grad.addColorStop(0, mix(NIGHT.sky, DAY.skyHigh, day));
  grad.addColorStop(0.45, mix(NIGHT.skyLow, '#e9a7a8', day));
  grad.addColorStop(0.75, mix(NIGHT.skyLow, DAY.sky, day));
  grad.addColorStop(1, mix(NIGHT.skyLow, '#ffd28e', day));
  g.fillStyle = grad;
  g.fillRect(-400, -400, W + 800, 2000);
  if (s.night > 0) {
    g.fillStyle = rgba(NIGHT.moon, s.night);
    g.beginPath();
    g.arc(880, 190, 54, 0, TAU);
    g.fill();
    g.fillStyle = rgba('#d8ccb0', s.night);
    g.beginPath();
    g.arc(866, 178, 10, 0, TAU);
    g.arc(898, 208, 7, 0, TAU);
    g.fill();
    glow(g, 880, 190, 220, NIGHT.moon, 0.2 * s.night);
    for (let i = 0; i < 22; i++) {
      const x = hash(i, 31) * W;
      const y = hash(i, 32) * 300 - 120;
      const tw = 0.5 + 0.5 * Math.sin(i * 3.1 + s.ctx.time * 0.05);
      g.fillStyle = rgba('#f3ecd6', s.night * (0.35 + 0.5 * tw));
      g.fillRect(x, y, 3, 3);
    }
  }
  if (day > 0) {
    glow(g, 1000, 330, 560, '#ffcf7a', 0.45 * day, 'source-over');
    g.fillStyle = rgba(DAY.sun, day);
    g.beginPath();
    g.arc(1000, 350, 74, 0, TAU);
    g.fill();
  }
}

/** The left door swung out on its hinge, narrowing toward the hinge side. */
export function drawOpenDoor(g: G, open: number, day: number, b: Boil): void {
  const door = FRONT.doors[0] as Rect;
  const ink = mix('#0b0e20', DAY.ink, day);
  const wNow = lerp(door.w, 46, open);
  const skew = 26 * open;
  const frame: Pt[] = [
    [door.x, door.y],
    [door.x + wNow, door.y - skew],
    [door.x + wNow, door.y + door.h + skew],
    [door.x, door.y + door.h],
  ];
  poly(g, frame, rgba(mix('#2a2f55', '#c5d5da', day), 0.55), ink, 5, b);
}

/** The cinema's front: the building, its doors, the sign, the pavement and the lamp. */
export function drawFront(g: G, s: FrontState, b: Boil): void {
  const day = 1 - s.night;
  const ink = mix('#0b0e20', DAY.ink, day);
  const rim = mix(NIGHT.rim, DAY.ink, day);
  sky(g, s);
  // Neighbours.
  g.fillStyle = mix('#11152f', '#c99272', day);
  g.fillRect(-300, 500, 370, 1300);
  g.fillRect(1010, 440, 400, 1360);
  // The building.
  const wall = mix('#262b52', '#efcfa3', day);
  poly(g, [[70, 330], [420, 330], [540, 246], [660, 330], [1010, 330], [1010, 1450], [70, 1450]], wall, rim, 5, b);
  line(g, [[70, 372], [1010, 372]], 4, rim, b);
  for (let i = 0; i < 26; i++) {
    const x = 100 + hash(i, 21) * 860;
    const y = 400 + hash(i, 22) * 1000;
    if (x > 280 && x < 800 && y > 540 && y < 1460) {
      continue;
    }
    line(g, [[x, y], [x + 40, y]], 3, rgba(rim, 0.5), b);
  }
  // Poster cases, empty.
  for (const x of [110, 810]) {
    sketchRect(g, x, 900, 160, 360, mix('#1b1f40', '#efdcc0', day), rim, 4, b);
  }
  // The doors: what is inside first, then the glass, then the paper.
  for (const [i, door] of FRONT.doors.entries()) {
    const gl = frontGlass(door);
    const swing = i === 0 ? s.open : 0;
    g.save();
    g.beginPath();
    g.rect(gl.x, gl.y, gl.w + (i === 0 ? 0 : 0), gl.h);
    g.clip();
    g.fillStyle = mix('#0d1026', '#b9a48c', day);
    g.fillRect(gl.x, gl.y, gl.w, gl.h);
    g.restore();
    void swing;
  }
  // The interior through both panes at once, so whatever is inside crosses the mullion.
  g.save();
  g.beginPath();
  for (const door of FRONT.doors) {
    const gl = frontGlass(door);
    g.rect(gl.x, gl.y, gl.w, gl.h);
  }
  if (s.open > 0) {
    const d = FRONT.doors[0] as Rect;
    g.rect(d.x, d.y, d.w, d.h);
  }
  g.clip();
  s.inside(g);
  g.restore();
  for (const [i, door] of FRONT.doors.entries()) {
    const gl = frontGlass(door);
    const open = i === 0 ? s.open : 0;
    if (open > 0.01) {
      if (s.openDrawnInside !== true) {
        drawOpenDoor(g, open, day, b);
      }
      continue;
    }
    g.fillStyle = rgba(mix('#8fa0e0', '#e9f4f6', day), 0.08 + 0.06 * day);
    g.fillRect(gl.x, gl.y, gl.w, gl.h);
    if (s.paper > 0) {
      // Blank paper from the street: the backs of the pages, lit faintly from inside.
      g.fillStyle = rgba(mix('#e9dcc2', '#f3e8d6', day), clamp(s.paper));
      g.fillRect(gl.x - 1, gl.y - 1, gl.w + 2, gl.h + 2);
      g.fillStyle = rgba(NIGHT.glow, 0.1 * s.night * s.paper);
      g.fillRect(gl.x, gl.y, gl.w, gl.h);
      for (let k = 1; k < 3; k++) {
        line(g, [[gl.x, gl.y + (gl.h * k) / 3], [gl.x + gl.w, gl.y + (gl.h * k) / 3]], 2, rgba('#8a7a64', 0.6 * s.paper), b);
      }
    }
    poly(g, rectPts(door.x, door.y, door.w, door.h), null, ink, 6, b);
    poly(g, rectPts(gl.x, gl.y, gl.w, gl.h), null, ink, 3, b);
    line(g, [[door.x + 28, door.y + 300], [door.x + door.w - 28, door.y + 300]], 9, mix('#4a4766', '#b88a3e', day), b);
    void open;
  }
  // The step.
  poly(g, [[280, FRONT.step], [800, FRONT.step], [812, FRONT.step + 28], [268, FRONT.step + 28]], mix('#30355e', '#dcc4a6', day), ink, 4, b);
  drawSign(g, s, b);
  // The ground: void until the search lays it.
  g.fillStyle = mix('#090b1a', '#c9a983', day);
  g.fillRect(-300, FRONT.step + 28, W + 600, 900);
  for (let i = 0; i < 6; i++) {
    const p = s.slabs[i] ?? 0;
    if (p >= 1) {
      // A slab slaps flat on landing, pressed down onto its far edge and spread wide, then springs back past rest and settles.
      const age = s.slabAge?.[i] ?? 99;
      const sq = age < 30 ? impact(age) : 0;
      const raw = slabQuad(i);
      const c: Pt = [(raw[0]![0] + raw[2]![0]) / 2, raw[2]![1]];
      const q = raw.map(([x, y]) => [c[0] + (x - c[0]) * (1 + 0.16 * sq), c[1] + (y - c[1]) * (1 - 0.55 * sq)] as Pt);
      poly(g, q, mix('#3a3f66', '#e9cfa8', day), ink, 4, b);
      line(g, [[lerp(q[0]![0], q[1]![0], 0.3), lerp(q[0]![1], q[3]![1], 0.4)], [lerp(q[0]![0], q[1]![0], 0.5), lerp(q[0]![1], q[3]![1], 0.55)]], 2, rgba(ink, 0.5), b);
    }
  }
  if ((s.slabs[5] ?? 0) >= 1) {
    poly(g, [[-60, FRONT.kerb], [1140, FRONT.kerb], [1140, FRONT.kerb + 30], [-60, FRONT.kerb + 30]], mix('#2c315a', '#d6bf9f', day), ink, 4, b);
    g.fillStyle = mix('#05060f', '#9a8f84', day);
    g.fillRect(-300, FRONT.kerb + 30, W + 600, 600);
  }
  drawLamp(g, s, b);
}

function drawLamp(g: G, s: FrontState, b: Boil): void {
  if (s.lamp <= 0) {
    return;
  }
  const day = 1 - s.night;
  const ink = mix('#0b0e20', DAY.ink, day);
  const base: Pt = [140, 1744];
  const top: Pt = [140, lerp(1744, 720, s.lamp)];
  if (s.lampLit > 0) {
    glow(g, base[0] + 40, base[1] - 20, 420, NIGHT.glow, 0.35 * s.lampLit * s.night);
  }
  line(g, [base, top], 12, ink, b);
  line(g, [[base[0] - 22, base[1]], [base[0] + 22, base[1]]], 10, ink, b);
  const head: Pt[] = [[top[0] - 34, top[1] - 80], [top[0] + 34, top[1] - 80], [top[0] + 22, top[1]], [top[0] - 22, top[1]]];
  poly(g, head, mix('#3a3a55', '#f2e2b0', s.lampLit * s.night + 0.3 * day), ink, 4, b);
  line(g, [[top[0] - 44, top[1] - 82], [top[0], top[1] - 108], [top[0] + 44, top[1] - 82]], 6, ink, b);
  if (s.lampLit > 0) {
    glow(g, top[0], top[1] - 40, 220, NIGHT.glow, 0.85 * s.lampLit * s.night);
    glow(g, top[0], top[1] - 40, 60, GOLD_HOT, 0.6 * s.lampLit * s.night);
  }
}

/** The bulbs round the sign's edge, in order round it. */
function bulbs(): Pt[] {
  const { x, y, w, h } = FRONT.sign;
  const out: Pt[] = [];
  const step = 40;
  for (let k = 0; k <= w; k += step) out.push([x + k, y]);
  for (let k = step; k <= h; k += step) out.push([x + w, y + k]);
  for (let k = w - step; k >= 0; k -= step) out.push([x + k, y + h]);
  for (let k = h - step; k > 0; k -= step) out.push([x, y + k]);
  return out;
}

export const SIGN_NAME = 'LANTERN';

export function drawSign(g: G, s: FrontState, b: Boil): void {
  if (s.sign <= 0) {
    return;
  }
  const day = 1 - s.night;
  const { x, y, w, h } = FRONT.sign;
  const ink = mix('#0b0e20', DAY.ink, day);
  g.save();
  g.translate(0, s.signDrop ?? 0);
  const sq = s.signSquash ?? 0;
  if (sq !== 0) {
    g.translate(x + w / 2, y + h + 70);
    g.scale(1 + 0.1 * sq, 1 - 0.24 * sq);
    g.translate(-(x + w / 2), -(y + h + 70));
  }
  g.globalAlpha = clamp(s.sign * 2);
  sketchRect(g, x, y, w, h, mix('#14162c', '#2b2430', day * 0.3), ink, 6, b);
  sketchRect(g, x + 34, y + 34, w - 68, h - 68, '#0e0f1c', mix(GOLD, '#8a6a2a', day), 3, b);
  // Brackets down to the wall.
  line(g, [[x + 60, y + h], [x + 40, y + h + 70]], 6, ink, b);
  line(g, [[x + w - 60, y + h], [x + w - 40, y + h + 70]], 6, ink, b);
  const list = bulbs();
  list.forEach(([bx, by], i) => {
    const lit = clamp(s.bulbs * list.length - i) * (0.75 + 0.25 * Math.sin(s.ctx.time * 0.3 + i * 1.3));
    g.fillStyle = lit > 0.05 ? mix('#5a4a2a', GOLD_HOT, lit) : '#3a3428';
    g.beginPath();
    g.arc(bx, by, 9, 0, TAU);
    g.fill();
    g.strokeStyle = ink;
    g.lineWidth = 2;
    g.stroke();
    if (lit > 0.3 && s.night > 0.2) {
      glow(g, bx, by, 34, GOLD, 0.45 * lit * s.night);
    }
  });
  // The name, in bulb letters.
  if (s.name > 0) {
    const n = SIGN_NAME.length;
    g.font = fontOf(s.ctx, 'sans', 800, 100);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let i = 0; i < n; i++) {
      const lit = clamp(s.nameLit * (n + 2) - i);
      const cx = x + w / 2 + (i - (n - 1) / 2) * 76;
      const cy = y + h / 2 + 4;
      // Lit, each letter pops in turn: up from small, past its size, and back.
      const pop = s.nameAge === undefined ? 1 : 0.3 + 0.7 * Math.max(0, spring(s.nameAge - 1.5 * i, 0, 3.2, 7));
      g.save();
      g.globalAlpha = clamp(s.name * (n + 2) - i);
      g.fillStyle = mix(day > 0.5 ? '#6e5a34' : '#3d3526', GOLD_HOT, lit);
      g.translate(cx, cy);
      g.scale(pop, pop);
      g.fillText(SIGN_NAME.charAt(i), 0, 0);
      g.restore();
      if (s.night > 0.2) {
        glow(g, cx, cy, 80, GOLD, 0.35 * lit * s.night);
      }
    }
  }
  g.restore();
  void hs;
  void scribble;
}

/** The whole sign's frame, for a card to fly into. */
export function signRect(): Rect {
  return FRONT.sign;
}
