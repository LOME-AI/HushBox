import { drawHud } from './hud.js';
import { CX, DEFAULT, FPB, H, HELL, INK, PARCH, SURV, TAU, W, beatPulse, bf, clamp, env, hash, hs, lerp, prog, rgba, smooth, springOf, wander } from './kit.js';
import { LAUGH_EASE_BEAT, LAUGH_FREEZE_BEAT, laugh } from './scenes-escape.js';
import { allButOne, allOfThem } from './field-search.js';
import { flock } from './flock.js';
import { leak, worldToSee } from './leak.js';
import { file, notToLike, ofCourse } from './scenes-hook.js';
import { brandPalette, encrypted, flinch, lens, lightPalette, markShot, notForSale, notHushbox, unreadable } from './scenes-hush.js';
import { save, watch } from './scenes-praise.js';
import { Q1_LEAD, TYPE_FRAMES, definition } from './score.js';
import { drawRows, fontOf } from './type.js';

import type { G, Palette } from './kit.js';
import type { Row, RowStyle } from './type.js';
import type { LookBox, LookContext, RenderFrame, TextBox } from '../../../../engine/look/index.js';
import type { PostSettings } from '../../../../engine/visual/gl/index.js';

type Ctx = LookContext<'2d'>;

const { spec } = definition;

/** Every cue that lands a blow: they drive the shake, the zoom punch and the chromatic split. */
const HITS = spec.cues.filter((c) => c.kind === 'impact' || c.kind === 'hit').map((c) => c.from);

type ShotId =
  | 'file' | 'of-course' | 'not-to-like' | 'save' | 'watch' | 'leak' | 'world-to-see' | 'flock'
  | 'laugh' | 'all-of-them' | 'all-but-one' | 'encrypted' | 'flinch' | 'unreadable' | 'lens'
  | 'not-for-sale' | 'which-one' | 'mark';

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
  reframe?: readonly (readonly [number, number, number, number, 'spring' | 'cut' | 'ease'])[];
}

function style(face: RowStyle['face'], weight: number, size: number, color: string, tracking = 0.02, shadow: string | null = null): RowStyle {
  return { face, weight, size, color, tracking, shadow };
}

/** The Devil's answers: gold serif, his second line in ember. */
const devilVoice = (pal: Palette = INK): readonly [RowStyle, RowStyle] => [
  style('serif', 900, 112, pal.hot, 0.02),
  style('serif', 900, 112, pal.key, 0.02),
];
const valuePair = (ctx: Ctx, light = false): readonly [RowStyle, RowStyle] => {
  const pal = light ? lightPalette(ctx) : brandPalette(ctx);
  // The headline in the narrower sans, so each value's first line holds on one line at its size.
  return [style('sans', 900, 104, pal.key, 0.01), style('sans', 700, 88, pal.hot, 0.04)];
};
const endStyles = (ctx: Ctx): readonly [RowStyle, RowStyle] => {
  const pal = brandPalette(ctx);
  return [style('sans', 700, 96, pal.hot, 0.01), style('sans', 800, 96, pal.key, 0.01)];
};

/** The shots of the end card, which draw no scrim and no HUD. */
const END: readonly ShotId[] = ['mark'];

const LOOKS: Record<ShotId, Look> = {
  file: { pal: () => INK, zoom: [1, 1], roll: 0, top: 360, styles: () => devilVoice(), bloom: 1 },
  'of-course': { pal: () => INK, zoom: [1, 1.1], roll: 0.006, top: 330, styles: () => devilVoice(), bloom: 0.9 },
  'not-to-like': { pal: () => INK, zoom: [1, 1.12], roll: 0.006, top: 330, styles: () => devilVoice(), bloom: 0.9 },
  save: { pal: () => PARCH, zoom: [1, 1.08], roll: 0.006, top: 980, styles: () => [style('serif', 900, 104, PARCH.line), style('serif', 900, 104, PARCH.key)], bloom: 0, reframe: [[13.5, 1.4, 540, 1250, 'cut']] },
  watch: { pal: () => SURV, zoom: [1, 1.1], roll: 0.015, top: 940, styles: () => devilVoice(SURV), bloom: 0.8 },
  leak: { pal: () => SURV, zoom: [1, 1.05], roll: 0.006, top: 330, styles: () => devilVoice(SURV), bloom: 0.8 },
  'world-to-see': { pal: () => SURV, zoom: [1, 1.12], roll: 0.01, top: 330, styles: () => devilVoice(SURV), bloom: 0.9 },
  // The flock carries its own keyed camera.
  flock: { pal: () => HELL, zoom: [1, 1], roll: 0, top: 340, styles: () => devilVoice(HELL), bloom: 1 },
  laugh: {
    pal: () => INK,
    zoom: [1, 1],
    roll: 0.02,
    top: 300,
    styles: () => devilVoice(),
    bloom: 1,
    reframe: [[33, 1.5, 540, 1400, 'spring'], [LAUGH_FREEZE_BEAT, 2.1, 540, 1150, 'cut'], [LAUGH_EASE_BEAT, 1, CX, H / 2, 'ease']],
  },
  // The search flies its own camera through the field.
  'all-of-them': { pal: () => INK, zoom: [1, 1], roll: 0, level: true, top: 360, styles: () => devilVoice(), bloom: 0.9 },
  'all-but-one': { pal: () => INK, zoom: [1, 1], roll: 0, level: true, top: 330, styles: () => devilVoice(), bloom: 0.9 },
  encrypted: { pal: brandPalette, zoom: [1, 1.12], roll: 0.01, top: 900, styles: valuePair, bloom: 0.7, reframe: [[47, 1.6, 900, 700, 'cut']] },
  flinch: { pal: lightPalette, zoom: [1, 1.08], roll: 0.02, top: 330, styles: (ctx) => valuePair(ctx, true), bloom: 0, reframe: [[49, 1.5, 300, 960, 'cut']] },
  unreadable: { pal: brandPalette, zoom: [1.02, 1.1], roll: 0.008, top: 330, styles: valuePair, bloom: 0.7, reframe: [[52, 1.8, 760, 1320, 'cut']] },
  lens: { pal: lightPalette, zoom: [1, 1.1], roll: 0.015, top: 330, styles: (ctx) => valuePair(ctx, true), bloom: 0, reframe: [[55.5, 1.5, 560, 1300, 'cut']] },
  'not-for-sale': { pal: brandPalette, zoom: [1, 1.04], roll: 0.01, top: 980, styles: valuePair, bloom: 0.7, reframe: [[58.5, 1.6, 600, 1330, 'cut']] },
  'which-one': { pal: brandPalette, zoom: [1, 1.35], roll: 0.03, top: 360, styles: valuePair, bloom: 0.8, reframe: [[61, 1.4, 540, 1350, 'cut']] },
  mark: { pal: brandPalette, zoom: [1, 1], roll: 0, level: true, top: 1010, styles: endStyles, bloom: 0 },
};

function shotAt(frame: number): (typeof spec.shots)[number] & { id: ShotId } {
  const shot = spec.shots.find((s) => frame >= s.from && frame < s.to) ?? spec.shots.at(-1);
  if (shot === undefined || !Object.hasOwn(LOOKS, shot.id)) {
    throw new Error(`interview-cut: no look for the shot at frame ${String(frame)}`);
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
  if (!ctx.hideText) {
    g.fillStyle = pal.hot;
    g.fillText('Hush', x, y);
    g.fillStyle = pal.key;
    g.fillText('Box', x + a.width, y);
  }
  const ascent = Math.max(a.actualBoundingBoxAscent, b.actualBoundingBoxAscent);
  const descent = Math.max(a.actualBoundingBoxDescent, b.actualBoundingBoxDescent);
  g.restore();
  g.letterSpacing = '0px';
  return { id: row.id, text: row.words, box: { x, y: y - ascent, width, height: ascent + descent }, fontSizePx: size, role: row.role };
}

const QUESTION_PX = 58;

/**
 * The interviewer's question, typed a character every two frames at the left of
 * the safe box behind a Q., a block cursor blinking after it. The box reported
 * is the typed text's.
 */
function question(g: G, ctx: Ctx, frame: number, row: Row, top: number): TextBox[] {
  const lead = row.id === 'q1' ? Q1_LEAD : 0;
  // The question types in, then backspaces out two characters a frame, empty two frames before its cut.
  const erase = Math.ceil(row.words.length / 2) + 2;
  const erased = Math.max(0, (frame - (row.to - erase)) * 2);
  const typed = Math.max(0, Math.min(row.words.length, Math.floor((frame - row.from + lead) / TYPE_FRAMES) + 1) - erased);
  const text = row.words.slice(0, typed);
  const x = 110;
  const y = top + QUESTION_PX;
  g.save();
  g.font = fontOf(ctx, 'mono', 700, QUESTION_PX);
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  const full = g.measureText(row.words);
  const scale = Math.min(1, 800 / Math.max(1, full.width + 60));
  g.translate(x, y);
  g.scale(scale, scale);
  const m = g.measureText(text);
  if (!ctx.hideText) {
    g.fillStyle = rgba(INK.line, 0.9);
    g.font = fontOf(ctx, 'mono', 500, 30);
    g.fillText('Q.', 0, -QUESTION_PX - 10);
    g.font = fontOf(ctx, 'mono', 700, QUESTION_PX);
    g.fillStyle = '#f2ece0';
    g.fillText(text, 0, 0);
    if (Math.floor(frame / 15) % 2 === 0 || typed < row.words.length) {
      g.fillStyle = INK.line;
      g.fillRect(m.width + 8, -QUESTION_PX * 0.78, QUESTION_PX * 0.5, QUESTION_PX * 0.9);
    }
  }
  g.restore();
  return [
    {
      id: row.id,
      text: row.words,
      box: { x, y: y - m.actualBoundingBoxAscent * scale, width: Math.max(1, m.width * scale), height: (m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) * scale },
      fontSizePx: QUESTION_PX * scale,
      role: row.role,
    },
  ];
}

function copyRows(shotId: string): Row[] {
  return spec.text.filter((t) => t.shotId === shotId);
}

/**
 * The take draws on a 2D canvas. The look host loads it by path, so no module
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
    vignette: look.bloom === 0 ? 0.3 : 0.6,
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
 * drew the same strokes a pixel or two differently from one render to the next, so the take
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
      throw new Error('interview-cut: the browser gave no software 2D context');
    }
    software = context;
  }
  return software;
}

/** The frame itself, drawn on `g`, returning its text and resting marks. */
function paint(g: CanvasRenderingContext2D, frame: number, ctx: Ctx): LookBox[] {
  const shot = shotAt(frame);
  const id = shot.id;
  // On the freeze the camera stops with the laugh, so the freeze frame snaps once and then holds dead still.
  const frozen = id === 'laugh' && frame >= bf(LAUGH_FREEZE_BEAT) && frame < bf(LAUGH_EASE_BEAT);
  const time = frozen ? bf(LAUGH_FREEZE_BEAT) : ctx.time;
  // Out of the freeze, the laugh's roll eases away with the camera, so it meets the locked interview shot level.
  const level = id === 'laugh' ? 1 - smooth(prog(time, bf(LAUGH_EASE_BEAT), bf(LAUGH_EASE_BEAT + 1))) : 1;
  const look = LOOKS[id];
  const pal = look.pal(ctx);
  const u = prog(time, shot.from, shot.to);
  const hitsHere = HITS.filter((h) => h >= shot.from && h < shot.to);
  const punch = env(Math.round(time), hitsHere, 5);
  // Stillness that snaps: the interview shots hold the camera dead still between hits.
  const still = id === 'file';
  const zoom = Math.exp(Math.log(look.zoom[0]) + (Math.log(look.zoom[1]) - Math.log(look.zoom[0])) * u) * (1 + 0.035 * punch);
  const roll = look.level === true ? 0 : (still ? 0 : look.roll * level * wander(time / 60, 11)) + 0.01 * punch * hs(Math.round(time), 7);
  const shake = 14 * punch;
  // Shake is keyed to the whole frame: both motion-blur samples take the same offset, so a hit never double-exposes.
  g.save();
  g.translate(CX + shake * hs(Math.round(time) * 3, 1), H / 2 + shake * hs(Math.round(time) * 3 + 1, 1));
  g.rotate(roll);
  let rz = 1;
  let fx = CX;
  let fy = H / 2;
  for (const [beat, z, x, y, how] of look.reframe ?? []) {
    const w = how === 'cut' ? (frame >= bf(beat) ? 1 : 0) : how === 'ease' ? smooth(prog(time, bf(beat), bf(beat + 1))) : springOf(time, bf(beat), DEFAULT);
    rz = lerp(rz, z, w);
    fx = lerp(fx, x, w);
    fy = lerp(fy, y, w);
  }
  g.scale(zoom * rz, zoom * rz);
  g.translate(-fx, -fy);
  const boxes: LookBox[] = [];
  switch (id) {
    case 'file':
      file(g, time, shot.from, frame);
      break;
    case 'of-course':
      ofCourse(g, time, shot.from);
      break;
    case 'not-to-like':
      notToLike(g, time, shot.from);
      break;
    case 'save':
      boxes.push(...save(g, ctx, time, shot.from));
      break;
    case 'watch':
      boxes.push(...watch(g, ctx, time, shot.from));
      break;
    case 'leak':
      boxes.push(...leak(g, ctx, time, shot.from));
      break;
    case 'world-to-see':
      worldToSee(g, time);
      break;
    case 'flock':
      boxes.push(...flock(g, ctx, time));
      break;
    case 'laugh':
      laugh(g, ctx, time, shot.from, frame);
      break;
    case 'all-of-them':
      allOfThem(g, ctx, time);
      break;
    case 'all-but-one':
      allButOne(g, ctx, time);
      break;
    case 'encrypted':
      boxes.push(...encrypted(g, ctx, time, shot.from, frame));
      break;
    case 'flinch':
      flinch(g, ctx, time, shot.from);
      break;
    case 'unreadable':
      boxes.push(...unreadable(g, ctx, time, shot.from));
      break;
    case 'lens':
      boxes.push(...lens(g, ctx, time, shot.from));
      break;
    case 'not-for-sale':
      boxes.push(...notForSale(g, ctx, time, shot.from));
      break;
    case 'which-one':
      notHushbox(g, ctx, time, shot.from, frame);
      break;
    case 'mark':
      boxes.push(...markShot(g, ctx, time));
      break;
  }
  g.restore();

  const rows = copyRows(id);
  const questions = rows.filter((row) => row.id.startsWith('q'));
  const lines = rows.filter((row) => !row.id.startsWith('q'));
  const first = lines[0];
  if (!END.includes(id) && first !== undefined && frame >= first.from) {
    // A scrim of the shot's own ground behind the copy, so the picture never runs under the words.
    const top = look.top - 90;
    const bottom = look.top + 380;
    const scrim = g.createLinearGradient(0, top, 0, bottom + 140);
    const edge = 90 / (bottom + 140 - top);
    const tail = 140 / (bottom + 140 - top);
    scrim.addColorStop(0, rgba(pal.bg, 0));
    scrim.addColorStop(edge, rgba(pal.bg, 0.9));
    scrim.addColorStop(1 - tail, rgba(pal.bg, 0.9));
    scrim.addColorStop(1, rgba(pal.bg, 0));
    g.fillStyle = scrim;
    g.fillRect(0, top, W, bottom + 140 - top);
  }
  for (const row of questions) {
    if (frame >= row.from && frame < row.to) {
      boxes.push(...question(g, ctx, frame, row, look.top));
    }
  }
  if (END.includes(id)) {
    const [a, b] = look.styles(ctx);
    for (const row of lines) {
      if (row.id === 'wordmark' && frame >= row.from) {
        boxes.push(wordmark(g, ctx, time, row));
      }
    }
    const tags = lines.filter((row) => row.id.startsWith('tag-'));
    boxes.push(...drawRows(g, ctx, frame, tags, (row) => (row.id === 'tag-3' ? b : a), { top: look.top, drift: 0, exit: 0 }));
  } else {
    const [a, b] = look.styles(ctx);
    boxes.push(
      ...drawRows(g, ctx, frame, lines, (row) => (lines.indexOf(row) === 0 ? a : b), {
        top: questions.length > 0 ? look.top + 150 : look.top,
        shake: 3 * punch,
        firstFrame: 0,
      })
    );
  }
  const fear = clamp((frame - bf(35)) / (bf(63) - bf(35)));
  const hudAlpha = END.includes(id) ? 0 : 1;
  // The HUD is the Devil's interview file: from act three it keeps his gold, never HushBox's red.
  const accent = frame < bf(35) ? pal.key : pal.bg === lightPalette(ctx).bg ? '#7a520e' : INK.line;
  boxes.push(...drawHud(g, ctx, frame, { ...pal, key: accent }, { alpha: hudAlpha, kick: beatPulse(time, FPB, 6), fear }));
  void TAU;
  void hash;
  return boxes;
}
