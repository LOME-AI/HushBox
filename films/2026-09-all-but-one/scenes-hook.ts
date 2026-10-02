import { drawDevil } from './devil.js';
import {
  CX,
  FPB,
  INK,
  SNAPPY,
  W,
  H,
  bf,
  clamp,
  env,
  lerp,
  mix,
  prog,
  rgba,
  smooth,
  springOf,
} from './kit.js';

import type { DevilPose } from './devil.js';
import type { G } from './kit.js';

/** The interview lamp: a hard cone of light from above onto the chair, everything else black. */
/** A snappy spring that is already half way on its cue's own frame, so the action reads on the hit. */
function snapOn(time: number, cue: number): number {
  const t = Math.round(time);
  return t < cue ? 0 : 0.5 + 0.5 * springOf(t + 1, cue, SNAPPY);
}

export function lamp(g: G, time: number, strength: number): void {
  g.fillStyle = INK.bg;
  g.fillRect(-200, -200, W + 400, H + 400);
  if (strength <= 0) {
    return;
  }
  const hum = 1 - 0.04 * (0.5 + 0.5 * Math.sin(time * 0.9) * Math.sin(time * 0.31));
  const grad = g.createLinearGradient(0, 120, 0, 1900);
  grad.addColorStop(0, rgba('#fff1cf', 0.22 * strength * hum));
  grad.addColorStop(1, rgba('#fff1cf', 0));
  g.fillStyle = grad;
  g.beginPath();
  g.moveTo(CX - 60, 120);
  g.lineTo(CX + 60, 120);
  g.lineTo(CX + 620, 1920);
  g.lineTo(CX - 620, 1920);
  g.closePath();
  g.fill();
  g.strokeStyle = rgba(INK.line, 0.5 * strength);
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(CX - 70, 110);
  g.lineTo(CX + 70, 110);
  g.lineTo(CX + 40, 70);
  g.lineTo(CX - 40, 70);
  g.closePath();
  g.stroke();
  g.beginPath();
  g.moveTo(CX, 70);
  g.lineTo(CX, -20);
  g.stroke();
}

/** Where the claw's fingertips reach: past the wrist along the arm's line, a finger's length on. */
export function tip({
  sx,
  sy,
  wx,
  wy,
  scale,
}: {
  sx: number;
  sy: number;
  wx: number;
  wy: number;
  scale: number;
}): [number, number] {
  const a = Math.atan2(wy - sy, wx - sx);
  return [wx + Math.cos(a) * scale * 1.05, wy + Math.sin(a) * scale * 1.05];
}

/** The Devil under the lamp: gold line, the default for the interview shots. */
function devil(
  g: G,
  time: number,
  pose: Partial<DevilPose> & { x: number; y: number; scale: number }
): void {
  drawDevil(g, time, {
    draw: 1,
    mood: 1,
    jaw: 0.15,
    tremble: 0,
    horns: 1,
    line: INK.line,
    eye: INK.key,
    fill: INK.bg,
    lineWidth: 4,
    ...pose,
  });
}

/**
 * Beats 0-4: the interview file in the dark while the question types. On 2.5
 * two eyes snap open where a face should be, and fix on the viewer; the faint
 * shape of him boils around them.
 */
export function file(g: G, time: number, start: number, frame: number): void {
  lamp(g, time, 0);
  const t = time - start;
  const push = 1 + 0.0009 * t;
  g.save();
  g.translate(CX, 1250);
  g.scale(push, push);
  g.translate(-CX, -1250);
  // The eyes snap open on their frame, wider than rest, and settle; his shape jumps up with them.
  const open =
    frame >= bf(2.5) ? 1.15 - 0.15 * clamp(springOf(Math.round(time), bf(2.5), SNAPPY), 0, 1.2) : 0;
  const shape = 0.17 + (frame >= bf(2.5) ? 0.06 : 0) + 0.06 * smooth(prog(time, bf(3), bf(4)));
  devil(g, time, {
    x: CX,
    y: 1330,
    scale: 330,
    line: mix(INK.bg, INK.line, shape),
    eye: INK.key,
    lids: open,
    jaw: 0.05,
    mood: 0.9,
    look: 0,
  });
  g.restore();
}

/** Beats 4-8: close on the face; the head tilts one way while the eyes stay on the viewer. */
export function ofCourse(g: G, time: number, start: number): void {
  lamp(g, time, 1);
  const u = prog(time, start, start + 4 * FPB);
  const tilt = 0.14 * smooth(u);
  // The smirk splits into the grin on 6's own frame.
  const split = snapOn(time, bf(6));
  devil(g, time, {
    x: CX,
    y: 1360,
    scale: 600 + 40 * u,
    tilt,
    mood: lerp(0.55, 1, clamp(split, 0, 1.15)),
    jaw: lerp(0.02, 0.35, clamp(split, 0, 1.2)),
    look: -tilt * 3,
    lookY: 0.2,
  });
}

/** Beats 8-12: extreme close on the mouth, the jaw opening slowly on row after row of teeth. */
export function notToLike(g: G, time: number, start: number): void {
  lamp(g, time, 1);
  const u = smooth(prog(time, start + 4, bf(10.25)));
  const chomp = Math.round(time) >= bf(10.5) ? clamp(springOf(time, bf(10.5), SNAPPY), 0, 1.1) : 0;
  const punch = 1 + 0.06 * env(Math.round(time), [bf(10.5)], 4);
  devil(g, time, {
    x: CX + 30,
    y: 820,
    scale: 1150 * punch,
    mood: 1,
    jaw: Math.max(0, lerp(0.1, 1, u) * (1 - chomp)),
    lids: lerp(1, 0.5, clamp(chomp)),
    lineWidth: 7,
    look: 0,
    lookY: 0.4,
  });
}
