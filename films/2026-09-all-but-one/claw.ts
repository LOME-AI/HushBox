import { TAU, boil, lerp, rgba } from './kit.js';

import type { G } from './kit.js';

export interface Claw {
  /** The shoulder the arm grows from, and the wrist it reaches to, in px. */
  sx: number;
  sy: number;
  wx: number;
  wy: number;
  /** 0 fingers splayed open, 1 clenched around what it holds. */
  grip: number;
  /** Pixels per finger unit; a finger is about 1.2 units long. */
  scale: number;
  line: string;
  lineWidth: number;
}

/**
 * The Devil's arm and claw in the same engraved gold line as his face: a long
 * thin arm on a bent arc from shoulder to wrist, and four jointed fingers too
 * long for a hand, each ending in a talon. The fingers differ in length and
 * curl, the thumb lags behind the others, and every stroke boils.
 */
export function drawClaw(g: G, time: number, c: Claw): void {
  const dx = c.wx - c.sx;
  const dy = c.wy - c.sy;
  const reach = Math.hypot(dx, dy) || 1;
  const dir = Math.atan2(dy, dx);
  // The elbow bows the arm off the straight line, always to the same side.
  const ex = c.sx + dx * 0.5 - Math.sin(dir) * reach * 0.18;
  const ey = c.sy + dy * 0.5 + Math.cos(dir) * reach * 0.18;
  g.save();
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const stroke = (pts: [number, number][], width: number): void => {
    g.strokeStyle = rgba(c.line, 0.25);
    g.lineWidth = width * 3;
    g.beginPath();
    for (const [index, [x, y]] of pts.entries()) {
      if (index === 0) {
        g.moveTo(x, y);
      } else {
        g.lineTo(x, y);
      }
    }
    g.stroke();
    g.strokeStyle = c.line;
    g.lineWidth = width;
    g.stroke();
  };
  const arm: [number, number][] = [];
  for (let index = 0; index <= 12; index++) {
    const s = index / 12;
    const u = 1 - s;
    arm.push([
      u * u * c.sx + 2 * u * s * ex + s * s * c.wx + boil(time, index, 9, 71) * 2,
      u * u * c.sy + 2 * u * s * ey + s * s * c.wy + boil(time, index + 20, 9, 71) * 2,
    ]);
  }
  stroke(arm, c.lineWidth);
  const offset = (s: number, side: number): [number, number][] =>
    arm.map(([x, y]) => [x - Math.sin(dir) * side * s, y + Math.cos(dir) * side * s]);
  stroke(offset(c.scale * 0.09, 1).slice(2), c.lineWidth * 0.6);
  // Fingers: spread across the wrist, each three segments that curl in as the grip closes.
  const fingers = [
    { spread: -0.55, len: 1.05, lag: 0.3 },
    { spread: -0.18, len: 1.3, lag: 0 },
    { spread: 0.16, len: 1.22, lag: 0.08 },
    { spread: 0.5, len: 0.95, lag: 0.16 },
  ];
  for (const [fi, f] of fingers.entries()) {
    const grip = Math.max(0, Math.min(1, c.grip - f.lag * 0.4));
    let a = dir + f.spread * lerp(1, 0.35, grip);
    let x = c.wx;
    let y = c.wy;
    const pts: [number, number][] = [[x, y]];
    for (let k = 0; k < 3; k++) {
      const seg = (c.scale * f.len) / 3;
      a += lerp(0.12, 0.75, grip) * (fi === 0 ? -1 : 1);
      x += Math.cos(a) * seg + boil(time, fi * 7 + k, 9, 73) * 1.5;
      y += Math.sin(a) * seg + boil(time, fi * 7 + k + 3, 9, 73) * 1.5;
      pts.push([x, y]);
    }
    stroke(pts, c.lineWidth * 0.8);
    // The talon.
    g.fillStyle = c.line;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(a) * c.scale * 0.22, y + Math.sin(a) * c.scale * 0.22);
    g.lineTo(x + Math.cos(a + 1.3) * c.scale * 0.06, y + Math.sin(a + 1.3) * c.scale * 0.06);
    g.closePath();
    g.fill();
    // A knuckle ring at the first joint.
    const [kx, ky] = pts[1] ?? [x, y];
    g.beginPath();
    g.arc(kx, ky, c.scale * 0.035, 0, TAU);
    g.stroke();
  }
  g.restore();
}
