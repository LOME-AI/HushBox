import { drawEndPage, pageTurn } from './endcard.js';
import { drawGirl, handPhone, posedLag } from './girl.js';
import { copyBox, fontOf, glow, line, poly, scribble, sketchRect } from './ink.js';
import { PILE_CHARS, PILE_SIZE, drawPile, drawTile, pickedSlots, slotAt } from './letters.js';
import { DAY, DEFAULT, GOLD_HOT, NIGHT, PLAYFUL, TAU, applyCam, bf, clamp, hs, impact, inOut, keyed, lerp, logZoom, mix, outCubic, prog, rgba, smooth, springOf } from './kit.js';
import { DOOR, GRAB, MARK, NIGHT_OUT, NOTE, OPEN_BEATS, PAGE_BEATS, PAGE_TURN, PEEL, PICK_BEATS, SMOOTH, SPIRAL, WRITE_FROM, WRITTEN } from './score.js';
import { LOBBY_PILE, LOBBY_PILE_SCALE, boilOf } from './shots-a.js';
import { FRONT, drawBoard, drawFront, drawLobby, drawOpenDoor, frontGlass, pageRect } from './sets.js';

import type { Boil } from './ink.js';
import type { Cam, G, Pt } from './kit.js';
import type { Pose, PoseKey } from './girl.js';
import type { ShotArgs } from './shots-a.js';
import type { FrontState, Rect } from './sets.js';
import type { LookBox, LookContext } from '../../../../engine/look/index.js';

type Ctx = LookContext<'2d'>;

/** Lines of small print that fit a page: each drawn whole, never clipped mid-word. */
function print(g: G, ctx: Ctx, lines: readonly string[], x: number, y: number, size: number, gap: number, color: string, weight = 500, face: 'sans' | 'serif' = 'sans'): void {
  g.font = fontOf(ctx, face, weight, size);
  g.fillStyle = color;
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  lines.forEach((l, i) => g.fillText(l, x, y + i * gap));
}

/** What each page of the conversation carries, writing facing her: the question, the chart, the search, the sketch, the names, the rest. */
function pageFace(ctx: Ctx): (g: G, k: number, r: Rect, b: Boil) => void {
  return (g, k, r, b) => {
    const ink = '#3a2e24';
    const x = r.x + 14;
    const w = r.w - 28;
    g.save();
    g.beginPath();
    g.rect(r.x, r.y, r.w, r.h);
    g.clip();
    if (k === 0) {
      sketchRect(g, x + 10, r.y + 24, w - 10, 96, rgba('#d9cdb4', 0.8), ink, 2, b);
      print(g, ctx, ['Is it crazy to quit', 'my job to open a', 'cinema?'], x + 18, r.y + 50, 15, 26, ink);
      scribble(g, x, r.y + 160, w, 4, 22, rgba(ink, 0.6), 3, 3, b);
    } else if (k === 1) {
      print(g, ctx, ['GPT-5.5'], x, r.y + 34, 15, 0, rgba(ink, 0.75), 600);
      scribble(g, x, r.y + 58, w, 2, 20, rgba(ink, 0.6), 3, 5, b);
      [0.45, 0.62, 0.8, 1].forEach((hh, i) => {
        g.fillStyle = rgba('#b8892f', 0.9);
        g.fillRect(x + 14 + i * 34, r.y + 250 - 120 * hh, 22, 120 * hh);
      });
    } else if (k === 2) {
      print(g, ctx, ['Gemini 3.1 Pro'], x, r.y + 34, 15, 0, rgba(ink, 0.75), 600);
      print(g, ctx, ['Searched the web', '· 6 sources'], x, r.y + 62, 15, 20, ink);
      for (let i = 0; i < 6; i++) {
        sketchRect(g, x + (i % 3) * 50, r.y + 104 + Math.floor(i / 3) * 44, 42, 34, rgba('#d9cdb4', 0.9), ink, 1.5, b);
      }
      scribble(g, x, r.y + 220, w, 2, 20, rgba(ink, 0.6), 3, 7, b);
    } else if (k === 3) {
      print(g, ctx, ['Seedream 5.0'], x, r.y + 34, 15, 0, rgba(ink, 0.75), 600);
      sketchRect(g, x, r.y + 50, w, 150, rgba('#d9cdb4', 0.8), ink, 2, b);
      line(g, [[x + 18, r.y + 90], [x + w - 18, r.y + 90], [x + w - 18, r.y + 130], [x + 18, r.y + 130], [x + 18, r.y + 90]], 2.5, '#b8892f', b);
      line(g, [[x + 36, r.y + 130], [x + 36, r.y + 190]], 2.5, '#b8892f', b);
      line(g, [[x + w - 36, r.y + 130], [x + w - 36, r.y + 190]], 2.5, '#b8892f', b);
      scribble(g, x, r.y + 230, w, 2, 20, rgba(ink, 0.6), 3, 9, b);
    } else if (k === 4) {
      ['Night Owl', 'Lantern', 'Little Light', 'The Moth'].forEach((name, i) => {
        sketchRect(g, x, r.y + 22 + i * 62, w, 52, i === 1 ? rgba('#f2c35b', 0.5) : rgba('#d9cdb4', 0.7), ink, 1.5, b);
        print(g, ctx, [name], x + 10, r.y + 56 + i * 62, 18, 0, ink, 700, 'serif');
      });
    } else {
      scribble(g, x, r.y + 34, w, 9, 24, rgba(ink, 0.6), 3, 13, b);
    }
    g.restore();
  };
}

// ---------------------------------------------------------------- 8 paper: beats 29-33

const STAND_L: Pose = {
  x: 455,
  y: 1312,
  scale: 1.45,
  facing: 1,
  spine: 0.02,
  neck: 0.05,
  head: -0.02,
  back: 0,
  armN: 0.25,
  elbowN: 0.35,
  armF: 1.55,
  elbowF: 0.95,
  legN: 0.03,
  kneeN: -0.03,
  legF: -0.06,
  kneeF: 0.02,
  brow: 0.6,
  blink: 0,
  smile: 0.3,
  open: 0,
};

const PAGE_FLIGHT = 16;

/** Each page's flight from the phone: its own spin and arc, so no two flutter alike. */
const PAGE_FLUTTER = [
  { spin: 1.3, arc: 170, flip: 3.1 },
  { spin: -0.9, arc: 120, flip: 2.3 },
  { spin: 0.7, arc: 210, flip: 3.7 },
  { spin: -1.5, arc: 150, flip: 2.7 },
  { spin: 1.0, arc: 100, flip: 3.3 },
  { spin: -0.6, arc: 190, flip: 2.1 },
] as const;

/** Beats 29-33: her conversation leaves the phone as pages and papers the glass doors, writing facing her. */
export function shotPaper(a: ShotArgs): LookBox[] {
  const { g, ctx, frame, time } = a;
  const b = boilOf(a);
  const u = smooth(prog(time, bf(29), bf(33)));
  const cam: Cam = { z: logZoom(1.22, 1.36, u), cx: lerp(640, 690, u), cy: lerp(1060, 1040, u), roll: 0.008 * Math.sin(time * 0.02) };
  const pages = PAGE_BEATS.map((beat) => (frame >= bf(beat) ? 1 : 0));
  // Each page squashes on its slap; the last squashes again under her palm.
  const pageAge = PAGE_BEATS.map((beat, k) => (k === 5 && time >= SMOOTH ? time - SMOOTH : time - bf(beat)));
  const face = pageFace(ctx);
  g.save();
  applyCam(g, cam);
  drawLobby(g, { night: 1, street: true, dawn: 0, pages, pageAge, pageFace: face, board: true }, b);
  const covered = pages.reduce<number>((s, p) => s + p, 0) / 6;
  glow(g, 780, 1400, 600, NIGHT.glow, 0.22 * (1 - covered));
  // A page slaps flat on the glass: a quick spread and settle.
  PAGE_BEATS.forEach((beat, k) => {
    const t = time - bf(beat);
    if (t >= 0 && t < 14) {
      const r = pageRect(k);
      const sq = Math.exp(-0.3 * t) * Math.cos(0.7 * t);
      g.strokeStyle = rgba(GOLD_HOT, 0.6 * Math.max(0, sq));
      g.lineWidth = 4;
      g.strokeRect(r.x - 10 * sq, r.y - 6 * sq, r.w + 20 * sq, r.h + 12 * sq);
    }
  });
  drawPile(g, ctx, time, NIGHT.ink, LOBBY_PILE, LOBBY_PILE_SCALE);
  const target = pageRect(5);
  const keys: (readonly [number, PoseKey])[] = [
    [bf(29) - 4, { armF: 1.75, elbowF: 1.0, head: -0.1, brow: 0.8, open: 0.3 }],
    [bf(30), { open: 0, smile: 0.5 }],
    [bf(31.5), { x: 670, legN: 0.3, kneeN: -0.15, legF: -0.35, kneeF: 0.1 }],
    // The phone hand drops to her side; only the near hand goes to the page.
    [bf(32), { legN: 0.03, kneeN: -0.03, legF: -0.06, kneeF: 0.02, spine: 0.1, armF: 0.2, elbowF: 0.55 }],
    [SMOOTH - 3, { spine: 0.22, head: 0.12 }],
    [SMOOTH + 8, { spine: 0.06, head: -0.05, smile: 0.8, brow: 0.5 }],
  ];
  const { pose, lag } = posedLag(STAND_L, keys, time, a.seed);
  const reachOn = smooth(prog(time, SMOOTH - 12, SMOOTH));
  // The palm lands on the page on the beat and smooths it down and across, never resting.
  const rub = smooth(prog(time, SMOOTH, SMOOTH + 22));
  const palm: Pt = [
    target.x + target.w * (0.42 + 0.12 * rub) + 14 * Math.sin((time - SMOOTH) * 0.25) * rub * (1 - rub) * 4,
    target.y + target.h * (0.3 + 0.42 * rub),
  ];
  let phone: Pt = [560, 1150];
  const j = drawGirl(g, pose, {
    time,
    seed: a.seed,
    ink: NIGHT.ink,
    night: 0.3,
    lag,
    reach: reachOn > 0 ? { near: [lerp(pose.x + 140, palm[0], reachOn), lerp(pose.y - 120, palm[1], reachOn)], bendN: -1 } : {},
    behind: (gg, jj) => {
      phone = handPhone(gg, { ...jj, wristN: jj.wristF, handAngleN: jj.handAngleF }, true, pose.scale, NIGHT.glow, 1, b, NIGHT.ink);
    },
  });
  void j;
  glow(g, phone[0], phone[1], 280, NIGHT.glow, 0.36);
  // Pages in flight: from the phone to the glass, each fluttering its own way, unfolding to its size.
  PAGE_BEATS.forEach((beat, k) => {
    const land = bf(beat);
    const t = time - (land - PAGE_FLIGHT);
    if (t < 0 || frame >= land) {
      return;
    }
    const fl = PAGE_FLUTTER[k] as (typeof PAGE_FLUTTER)[number];
    const m = inOut(t / PAGE_FLIGHT);
    const r = pageRect(k);
    const cx = lerp(phone[0], r.x + r.w / 2, m);
    const cy = lerp(phone[1], r.y + r.h / 2, m) - fl.arc * Math.sin(Math.PI * m);
    const w = lerp(40, r.w, m);
    const h = lerp(56, r.h, m);
    // Stretched along its flight as it closes on the glass.
    const st = 0.3 * Math.sin(Math.PI * Math.min(1, m * 1.1));
    g.save();
    g.translate(cx, cy);
    g.rotate((1 - m) * fl.spin);
    g.scale(Math.max(0.15, Math.abs(Math.cos((1 - m) * fl.flip))) * (1 - 0.3 * st), 1 + st);
    sketchRect(g, -w / 2, -h / 2, w, h, '#efe2c7', '#6b5a48', 3, b);
    face(g, k, { x: -w / 2, y: -h / 2, w, h }, b);
    g.restore();
  });
  if (time >= SMOOTH && time < SMOOTH + 16) {
    const w = (time - SMOOTH) / 16;
    g.strokeStyle = rgba(GOLD_HOT, 0.5 * (1 - w));
    g.lineWidth = 3;
    g.beginPath();
    g.ellipse(target.x + target.w / 2, target.y + target.h / 2, 40 + 120 * w, 30 + 90 * w, 0, 0, TAU);
    g.stroke();
  }
  g.restore();
  return [];
}

// ---------------------------------------------------------------- 9 coming soon: beats 33-38

const NOTE_RECT: Rect = { x: 532, y: 1080, w: 262, h: 168 };
const NOTE_LINES = ['Not even we', 'can read it.'] as const;
const NOTE_PX = 40;
const COMING_PX = 58;
const COMING_Y = 978;
const BANNER: Rect = { x: 288, y: 908, w: 504, h: 98 };
const SPIRAL_AT: Pt = [418, 1078];
const SPIRAL_SIZE = 92;

/** The note: a card, two lines in a slanted hand, tape at the top. */
function drawNote(g: G, ctx: Ctx, b: Boil, rot: number, dx: number, dy: number, sx: number, sy: number, report: boolean): LookBox[] {
  const boxes: LookBox[] = [];
  g.save();
  g.translate(NOTE_RECT.x + NOTE_RECT.w / 2 + dx, NOTE_RECT.y + dy);
  g.rotate(rot);
  g.scale(sx, sy);
  g.translate(-NOTE_RECT.w / 2, 0);
  g.fillStyle = rgba('#000000', 0.18);
  g.fillRect(6, 8, NOTE_RECT.w, NOTE_RECT.h);
  sketchRect(g, 0, 0, NOTE_RECT.w, NOTE_RECT.h, '#fbf6ea', '#5e4f40', 3, b);
  for (const tx of [26, NOTE_RECT.w - 26]) {
    g.save();
    g.translate(tx, 2);
    g.rotate(tx < NOTE_RECT.w / 2 ? -0.5 : 0.5);
    g.fillStyle = rgba('#e7ddb8', 0.8);
    g.fillRect(-26, -10, 52, 20);
    g.restore();
  }
  g.font = fontOf(ctx, 'serif', 700, NOTE_PX, true);
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  const widths = NOTE_LINES.map((l) => g.measureText(l));
  const top = 66;
  if (!ctx.hideText || !report) {
    g.fillStyle = '#2b211c';
    NOTE_LINES.forEach((l, i) => {
      g.save();
      g.translate(NOTE_RECT.w / 2, top + i * 52);
      g.rotate(hs(i, 71) * 0.03);
      g.fillText(l, 0, 0);
      g.restore();
    });
  }
  if (report) {
    const w = Math.max(...widths.map((m) => m.width));
    const asc = widths[0]?.actualBoundingBoxAscent ?? NOTE_PX * 0.75;
    const desc = widths[1]?.actualBoundingBoxDescent ?? NOTE_PX * 0.2;
    boxes.push(copyBox(g, 'note', 'Not even we can read it.', 'support', NOTE_RECT.w / 2 - w / 2 - 4, top - asc - 4, w + 8, 52 + asc + desc + 8, NOTE_PX));
  }
  g.restore();
  return boxes;
}

/** A moth circling the lamp: two wing strokes flapping on its own beat. */
function moth(g: G, time: number): void {
  const t = time / 60;
  const cx = 140 + 70 * Math.sin(t * 2.3) + 20 * Math.sin(t * 5.1);
  const cy = 640 + 40 * Math.cos(t * 2.3 + 0.6) + 12 * Math.sin(t * 7.3);
  const flap = Math.abs(Math.sin(t * 22));
  g.strokeStyle = rgba('#f3ead8', 0.9);
  g.fillStyle = rgba('#f3ead8', 0.75);
  g.lineWidth = 2;
  for (const side of [-1, 1]) {
    g.beginPath();
    g.ellipse(cx + side * 7 * flap, cy - 3, 8 * flap + 2, 5, side * 0.6, 0, TAU);
    g.fill();
  }
}

/** Beats 33-38: from the street the papered doors are blank; COMING SOON; a beat later the spiral; a beat after that, the note. */
export function shotComingSoon(a: ShotArgs): LookBox[] {
  const { g, ctx, frame, time } = a;
  const b = boilOf(a);
  const u = smooth(prog(time, bf(33), bf(38)));
  const cam: Cam = { z: Math.exp(Math.log(1.3) * u), cx: 540 + 4 * Math.sin(time * 0.01), cy: 1000 + 75 * u, roll: 0.004 * Math.sin(time * 0.015) };
  const state: FrontState = {
    night: 1,
    slabs: [1, 1, 1, 1, 1, 1],
    lamp: 1,
    lampLit: 0.92 + 0.08 * Math.sin(time * 0.37) * Math.sin(time * 0.11),
    sign: 1,
    bulbs: 0,
    name: 1,
    nameLit: 0,
    paper: 1,
    open: 0,
    inside: (gg) => {
      gg.fillStyle = '#0d1026';
      gg.fillRect(280, 840, 520, 640);
    },
    ctx,
  };
  const boxes: LookBox[] = [];
  g.save();
  applyCam(g, cam);
  drawFront(g, state, b);
  moth(g, time);
  // Her lamp inside, warm behind the paper: she is working.
  for (const door of FRONT.doors) {
    const gl = frontGlass(door);
    const grad = g.createRadialGradient(gl.x + gl.w / 2, gl.y + gl.h * 0.6, 10, gl.x + gl.w / 2, gl.y + gl.h * 0.6, 420);
    grad.addColorStop(0, rgba(NIGHT.glow, 0.22 + 0.04 * Math.sin(time * 0.05)));
    grad.addColorStop(1, rgba(NIGHT.glow, 0));
    g.fillStyle = grad;
    g.fillRect(gl.x, gl.y, gl.w, gl.h);
  }
  // The banner: one more sheet of paper, taped across both doors.
  g.save();
  g.translate(BANNER.x + BANNER.w / 2, BANNER.y + BANNER.h / 2);
  g.rotate(-0.012);
  g.translate(-(BANNER.x + BANNER.w / 2), -(BANNER.y + BANNER.h / 2));
  g.fillStyle = rgba('#000000', 0.2);
  g.fillRect(BANNER.x + 6, BANNER.y + 8, BANNER.w, BANNER.h);
  sketchRect(g, BANNER.x, BANNER.y, BANNER.w, BANNER.h, '#f6ecd6', '#6b5a48', 3, b);
  for (const tx of [BANNER.x + 4, BANNER.x + BANNER.w - 4]) {
    g.fillStyle = rgba('#e7ddb8', 0.85);
    g.fillRect(tx - 18, BANNER.y + BANNER.h / 2 - 30, 36, 60);
  }
  g.restore();
  if (frame >= WRITE_FROM) {
    g.save();
    g.font = fontOf(ctx, 'sans', 800, COMING_PX);
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    const word = 'COMING SOON';
    const m = g.measureText(word);
    const x0 = 540 - m.width / 2;
    const reveal = prog(time, WRITE_FROM, WRITTEN);
    const leaving = frame >= NIGHT_OUT;
    if (!ctx.hideText || leaving) {
      g.save();
      if (reveal < 1) {
        g.beginPath();
        g.rect(x0 - 10, COMING_Y - 80, (m.width + 20) * reveal, 120);
        g.clip();
      }
      g.fillStyle = '#2b211c';
      let x = x0;
      for (let i = 0; i < word.length; i++) {
        const ch = word.charAt(i);
        const cw = g.measureText(ch).width;
        // On the gust the letters come unstuck one after another and drop, tumbling.
        const t = Math.max(0, time - NIGHT_OUT - i * 0.7);
        g.save();
        g.translate(x + cw / 2 + (i % 2 === 0 ? -1 : 1) * 1.5 * t, COMING_Y + 3 * t * t - 3 * t);
        g.rotate(hs(i, 81) * 0.035 + (i % 2 === 0 ? -0.05 : 0.06) * t);
        g.fillText(ch, -cw / 2, 0);
        g.restore();
        x += cw;
      }
      g.restore();
      if (reveal < 1) {
        glow(g, x0 + m.width * reveal, COMING_Y - 20, 40, GOLD_HOT, 0.8);
      }
    }
    if (frame >= WRITTEN && !leaving) {
      boxes.push(copyBox(g, 'coming-soon', word, 'support', x0 - 4, COMING_Y - m.actualBoundingBoxAscent - 4, m.width + 8, m.actualBoundingBoxAscent + m.actualBoundingBoxDescent + 8, COMING_PX));
    }
    g.restore();
  }
  // The spiral: small, Signal Red, printed on the paper; it springs up on its beat and breathes.
  if (frame >= SPIRAL - 3) {
    const s = Math.max(0, springOf(time, SPIRAL - 3, PLAYFUL)) * (1 + 0.02 * Math.sin(time * 0.08));
    const size = SPIRAL_SIZE * s;
    if (size > 1) {
      g.save();
      g.translate(SPIRAL_AT[0], SPIRAL_AT[1]);
      g.rotate((1 - Math.min(1, s)) * -0.8);
      g.drawImage(ctx.logo.image, -size / 2, -size / 2, size, (size * ctx.logo.height) / ctx.logo.width);
      g.restore();
    }
  }
  // The note flutters down, stretching as it falls, slaps onto the glass with a squash, and swings to rest from its tape;
  // on the gust it peels off its tape and is carried up and away before the cut.
  const fall = 16;
  if (frame >= NOTE - fall) {
    const t = time - NOTE;
    const flutter = t < 0 ? -t / fall : 0;
    const gust = smooth(prog(time, NIGHT_OUT, NIGHT_OUT + 16));
    const dy = -420 * flutter * flutter - 420 * gust * gust - 40 * gust;
    const dx = 40 * Math.sin(flutter * 5) + 300 * gust * gust;
    const settle = t >= 0 ? Math.exp(-0.16 * t) : 0;
    const rot = -0.04 + (t < 0 ? 1.1 * flutter * Math.sin(flutter * 6) : 0.12 * settle * Math.cos(0.45 * t)) - 0.9 * gust;
    const fallStretch = t < 0 ? 0.24 * (1 - flutter) ** 2 : 0;
    const sq = impact(t);
    const curl = 0.35 * Math.sin(Math.PI * gust);
    const breeze = 0.006 * Math.sin(time * 0.07);
    boxes.push(...drawNote(g, ctx, b, rot + breeze, dx, dy, (1 + 0.2 * sq) * (1 - 0.4 * fallStretch), (1 - 0.3 * sq) * (1 + fallStretch) * (1 - curl), frame >= NOTE && frame < NIGHT_OUT));
  }
  g.restore();
  return boxes;
}

// ---------------------------------------------------------------- 10 peel: beats 38-42

const STAND_D: Pose = {
  x: 560,
  y: 1300,
  scale: 1.5,
  facing: 1,
  spine: 0,
  neck: -0.15,
  head: -0.3,
  back: 0,
  armN: 0.2,
  elbowN: 0.3,
  armF: 0.1,
  elbowF: 0.3,
  legN: 0.03,
  kneeN: -0.03,
  legF: -0.06,
  kneeF: 0.02,
  brow: 0.5,
  blink: 0,
  smile: 0.1,
  open: 0,
};

const PEEL_KEYS: readonly (readonly [number, PoseKey])[] = [
  [bf(38.25), { y: 1350, spine: 0.35, legN: 0.55, kneeN: -1.1, legF: 0.45, kneeF: -1.0, armN: 0.6, armF: 0.4, head: 0, neck: 0, brow: 0.2 }],
  // Up on her toes, the far arm full up so her face stays clear, the near arm swinging back for balance.
  [bf(38.75), { y: 1250, spine: -0.12, legN: -0.05, kneeN: 0.05, legF: -0.1, kneeF: 0.1, armF: 2.95, elbowF: 0.05, armN: -0.5, elbowN: 0.3, head: -0.65, neck: -0.3, brow: 0.7, open: 0.3 }],
  // The sweep down: the far arm leads it, straight; the near arm follows, bent and behind.
  [bf(39.25), { y: 1380, spine: 0.55, legN: 0.65, kneeN: -1.25, legF: 0.5, kneeF: -1.1, armF: 0.95, elbowF: 0.1, armN: 0.15, elbowN: 1.75, head: 0.25, neck: 0.2, open: 0 }],
  // In the flood of light: the far arm flung up, the near hand to her chest.
  [bf(39.75), { y: 1300, spine: -0.1, legN: 0.03, kneeN: -0.03, legF: -0.06, kneeF: 0.02, armF: 2.55, elbowF: 0.35, armN: 0.55, elbowN: 2.05, head: -0.3, neck: -0.15, brow: 0.9, smile: 1, open: 0.35 }],
  // Down at the pile: the near hand picks, the far hand waits at her chest for the letters.
  [bf(40.5), { x: 420, y: 1500, spine: 0.6, legN: 1.5, kneeN: -2.5, legF: 1.25, kneeF: -2.3, armN: 0.35, elbowN: 0.5, armF: 0.45, elbowF: 2.1, head: 0.45, neck: 0.35, open: 0 }],
  ...PICK_BEATS.flatMap((beat, i): (readonly [number, PoseKey])[] => [
    [bf(beat) - 5, { armN: 0.06 + 0.04 * (i % 2), elbowN: 0.12, spine: 0.66 }],
    [bf(beat) + 3, { armN: 0.5, elbowN: 1.45, spine: 0.56 }],
  ]),
  [bf(41.75), { armN: 0.7, elbowN: 1.0, spine: 0.35, head: -0.1, neck: 0, smile: 1 }],
];

/** A page coming down: its top edge curls forward and falls, landing flat on the floor below the door. */
function peeledQuad(r: Rect, q: number, k: number): Pt[] {
  const fallTo = 1440 + (k % 3) * 14;
  const drop = q * q;
  const topY = lerp(r.y, fallTo - 30, drop);
  const botY = lerp(r.y + r.h, fallTo + 30, drop);
  const spread = 30 * Math.sin(Math.PI * q);
  const dx = (k % 2 === 0 ? -1 : 1) * 60 * drop - 80 * drop;
  return [
    [r.x - spread + dx, topY],
    [r.x + r.w + spread + dx, topY + 20 * Math.sin(Math.PI * q)],
    [r.x + r.w + dx * 0.6, botY],
    [r.x + dx * 0.6, botY],
  ];
}

/** Beats 38-42: dawn behind the paper; she reaches up and peels it all down; light floods in; she picks four letters. */
export function shotPeel(a: ShotArgs): LookBox[] {
  const { g, ctx, frame, time } = a;
  const b = boilOf(a);
  const day = frame >= PEEL;
  const cam: Cam = {
    z: Math.exp(keyed(time, [[bf(38), Math.log(1.12)], [PEEL, Math.log(1.22)], [bf(40.75), Math.log(1.08)], [bf(42), Math.log(1.12)]], outCubic)),
    cx: keyed(time, [[bf(38), 700], [PEEL, 700], [bf(40.75), 620], [bf(42), 610]], outCubic),
    cy: keyed(time, [[bf(38), 1000], [PEEL, 970], [bf(40.75), 1300], [bf(42), 1320]], outCubic),
    roll: 0.008 * Math.sin(time * 0.02),
  };
  const face = pageFace(ctx);
  const peeled = (k: number): number => prog(time, PEEL - 6 + k * 2 + (k % 2) * 1, PEEL + 14 + k * 3);
  g.save();
  applyCam(g, cam);
  drawLobby(g, { night: day ? 0 : 0.72, street: true, dawn: day ? 1 : smooth(prog(time, bf(38), PEEL)), pages: [0, 1, 2, 3, 4, 5].map((k) => (peeled(k) > 0 ? 0 : 1)), pageFace: face, board: false }, b);
  if (day) {
    glow(g, 780, 980, 900, '#ffe2b0', 0.5 * (1 - 0.5 * prog(time, PEEL, PEEL + 40)), 'source-over');
    const reach = smooth(prog(time, PEEL, PEEL + 16));
    g.save();
    g.globalCompositeOperation = 'lighter';
    for (const door of [0, 1]) {
      const gx = 574 + door * 229;
      const gw = 183;
      g.fillStyle = rgba('#ffcf7a', 0.22);
      g.beginPath();
      g.moveTo(gx, 1430);
      g.lineTo(gx + gw, 1430);
      g.lineTo(gx + gw - 260 * reach, 1430 + 520 * reach);
      g.lineTo(gx - 380 * reach, 1430 + 520 * reach);
      g.closePath();
      g.fill();
    }
    g.restore();
  } else {
    glow(g, 780, 980, 600, '#ffb98a', 0.25 * smooth(prog(time, bf(38), PEEL)));
  }
  for (let k = 0; k < 6; k++) {
    const q = peeled(k);
    if (q <= 0) {
      continue;
    }
    poly(g, peeledQuad(pageRect(k), q, k), mix('#efe2c7', '#fbf1de', day ? 1 : 0), '#6b5a48', 3, b);
  }
  const picks = pickedSlots();
  const lifted = new Set(picks.filter((_, i) => frame >= bf(PICK_BEATS[i] as number)));
  drawPile(g, ctx, time, day ? DAY.ink : NIGHT.ink, LOBBY_PILE, LOBBY_PILE_SCALE, lifted);
  const { pose, lag } = posedLag(STAND_D, PEEL_KEYS, time, a.seed, 2.8, 7);
  const j = drawGirl(g, pose, { time, seed: a.seed, ink: day ? DAY.ink : NIGHT.ink, night: day ? 0 : 0.3, lag });
  // Each letter: up in the near hand on its beat, then passed to the far hand at her chest, stacking there.
  picks.forEach((slot, i) => {
    const at = bf(PICK_BEATS[i] as number);
    if (slot < 0 || frame < at) {
      return;
    }
    const s = slotAt(slot, LOBBY_PILE, LOBBY_PILE_SCALE);
    const u1 = smooth(prog(time, at, at + 5));
    const u2 = smooth(prog(time, at + 4, at + 11));
    const inHand: Pt = [lerp(s.x, j.wristN[0], u1), lerp(s.y, j.wristN[1] - 20, u1) - 30 * Math.sin(Math.PI * u1)];
    const held: Pt = [j.wristF[0] + 8 + (i - 1.5) * 14, j.wristF[1] - 26 - i * 6];
    const x = lerp(inHand[0], held[0], u2);
    const y = lerp(inHand[1], held[1], u2) - 24 * Math.sin(Math.PI * u2);
    drawTile(g, ctx, PILE_CHARS[slot] ?? 'o', x, y, PILE_SIZE * LOBBY_PILE_SCALE * lerp(1, 0.82, u2), s.rot * (1 - u1), DAY.ink);
  });
  g.restore();
  void GRAB;
  return [];
}

// ---------------------------------------------------------------- 11 open: beats 42-46

const BOARD_CORNERS: Pt[] = [
  [578, 992],
  [752, 992],
  [752, 1214],
  [578, 1214],
];
const OPEN_PX = 58;
const OPEN_X = (i: number): number => 665 + (i - 1.5) * 44;
const OPEN_Y = 1103;
const LETTER_FLIGHT = 9;

const STAND_O: Pose = {
  x: 420,
  y: 1236,
  scale: 1.12,
  facing: 1,
  spine: 0.1,
  neck: 0.05,
  head: -0.1,
  back: 0,
  armN: 1.5,
  elbowN: -0.15,
  armF: 0.3,
  elbowF: 2.25,
  legN: 0.03,
  kneeN: -0.03,
  legF: -0.06,
  kneeF: 0.02,
  brow: 0.6,
  blink: 0,
  smile: 0.6,
  open: 0,
};

/** Her keys at the board, through the door, and after it: she never holds still. */
function openKeys(): (readonly [number, PoseKey])[] {
  const keys: (readonly [number, PoseKey])[] = OPEN_BEATS.flatMap((beat, i): (readonly [number, PoseKey])[] => [
    [bf(beat) - LETTER_FLIGHT, { armN: 1.62, elbowN: -0.3, head: -0.12 - 0.03 * i, spine: 0.14 }],
    [bf(beat), { armN: 1.48, elbowN: -0.1, spine: 0.1 }],
  ]);
  keys.push(
    [DOOR - 10, { x: 445, spine: -0.04, armN: -0.6, elbowN: 0.4, armF: -0.5, elbowF: -1.7, head: -0.55, neck: -0.3, smile: 1, brow: 0.9, open: 0.4 }],
    [DOOR + 20, { open: 0 }],
    // She looks from the sign to us, beaming, and rocks on her heels.
    [bf(44.75) + 6, { head: 0.05, neck: 0.05, spine: 0.04 }],
    [bf(45.25), { spine: -0.06, y: STAND_O.y - 10 }],
    [bf(45.5), { spine: 0.04, y: STAND_O.y }],
  );
  return keys;
}

/** Beats 42-46: she spells OPEN on the board inside the door; she opens it, the bell rings, LANTERN lights; she beams. */
export function shotOpen(a: ShotArgs, report = true): LookBox[] {
  const { g, ctx, frame, time } = a;
  const b = boilOf(a);
  const cam: Cam = {
    z: Math.exp(keyed(time, [[bf(42), Math.log(1.34)], [bf(44.5), Math.log(1.06)], [bf(46), Math.log(1.16)]])),
    cx: keyed(time, [[bf(42), 610], [bf(44.5), 540], [bf(46), 500]]),
    cy: keyed(time, [[bf(42), 1090], [bf(44.5), 920], [bf(46), 1000]]),
    roll: 0.006 * Math.sin(time * 0.02),
  };
  const boxes: LookBox[] = [];
  const { pose, lag } = posedLag(STAND_O, openKeys(), time, a.seed);
  const placed = OPEN_BEATS.map((beat) => frame >= bf(beat));
  const doorOpen = frame >= DOOR - 2 ? clamp(springOf(time, DOOR - 2, DEFAULT), 0, 1.08) : 0;
  const inside = (gg: G): void => {
    gg.fillStyle = DAY.wall;
    gg.fillRect(280, 840, 520, 640);
    gg.fillStyle = DAY.floor;
    gg.fillRect(280, 1300, 520, 200);
    line(gg, [[600, 1214], [570, 1420]], 6, DAY.ink, b);
    line(gg, [[730, 1214], [760, 1420]], 6, DAY.ink, b);
    drawBoard(gg, BOARD_CORNERS, [], null, 0, b);
    if (!ctx.hideText || !report) {
      gg.font = fontOf(ctx, 'sans', 800, OPEN_PX);
      gg.textAlign = 'center';
      gg.textBaseline = 'middle';
      ['O', 'P', 'E', 'N'].forEach((ch, i) => {
        if (!placed[i]) {
          return;
        }
        const t = time - bf(OPEN_BEATS[i] as number);
        // Pressed on its beat: squashed into the felt, then springing back.
        const press = Math.exp(-0.3 * t);
        gg.save();
        gg.translate(OPEN_X(i), OPEN_Y);
        gg.scale(1 + 0.2 * press, 1 - 0.15 * press);
        gg.fillStyle = '#f7f2e7';
        gg.fillText(ch, 0, 0);
        gg.restore();
      });
    }
    // The swung door goes behind her, so nothing of her shows through its glass.
    if (doorOpen > 0.01) {
      drawOpenDoor(gg, doorOpen, 1, b);
    }
    const j = drawGirl(gg, pose, { time, seed: a.seed, ink: DAY.ink, night: 0, lag });
    ['O', 'P', 'E', 'N'].forEach((ch, i) => {
      const at = bf(OPEN_BEATS[i] as number);
      if (frame >= at || time < at - LETTER_FLIGHT) {
        return;
      }
      const u = inOut((time - (at - LETTER_FLIGHT)) / LETTER_FLIGHT);
      drawTile(gg, ctx, ch, lerp(j.wristN[0], OPEN_X(i), u), lerp(j.wristN[1], OPEN_Y, u) - 30 * Math.sin(Math.PI * u), lerp(40, OPEN_PX, u), 0, DAY.ink, false);
    });
    // The letters still to place, held in the far hand at her chest.
    ['O', 'P', 'E', 'N'].forEach((ch, i) => {
      const at = bf(OPEN_BEATS[i] as number);
      if (time >= at - LETTER_FLIGHT || frame >= DOOR - 12) {
        return;
      }
      drawTile(gg, ctx, ch, j.wristF[0] + 6 + i * 5, j.wristF[1] - 18 - i * 7, 30, 0.08 * (i - 1.5), DAY.ink, false);
    });
  };
  const state: FrontState = {
    night: 0,
    slabs: [1, 1, 1, 1, 1, 1],
    lamp: 1,
    lampLit: 0,
    sign: 1,
    bulbs: smooth(prog(time, DOOR, DOOR + 18)),
    name: 1,
    nameLit: prog(time, DOOR + 2, DOOR + 20),
    paper: 0,
    open: doorOpen,
    openDrawnInside: true,
    inside,
    ctx,
  };
  g.save();
  applyCam(g, cam);
  drawFront(g, state, b);
  if (report && frame >= bf(44) && frame < PAGE_TURN) {
    g.font = fontOf(ctx, 'sans', 800, OPEN_PX);
    const m = g.measureText('O');
    const left = OPEN_X(0) - 26;
    const right = OPEN_X(3) + 26;
    boxes.push(copyBox(g, 'open', 'OPEN', 'support', left, OPEN_Y - m.actualBoundingBoxAscent / 2 - 22, right - left, OPEN_PX * 0.95, OPEN_PX));
  }
  if (time >= DOOR && time < DOOR + 30) {
    const w = (time - DOOR) / 30;
    for (let k = 0; k < 3; k++) {
      line(g, [[320 + k * 18, 840 - 10 - w * 30], [326 + k * 18, 820 - 10 - w * 40]], 3, rgba(DAY.ink, 1 - w), null);
    }
  }
  g.restore();
  return boxes;
}

// ---------------------------------------------------------------- 12 end: beats 46-50

/** Beat 45.5-46, the open shot's last half beat: the page turns from its corner, quick at first, onto the end page. */
export function shotTurn(a: ShotArgs): LookBox[] {
  const { g, ctx, frame, time } = a;
  const boxes = drawEndPage(g, ctx, time, frame);
  const p = prog(time, PAGE_TURN - 1, MARK);
  pageTurn(g, 1 - (1 - p) ** 1.5, () => {
    shotOpen({ ...a }, false);
  });
  return boxes;
}

/** Beats 46-50: the mark lands on the cut, then HushBox, then the tagline, a beat each. */
export function shotEnd(a: ShotArgs): LookBox[] {
  return drawEndPage(a.g, a.ctx, a.time, a.frame);
}
