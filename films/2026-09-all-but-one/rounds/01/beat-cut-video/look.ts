import { drawHud } from './hud.js';
import { CX, DEFAULT, FPB, H, SNAPPY, lerp, springOf, HELL, INK, NIGHT, PARCH, SURV, TAU, W, beatPulse, bf, clamp, env, hash, hs, prog, rgba, wander } from './kit.js';
import { brandPalette, encrypted, flinch, lens, lightPalette, markShot, notForSale, notHushbox, one, sweatShot, unreadable } from './scenes-hush.js';
import { exposed, escape, laugh, world } from './scenes-escape.js';
import { build, cackle, grin, ignite, keep, leak, watch } from './scenes-praise.js';
import { definition } from './score.js';
import { drawRows, fontOf } from './type.js';

import type { G, Palette } from './kit.js';
import type { Row, RowStyle } from './type.js';
import type { LookContext, RenderFrame, TextBox } from '../../../../engine/look/index.js';
import type { PostSettings } from '../../../../engine/visual/gl/index.js';

type Ctx = LookContext<'2d'>;

const { spec } = definition;

/** Every cue that lands a blow: they drive the shake, the zoom punch and the chromatic split. */
const HITS = spec.cues.filter((c) => c.kind === 'impact' || c.kind === 'hit').map((c) => c.from);

type ShotId =
  | 'ignite' | 'grin' | 'keep' | 'cackle' | 'watch' | 'leak' | 'build' | 'escape' | 'world'
  | 'exposed' | 'laugh' | 'one' | 'encrypted' | 'flinch' | 'unreadable' | 'lens' | 'not-for-sale' | 'sweat' | 'not-hushbox' | 'mark' | 'tagline';

interface Look {
  pal: (ctx: Ctx) => Palette;
  /** Log-space zoom at the shot's start and end. */
  zoom: readonly [number, number];
  roll: number;
  /** Where the copy stack starts. */
  top: number;
  styles: (ctx: Ctx) => readonly [RowStyle, RowStyle];
  bloom: number;
  /**
   * Mid-shot reframes on the beat: at `beat` the camera goes to `zoom` about (x, y), on a spring,
   * or as a punch-in cut where dense line art would flicker under a fast move (WCAG 2.3.1).
   */
  reframe?: readonly (readonly [number, number, number, number, 'spring' | 'cut'])[];
}

function style(face: RowStyle['face'], weight: number, size: number, color: string, tracking = 0.02, shadow: string | null = null): RowStyle {
  return { face, weight, size, color, tracking, shadow };
}

const pair = (pal: Palette, a = 92, b = 128): readonly [RowStyle, RowStyle] => [
  style('sans', 800, a, pal.hot, 0.06),
  style('serif', 900, b, pal.key, 0.02),
];
const inkPair = (pal: Palette, a = 92, b = 128): readonly [RowStyle, RowStyle] => [
  style('sans', 800, a, pal.line, 0.06),
  style('serif', 900, b, pal.key, 0.02),
];
const valuePair = (ctx: Ctx, light = false): readonly [RowStyle, RowStyle] => {
  const pal = light ? lightPalette(ctx) : brandPalette(ctx);
  return [style('serif', 900, 124, pal.key, 0.02), style('sans', 700, 88, pal.hot, 0.04)];
};

/** The tagline's lines, as the welcome page sets them: two in the foreground colour, Private. in Signal Red. */
const endStyles = (ctx: Ctx): readonly [RowStyle, RowStyle] => {
  const pal = brandPalette(ctx);
  return [style('sans', 700, 96, pal.hot, 0.01), style('sans', 800, 96, pal.key, 0.01)];
};

/** The shots of the end card, which draw no scrim and fade the HUD. */
const END: readonly ShotId[] = ['mark', 'tagline'];

const LOOKS: Record<ShotId, Look> = {
  ignite: { pal: () => INK, zoom: [1, 1.18], roll: 0.01, top: 360, styles: () => [style('serif', 900, 132, INK.hot, 0.04), style('sans', 800, 100, INK.key, 0.08)], bloom: 1 },
  grin: { pal: () => INK, zoom: [1.1, 1.3], roll: 0.02, top: 400, styles: () => [style('serif', 900, 118, INK.hot, 0.03), style('serif', 900, 118, INK.hot)], bloom: 0.9 },
  keep: { pal: () => PARCH, zoom: [1, 1.08], roll: 0.006, top: 330, styles: () => inkPair(PARCH, 92, 134), bloom: 0, reframe: [[8, 1.45, 540, 1250, 'cut']] },
  cackle: { pal: () => INK, zoom: [1, 1.25], roll: 0.03, top: 360, styles: () => pair(INK), bloom: 0.9 },
  watch: { pal: () => SURV, zoom: [1, 1.1], roll: 0.015, top: 330, styles: () => pair(SURV, 92, 112), bloom: 0.8 },
  leak: { pal: () => PARCH, zoom: [1, 1], roll: 0.008, top: 330, styles: () => inkPair(PARCH, 92, 160), bloom: 0 },
  build: { pal: () => INK, zoom: [1, 1.2], roll: 0.03, top: 360, styles: () => pair(INK), bloom: 0.9 },
  escape: { pal: () => HELL, zoom: [1.12, 0.96], roll: 0.02, top: 340, styles: () => pair(HELL, 100, 176), bloom: 1.1 },
  world: { pal: () => NIGHT, zoom: [1, 1.12], roll: 0.02, top: 330, styles: () => [style('sans', 800, 92, NIGHT.hot, 0.06), style('serif', 900, 116, HELL.key)], bloom: 1 },
  exposed: { pal: () => HELL, zoom: [1, 1.15], roll: 0.02, top: 320, styles: () => pair(HELL, 130, 130), bloom: 1 },
  laugh: { pal: () => INK, zoom: [1, 1.14], roll: 0.02, top: 300, styles: () => pair(INK, 96, 124), bloom: 1, reframe: [[38, 1.5, 540, 1400, 'spring'], [39.5, 2.1, 540, 1265, 'cut']] },
  one: { pal: () => INK, zoom: [1, 1], roll: 0, top: 320, styles: (ctx) => [style('sans', 800, 110, INK.hot, 0.1), style('serif', 900, 210, brandPalette(ctx).key)], bloom: 0.9 },
  encrypted: { pal: brandPalette, zoom: [1, 1.12], roll: 0.01, top: 330, styles: valuePair, bloom: 0.7, reframe: [[46, 1.7, 700, 1010, 'cut']] },
  flinch: { pal: brandPalette, zoom: [1, 1.08], roll: 0.02, top: 330, styles: valuePair, bloom: 0.8, reframe: [[49.5, 1.5, 300, 960, 'cut']] },
  unreadable: { pal: lightPalette, zoom: [1.02, 1.1], roll: 0.008, top: 330, styles: (ctx) => valuePair(ctx, true), bloom: 0, reframe: [[53.5, 1.8, 760, 1320, 'cut']] },
  lens: { pal: lightPalette, zoom: [1, 1.1], roll: 0.015, top: 330, styles: (ctx) => valuePair(ctx, true), bloom: 0 },
  'not-for-sale': { pal: brandPalette, zoom: [1, 1.04], roll: 0.01, top: 330, styles: valuePair, bloom: 0.7, reframe: [[61.5, 1.6, 600, 1330, 'cut']] },
  sweat: { pal: brandPalette, zoom: [1, 1], roll: 0.015, top: 330, styles: valuePair, bloom: 0.7, reframe: [[65, 1.6, 380, 1420, 'spring']] },
  'not-hushbox': { pal: brandPalette, zoom: [1, 1.35], roll: 0.03, top: 360, styles: (ctx) => [style('serif', 900, 130, brandPalette(ctx).key, 0.03), style('serif', 900, 130, brandPalette(ctx).key)], bloom: 0.8 },
  mark: { pal: brandPalette, zoom: [1, 1], roll: 0, top: 960, styles: endStyles, bloom: 0.5 },
  tagline: { pal: brandPalette, zoom: [1, 1], roll: 0, top: 600, styles: endStyles, bloom: 0.5 },
};

function shotAt(frame: number): (typeof spec.shots)[number] & { id: ShotId } {
  const shot = spec.shots.find((s) => frame >= s.from && frame < s.to) ?? spec.shots.at(-1);
  if (shot === undefined || !Object.hasOwn(LOOKS, shot.id)) {
    throw new Error(`beat-cut-video: no look for the shot at frame ${String(frame)}`);
  }
  return shot as (typeof spec.shots)[number] & { id: ShotId };
}

/** Radial speed lines bursting from the centre over the first frames of a cut, the reference's seam. */
function speedLines(g: G, time: number, at: number, color: string, cy: number): void {
  const u = (time - at) / 10;
  if (u < 0 || u > 1) {
    return;
  }
  g.save();
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 90; i++) {
    const a = hash(i, 301) * TAU;
    const r0 = 120 + 700 * u + 300 * hash(i, 302);
    const len = 300 + 900 * hash(i, 303);
    g.strokeStyle = rgba(color, 0.55 * (1 - u));
    g.lineWidth = 1 + 3 * hash(i, 304);
    g.beginPath();
    g.moveTo(CX + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    g.lineTo(CX + Math.cos(a) * (r0 + len), cy + Math.sin(a) * (r0 + len));
    g.stroke();
  }
  g.restore();
}

/**
 * The wordmark as the brand sets it: "Hush" in the foreground colour and "Box" in Signal Red,
 * centred under the mark, or docked right of it as the lockup when `dock` reaches 1.
 */
function wordmark(g: G, ctx: Ctx, time: number, row: Row, dock: number): TextBox {
  const pal = brandPalette(ctx);
  const size = Math.round(lerp(150, 112, dock));
  const k = clamp((time - row.from) / 8);
  g.save();
  g.font = fontOf(ctx, 'serif', 900, size);
  g.letterSpacing = `${String((row.id === 'wordmark' ? 0.3 * (1 - k) : 0) * size + 0.01 * size)}px`;
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  const a = g.measureText('Hush');
  const b = g.measureText('Box');
  const width = a.width + b.width;
  const x = lerp(CX - width / 2, 350, dock);
  const y = lerp(1190, 480, dock);
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
 * Two sub-frames across the shutter: fast type and flying demons smear
 * instead of stepping.
 * @toolContract
 */
export const motionBlur = 2;

/**
 * The post chain per frame: bloom by palette (none on parchment, which would
 * glow whole), a chromatic split and flash on the blows, and a vignette.
 * @toolContract
 */
export function post(frame: number): PostSettings {
  const shot = shotAt(frame);
  const look = LOOKS[shot.id];
  const hit = clamp(env(frame, HITS, 4));
  // The flash is added in linear light, so a small value already washes the frame: the drop alone earns one.
  const flash = 0.5 * env(frame, [bf(24)], 2);
  return {
    bloom: look.bloom * (1 + 0.4 * hit),
    aberration: 0.04 + 0.35 * hit,
    vignette: look.bloom === 0 ? 0.3 : 0.5,
    flash: Math.min(0.6, flash),
  };
}

/**
 * All But One as a beat-cut music video: a hard cut or a hit on nearly every
 * beat, type slammed into frame word row by word row, palettes flipping
 * between ink and gold, parchment, radar cyan, hellfire and night, until
 * HushBox's charcoal and Signal Red take the frame.
 * @toolContract
 */
export const renderFrame: RenderFrame<'2d'> = (frame, ctx) => {
  const g = ctx.context;
  const { time } = ctx;
  const shot = shotAt(frame);
  const id = shot.id;
  const look = LOOKS[id];
  const pal = look.pal(ctx);
  const u = prog(time, shot.from, shot.to);
  const hitsHere = HITS.filter((h) => h >= shot.from && h < shot.to);
  const punch = env(time, hitsHere, 5);
  const zoom = Math.exp(Math.log(look.zoom[0]) + (Math.log(look.zoom[1]) - Math.log(look.zoom[0])) * u) * (1 + 0.035 * punch);
  const roll = look.roll * wander(time / 60, 11) + 0.01 * punch * hs(Math.floor(time), 7);
  const shake = 14 * punch;
  g.save();
  g.translate(CX + shake * hs(Math.floor(time) * 3, 1), H / 2 + shake * hs(Math.floor(time) * 3 + 1, 1));
  g.rotate(roll);
  let rz = 1;
  let fx = CX;
  let fy = H / 2;
  for (const [beat, z, x, y, how] of look.reframe ?? []) {
    const w = how === 'cut' ? (frame >= bf(beat) ? 1 : 0) : springOf(time, bf(beat), DEFAULT);
    rz = lerp(rz, z, w);
    fx = lerp(fx, x, w);
    fy = lerp(fy, y, w);
  }
  g.scale(zoom * rz, zoom * rz);
  g.translate(-fx, -fy);
  const boxes: TextBox[] = [];
  switch (id) {
    case 'ignite':
      ignite(g, time, shot.from);
      break;
    case 'grin':
      grin(g, time, shot.from, clamp(prog(time, shot.from, shot.from + 36)));
      speedLines(g, time, shot.from, INK.hot, 1300);
      break;
    case 'keep':
      boxes.push(...keep(g, ctx, time, shot.from));
      break;
    case 'cackle':
      boxes.push(...cackle(g, ctx, time, shot.from));
      break;
    case 'watch':
      boxes.push(...watch(g, ctx, time, shot.from));
      break;
    case 'leak':
      leak(g, time, shot.from);
      break;
    case 'build':
      boxes.push(...build(g, ctx, frame, time));
      break;
    case 'escape':
      escape(g, time);
      break;
    case 'world':
      boxes.push(...world(g, ctx, time, shot.from));
      break;
    case 'exposed':
      boxes.push(...exposed(g, ctx, time, shot.from));
      break;
    case 'laugh':
      laugh(g, time, shot.from, frame);
      speedLines(g, time, shot.from, HELL.key, 1250);
      break;
    case 'one':
      one(g, ctx, time);
      break;
    case 'encrypted':
      boxes.push(...encrypted(g, ctx, time, shot.from, frame));
      break;
    case 'unreadable':
      boxes.push(...unreadable(g, ctx, time, shot.from));
      break;
    case 'not-for-sale':
      boxes.push(...notForSale(g, ctx, time, shot.from));
      break;
    case 'flinch':
      flinch(g, ctx, time, shot.from);
      break;
    case 'lens':
      boxes.push(...lens(g, ctx, time, shot.from));
      break;
    case 'sweat':
      sweatShot(g, ctx, time, shot.from);
      break;
    case 'not-hushbox':
      notHushbox(g, ctx, time, shot.from);
      break;
    case 'mark':
    case 'tagline':
      markShot(g, ctx, time, id);
      break;
  }
  g.restore();

  const rows = copyRows(id);
  const first = rows[0];
  if (!END.includes(id) && first !== undefined && frame >= first.from) {
    // A scrim of the shot's own ground behind the copy, so a reframe never pushes art under the words.
    const top = look.top - 90;
    const bottom = look.top + (id === 'exposed' ? 470 : 380);
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
  if (END.includes(id)) {
    const dock = id === 'tagline' ? 1 : 0;
    const [a, b] = look.styles(ctx);
    for (const row of rows) {
      if (row.id === 'wordmark' || row.id === 'lockup') {
        if (frame >= row.from) {
          boxes.push(wordmark(g, ctx, time, row, dock));
        }
      }
    }
    const lines = rows.filter((row) => row.id.startsWith('tag-'));
    boxes.push(...drawRows(g, ctx, frame, lines, (row) => (row.id === 'tag-3' ? b : a), { top: look.top, drift: 0.01, exit: 0 }));
  } else {
    const [a, b] = look.styles(ctx);
    boxes.push(
      ...drawRows(g, ctx, frame, rows, (row) => (rows.indexOf(row) === 0 || id === 'exposed' ? (id === 'exposed' && rows.indexOf(row) === 1 ? b : a) : b), {
        top: look.top,
        shake: 3 * punch,
        firstFrame: 0,
      })
    );
  }
  const fear = clamp((frame - bf(40)) / (bf(69) - bf(40)));
  const hudAlpha = END.includes(id) ? 0 : id === 'build' && frame >= bf(23.5) ? 0.2 : 1;
  // The HUD is the Devil's interview file: from act three it keeps his gold, never HushBox's red.
  const accent = frame < bf(40) ? pal.key : pal.bg === lightPalette(ctx).bg ? '#7a520e' : INK.line;
  boxes.push(...drawHud(g, ctx, frame, { ...pal, key: accent }, { alpha: hudAlpha, kick: beatPulse(time, FPB, 6), fear }));
  void W;
  return boxes;
};
