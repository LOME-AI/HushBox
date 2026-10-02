import { drawDevil } from './devil.js';
import { drawEmber, drawFlame } from './fire.js';
import {
  CX,
  FPB,
  H,
  INK,
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
  outCubic,
  outExpo,
  polyline,
  prog,
  rgba,
  smooth,
  springOf,
  wander,
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

/** Beat 0-3: a flame low in the dark that tears into two horn-shaped plumes. */
export function ignite(g: G, time: number, start: number): void {
  const lt = time - start;
  field(g, time, INK, 1400, 0.5);
  diagram(g, time, CX, 1380, 470 + lt * 0.8, INK.line, 0.3);
  const split = smooth(prog(time, bf(1.5), bf(3)));
  drawFlame(g, time, { x: CX, y: 1640, height: 520 + 160 * split + 40 * beatPulse(time), width: 170, split, heat: 1, particles: 200 });
}

/** The Devil's pose for the grin shots: drawn on from its horns, grinning, the jaw bouncing on the beat. */
export function grin(g: G, time: number, start: number, draw: number): void {
  field(g, time, INK, 1300, 0.4);
  diagram(g, time, CX, 1300, 520, INK.line, 0.12);
  const jaw = 0.35 * beatPulse(time, FPB, 4);
  drawDevil(g, time, {
    x: CX,
    y: 1300,
    scale: 250,
    draw,
    mood: 1,
    jaw,
    tremble: 0,
    horns: 1,
    line: INK.line,
    eye: INK.key,
    fill: INK.bg,
    lineWidth: 4,
  });
  const flicker = clamp(draw * 2);
  for (const side of [-1, 1]) {
    drawFlame(g, time + side * 40, {
      x: CX + side * 175,
      y: 1300 - 1.9 * 250 + 20,
      height: 120 * flicker,
      width: 36,
      split: 0,
      heat: flicker,
      particles: 60,
      seed: side > 0 ? 5 : 9,
    });
  }
  void start;
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
      const filled = opts.noise || time >= fillAt + 9;
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
        g.fillStyle = pal.bg;
        g.strokeStyle = pal.hot;
        g.fillRect(-26, -34, 52, 68);
        g.strokeRect(-26, -34, 52, 68);
        g.fillStyle = pal.key;
        for (let li = 0; li < 4; li++) {
          g.fillRect(-18, -22 + li * 12, 36 - (li % 2) * 12, 4);
        }
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

/** Beat 6-10: parchment, the archive filling on the 16ths while the camera tilts down it. */
export function keep(g: G, ctx: Ctx, time: number, start: number): TextBox[] {
  field(g, time, PARCH, 900, 0.1);
  const lt = time - start;
  const boxes = [
    imagery(g, ctx, { id: 'keep-stamp', text: 'ARCHIVE · DO NOT DELETE', x: CX, y: 770 - lt * 0.9, size: 26, face: 'mono', weight: 600, fill: rgba(PARCH.line, 0.7), align: 'center', tracking: 0.2 }),
  ];
  return [...boxes, ...archive(g, ctx, time, PARCH, { fillFrom: start + 6, top: 820 - lt * 1.4, noise: false, lock: null })];
}

/** Beat 10-12: the grin so close its teeth fill the frame, HA HA scrolling behind in outline. */
export function cackle(g: G, ctx: Ctx, time: number, start: number): TextBox[] {
  field(g, time, INK, 960, 0.3);
  const lt = time - start;
  const boxes: TextBox[] = [];
  for (let row = 0; row < 7; row++) {
    const dir = row % 2 === 0 ? 1 : -1;
    const x = ((lt * 9 * dir + row * 190) % 700) - 700;
    boxes.push(
      imagery(g, ctx, { id: `ha-${String(row)}`, text: 'HA HA HA HA HA', x, y: 300 + row * 250, size: 230, face: 'serif', weight: 900, stroke: rgba(INK.line, 0.22), lineWidth: 2 })
    );
  }
  const jaw = 0.9 * Math.abs(Math.sin((Math.PI * (time - start)) / (FPB / 2)));
  drawDevil(g, time, {
    x: CX + 30 * wander(time / 60, 3),
    y: 760,
    scale: 820 + lt * 3,
    draw: 1,
    mood: 1,
    jaw,
    tremble: 0.004,
    horns: 1,
    line: INK.line,
    eye: INK.key,
    fill: rgba(INK.bg, 0.85),
    lineWidth: 7,
  });
  return boxes;
}

/** The sweep angle of the radar eye at `time`: one turn every two beats. */
function sweepAt(time: number): number {
  return (time / (FPB * 2)) * TAU - Math.PI / 2;
}

/** A thought bubble: a rounded cloud with scribbled lines. */
function bubble(g: G, x: number, y: number, s: number, pal: Palette, seed: number): void {
  g.save();
  g.translate(x, y);
  g.fillStyle = pal.bg;
  g.strokeStyle = pal.line;
  g.lineWidth = 2.5;
  g.beginPath();
  g.roundRect(-s, -s * 0.6, s * 2, s * 1.2, s * 0.5);
  g.fill();
  g.stroke();
  g.beginPath();
  g.arc(-s * 0.7, s * 0.85, s * 0.14, 0, TAU);
  g.stroke();
  for (let i = 0; i < 3; i++) {
    g.beginPath();
    g.moveTo(-s * 0.7, -s * 0.25 + i * s * 0.25);
    const len = s * (0.8 + 0.6 * hash(seed * 7 + i, 2));
    for (let k = 0; k <= 8; k++) {
      g.lineTo(-s * 0.7 + (len * k) / 8, -s * 0.25 + i * s * 0.25 + 4 * Math.sin(k * 2.2 + seed));
    }
    g.stroke();
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
      // The thoughts arrive after the words, flying in from the edge on beat 13.5.
      const arrive = clamp(springOf(time, bf(13.5) + j * 2, PLAYFUL), 0, 1.2);
      if (arrive <= 0) {
        return;
      }
      const bx = Math.cos(a) * r * (2.2 - 1.2 * arrive);
      const by = Math.sin(a) * r * 0.6 * (2.2 - 1.2 * arrive);
      bubble(g, bx, by, 62, pal, j + 3);
      if (time >= at) {
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

/** Beat 12-16: the eye, pushed on each stamp. */
export function watch(g: G, ctx: Ctx, time: number, start: number): TextBox[] {
  const hits = STAMP_BEATS.map(bf);
  const zoom = 1 + 0.03 * env(time, hits, 4) + (time - start) * 0.0008;
  return eye(g, ctx, time, 1240, zoom, true, start);
}

/** A vault door: ring, bolts, spinning wheel; cracks at `crackAt` and bursts at `burstAt`. */
export function vault(g: G, time: number, pal: Palette, cy: number, crackAt: number, burstAt: number): void {
  const r = 350;
  const burst = time >= burstAt ? outExpo((time - burstAt) / 26) : 0;
  const spin = time * 0.02 + 0.12 * Math.max(0, time - (crackAt - 30)) ** 1.2 * 0.01;
  g.save();
  g.lineWidth = 4;
  g.strokeStyle = pal.line;
  g.lineCap = 'round';
  // The wall frame stays; the door halves part.
  g.strokeRect(CX - r - 60, cy - r - 60, 2 * r + 120, 2 * r + 120);
  for (const side of [-1, 1]) {
    g.save();
    g.translate(CX + side * burst * 520, cy + burst * 80);
    g.rotate(side * burst * 0.5);
    g.beginPath();
    g.rect(side < 0 ? -r - 10 : 0, -r - 10, r + 10, 2 * r + 20);
    g.clip();
    g.fillStyle = pal.bg;
    g.beginPath();
    g.arc(0, 0, r, 0, TAU);
    g.fill();
    g.stroke();
    g.beginPath();
    g.arc(0, 0, r * 0.84, 0, TAU);
    g.stroke();
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * TAU;
      g.beginPath();
      g.arc(Math.cos(a) * r * 0.92, Math.sin(a) * r * 0.92, 9, 0, TAU);
      g.stroke();
    }
    g.save();
    g.rotate(spin);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU;
      g.beginPath();
      g.moveTo(Math.cos(a) * 40, Math.sin(a) * 40);
      g.lineTo(Math.cos(a) * r * 0.55, Math.sin(a) * r * 0.55);
      g.stroke();
      g.beginPath();
      g.arc(Math.cos(a) * r * 0.58, Math.sin(a) * r * 0.58, 18, 0, TAU);
      g.stroke();
    }
    g.beginPath();
    g.arc(0, 0, 40, 0, TAU);
    g.stroke();
    g.restore();
    // Engraved hatching on the lower right of the door.
    g.lineWidth = 1.5;
    for (let i = 0; i < 16; i++) {
      const a = 0.2 + i * 0.05;
      g.beginPath();
      g.moveTo(Math.cos(a) * r * 0.86, Math.sin(a) * r * 0.86);
      g.lineTo(Math.cos(a) * r * 0.97, Math.sin(a) * r * 0.97);
      g.stroke();
    }
    g.lineWidth = 4;
    g.restore();
  }
  if (time >= crackAt && burst < 1) {
    const u = clamp((time - crackAt) / 5);
    const pts: [number, number][] = [];
    for (let i = 0; i <= 14; i++) {
      const s = i / 14;
      pts.push([CX + lerp(-r * 0.9, r * 0.9, s) + hs(i, 12) * 20, cy + lerp(-r * 0.6, r * 0.7, s) + hs(i + 40, 12) * 50]);
    }
    g.strokeStyle = pal.key;
    g.lineWidth = 6;
    polyline(g, pts, u);
  }
  g.restore();
}

/** Pages bursting out of the vault toward the viewer, each on its own ballistic arc and spin. */
export function papers(g: G, time: number, pal: Palette, cx: number, cy: number, burstAt: number, count = 70): void {
  if (time < burstAt) {
    return;
  }
  const u = (time - burstAt) / 60;
  const list = Array.from({ length: count }, (_, i) => i).sort((a, b) => hash(a, 71) - hash(b, 71));
  for (const i of list) {
    const a = hash(i, 61) * TAU;
    const speed = 500 + 900 * hash(i, 62);
    const z = 1 + u * (1.5 + 3 * hash(i, 63));
    const x = cx + Math.cos(a) * speed * u * z * 0.6;
    const y = cy + Math.sin(a) * speed * u * z * 0.5 - 200 * u + 500 * u * u;
    const s = 22 * z;
    g.save();
    g.translate(x, y);
    g.rotate(hs(i, 64) * 6 * u + a);
    g.scale(1, Math.cos(u * (4 + 6 * hash(i, 65))));
    g.fillStyle = pal === PARCH ? '#f7efdc' : pal.bg;
    g.strokeStyle = pal.line;
    g.lineWidth = 2;
    g.fillRect(-s, -s * 1.3, s * 2, s * 2.6);
    g.strokeRect(-s, -s * 1.3, s * 2, s * 2.6);
    g.fillStyle = hash(i, 66) < 0.3 ? pal.key : rgba(pal.line, 0.7);
    for (let l = 0; l < 5; l++) {
      g.fillRect(-s * 0.7, -s + l * s * 0.45, s * (1.4 - (l % 3) * 0.3), s * 0.12);
    }
    g.restore();
  }
}

/** Beat 16-20: the vault on parchment; crack on 17, burst on 18. */
export function leak(g: G, time: number, start: number): void {
  field(g, time, PARCH, 1400, 0.1);
  // The camera creeps in on the door and drifts across it until the crack, then is thrown back by the burst.
  const creep = 0.2 * smooth(prog(time, start, bf(18)));
  const thrown = 0.28 * outExpo(prog(time, bf(18), bf(18) + 20));
  const z = 1 + creep - thrown;
  const drift = 70 * Math.sin((time - start) / 40) * (1 - thrown * 3);
  g.save();
  g.translate(CX + drift, 1400);
  g.rotate(0.03 * Math.sin((time - start) / 55));
  g.scale(z, z);
  g.translate(-CX, -1400);
  vault(g, time, PARCH, 1400, bf(17), bf(18));
  g.restore();
  papers(g, time, PARCH, CX, 1400, bf(18));
}

/**
 * Beats 20-24, one shot with in-shot hits: the Devil's grin in the dark with an
 * ember in his mouth, the camera pushing in faster and faster. KEEP, WATCH and
 * LEAK slam over him on 20, 21 and 22, each flaring his eyes; on 23 the jaw
 * slams open and the stutter repeats the slam; at 23.5 the frame inhales to
 * the ember alone.
 */
export function build(g: G, ctx: Ctx, frame: number, time: number): TextBox[] {
  const beat = frame / FPB;
  const boxes: TextBox[] = [];
  if (beat >= 23.5) {
    g.fillStyle = '#000000';
    g.fillRect(-200, -200, W + 400, H + 400);
    const u = prog(time, bf(23.5), bf(24));
    drawEmber(g, time, CX, 1100, lerp(26, 6, u), lerp(1, 0.6, u));
    return boxes;
  }
  // The stutter repeats beat 23's first three frames, as the drums do.
  const t = beat < 23 ? time : bf(23) + ((time - bf(23)) % 3);
  const slam = t >= bf(23) ? t - bf(23) : -1;
  const words = [bf(20), bf(21), bf(22)];
  const flare = env(t, words, 4);
  const push = Math.exp(Math.log(1.55) * (prog(t, bf(20), bf(23.5)) ** 2)) * (1 + 0.04 * flare) * (slam < 0 ? 1 : 1.12 - 0.04 * slam);
  const hx = CX;
  const hy = 1180;
  g.save();
  g.translate(hx, 1060);
  g.scale(push, push);
  g.translate(-hx, -1060);
  field(g, t, INK, hy, 0.3 + 0.3 * flare);
  diagram(g, t, hx, hy, 620, INK.line, 0.12);
  const jaw = slam >= 0 ? ([1, 0.55, 0.25][Math.floor(slam)] ?? 0.25) : 0.25 + 0.35 * flare;
  drawDevil(g, t, {
    x: hx,
    y: hy,
    scale: 420,
    draw: 1,
    mood: 1,
    jaw,
    tremble: 0.004,
    horns: 1,
    line: INK.line,
    eye: slam >= 0 || flare > 0.5 ? INK.hot : INK.key,
    fill: INK.bg,
    lineWidth: 5,
    look: 0.3 * Math.sin(t / 11),
  });
  drawEmber(g, t, hx, hy + 0.45 * 420, 10 + 16 * prog(t, bf(20), bf(23.5)), 0.9);
  g.restore();
  const word = ['KEEP', 'WATCH', 'LEAK'][beat < 21 ? 0 : beat < 22 ? 1 : 2] ?? 'LEAK';
  if (beat < 23) {
    const hitAt = words[beat < 21 ? 0 : beat < 22 ? 1 : 2] ?? 0;
    const k = springOf(time, hitAt, SNAPPY);
    g.save();
    g.translate(CX, 760);
    g.scale(1.4 - 0.4 * k, 1.4 - 0.4 * k);
    boxes.push(
      imagery(g, ctx, { id: 'build-word', text: word, x: 0, y: 110, size: word === 'WATCH' ? 225 : 290, face: 'serif', weight: 900, stroke: INK.hot, lineWidth: 5, align: 'center' })
    );
    g.restore();
  }
  return boxes;
}
