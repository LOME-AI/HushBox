import { drawHud } from './hud.js';
import {
  CX,
  DEFAULT,
  FPB,
  H,
  HELL,
  INK,
  PARCH,
  SURV,
  W,
  beatPulse,
  bf,
  clamp,
  env,
  hs,
  lerp,
  prog,
  rgba,
  smooth,
  springOf,
  wander,
} from './kit.js';
import { LAUGH_EASE_BEAT, LAUGH_FREEZE_BEAT, laugh } from './scenes-escape.js';
import { allButOne, allOfThem } from './field-search.js';
import { flock } from './flock.js';
import { leak, worldToSee } from './leak.js';
import { file, notToLike, ofCourse } from './scenes-hook.js';
import {
  brandPalette,
  encrypted,
  flinch,
  lens,
  lightPalette,
  markShot,
  notHushbox,
  unreadable,
} from './scenes-hush.js';
import { save, watch } from './scenes-praise.js';
import { notForSale } from './scenes-sale.js';
import { definition } from './film.js';
import { Q1_LEAD, TYPE_FRAMES } from './score.js';
import { drawRows, fontOf, frameBox, intoSafeBox, padded } from './type.js';
import { SAFE_BOX } from '../engine/layout/index.js';

import type { G, Palette } from './kit.js';
import type { Row, RowStyle } from './type.js';
import type { LookBox, LookContext, RenderFrame, TextBox } from '../engine/look/index.js';
import type { PostSettings } from '../engine/visual/gl/index.js';

type Ctx = LookContext<'2d'>;

const { spec } = definition;

/** Every cue that lands a blow: they drive the shake, the zoom punch and the chromatic split. */
const HITS = spec.cues.filter((c) => c.kind === 'impact' || c.kind === 'hit').map((c) => c.from);

type ShotId =
  | 'file'
  | 'of-course'
  | 'not-to-like'
  | 'save'
  | 'watch'
  | 'leak'
  | 'world-to-see'
  | 'flock'
  | 'laugh'
  | 'all-of-them'
  | 'all-but-one'
  | 'encrypted'
  | 'flinch'
  | 'unreadable'
  | 'lens'
  | 'not-for-sale'
  | 'which-one'
  | 'mark';

/** A mid-shot reframe: on `beat` the camera goes to zoom `z` about (x, y), by a spring, a cut or an ease. */
type Reframe = readonly [
  beat: number,
  z: number,
  x: number,
  y: number,
  how: 'spring' | 'cut' | 'ease',
];

interface Look {
  pal: (ctx: Ctx) => Palette;
  /** Log-space zoom at the shot's start and end. */
  zoom: readonly [number, number];
  roll: number;
  /** Where the copy stack starts. */
  top: number;
  styles: (ctx: Ctx) => readonly [RowStyle, RowStyle];
  bloom: number;
  /** No roll at all, not even on a hit: the shot shows the logo at rest, whose box only scale and translation keep exact. */
  level?: true;
  /**
   * Mid-shot reframes on the beat: at `beat` the camera goes to `zoom` about (x, y), on a spring,
   * as a punch-in cut where dense line art would flicker under a fast move (WCAG 2.3.1), or on a
   * one-beat ease with no overshoot.
   */
  reframe?: readonly Reframe[];
  /** The vignette's strength, where the palette's default would dim the copy below its contrast. */
  vignette?: number;
  /** How opaque the scrim behind the copy is at its middle, where the default 0.9 lets the picture lift the background. */
  scrim?: number;
  /** A scrim behind the question too, where the picture runs bright under it. */
  questionScrim?: true;
}

function style({
  face,
  weight,
  size,
  color,
  tracking = 0.02,
  shadow = null,
}: {
  face: RowStyle['face'];
  weight: number;
  size: number;
  color: string;
  tracking?: number;
  shadow?: string | null;
}): RowStyle {
  return { face, weight, size, color, tracking, shadow };
}

/** The Devil's answers: gold serif, his second line in ember. */
const devilVoice = (pal: Palette = INK): readonly [RowStyle, RowStyle] => [
  style({ face: 'serif', weight: 900, size: 112, color: pal.hot, tracking: 0.02 }),
  style({ face: 'serif', weight: 900, size: 112, color: pal.key, tracking: 0.02 }),
];
const valuePair = (ctx: Ctx, light = false): readonly [RowStyle, RowStyle] => {
  const pal = light ? lightPalette(ctx) : brandPalette(ctx);
  // The headline in the narrower sans, so each value's first line holds on one line at its size.
  return [
    style({ face: 'sans', weight: 900, size: 104, color: pal.key, tracking: 0.01 }),
    style({ face: 'sans', weight: 700, size: 88, color: pal.hot, tracking: 0.04 }),
  ];
};
/**
 * The tagline's size, gap and top: the three rows fit between the wordmark and the foot of the safe box,
 * no smaller than a headline's floor.
 */
const END_PX = 88;
const END_GAP = 10;
/** Behind the tagline the end card's rays are dimmed this far, so Signal Red keeps its contrast over them. */
const END_SCRIM = 0.6;
const END_SCRIM_FRAMES = 8;

const endStyles = (ctx: Ctx): readonly [RowStyle, RowStyle] => {
  const pal = brandPalette(ctx);
  return [
    style({ face: 'sans', weight: 700, size: END_PX, color: pal.hot, tracking: 0.01 }),
    style({ face: 'sans', weight: 800, size: END_PX, color: pal.key, tracking: 0.01 }),
  ];
};

/** The shots of the end card, which draw no scrim and no HUD. */
const END: ReadonlySet<ShotId> = new Set(['mark']);

const LOOKS: Record<ShotId, Look> = {
  file: { pal: () => INK, zoom: [1, 1], roll: 0, top: 360, styles: () => devilVoice(), bloom: 1 },
  'of-course': {
    pal: () => INK,
    zoom: [1, 1.1],
    roll: 0.006,
    top: 330,
    styles: () => devilVoice(),
    bloom: 0.9,
  },
  'not-to-like': {
    pal: () => INK,
    zoom: [1, 1.12],
    roll: 0.006,
    top: 330,
    styles: () => devilVoice(),
    bloom: 0.9,
  },
  save: {
    pal: () => PARCH,
    zoom: [1, 1.08],
    roll: 0.006,
    top: 980,
    styles: () => [
      style({ face: 'serif', weight: 900, size: 104, color: PARCH.line }),
      style({ face: 'serif', weight: 900, size: 104, color: PARCH.key }),
    ],
    bloom: 0,
    reframe: [[13.5, 1.4, 540, 1250, 'cut']],
  },
  watch: {
    pal: () => SURV,
    zoom: [1, 1.1],
    roll: 0.015,
    top: 940,
    styles: () => devilVoice(SURV),
    bloom: 0.8,
  },
  leak: {
    pal: () => SURV,
    zoom: [1, 1.05],
    roll: 0.006,
    top: 330,
    styles: () => devilVoice(SURV),
    bloom: 0.8,
  },
  'world-to-see': {
    pal: () => SURV,
    zoom: [1, 1.12],
    roll: 0.01,
    top: 330,
    styles: () => devilVoice(SURV),
    bloom: 0.9,
  },
  // The flock carries its own keyed camera.
  flock: {
    pal: () => HELL,
    zoom: [1, 1],
    roll: 0,
    top: 340,
    styles: () => devilVoice(HELL),
    bloom: 1,
  },
  laugh: {
    pal: () => INK,
    zoom: [1, 1],
    roll: 0.02,
    top: 300,
    styles: () => devilVoice(),
    bloom: 1,
    reframe: [
      [33, 1.5, 540, 1400, 'spring'],
      [LAUGH_FREEZE_BEAT, 2.1, 540, 1150, 'cut'],
      [LAUGH_EASE_BEAT, 1, CX, H / 2, 'ease'],
    ],
  },
  // The search flies its own camera through the field.
  'all-of-them': {
    pal: () => INK,
    zoom: [1, 1],
    roll: 0,
    level: true,
    top: 360,
    styles: () => devilVoice(),
    bloom: 0.9,
  },
  'all-but-one': {
    pal: () => INK,
    zoom: [1, 1],
    roll: 0,
    level: true,
    top: 330,
    styles: () => devilVoice(),
    bloom: 0.9,
  },
  encrypted: {
    pal: brandPalette,
    zoom: [1, 1.12],
    roll: 0.01,
    top: 900,
    styles: valuePair,
    bloom: 0.7,
    reframe: [[47, 1.6, 900, 700, 'cut']],
  },
  flinch: {
    pal: lightPalette,
    zoom: [1, 1.08],
    roll: 0.02,
    top: 330,
    styles: (ctx) => valuePair(ctx, true),
    bloom: 0,
    reframe: [[49, 1.5, 300, 960, 'cut']],
  },
  // Signal Red on charcoal has little contrast to spare: this shot's copy sits high, where the vignette would dim it, over the cipher wall.
  unreadable: {
    pal: brandPalette,
    zoom: [1.02, 1.1],
    roll: 0.008,
    top: 330,
    styles: valuePair,
    bloom: 0.7,
    reframe: [[52, 1.8, 760, 1320, 'cut']],
    vignette: 0,
    scrim: 1,
  },
  lens: {
    pal: lightPalette,
    zoom: [1, 1.1],
    roll: 0.015,
    top: 330,
    styles: (ctx) => valuePair(ctx, true),
    bloom: 0,
    reframe: [[55.5, 1.5, 560, 1300, 'cut']],
  },
  'not-for-sale': {
    pal: brandPalette,
    zoom: [1, 1.04],
    roll: 0.01,
    top: 980,
    styles: valuePair,
    bloom: 0.7,
    reframe: [[58.5, 1.6, 600, 1330, 'cut']],
  },
  'which-one': {
    pal: brandPalette,
    zoom: [1, 1.35],
    roll: 0.03,
    top: 360,
    styles: valuePair,
    bloom: 0.8,
    reframe: [[61, 1.4, 540, 1350, 'cut']],
    questionScrim: true,
  },
  mark: {
    pal: brandPalette,
    zoom: [1, 1],
    roll: 0,
    level: true,
    top: 969,
    styles: endStyles,
    bloom: 0,
  },
};

function shotAt(frame: number): (typeof spec.shots)[number] & { id: ShotId } {
  const shot = spec.shots.find((s) => frame >= s.from && frame < s.to) ?? spec.shots.at(-1);
  if (shot === undefined || !Object.hasOwn(LOOKS, shot.id)) {
    throw new Error(`2026-09-all-but-one: no look for the shot at frame ${String(frame)}`);
  }
  return shot as (typeof spec.shots)[number] & { id: ShotId };
}

/** The wordmark as the brand sets it: "Hush" in the foreground colour and "Box" in Signal Red. */
function wordmark(g: G, ctx: Ctx, time: number, row: Row): TextBox {
  const pal = brandPalette(ctx);
  const size = 150;
  const k = clamp((time - row.from) / 8);
  g.save();
  g.font = fontOf(ctx, 'serif', 900, size);
  g.letterSpacing = `${String((row.id === 'wordmark' ? 0.3 * (1 - k) : 0) * size + 0.01 * size)}px`;
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  const a = g.measureText('Hush');
  const b = g.measureText('Box');
  const width = a.width + b.width;
  const x = CX - width / 2;
  // Under the mark, above the tagline.
  const y = 960;
  const ascent = Math.max(a.actualBoundingBoxAscent, b.actualBoundingBoxAscent);
  const descent = Math.max(a.actualBoundingBoxDescent, b.actualBoundingBoxDescent);
  const left = x - a.actualBoundingBoxLeft;
  const inked = padded({
    x: left,
    y: y - ascent,
    width: x + a.width + b.actualBoundingBoxRight - left,
    height: ascent + descent,
  });
  // While its letters converge it is wider than the safe box: it is scaled about its centre to fit, then moved in as little as it must.
  const fit = Math.min(1, (SAFE_BOX.width - 2) / inked.width);
  const scaled = {
    x: CX + (inked.x - CX) * fit,
    y: y + (inked.y - y) * fit,
    width: inked.width * fit,
    height: inked.height * fit,
  };
  const [dx, dy] = intoSafeBox(scaled);
  if (fit !== 1 || dx !== 0 || dy !== 0) {
    g.translate(CX + dx, y + dy);
    g.scale(fit, fit);
    g.translate(-CX, -y);
  }
  if (!ctx.hideText) {
    g.fillStyle = pal.hot;
    g.fillText('Hush', x, y);
    g.fillStyle = pal.key;
    g.fillText('Box', x + a.width, y);
  }
  g.restore();
  g.letterSpacing = '0px';
  const box = { x: scaled.x + dx, y: scaled.y + dy, width: scaled.width, height: scaled.height };
  return { id: row.id, text: row.words, box, fontSizePx: size * fit, role: row.role };
}

const QUESTION_PX = 58;

/**
 * The interviewer's question, typed a character every two frames at the left of
 * the safe box behind a Q., a block cursor blinking after it. The box reported
 * is the typed text's and its Q.'s; the cursor is reported as imagery.
 */
function question(
  g: G,
  ctx: Ctx,
  { frame, row, top }: { frame: number; row: Row; top: number }
): TextBox[] {
  const lead = row.id === 'q1' ? Q1_LEAD : 0;
  // The question types in, then backspaces out two characters a frame, empty two frames before its cut.
  const erase = Math.ceil(row.words.length / 2) + 2;
  const erased = Math.max(0, (frame - (row.to - erase)) * 2);
  const typed = Math.max(
    0,
    Math.min(row.words.length, Math.floor((frame - row.from + lead) / TYPE_FRAMES) + 1) - erased
  );
  const text = row.words.slice(0, typed);
  const x = 110;
  const y = top + QUESTION_PX;
  const cursor = Math.floor(frame / 15) % 2 === 0 || typed < row.words.length;
  g.save();
  g.font = fontOf(ctx, 'mono', 700, QUESTION_PX);
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  const full = g.measureText(row.words);
  const scale = Math.min(1, 800 / Math.max(1, full.width + 60));
  g.translate(x, y);
  g.scale(scale, scale);
  const m = g.measureText(text);
  g.font = fontOf(ctx, 'mono', 500, 30);
  const label = g.measureText('Q.');
  g.font = fontOf(ctx, 'mono', 700, QUESTION_PX);
  const t = g.getTransform();
  if (!ctx.hideText) {
    g.fillStyle = rgba(INK.line, 0.9);
    g.font = fontOf(ctx, 'mono', 500, 30);
    g.fillText('Q.', 0, -QUESTION_PX - 10);
    g.font = fontOf(ctx, 'mono', 700, QUESTION_PX);
    g.fillStyle = '#f2ece0';
    g.fillText(text, 0, 0);
    if (cursor) {
      g.fillStyle = INK.line;
      g.fillRect(m.width + 8, -QUESTION_PX * 0.78, QUESTION_PX * 0.5, QUESTION_PX * 0.9);
    }
  }
  g.restore();
  const labelY = -QUESTION_PX - 10;
  const box = padded(
    frameBox(t, {
      x0: Math.min(-m.actualBoundingBoxLeft, -label.actualBoundingBoxLeft),
      y0: Math.min(-m.actualBoundingBoxAscent, labelY - label.actualBoundingBoxAscent),
      x1: Math.max(m.actualBoundingBoxRight, label.actualBoundingBoxRight),
      y1: Math.max(m.actualBoundingBoxDescent, labelY + label.actualBoundingBoxDescent),
    })
  );
  const boxes: TextBox[] = [
    { id: row.id, text: row.words, box, fontSizePx: QUESTION_PX * scale, role: row.role },
  ];
  if (cursor) {
    boxes.push({
      id: `${row.id}-cursor`,
      text: row.words,
      box: padded(
        frameBox(t, {
          x0: m.width + 8,
          y0: -QUESTION_PX * 0.78,
          x1: m.width + 8 + QUESTION_PX * 0.5,
          y1: QUESTION_PX * 0.12,
        })
      ),
      fontSizePx: QUESTION_PX * scale,
      role: 'imagery',
    });
  }
  return boxes;
}

function copyRows(shotId: string): Row[] {
  return spec.text.filter((t) => t.shotId === shotId);
}

/**
 * This look draws on a 2D canvas. The look host loads it by path, so no module
 * imports these exports.
 * @toolContract
 */
export const context = '2d';

/**
 * Two sub-frames across the shutter: fast claws, type and flying messages smear
 * instead of stepping.
 * @toolContract
 */
export const motionBlur = 2;

/**
 * The post chain per frame: bloom by palette (none on paper, which would glow
 * whole), a small chromatic split on the blows, one flash on the drop, and a
 * deep vignette.
 * @toolContract
 */
export function post(frame: number): PostSettings {
  const shot = shotAt(frame);
  const look = LOOKS[shot.id];
  const hit = clamp(env(frame, HITS, 4));
  // The flash is added in linear light, so a small value already washes the frame: the drop alone earns one.
  const flash = 0.45 * env(frame, [bf(24)], 2);
  return {
    bloom: look.bloom * (1 + 0.4 * hit),
    // Kept small on hits: a wide channel split reads as a double exposure on type and stamps.
    aberration: 0.04 + 0.1 * hit,
    vignette: look.vignette ?? (look.bloom === 0 ? 0.3 : 0.6),
    flash: Math.min(0.5, flash),
  };
}

/**
 * All But One as an interview cut hard on the beat: the Devil answers the
 * interviewer by plucking something out of the air, praises the companies
 * that keep, watch and leak, lets the leaked secrets loose as a flock of demons, and
 * breaks when asked "All of them?", listing HushBox's values in fear.
 * @toolContract
 */
export const renderFrame: RenderFrame<'2d'> = (frame, ctx) => {
  const g = softwareContext();
  // Reset whole on every call, so nothing one call drew or set reaches the next.
  g.reset();
  const boxes = paint(g, frame, ctx);
  ctx.context.drawImage(g.canvas, 0, 0);
  return boxes;
};

/**
 * The canvas the frame is drawn on before it is copied whole onto the host's. It is a
 * `willReadFrequently` canvas, which the browser rasterises in software: the GPU rasteriser
 * drew the same strokes a pixel or two differently from one render to the next, so the look
 * was not pure. Reset at the start of every call, it carries nothing between calls.
 */
let software: CanvasRenderingContext2D | null = null;

function softwareContext(): CanvasRenderingContext2D {
  if (software === null) {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context === null) {
      throw new Error('2026-09-all-but-one: the browser gave no software 2D context');
    }
    software = context;
  }
  return software;
}

/** How far a mid-shot reframe on `beat` has gone: a cut jumps on its frame, an ease takes a beat, a spring settles. */
function reframeWeight(how: Reframe[4], beat: number, frame: number, time: number): number {
  if (how === 'cut') {
    return frame >= bf(beat) ? 1 : 0;
  }
  return how === 'ease'
    ? smooth(prog(time, bf(beat), bf(beat + 1)))
    : springOf(time, bf(beat), DEFAULT);
}

/** The HUD's accent in act three: the Devil's gold, darkened on daylight paper. */
function actThreeAccent(ctx: Ctx, pal: Palette): string {
  return pal.bg === lightPalette(ctx).bg ? '#7a520e' : INK.line;
}

/** A band of the palette's ground from `top` to `bottom` at `alpha`, fading in above it and out below. */
function scrim(
  g: G,
  { pal, top, bottom, alpha }: { pal: Palette; top: number; bottom: number; alpha: number }
): void {
  const fill = g.createLinearGradient(0, top, 0, bottom + 140);
  const edge = 90 / (bottom + 140 - top);
  const tail = 140 / (bottom + 140 - top);
  fill.addColorStop(0, rgba(pal.bg, 0));
  fill.addColorStop(edge, rgba(pal.bg, alpha));
  fill.addColorStop(1 - tail, rgba(pal.bg, alpha));
  fill.addColorStop(1, rgba(pal.bg, 0));
  g.fillStyle = fill;
  g.fillRect(0, top, W, bottom + 140 - top);
}

/** Whether any of a box lies on the frame: a box wholly off it has nothing of its text to show. */
function onFrame({ box }: LookBox): boolean {
  return box.x < W && box.y < H && box.x + box.width > 0 && box.y + box.height > 0;
}

/** What every scene is drawn from: the canvas, the look's context, the shot and the frame's clock. */
interface Scene {
  g: G;
  ctx: Ctx;
  from: number;
  frame: number;
  time: number;
}

/** Each shot's picture, drawn under the camera, returning the text and resting marks it reported. */
const SCENES: Record<ShotId, (scene: Scene) => LookBox[]> = {
  file: ({ g, time, from, frame }) => {
    file(g, time, from, frame);
    return [];
  },
  'of-course': ({ g, time, from }) => {
    ofCourse(g, time, from);
    return [];
  },
  'not-to-like': ({ g, time, from }) => {
    notToLike(g, time, from);
    return [];
  },
  save: ({ g, ctx, time, from }) => save(g, ctx, time, from),
  watch: ({ g, ctx, time, from }) => watch(g, ctx, time, from),
  leak: ({ g, ctx, time, from }) => leak(g, ctx, time, from),
  'world-to-see': ({ g, time }) => {
    worldToSee(g, time);
    return [];
  },
  flock: ({ g, ctx, time }) => flock(g, ctx, time),
  laugh: ({ g, ctx, time, from, frame }) => {
    laugh(g, ctx, { now: time, start: from, frame });
    return [];
  },
  'all-of-them': ({ g, ctx, time }) => {
    allOfThem(g, ctx, time);
    return [];
  },
  'all-but-one': ({ g, ctx, time }) => {
    allButOne(g, ctx, time);
    return [];
  },
  encrypted: ({ g, ctx, time, from, frame }) => encrypted(g, ctx, { time, start: from, frame }),
  flinch: ({ g, ctx, time, from }) => {
    flinch(g, ctx, time, from);
    return [];
  },
  unreadable: ({ g, ctx, time, from }) => unreadable(g, ctx, time, from),
  lens: ({ g, ctx, time, from }) => lens(g, ctx, time, from),
  'not-for-sale': ({ g, ctx, time, from }) => notForSale(g, ctx, time, from),
  'which-one': ({ g, ctx, time, from, frame }) => {
    notHushbox(g, ctx, { time, start: from, frame });
    return [];
  },
  mark: ({ g, ctx, time }) => markShot(g, ctx, time),
};

/** The clock the shot's picture is drawn at, and how much of its roll it keeps. */
function shotClock(id: ShotId, frame: number, ctx: Ctx): { time: number; level: number } {
  // On the freeze the camera stops with the laugh, so the freeze frame snaps once and then holds dead still.
  const frozen = id === 'laugh' && frame >= bf(LAUGH_FREEZE_BEAT) && frame < bf(LAUGH_EASE_BEAT);
  const time = frozen ? bf(LAUGH_FREEZE_BEAT) : ctx.time;
  // Out of the freeze, the laugh's roll eases away with the camera, so it meets the locked interview shot level.
  const level =
    id === 'laugh' ? 1 - smooth(prog(time, bf(LAUGH_EASE_BEAT), bf(LAUGH_EASE_BEAT + 1))) : 1;
  return { time, level };
}

/**
 * Puts the shot's camera on `g`: its zoom across the shot, its roll, the shake and punch on a hit and
 * its mid-shot reframes. Returns the hit's punch, which the copy shakes with.
 */
function placeCamera(
  g: G,
  {
    shot,
    frame,
    time,
    level,
  }: {
    shot: (typeof spec.shots)[number] & { id: ShotId };
    frame: number;
    time: number;
    level: number;
  }
): number {
  const id = shot.id;
  const look = LOOKS[id];
  const u = prog(time, shot.from, shot.to);
  const hitsHere = HITS.filter((h) => h >= shot.from && h < shot.to);
  const punch = env(Math.round(time), hitsHere, 5);
  // Stillness that snaps: the interview shots hold the camera dead still between hits.
  const still = id === 'file';
  const zoom =
    Math.exp(Math.log(look.zoom[0]) + (Math.log(look.zoom[1]) - Math.log(look.zoom[0])) * u) *
    (1 + 0.035 * punch);
  const sway = still ? 0 : look.roll * level * wander(time / 60, 11);
  const roll = look.level === true ? 0 : sway + 0.01 * punch * hs(Math.round(time), 7);
  const shake = 14 * punch;
  // Shake is keyed to the whole frame: both motion-blur samples take the same offset, so a hit never double-exposes.
  g.translate(
    CX + shake * hs(Math.round(time) * 3, 1),
    H / 2 + shake * hs(Math.round(time) * 3 + 1, 1)
  );
  g.rotate(roll);
  let rz = 1;
  let fx = CX;
  let fy = H / 2;
  for (const [beat, z, x, y, how] of look.reframe ?? []) {
    const w = reframeWeight(how, beat, frame, time);
    rz = lerp(rz, z, w);
    fx = lerp(fx, x, w);
    fy = lerp(fy, y, w);
  }
  g.scale(zoom * rz, zoom * rz);
  g.translate(-fx, -fy);
  return punch;
}

/** The scrim behind a shot's copy, and the scene's boxes left once an opaque scrim has covered some of them. */
function copyScrim(
  g: G,
  { look, pal, boxes }: { look: Look; pal: Palette; boxes: LookBox[] }
): LookBox[] {
  // A scrim of the shot's own ground behind the copy, so the picture never runs under the words.
  const alpha = look.scrim ?? 0.9;
  scrim(g, { pal, top: look.top - 90, bottom: look.top + 380, alpha });
  if (alpha !== 1) {
    return boxes;
  }
  // Where the scrim is opaque the picture's own text is gone: a box wholly under it shows nothing.
  return boxes.filter(({ box }) => !(box.y >= look.top && box.y + box.height <= look.top + 380));
}

/** The end card's words: the scrim the tagline lands on, the wordmark, then the tagline. */
function endCard(
  g: G,
  ctx: Ctx,
  {
    look,
    pal,
    lines,
    frame,
    time,
  }: { look: Look; pal: Palette; lines: readonly Row[]; frame: number; time: number }
): LookBox[] {
  const boxes: LookBox[] = [];
  const [a, b] = look.styles(ctx);
  const tagFrom = lines.find((row) => row.id.startsWith('tag-'))?.from;
  // It comes up over the frames before the tagline lands, so the tagline never lands on undimmed rays.
  if (tagFrom !== undefined && frame >= tagFrom - END_SCRIM_FRAMES) {
    scrim(g, {
      pal,
      top: look.top - 90,
      bottom: look.top + 280,
      alpha: END_SCRIM * clamp((frame - tagFrom + END_SCRIM_FRAMES) / END_SCRIM_FRAMES),
    });
  }
  for (const row of lines) {
    if (row.id === 'wordmark' && frame >= row.from) {
      boxes.push(wordmark(g, ctx, time, row));
    }
  }
  const tags = lines.filter((row) => row.id.startsWith('tag-'));
  boxes.push(
    ...drawRows(g, ctx, {
      frame,
      rows: tags,
      styleOf: (row) => (row.id === 'tag-3' ? b : a),
      options: {
        top: look.top,
        gap: END_GAP,
        drift: 0,
        exit: 0,
      },
    })
  );
  return boxes;
}

/** The shot's words over its picture: the scrims, the interviewer's question, then the copy or the end card. */
function words(
  g: G,
  ctx: Ctx,
  {
    id,
    scene,
    frame,
    time,
    punch,
  }: { id: ShotId; scene: LookBox[]; frame: number; time: number; punch: number }
): LookBox[] {
  const look = LOOKS[id];
  const pal = look.pal(ctx);
  const rows = copyRows(id);
  const questions = rows.filter((row) => row.id.startsWith('q'));
  const lines = rows.filter((row) => !row.id.startsWith('q'));
  const first = lines[0];
  const shown = !END.has(id) && first !== undefined && frame >= first.from;
  const boxes = shown ? copyScrim(g, { look, pal, boxes: scene }) : [...scene];
  const asked = questions.find((row) => frame >= row.from && frame < row.to);
  if (look.questionScrim === true && asked !== undefined) {
    scrim(g, { pal, top: look.top - 90, bottom: look.top + 110, alpha: 0.9 });
  }
  if (asked !== undefined) {
    boxes.push(...question(g, ctx, { frame, row: asked, top: look.top }));
  }
  if (END.has(id)) {
    return [...boxes, ...endCard(g, ctx, { look, pal, lines, frame, time })];
  }
  const [a, b] = look.styles(ctx);
  boxes.push(
    ...drawRows(g, ctx, {
      frame,
      rows: lines,
      styleOf: (row) => (lines.indexOf(row) === 0 ? a : b),
      options: {
        top: questions.length > 0 ? look.top + 150 : look.top,
        shake: 3 * punch,
        firstFrame: 0,
      },
    })
  );
  return boxes;
}

/** The frame itself, drawn on `g`, returning its text and resting marks. */
function paint(g: CanvasRenderingContext2D, frame: number, ctx: Ctx): LookBox[] {
  const shot = shotAt(frame);
  const id = shot.id;
  const { time, level } = shotClock(id, frame, ctx);
  const pal = LOOKS[id].pal(ctx);
  g.save();
  const punch = placeCamera(g, { shot, frame, time, level });
  const scene = SCENES[id]({ g, ctx, from: shot.from, frame, time });
  g.restore();
  const boxes = words(g, ctx, { id, scene, frame, time, punch });
  const fear = clamp((frame - bf(35)) / (bf(63) - bf(35)));
  const hudAlpha = END.has(id) ? 0 : 1;
  // The HUD is the Devil's interview file: from act three it keeps his gold, never HushBox's red.
  const accent = frame < bf(35) ? pal.key : actThreeAccent(ctx, pal);
  boxes.push(
    ...drawHud(g, ctx, {
      frame,
      pal: { ...pal, key: accent },
      options: { alpha: hudAlpha, kick: beatPulse(time, FPB, 6), fear },
    })
  );
  return boxes.filter((box) => onFrame(box));
}
