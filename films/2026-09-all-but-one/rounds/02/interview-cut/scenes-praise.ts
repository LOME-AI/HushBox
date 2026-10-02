import {
  CX,
  FPB,
  H,
  PARCH,
  PLAYFUL,
  DEFAULT,
  SNAPPY,
  SURV,
  TAU,
  W,
  bf,
  beatPulse,
  clamp,
  env,
  hash,
  hs,
  lerp,
  rgba,
  springOf,
} from './kit.js';
import { STAMP_BEATS } from './score.js';
import { imagery } from './type.js';

import type { G, Palette } from './kit.js';
import type { LookContext, TextBox } from '../../../../engine/look/index.js';

type Ctx = LookContext<'2d'>;

/** A background field with a slow radial glow and a grain that re-rolls eight times a second. */
export function field(g: G, time: number, pal: Palette, glowY = 1300, glow = 0.35): void {
  g.fillStyle = pal.bg;
  g.fillRect(-200, -200, W + 400, H + 400);
  const grad = g.createRadialGradient(CX, glowY, 0, CX, glowY, 1100);
  grad.addColorStop(0, rgba(pal.line, glow * 0.35));
  grad.addColorStop(1, rgba(pal.line, 0));
  g.fillStyle = grad;
  g.fillRect(-200, -200, W + 400, H + 400);
  const roll = Math.floor((time / 60) * 8);
  g.fillStyle = rgba(pal.line, 0.06);
  for (let i = 0; i < 220; i++) {
    const x = hash(i * 2 + roll * 977, 3) * W;
    const y = hash(i * 2 + 1 + roll * 977, 3) * H;
    g.fillRect(x, y, 2, 2);
  }
}

/** Concentric construction lines, like an engraver's setting-out, turning slowly behind the subject. */
export function diagram(g: G, time: number, x: number, y: number, r: number, color: string, alpha: number): void {
  g.save();
  g.translate(x, y);
  g.rotate(time * 0.002);
  g.strokeStyle = rgba(color, alpha);
  g.lineWidth = 1.5;
  for (const k of [1, 0.82, 0.6, 0.36]) {
    g.beginPath();
    g.arc(0, 0, r * k, 0, TAU);
    g.stroke();
  }
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    g.beginPath();
    g.moveTo(Math.cos(a) * r * 0.36, Math.sin(a) * r * 0.36);
    g.lineTo(Math.cos(a) * r * 1.08, Math.sin(a) * r * 1.08);
    g.stroke();
  }
  g.beginPath();
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * TAU - Math.PI / 2;
    g.lineTo(Math.cos(a) * r * 0.82, Math.sin(a) * r * 0.82);
  }
  g.stroke();
  g.restore();
}



const COLS = 5;
const ROWS = 8;

/** The drawer order of the archive: a seeded shuffle, so it fills unevenly. */
function drawerRank(k: number): number {
  return hash(k, 41);
}

/**
 * An archive wall of drawers. Each drawer slides open, swallows a glowing page
 * and closes, two or three on every 16th from `fillFrom`; `noise` fills every
 * drawer with re-rolling cipher instead.
 */
export function archive(
  g: G,
  ctx: Ctx,
  time: number,
  pal: Palette,
  opts: { fillFrom: number; top: number; noise: boolean; lock: string | null; rows?: number }
): TextBox[] {
  const boxes: TextBox[] = [];
  const cw = 176;
  const ch = 124;
  const x0 = CX - (COLS * cw) / 2;
  const order = Array.from({ length: COLS * ROWS }, (_, k) => k).sort((a, b) => drawerRank(a) - drawerRank(b));
  const rankOf = new Map(order.map((k, r) => [k, r]));
  g.lineWidth = 2.5;
  for (let r = 0; r < (opts.rows ?? ROWS); r++) {
    for (let c = 0; c < COLS; c++) {
      const k = r * COLS + c;
      const x = x0 + c * cw;
      const y = opts.top + r * ch;
      const rank = rankOf.get(k) ?? 0;
      const fillAt = opts.fillFrom + 6 * Math.floor(rank / 2.5);
      const u = (time - fillAt) / 18;
      const open = opts.noise ? 0.55 : u > 0 && u < 1 ? Math.sin(Math.PI * u) : 0;
      const filled = opts.noise || Math.round(time) >= fillAt + 9;
      g.strokeStyle = pal.line;
      g.strokeRect(x + 6, y + 6, cw - 12, ch - 12);
      const dx = open * 16;
      const dy = open * 22;
      g.fillStyle = pal.bg;
      g.fillRect(x + 12 - dx, y + 12 + dy, cw - 24 + 2 * dx, ch - 24);
      g.strokeRect(x + 12 - dx, y + 12 + dy, cw - 24 + 2 * dx, ch - 24);
      g.beginPath();
      g.moveTo(x + cw / 2 - 22, y + 44 + dy);
      g.lineTo(x + cw / 2 + 22, y + 44 + dy);
      g.stroke();
      if (opts.noise) {
        g.fillStyle = rgba(pal.line, 0.8);
        g.font = `500 17px ${ctx.fonts['mono'] ?? 'monospace'}`;
        // Each drawer re-rolls on its own phase, so the wall never changes all at once (WCAG 2.3.1).
        const roll = Math.floor((time / 60) * 6 + hash(k, 77));
        for (let li = 0; li < 3; li++) {
          let s = '';
          for (let ci = 0; ci < 12; ci++) {
            s += NOISE[Math.floor(hash(k * 97 + li * 13 + ci + roll * 7, 3) * NOISE.length)] ?? '#';
          }
          if (!ctx.hideText) {
            g.fillText(s, x + 20, y + 72 + li * 17 + dy);
          }
        }
        if (opts.lock !== null) {
          padlock(g, x + cw - 30, y + 30 + dy, 10, opts.lock);
        }
      } else if (filled) {
        g.fillStyle = pal.key;
        g.fillRect(x + cw / 2 - 30, y + 62 + dy, 60, 6);
        g.fillRect(x + cw / 2 - 30, y + 74 + dy, 40, 6);
      }
      if (!opts.noise && u > -0.6 && u < 0.5) {
        // The page, falling into its drawer.
        const fu = clamp((u + 0.6) / 1.1);
        const py = lerp(y - 220, y + 40 + dy, fu * fu);
        g.save();
        g.translate(x + cw / 2, py);
        g.rotate(hs(k, 5) * 0.4 * (1 - fu));
        // A message: a small chat bubble with two lines of words.
        g.fillStyle = '#f4efe6';
        g.strokeStyle = pal.hot;
        g.lineWidth = 2;
        g.beginPath();
        g.roundRect(-44, -24, 88, 48, 16);
        g.fill();
        g.stroke();
        g.beginPath();
        g.moveTo(-30, 22);
        g.lineTo(-40, 36);
        g.lineTo(-18, 22);
        g.fill();
        g.fillStyle = '#3a3129';
        g.fillRect(-32, -10, 64 - 16 * hash(k, 9), 5);
        g.fillRect(-32, 3, 40 + 16 * hash(k, 10), 5);
        g.restore();
      }
    }
  }
  return boxes;
}

const NOISE = '▓▒░#%&@$*+=?<>/\\{}[]01ABCDEF';

/** A small padlock: HushBox's, when drawn in Signal Red. */
export function padlock(g: G, x: number, y: number, s: number, color: string): void {
  g.save();
  g.strokeStyle = color;
  g.fillStyle = color;
  g.lineWidth = s * 0.35;
  g.beginPath();
  g.arc(x, y - s * 0.3, s * 0.65, Math.PI, 0);
  g.stroke();
  g.fillRect(x - s, y - s * 0.3, s * 2, s * 1.5);
  g.restore();
}



/** The sweep angle of the radar eye at `time`: one turn every two beats. */
function sweepAt(time: number): number {
  return (time / (FPB * 2)) * TAU - Math.PI / 2;
}

/** A chat bubble with scribbled words, orbiting the eye. */
function bubble(g: G, x: number, y: number, s: number, pal: Palette, seed: number): void {
  g.save();
  g.translate(x, y);
  g.fillStyle = '#e8f6fb';
  g.strokeStyle = pal.line;
  g.lineWidth = 2.5;
  g.beginPath();
  g.roundRect(-s, -s * 0.5, s * 2, s, s * 0.35);
  g.fill();
  g.stroke();
  g.beginPath();
  g.moveTo(-s * 0.6, s * 0.48);
  g.lineTo(-s * 0.85, s * 0.8);
  g.lineTo(-s * 0.3, s * 0.48);
  g.fill();
  g.fillStyle = '#20313a';
  for (let i = 0; i < 2; i++) {
    g.fillRect(-s * 0.72, -s * 0.2 + i * s * 0.3, s * (0.9 + 0.5 * hash(seed * 7 + i, 2)), s * 0.1);
  }
  g.restore();
}

/** The radar eye: lid, iris fibres, pupil, a sweep, and thoughts orbiting that it stamps FLAGGED. */
export function eye(g: G, ctx: Ctx, time: number, cy: number, zoom: number, stamps: boolean, openAt = -1e9): TextBox[] {
  const pal = SURV;
  field(g, time, pal, cy, 0.25);
  const boxes: TextBox[] = [];
  g.save();
  g.translate(CX, cy);
  g.scale(zoom, zoom);
  // Scan lines.
  g.fillStyle = rgba(pal.line, 0.05);
  for (let y = -1100; y < 1100; y += 6) {
    g.fillRect(-900, y, 1800, 2);
  }
  g.strokeStyle = pal.line;
  g.lineWidth = 3;
  const lidW = 470;
  // The eye opens on its shot's first beat, overshooting wide before it settles.
  const lidH = 250 * clamp(springOf(time, openAt, DEFAULT), 0.04, 1.3);
  g.beginPath();
  g.moveTo(-lidW, 0);
  g.quadraticCurveTo(0, -lidH * 1.6, lidW, 0);
  g.quadraticCurveTo(0, lidH * 1.6, -lidW, 0);
  g.stroke();
  const iris = 230;
  for (const k of [1, 0.9, 0.55, 0.4]) {
    g.beginPath();
    g.arc(0, 0, iris * k, 0, TAU);
    g.stroke();
  }
  g.lineWidth = 1.5;
  for (let i = 0; i < 90; i++) {
    const a = (i / 90) * TAU + time * 0.003;
    const r0 = iris * (0.42 + 0.05 * hash(i, 8));
    const r1 = iris * (0.86 + 0.1 * hash(i + 90, 8));
    g.strokeStyle = rgba(pal.line, 0.35 + 0.4 * hash(i + 200, 8));
    g.beginPath();
    g.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
    g.lineTo(Math.cos(a + 0.04) * r1, Math.sin(a + 0.04) * r1);
    g.stroke();
  }
  const pupil = iris * (0.3 + 0.08 * beatPulse(time));
  g.fillStyle = '#000000';
  g.beginPath();
  g.arc(0, 0, pupil, 0, TAU);
  g.fill();
  // The sweep.
  const s = sweepAt(time);
  const wedge = g.createConicGradient(s - 0.9, 0, 0);
  wedge.addColorStop(0, rgba(pal.line, 0));
  wedge.addColorStop(0.143, rgba(pal.line, 0.45));
  wedge.addColorStop(0.1432, rgba(pal.line, 0));
  wedge.addColorStop(1, rgba(pal.line, 0));
  g.fillStyle = wedge;
  g.beginPath();
  g.arc(0, 0, 620, 0, TAU);
  g.fill();
  g.strokeStyle = pal.hot;
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(Math.cos(s) * 620, Math.sin(s) * 620);
  g.stroke();
  if (stamps) {
    const orbit = 0.004;
    STAMP_BEATS.forEach((beat, j) => {
      const at = bf(beat);
      const a = sweepAt(at) - orbit * at + orbit * time;
      const r = 470 + 40 * (j % 2);
      // The thoughts arrive after the words, flying in from the edge on beat 15.5.
      const arrive = clamp(springOf(time, bf(15.5) + j * 2, PLAYFUL), 0, 1.2);
      if (arrive <= 0) {
        return;
      }
      const bx = Math.cos(a) * r * (2.2 - 1.2 * arrive);
      const by = Math.sin(a) * r * 0.6 * (2.2 - 1.2 * arrive);
      bubble(g, bx, by, 62, pal, j + 3);
      if (Math.round(time) >= at) {
        const k = springOf(time, at, SNAPPY);
        g.save();
        g.translate(bx, by);
        g.rotate(hs(j, 4) * 0.25);
        g.scale(2.2 - 1.2 * k, 2.2 - 1.2 * k);
        g.strokeStyle = pal.key;
        g.lineWidth = 3;
        g.strokeRect(-78, -26, 156, 44);
        boxes.push(
          imagery(g, ctx, { id: `flag-${String(j)}`, text: 'FLAGGED', x: 0, y: 8, size: 30, face: 'mono', weight: 800, fill: pal.key, align: 'center', tracking: 0.08 })
        );
        g.restore();
      }
    });
  }
  g.restore();
  return boxes;
}

/** Beats 15-18: the eye opens and stamps the messages orbiting it, pushed on each stamp. */
export function watch(g: G, ctx: Ctx, time: number, start: number): TextBox[] {
  const hits = STAMP_BEATS.map(bf);
  const zoom = 1 + 0.03 * env(Math.round(time), hits, 4) + (time - start) * 0.0008;
  // The eye sits high this time, the words under it.
  return eye(g, ctx, time, 700, zoom, true, start);
}

/** Beats 12-15: the archive in parchment; messages drop into the drawers on the 16ths as the camera tilts down. */
export function save(g: G, ctx: Ctx, time: number, start: number): TextBox[] {
  field(g, time, PARCH, 900, 0.1);
  const lt = time - start;
  // The wall fills the top of the frame and the words sit under it, low in the safe box.
  return archive(g, ctx, time, PARCH, { fillFrom: start + 6, top: 60 - lt * 1.2, noise: false, lock: null });
}
