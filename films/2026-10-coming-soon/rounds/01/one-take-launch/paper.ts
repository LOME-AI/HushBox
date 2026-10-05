import { Z_FACADE, Z_HER, onLayer, onScreen, proj, visible } from './camera.js';
import { phoneAt } from './figure.js';
import { INK, PLAYFUL, SNAPPY, bf, clamp, hs, inOut, lerp, mix, prog, rgba, roundRect, spring } from './kit.js';
import { drawMark } from './mark.js';
import { BEAT, PRINT_FLIGHT, printLand } from './score.js';
import { drawText, fontOf, unionBox } from './type.js';
import { CHART_VALUES, CHIP_HUES, drawSignArt, sheetBox, sheetLeft } from './world.js';

import type { Cam } from './camera.js';
import type { Box, G } from './kit.js';
import type { Ui } from './ui.js';
import type { LookContext, TextBox } from '../../../../engine/look/index.js';

type Ctx = LookContext<'2d'>;

function pageLaunch(i: number): number {
  return bf((BEAT.pages[i] ?? 31) - 0.75);
}
function pageLand(i: number): number {
  return bf(BEAT.pages[i] ?? 31);
}
/** Whether page i is on the glass. */
export function pageLanded(i: number, time: number): boolean {
  return time >= pageLand(i);
}

/** A page of the conversation, front side, in the sheet's own units (0..w, 0..h): a reply in miniature. */
function pageFront(g: G, ui: Ui, i: number, w: number, h: number): void {
  g.fillStyle = INK.paper;
  g.fillRect(0, 0, w, h);
  g.fillStyle = mix(INK.paper, '#000000', 0.08);
  g.fillRect(0, 0, w, 6);
  const dark = ui.card;
  if (i === 0) {
    // Her question, then the chart.
    g.fillStyle = dark;
    roundRect(g, w * 0.3, 18, w * 0.62, 34, 17);
    g.fill();
    g.fillStyle = mix(dark, '#ffffff', 0.5);
    g.fillRect(w * 0.36, 32, w * 0.46, 6);
    CHART_VALUES.forEach((v, b) => {
      g.fillStyle = '#4a5398';
      roundRect(g, 18, 80 + b * 34, ((w - 50) * v) / 14, 22, 5);
      g.fill();
    });
  } else if (i === 1) {
    g.fillStyle = dark;
    g.fillRect(18, 22, w * 0.7, 10);
    g.fillRect(18, 44, w * 0.45, 8);
    for (let j = 0; j < 12; j++) {
      g.fillStyle = CHIP_HUES[j] ?? '#666666';
      roundRect(g, 18 + (j % 4) * ((w - 36) / 4), 78 + Math.floor(j / 4) * 58, (w - 36) / 4 - 10, 46, 8);
      g.fill();
    }
  } else if (i === 2) {
    g.save();
    g.translate(12, 24);
    g.scale((w - 24) / 800, (w - 24) / 800);
    g.translate(-140, -270);
    g.fillStyle = INK.wall;
    g.fillRect(140, 270, 800, 512);
    drawSignArt(g, { bulbs: 0, chase: 0, name: 0, day: 0 });
    g.restore();
    g.fillStyle = dark;
    g.fillRect(18, h - 50, w * 0.5, 9);
  } else {
    for (let j = 0; j < 4; j++) {
      g.fillStyle = j === 2 ? mix(dark, '#ffffff', 0.12) : dark;
      roundRect(g, 14, 18 + j * 66, w - 28, 54, 10);
      g.fill();
      g.fillStyle = mix(dark, '#ffffff', 0.55);
      g.fillRect(28, 36 + j * 66, w * (0.35 + 0.1 * (j % 2)), 8);
      g.fillRect(28, 52 + j * 66, w * 0.25, 5);
    }
  }
}

/**
 * At night her phone sends the conversation to the doors: a page a beat, each
 * showing a reply as it flies, each turning round as it lands so its writing
 * faces her. Drawn inside the doors, behind the glass.
 */
export function drawPagesInFlight(g: G, cam: Cam, time: number, ui: Ui): void {
  for (let i = 0; i < 4; i++) {
    const launch = pageLaunch(i);
    const land = pageLand(i);
    if (time < launch || time >= land) {
      continue;
    }
    const u = inOut((time - launch) / (land - launch));
    const end = sheetBox(i);
    const z = lerp(Z_HER - 4, Z_FACADE + 1, u);
    if (!visible(cam, z)) {
      continue;
    }
    const [px, py] = phoneAt(time);
    const cx = lerp(px, end.x + end.w / 2, u);
    const cy = lerp(py - 14, end.y + end.h / 2, u) - 90 * Math.sin(Math.PI * u);
    const w = lerp(16, end.w, u);
    const h = lerp(26, end.h, u);
    const [x0, y0] = proj(cam, cx - w / 2, cy - h / 2, z);
    const [x1, y1] = proj(cam, cx + w / 2, cy + h / 2, z);
    // The turn: it shows its reply, goes edge on, and lands with its blank back to the street.
    const flip = Math.cos(Math.PI * clamp((u - 0.62) / 0.34));
    onScreen(g, cam);
    g.save();
    const mx = (x0 + x1) / 2;
    g.translate(mx, (y0 + y1) / 2);
    g.rotate(hs(i, 81) * 0.25 * Math.sin(Math.PI * u));
    g.scale(Math.max(0.02, Math.abs(flip)), 1);
    g.translate(-(x1 - x0) / 2, -(y1 - y0) / 2);
    g.scale((x1 - x0) / end.w, (y1 - y0) / end.h);
    if (flip > 0) {
      pageFront(g, ui, i, end.w, end.h);
    } else {
      g.fillStyle = mix('#f2dfb8', INK.paper, 0.4);
      g.fillRect(0, 0, end.w, end.h);
    }
    g.restore();
  }
}

/** Clips `g` (on the facade layer) to what is left of sheet i as it peels. */
function clipSheet(g: G, i: number, time: number): Box {
  const b = sheetBox(i);
  const left = sheetLeft(i, time);
  const top = b.y + b.h * (1 - left);
  g.beginPath();
  g.rect(b.x, top, b.w, b.y + b.h - top);
  g.clip();
  return b;
}

/** COMING and SOON stamped onto the blank backs, letter by letter; the small Signal Red spiral printed beside the note. */
export function drawPrint(g: G, ctx: Ctx, cam: Cam, time: number, red: string, report: boolean): TextBox[] {
  const boxes: TextBox[] = [];
  if (!visible(cam, Z_FACADE) || time < bf(BEAT.coming)) {
    return boxes;
  }
  const words = [
    { id: 'coming', text: 'COMING', sheet: 0 },
    { id: 'soon', text: 'SOON', sheet: 1 },
  ] as const;
  const size = 54;
  for (const word of words) {
    onLayer(g, cam, Z_FACADE);
    g.save();
    const b = clipSheet(g, word.sheet, time);
    const cx = b.x + b.w / 2;
    const base = b.y + b.h / 2 + 16;
    g.font = fontOf(ctx, 'sans', 800, size);
    g.letterSpacing = `${String(0.06 * size)}px`;
    const total = g.measureText(word.text).width;
    const advances = [...word.text].map((ch) => g.measureText(ch).width);
    g.letterSpacing = '0px';
    let x = cx - total / 2;
    [...word.text].forEach((ch, j) => {
      const adv = advances[j] ?? 0;
      // Each letter is thrown at the paper: it comes at it from the camera's side, big and turning, faster and faster,
      // slams flat on its frame and springs back to shape.
      const at = printLand(j, word.sheet);
      if (time < at - PRINT_FLIGHT) {
        x += adv;
        return;
      }
      const e = time < at ? ((time - (at - PRINT_FLIGHT)) / PRINT_FLIGHT) ** 2 : 1;
      const q = time < at ? 0 : 1 - spring(time, at, PLAYFUL);
      g.save();
      g.translate(x + adv / 2 + hs(j + word.sheet * 7, 93) * 40 * (1 - e), base - size * 0.35 - 50 * (1 - e) + 10 * q);
      g.rotate(hs(j + word.sheet * 7, 94) * 0.45 * (1 - e));
      g.scale((2.4 - 1.4 * e) * (1 + 0.35 * q), (2.4 - 1.4 * e) * (1 - 0.4 * q));
      drawText(g, ctx, { id: word.id, text: ch, x: 0, y: size * 0.35, size, face: 'sans', weight: 800, fill: INK.ink, role: 'support', align: 'center' });
      g.restore();
      x += adv;
    });
    g.restore();
    // The row is reported at its resting box, so a letter still landing never shrinks it below the floor.
    onLayer(g, cam, Z_FACADE);
    const rest = drawRestingBox(g, ctx, word.text, cx, base, size);
    if (report) {
      boxes.push({ ...rest, id: word.id });
    }
  }
  // The spiral: its arcs swirl in round the dot and settle as the mark.
  if (time >= bf(BEAT.spiral) - 10) {
    onLayer(g, cam, Z_FACADE);
    g.save();
    clipSheet(g, 3, time);
    drawMark(g, ctx, SPIRAL, red, (i, dot) => clamp(spring(time, bf(BEAT.spiral) - 10 + (dot ? 0 : 3 + i * 1.5), dot ? SNAPPY : PLAYFUL), 0, 1.15));
    g.restore();
  }
  return boxes;
}

/** Where the spiral is printed on the bottom right sheet, under the note. */
const SPIRAL = { x: 742, y: 1352, size: 64 };

/** The box a word would have at rest, without drawing it. */
function drawRestingBox(g: G, ctx: Ctx, text: string, cx: number, base: number, size: number): TextBox {
  g.save();
  g.font = fontOf(ctx, 'sans', 800, size);
  g.letterSpacing = `${String(0.06 * size)}px`;
  g.textAlign = 'center';
  const m = g.measureText(text);
  const t = g.getTransform();
  const a = t.transformPoint({ x: cx - m.actualBoundingBoxLeft, y: base - m.actualBoundingBoxAscent });
  const b = t.transformPoint({ x: cx + m.actualBoundingBoxRight, y: base + m.actualBoundingBoxDescent });
  g.restore();
  g.letterSpacing = '0px';
  return { id: text, text, role: 'support', box: { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y }, fontSizePx: size * Math.hypot(t.a, t.b) };
}

const NOTE: Box = { x: 556, y: 1150, w: 222, h: 134 };
const NOTE_PX = 30;
const NOTE_LINES = ['Not even we', 'can read it.'] as const;

/**
 * The note taped to the outside of the glass: it slaps on, its tape snaps, and
 * it falls away when the paper behind it comes down. Written by hand: each
 * letter leans and sits a little off the line.
 */
export function drawNote(g: G, ctx: Ctx, cam: Cam, time: number, report: boolean): TextBox[] {
  const boxes: TextBox[] = [];
  if (!visible(cam, Z_FACADE) || time < bf(BEAT.note) - 8) {
    return boxes;
  }
  const fall = prog(time, bf(BEAT.peels[3] ?? 44.5), bf((BEAT.peels[3] ?? 44.5) + 1));
  if (fall >= 1) {
    return boxes;
  }
  onLayer(g, cam, Z_FACADE);
  // The note is slapped on: it comes at the glass big, faster and faster, flattens on its frame and springs back.
  const at = bf(BEAT.note);
  const e = time < at ? clamp((time - (at - 8)) / 8) ** 2 : 1;
  const q = time < at ? 0 : 1 - spring(time, at, PLAYFUL);
  const cx = NOTE.x + NOTE.w / 2;
  const cy = NOTE.y + NOTE.h / 2;
  g.save();
  g.translate(cx, cy + 900 * fall * fall - 120 * (1 - e));
  g.rotate(-0.035 + 0.9 * fall * fall + 0.3 * (1 - e));
  g.scale((1.8 - 0.8 * e) * (1 + 0.14 * q), (1.8 - 0.8 * e) * (1 - 0.16 * q));
  g.translate(-cx, -cy);
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.25)';
  g.shadowBlur = 10;
  g.shadowOffsetY = 4;
  g.fillStyle = '#fbf3dc';
  g.fillRect(NOTE.x, NOTE.y, NOTE.w, NOTE.h);
  g.restore();
  // Faint ruled lines, as on a pad.
  g.fillStyle = rgba('#8aa0c8', 0.35);
  for (let y = NOTE.y + 52; y < NOTE.y + NOTE.h - 8; y += 43) {
    g.fillRect(NOTE.x + 8, y + 9, NOTE.w - 16, 1.5);
  }
  // The tape snaps on half a beat after the note.
  const tape = clamp(spring(time, bf(BEAT.note + 0.5), SNAPPY), 0, 1.15);
  if (tape > 0) {
    g.fillStyle = 'rgba(232,226,205,0.78)';
    for (const [tx, rot] of [[NOTE.x + 18, -0.5], [NOTE.x + NOTE.w - 18, 0.45]] as const) {
      g.save();
      g.translate(tx, NOTE.y + 2);
      g.rotate(rot);
      g.scale(tape, tape);
      g.fillRect(-30, -10, 60, 20);
      g.restore();
    }
  }
  const ink = '#2b2448';
  const lines: TextBox[] = [];
  NOTE_LINES.forEach((line, li) => {
    const base = NOTE.y + 58 + li * 43;
    let x = NOTE.x + 16;
    g.font = fontOf(ctx, 'serif', 500, NOTE_PX, true);
    [...line].forEach((ch, j) => {
      const adv = g.measureText(ch).width;
      const n = li * 31 + j;
      g.save();
      g.translate(x, base + hs(n, 91) * 1.6);
      g.rotate(hs(n, 92) * 0.06);
      const box = drawText(g, ctx, { id: 'note', text: ch, x: 0, y: 0, size: NOTE_PX, face: 'serif', weight: 500, fill: ink, role: 'support', italic: true });
      if (ch !== ' ') {
        lines.push(box);
      }
      g.restore();
      x += adv * 0.97;
    });
  });
  g.restore();
  const merged = unionBox('note', 'Not even we can read it.', 'support', lines);
  if (report && merged !== null) {
    boxes.push(merged);
  }
  return boxes;
}

void lerp;
void SNAPPY;
void prog;
void PLAYFUL;
