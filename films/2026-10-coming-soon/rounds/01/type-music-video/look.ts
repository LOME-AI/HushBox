import { CARD_REST, DIVE, FINAL, PRESS, SEND, bf } from './beats.js';
import { CX, CY, H, W, clamp, env, hs, setSeed } from './kit.js';
import { code, names, pick, seats, sent, street } from './scenes-build.js';
import { dawnShot, facadeShot, openShot, outside, papering, sign } from './scenes-cinema.js';
import { endCard } from './scenes-end.js';
import { ask, deleteScene, doubt, nights, wish } from './scenes-night.js';
import { definition } from './score.js';

import type { G } from './kit.js';
import type { Ctx } from './type.js';
import type { LookBox, RenderFrame } from '../../../../engine/look/index.js';
import type { PostSettings } from '../../../../engine/visual/gl/index.js';

const { spec } = definition;

type Scene = (g: G, ctx: Ctx, frame: number, time: number) => LookBox[];

const SCENES: Record<string, Scene> = {
  doubt,
  delete: deleteScene,
  nights,
  wish,
  ask,
  sent,
  street,
  code,
  seats,
  names,
  pick,
  sign,
  facade: facadeShot,
  papering,
  outside,
  dawn: dawnShot,
  open: openShot,
  end: endCard,
};

/** Every cue that lands a blow: they drive the camera kick; impacts also shake. */
const HITS = spec.cues.filter((c) => c.kind === 'impact' || c.kind === 'hit').map((c) => c.from);
const IMPACTS = spec.cues.filter((c) => c.kind === 'impact').map((c) => c.from);

function shotAt(frame: number): (typeof spec.shots)[number] {
  const shot = spec.shots.find((s) => frame >= s.from && frame < s.to) ?? spec.shots.at(-1);
  if (shot === undefined || !Object.hasOwn(SCENES, shot.id)) {
    throw new Error(`type-music-video: no scene for the shot at frame ${String(frame)}`);
  }
  return shot;
}

/**
 * The take draws on a 2D canvas. The look host loads it by path, so no module
 * imports these exports.
 * @toolContract
 */
export const context = '2d';

/**
 * Four sub-frames across the shutter, so falling letters, flying sheets and
 * whips smear instead of splitting into copies.
 * @toolContract
 */
export const motionBlur = 4;

/**
 * The post chain per frame: bloom for the bulbs, lamps and phone light, a
 * small channel split on the blows and a deeper vignette on the two inhales.
 * No flash: the chain adds it in linear light, where even a little greys the
 * whole frame.
 * @toolContract
 */
export function post(frame: number): PostSettings {
  const shot = shotAt(frame);
  const hit = clamp(env(frame, HITS, 4));
  const inhale = (frame >= bf(PRESS) && frame < bf(SEND)) || (frame >= bf(DIVE) && frame < bf(FINAL));
  const end = shot.id === 'end';
  return {
    bloom: (BLOOM[shot.id] ?? 0.5) * (1 + 0.3 * hit),
    aberration: end && frame >= bf(CARD_REST) ? 0 : 0.03 + 0.07 * hit,
    vignette: inhale ? 0.85 : end ? 0.35 : 0.5,
    flash: 0,
  };
}

/** Bloom by shot: full on the night's lamps and bulbs, low where paper or type fills the frame, so dark ink stays dark. */
const BLOOM: Readonly<Record<string, number>> = {
  doubt: 0.7,
  delete: 0.7,
  nights: 0.55,
  wish: 0.6,
  ask: 0.65,
  sent: 0.55,
  street: 0.7,
  code: 0.08,
  seats: 0.55,
  names: 0.08,
  pick: 0.08,
  sign: 0.6,
  facade: 0.6,
  papering: 0.3,
  outside: 0.22,
  dawn: 0.22,
  open: 0.3,
  end: 0.18,
};

/**
 * Coming Soon as a kinetic-type music video: every thing on screen is built
 * from letters. The doubt she deletes piles up; the wish she sends is
 * answered and the answers build a cinema; at night its conversation papers
 * the doors; at dawn she spells OPEN with letters from the heap.
 * @toolContract
 */
export const renderFrame: RenderFrame<'2d'> = (frame, ctx) => {
  setSeed(Math.floor(ctx.random('take')() * 2147483647));
  const g = softwareContext();
  g.reset();
  const boxes = paint(g, frame, ctx);
  ctx.context.drawImage(g.canvas, 0, 0);
  return boxes;
};

/**
 * The canvas each frame is drawn on before it is copied whole onto the host's:
 * a `willReadFrequently` canvas, which the browser rasterises in software, so
 * the same frame draws the same pixels on every render. Reset at the start of
 * every call, it carries nothing between calls.
 */
let software: CanvasRenderingContext2D | null = null;

function softwareContext(): CanvasRenderingContext2D {
  if (software === null) {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context === null) {
      throw new Error('type-music-video: the browser gave no software 2D context');
    }
    software = context;
  }
  return software;
}

function paint(g: CanvasRenderingContext2D, frame: number, ctx: Ctx): LookBox[] {
  const shot = shotAt(frame);
  const scene = SCENES[shot.id];
  if (scene === undefined) {
    return [];
  }
  const time = ctx.time;
  // The camera kick on every blow, keyed to the whole frame so both sub-frames take the same offset.
  // No kick on the still card, nor outside, where THE sits at the frame's top and the note at the safe area's edge.
  const still = (shot.id === 'end' && frame >= bf(FINAL) + 10) || shot.id === 'outside';
  const near = Math.round(time);
  const punch = still ? 0 : clamp(env(near, HITS.filter((h) => h >= shot.from), 4), 0, 1.4);
  const shake = still ? 0 : 7 * clamp(env(near, IMPACTS.filter((h) => h >= shot.from), 3));
  const zoom = 1 + 0.022 * punch;
  g.save();
  g.translate(CX + shake * hs(near * 3, 1), CY + shake * hs(near * 3 + 1, 1));
  g.scale(zoom, zoom);
  g.translate(-CX, -CY);
  const boxes = scene(g, ctx, frame, time);
  g.restore();
  return boxes;
}
