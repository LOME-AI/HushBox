import { H, W, boilTick, clamp, hash, hexOf } from './kit.js';
import { MARK, PAGE_TURN, PEEL, definition } from './score.js';
import { shotHook, shotSearch, shotSeats, shotSend, shotSign, shotStreet, shotWant } from './shots-a.js';
import { shotComingSoon, shotEnd, shotOpen, shotPaper, shotPeel, shotTurn } from './shots-b.js';

import type { ShotArgs } from './shots-a.js';
import type { LookBox, LookContext, RenderFrame } from '../../../../engine/look/index.js';
import type { PostSettings } from '../../../../engine/visual/gl/index.js';

type Ctx = LookContext<'2d'>;

const { spec } = definition;

type ShotId = 'hook' | 'want' | 'send' | 'seats' | 'search' | 'street' | 'sign' | 'paper' | 'coming-soon' | 'peel' | 'open' | 'end';

const SHOTS: Record<ShotId, (a: ShotArgs) => LookBox[]> = {
  hook: shotHook,
  want: shotWant,
  send: shotSend,
  seats: shotSeats,
  search: shotSearch,
  street: shotStreet,
  sign: shotSign,
  paper: shotPaper,
  'coming-soon': shotComingSoon,
  peel: shotPeel,
  // Its last half beat is the page turning onto the end page.
  open: (a) => (a.frame >= PAGE_TURN ? shotTurn(a) : shotOpen(a, true)),
  end: shotEnd,
};

/** How much glow each shot's lights bloom: the night's lamps and screens, little by day. */
const BLOOM: Record<ShotId, number> = {
  hook: 0.4,
  want: 0.5,
  send: 0.35,
  seats: 0.55,
  search: 0.35,
  street: 0.55,
  sign: 0.6,
  paper: 0.5,
  'coming-soon': 0.5,
  peel: 0.3,
  open: 0.15,
  end: 0,
};

function shotAt(frame: number): ShotId {
  const shot = spec.shots.find((s) => frame >= s.from && frame < s.to) ?? spec.shots.at(-1);
  if (shot === undefined || !Object.hasOwn(SHOTS, shot.id)) {
    throw new Error(`storybook-short: no shot at frame ${String(frame)}`);
  }
  return shot.id as ShotId;
}

/**
 * The take draws on a 2D canvas. The look host loads it by path, so no module
 * imports these exports.
 * @toolContract
 */
export const context = '2d';

/**
 * The post chain per frame: bloom on the night's lights, a storybook vignette,
 * and one flash, as the paper comes down and the morning floods in.
 * @toolContract
 */
export function post(frame: number): PostSettings {
  const id = shotAt(frame);
  const d = frame - PEEL;
  const flash = d >= 0 && d < 24 ? 0.28 * 0.5 ** (d / 4) : 0;
  return { bloom: BLOOM[id], aberration: 0, vignette: id === 'end' ? 0.25 : 0.42, flash };
}

/**
 * Coming Soon as a storybook short: she types the question and deletes it,
 * and the deleted letters fall and pile up; she sends it; the answers build
 * her cinema in gold; at night the conversation papers its doors, blank from
 * the street but for a red spiral and a note; at dawn she peels it down and
 * spells OPEN with letters from the pile.
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
 * The canvas a frame is drawn on before it is copied whole onto the host's: a
 * `willReadFrequently` canvas, which the browser rasterises in software, so the
 * same frame draws the same pixels on every render. Reset at the start of every
 * call, it carries nothing between calls.
 */
let software: CanvasRenderingContext2D | null = null;

function softwareContext(): CanvasRenderingContext2D {
  if (software === null) {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context === null) {
      throw new Error('storybook-short: the browser gave no software 2D context');
    }
    software = context;
  }
  return software;
}

/** The paper the whole book is drawn on: a grain built once from the seed, half the frame's size. */
let grain: { seed: number; canvas: HTMLCanvasElement } | null = null;

function grainOf(seed: number): HTMLCanvasElement {
  if (grain !== null && grain.seed === seed) {
    return grain.canvas;
  }
  const canvas = document.createElement('canvas');
  const w = W / 2 + 32;
  const h = H / 2 + 32;
  canvas.width = w;
  canvas.height = h;
  const c = canvas.getContext('2d', { willReadFrequently: true });
  if (c === null) {
    throw new Error('storybook-short: no 2D context for the paper grain');
  }
  const img = c.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const fibre = hash(i, seed) * 0.7 + hash(Math.floor(i / 3), seed + 1) * 0.3;
    const v = Math.round(128 + (fibre - 0.5) * 110);
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  c.putImageData(img, 0, 0);
  grain = { seed, canvas };
  return canvas;
}

/** The seed every procedural value of the look is keyed from, drawn from the take's seeded source. */
function seedOf(ctx: Ctx): number {
  return Math.floor(ctx.random('look')() * 1_000_000);
}

function paint(g: CanvasRenderingContext2D, frame: number, ctx: Ctx): LookBox[] {
  const id = shotAt(frame);
  const seed = seedOf(ctx);
  const args: ShotArgs = { g, ctx, frame, time: ctx.time, seed, red: hexOf(ctx.brand.brandRed) };
  g.save();
  const boxes = SHOTS[id](args);
  g.restore();
  // The paper's tooth over every page of the book but the last, its fibres re-rolled a few times a second.
  const endStill = frame >= MARK;
  if (!endStill) {
    const tick = boilTick(ctx.time, 6);
    const ox = Math.floor(hash(tick, seed + 3) * 24);
    const oy = Math.floor(hash(tick, seed + 4) * 24);
    g.save();
    g.globalCompositeOperation = 'overlay';
    g.globalAlpha = clamp(0.16);
    g.imageSmoothingEnabled = false;
    g.drawImage(grainOf(seed), ox, oy, W / 2, H / 2, 0, 0, W, H);
    g.restore();
  }
  return boxes;
}
