import { FPB, H, W, clamp, grouped, rgba } from './kit.js';
import { imagery } from './type.js';

import type { G, Palette } from './kit.js';
import type { LookContext, TextBox } from '../../../../engine/look/index.js';

const CHAPTERS: readonly [number, string][] = [
  [0, 'I · THE INTERVIEW'],
  [24, 'II · THE ESCAPE'],
  [40, 'III · ALL BUT ONE'],
];

/** The act's chapter label, by beat. */
function chapterOf(beat: number): string {
  let label = '';
  for (const [from, text] of CHAPTERS) {
    if (beat >= from) {
      label = text;
    }
  }
  return label;
}

function timecode(frame: number): string {
  const s = Math.floor(frame / 60);
  const f = frame % 60;
  return `00:00:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
}

/** Secrets the companies hold, climbing exponentially through the praise and the escape. */
function secretsKept(frame: number): number {
  const u = clamp(frame / 960);
  return 1200 * 10 ** (u * 7.6);
}

/**
 * The frame's HUD: corner marks, the act, the file, a running REC timecode, a
 * counter, and a scrubber that advances across the whole film with a tick on
 * every beat. It is the one layer that is never cut, only recoloured.
 */
export function drawHud(
  g: G,
  ctx: LookContext<'2d'>,
  frame: number,
  pal: Palette,
  opts: { alpha: number; kick: number; fear: number }
): TextBox[] {
  const { time } = ctx;
  const beat = frame / FPB;
  const boxes: TextBox[] = [];
  if (opts.alpha <= 0) {
    return boxes;
  }
  const jx = opts.kick * 4 * Math.sin(time * 2.1);
  g.save();
  g.globalAlpha = opts.alpha;
  g.translate(jx, 0);
  g.strokeStyle = rgba(pal.line, 0.7);
  g.lineWidth = 2;
  const m = 44;
  const len = 46 + 10 * opts.kick;
  for (const [x, y, sx, sy] of [
    [m, m, 1, 1],
    [W - m, m, -1, 1],
    [m, H - m, 1, -1],
    [W - m, H - m, -1, -1],
  ] as const) {
    g.beginPath();
    g.moveTo(x, y + sy * len);
    g.lineTo(x, y);
    g.lineTo(x + sx * len, y);
    g.stroke();
  }
  const dim = rgba(pal.line, 0.85);
  boxes.push(
    imagery(g, ctx, { id: 'hud-chapter', text: chapterOf(beat), x: 70, y: 118, size: 26, face: 'mono', weight: 600, fill: dim, tracking: 0.08 }),
    imagery(g, ctx, { id: 'hud-file', text: 'FILE 666 · SUBJECT: THE DEVIL', x: W - 70, y: 118, size: 22, face: 'mono', weight: 500, fill: dim, align: 'right' })
  );
  if (beat < 40) {
    const on = Math.floor(time / 30) % 2 === 0;
    g.fillStyle = rgba(pal.key, on ? 1 : 0.25);
    g.beginPath();
    g.arc(80, 170, 9, 0, Math.PI * 2);
    g.fill();
    boxes.push(
      imagery(g, ctx, { id: 'hud-rec', text: `REC  ${timecode(frame)}`, x: 100, y: 179, size: 24, face: 'mono', weight: 500, fill: dim })
    );
  }
  const label = beat < 40 ? 'SECRETS KEPT' : 'SUBJECT HEART RATE';
  const value = beat < 40 ? grouped(secretsKept(frame)) : `${String(Math.round(88 + 110 * opts.fear + 6 * Math.sin(frame * 0.8)))} BPM`;
  boxes.push(
    imagery(g, ctx, { id: 'hud-label', text: label, x: 70, y: H - 150, size: 22, face: 'mono', weight: 500, fill: rgba(pal.line, 0.6), tracking: 0.1 }),
    imagery(g, ctx, { id: 'hud-value', text: value, x: 70, y: H - 108, size: 40, face: 'mono', weight: 700, fill: pal.line })
  );
  // The scrubber: the whole film's length, a tick on every beat, the head at this frame.
  const x0 = 70;
  const x1 = W - 70;
  const y = H - 74;
  g.strokeStyle = rgba(pal.line, 0.35);
  g.beginPath();
  g.moveTo(x0, y);
  g.lineTo(x1, y);
  g.stroke();
  for (let b = 0; b <= 75; b++) {
    const x = x0 + ((x1 - x0) * b) / 75;
    g.beginPath();
    g.moveTo(x, y - (b % 4 === 0 ? 10 : 5));
    g.lineTo(x, y);
    g.stroke();
  }
  const head = x0 + ((x1 - x0) * time) / 1800;
  g.strokeStyle = pal.key;
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(x0, y);
  g.lineTo(head, y);
  g.stroke();
  g.fillStyle = pal.key;
  g.fillRect(head - 3, y - 14, 6, 28);
  boxes.push(
    imagery(g, ctx, { id: 'hud-beat', text: `BEAT ${String(Math.floor(beat) + 1).padStart(2, '0')}/75 · 150 BPM`, x: W - 70, y: H - 108, size: 22, face: 'mono', weight: 500, fill: dim, align: 'right' })
  );
  g.restore();
  return boxes;
}
