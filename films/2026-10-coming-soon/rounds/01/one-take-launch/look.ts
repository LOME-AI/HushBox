import { END_D, F, REST_BEAT, Z_FACADE, Z_ROWS, Z_SCREEN, cameraAt, onLayer, onScreen, visible } from './camera.js';
import { drawHer } from './figure.js';
import { CX, H, PLAYFUL, SNAPPY, TAU, W, bf, clamp, prog, spring } from './kit.js';
import { drawBoardLetters, drawFalling, drawOpenFlight, drawPile } from './letters.js';
import { drawMark, markAtRest } from './mark.js';
import { drawNote, drawPagesInFlight, drawPrint, pageLanded } from './paper.js';
import { BEAT, definition } from './score.js';
import { drawText, fontOf } from './type.js';
import {
  composerLayout,
  docActive,
  drawBubble,
  drawComposer,
  drawDocCard,
  drawImageCard,
  drawNameCards,
  drawSearchCard,
  drawSignName,
  rowLand,
  slabLaidAt,
  uiColors,
} from './ui.js';
import {
  INK_WALL,
  SCREEN,
  clipOpening,
  drawDoors,
  drawFacade,
  drawHallShell,
  drawNeighbours,
  drawPaper,
  drawRow,
  drawScreen,
  drawSign,
  drawSky,
  drawStreet,
  drawStreetLight,
  nightness,
} from './world.js';

import type { Cam } from './camera.js';
import type { G } from './kit.js';
import type { LookBox, LookContext, RenderFrame, TextBox } from '../../../../engine/look/index.js';
import type { PostSettings } from '../../../../engine/visual/gl/index.js';

type Ctx = LookContext<'2d'>;

const { spec } = definition;

/** A copy row's frames, from the spec, so every box is reported exactly across its span. */
function span(id: string): { from: number; to: number } {
  const row = spec.text.find((t) => t.id === id);
  if (row === undefined) {
    throw new Error(`one-take-launch: no text row ${id}`);
  }
  return { from: row.from, to: row.to };
}
function within(frame: number, id: string): boolean {
  const s = span(id);
  return frame >= s.from && frame < s.to;
}

/** The mark on the screen: placed so that when the camera rests, it sits high on the end card. */
const K_END = F / END_D;
const MARK_SCREEN_Y = 560;
const MARK_PX = 380;
const MARK = {
  x: SCREEN.x + SCREEN.w / 2,
  y: SCREEN.y + SCREEN.h / 2 + (MARK_SCREEN_Y - 960) / K_END,
  size: MARK_PX / K_END,
};

/** The mark forms on the screen as the camera flies down the hall. */
function drawScreenMark(g: G, ctx: Ctx, cam: Cam, frame: number, time: number, red: string): LookBox[] {
  // The dot opens with the screen's iris; the arcs swirl in round it as the screen fills the frame.
  const dotAt = bf(BEAT.fly) + 8;
  const arcsAt = bf(BEAT.fly + 0.4);
  if (time < dotAt || !visible(cam, Z_SCREEN)) {
    return [];
  }
  onLayer(g, cam, Z_SCREEN);
  // From the wordmark on, the mark breathes: a slow swell and fall, so the card is never frozen.
  const breath = time < bf(BEAT.wordmark) ? 0 : 0.035 * (1 - Math.cos((TAU * (time - bf(BEAT.wordmark))) / 150)) / 2;
  const place = { ...MARK, size: MARK.size * (1 + breath) };
  if (frame >= bf(REST_BEAT)) {
    return [markAtRest(g, ctx, place, red, 'end-mark')];
  }
  drawMark(g, ctx, place, red, (i, dot) => {
    const w = spring(time, dot ? dotAt : arcsAt + i * 1.6, dot ? SNAPPY : PLAYFUL);
    return clamp(w, 0, 1.15);
  });
  return [];
}

/**
 * The end card's words: the wordmark drops in a letter at a time on its beat,
 * each letter overshooting and settling; the tagline's lines rise one after
 * another from behind a line, each overshooting. A copy row reports the box it
 * rests in.
 */
function drawCard(g: G, ctx: Ctx, frame: number, time: number): TextBox[] {
  const boxes: TextBox[] = [];
  if (frame < bf(BEAT.wordmark) - 6) {
    return boxes;
  }
  const ui = uiColors(ctx);
  onScreen(g, null);
  const size = 132;
  const base = 900;
  g.font = fontOf(ctx, 'serif', 900, size);
  const word = 'HushBox';
  const advances = [...word].map((ch) => g.measureText(ch).width + 0.01 * size);
  const total = advances.reduce((a, b) => a + b, 0);
  let x = CX - total / 2;
  const parts: TextBox[] = [];
  [...word].forEach((ch, j) => {
    const at = bf(BEAT.wordmark) - 6 + j * 2;
    const adv = advances[j] ?? 0;
    if (time >= at) {
      const drop = spring(time, at, PLAYFUL);
      g.save();
      g.translate(x + adv / 2, base - size * 0.35 - 70 * (1 - drop));
      g.scale(1 + 0.25 * (1 - drop), 1 + 0.25 * (1 - drop));
      parts.push(drawText(g, ctx, { id: 'wordmark', text: ch, x: 0, y: size * 0.35, size, face: 'serif', weight: 900, fill: j < 4 ? ui.text : ui.red, role: 'headline', align: 'center' }));
      g.restore();
    }
    x += adv;
  });
  if (frame >= bf(BEAT.wordmark)) {
    // The row rests where every letter settles.
    g.save();
    g.font = fontOf(ctx, 'serif', 900, size);
    const m = g.measureText(word);
    g.restore();
    boxes.push({ id: 'wordmark', text: 'HushBox', role: 'headline', fontSizePx: size, box: { x: CX - total / 2, y: base - m.actualBoundingBoxAscent, width: total, height: m.actualBoundingBoxAscent + m.actualBoundingBoxDescent } });
  }
  void parts;
  const rows = [
    { id: 'tag-1', text: 'One interface.' },
    { id: 'tag-2', text: 'Every feature.' },
    { id: 'tag-3', text: 'Private.' },
  ] as const;
  rows.forEach((row, i) => {
    const at = bf(BEAT.tagline) - 4 + i * 6;
    if (time < at) {
      return;
    }
    const y = 1030 + i * 100;
    const rise = spring(time, at, { hz: 2.6, damp: 5 });
    // Each line rises out of the line it rests on, overshoots above it and settles back.
    g.save();
    g.beginPath();
    g.rect(0, 0, W, y + 22);
    g.clip();
    const drawn = drawText(g, ctx, { id: row.id, text: row.text, x: CX, y: y + 70 * (1 - rise), size: 88, face: 'sans', weight: i === 2 ? 800 : 600, fill: ui.text, role: 'headline', align: 'center' });
    g.restore();
    if (frame >= bf(BEAT.tagline)) {
      boxes.push({ ...drawn, box: { ...drawn.box, y: drawn.box.y - 70 * (1 - rise) } });
    }
  });
  return boxes;
}

/**
 * The take draws on a 2D canvas. The look host loads it by path, so no module
 * imports these exports.
 * @toolContract
 */
export const context = '2d';

/**
 * The post chain: a little bloom on the night's lights, less by day and none on
 * the end card, and a soft vignette.
 * @toolContract
 */
export function post(frame: number): PostSettings {
  const night = nightness(frame);
  const end = clamp(prog(frame, bf(BEAT.screen - 1), bf(BEAT.screen)));
  return {
    bloom: (0.25 + 0.35 * night) * (1 - end),
    aberration: 0,
    vignette: 0.32 - 0.12 * end,
    flash: 0,
  };
}

/**
 * Coming Soon as one continuous take: a question deleted into a pile of
 * letters, a question sent, and its answers building the cinema she opens.
 * @toolContract
 */
export const renderFrame: RenderFrame<'2d'> = (frame, ctx) => {
  const g = softwareContext();
  g.reset();
  const boxes = paint(g, frame, ctx);
  ctx.context.drawImage(g.canvas, 0, 0);
  return boxes;
};

/**
 * The canvas the frame is drawn on before it is copied whole onto the host's: a
 * `willReadFrequently` canvas, which the browser rasterises in software, so a
 * frame draws the same pixels on every render. Reset at the start of every call.
 */
let software: CanvasRenderingContext2D | null = null;
function softwareContext(): CanvasRenderingContext2D {
  if (software === null) {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context === null) {
      throw new Error('one-take-launch: the browser gave no software 2D context');
    }
    software = context;
  }
  return software;
}

function paint(g: CanvasRenderingContext2D, frame: number, ctx: Ctx): LookBox[] {
  const time = ctx.time;
  const cam = cameraAt(time);
  const ui = uiColors(ctx);
  const boxes: LookBox[] = [];

  drawSky(g, cam, time);

  // The hall behind the doors: seen only through the opening while the facade is in front of the camera.
  g.save();
  if (visible(cam, Z_FACADE)) {
    clipOpening(g, cam);
  }
  drawHallShell(g, cam, time, time >= bf(BEAT.rows[0]));
  drawScreen(g, cam, time, ui.bg, MARK);
  boxes.push(...drawScreenMark(g, ctx, cam, frame, time, ui.red));
  for (let r = Z_ROWS.length - 1; r >= 0; r--) {
    const land = rowLand(r);
    if (time >= land) {
      // Each row lands on its own half beat, squashes, and parts into seats.
      const split = clamp(spring(time, land, SNAPPY));
      const squash = 1 - spring(time, land, PLAYFUL);
      drawRow(g, cam, r, split, squash, time);
    }
  }
  drawPile(g, ctx, cam, time);
  drawHer(g, cam, time);
  drawPagesInFlight(g, cam, time, ui);
  drawOpenFlight(g, ctx, cam, time, false);
  g.restore();

  // The street side: the neighbours, the wall, the paper on the glass, the doors, the sign, the street.
  drawNeighbours(g, cam, time);
  drawFacade(g, cam, time);
  drawPaper(g, cam, time, (i) => pageLanded(i, time));
  boxes.push(...drawPrint(g, ctx, cam, time, ui.red, within(frame, 'coming')));
  drawDoors(g, cam, time);
  boxes.push(...drawNote(g, ctx, cam, time, within(frame, 'note')));
  drawSign(g, cam, time);
  drawSignName(g, ctx, cam, time);
  boxes.push(...drawBoardLetters(g, ctx, cam, time, span('open')));
  drawStreet(g, cam, time, (i) => slabLaidAt(i, time));
  drawStreetLight(g, cam, time);
  drawOpenFlight(g, ctx, cam, time, true);

  // The app, over the world: its cards hand each piece to the world as it lands.
  boxes.push(...drawComposer(g, ctx, cam, frame, time));
  if (frame < bf(BEAT.ask) + 30) {
    drawFalling(g, ctx, cam, time, composerLayout(g, ctx, cam));
  }
  if (docActive(time)) {
    boxes.push(...drawDocCard(g, ctx, cam, time));
    // The bars land behind her: while they hang and fall she and the pile stay in front of them.
    if (time >= bf(BEAT.seatsMorph) - 3) {
      drawPile(g, ctx, cam, time);
      drawHer(g, cam, time);
    }
  }
  boxes.push(...drawBubble(g, ctx, frame, time));
  boxes.push(...drawSearchCard(g, ctx, cam, time));
  boxes.push(...drawImageCard(g, ctx, cam, time, INK_WALL(time)));
  boxes.push(...drawNameCards(g, ctx, cam, time));
  boxes.push(...drawCard(g, ctx, frame, time));
  onScreen(g, null);
  return boxes;
}
