import { TAU, boil, clamp, hash, lerp, nth, polyline, rgba } from './kit.js';

import type { G } from './kit.js';

type P = [number, number];

export interface DevilPose {
  x: number;
  y: number;
  /** Pixels per head unit; the head spans about 2.2 units wide with horns, 3 tall. */
  scale: number;
  /** How much of the drawing has drawn on, 0 to 1, part after part. */
  draw: number;
  /** 1 delight (grin, V brows, slit eyes) through 0 to -1 terror (O mouth, raised brows, pinned eyes). */
  mood: number;
  /** How far the jaw is open, 0 to 1; the chin drops with it. */
  jaw: number;
  /** How much the whole drawing shakes, in head units. */
  tremble: number;
  /** Horn length, 0 to 1. */
  horns: number;
  line: string;
  eye: string;
  /** The face's fill, which hides whatever is behind the head; null leaves it open. */
  fill: string | null;
  lineWidth: number;
  /** Where the pupils look, -1 (his right, screen left) to 1 (screen right). */
  look?: number;
  /** How open both lids are, 0 shut to 1 open, over their own blinking. */
  lids?: number;
  /** Where the pupils look vertically, -1 up to 1 down. */
  lookY?: number;
  /** Head tilt in radians. */
  tilt?: number;
  /** 0 to 1: the drawing tears into its strokes, each a rigid piece spiralling into (pullX, pullY). */
  shatter?: number;
  pullX?: number;
  pullY?: number;
}

function quad(a: P, c: P, b: P, n: number): P[] {
  return Array.from({ length: n + 1 }, (_, index) => {
    const s = index / n;
    const u = 1 - s;
    return [
      u * u * a[0] + 2 * u * s * c[0] + s * s * b[0],
      u * u * a[1] + 2 * u * s * c[1] + s * s * b[1],
    ];
  });
}

/** The head's outline; below the cheekbones it stretches down as the jaw opens. */
function headOutline(jaw: number): P[] {
  const pts: P[] = [];
  for (let index = 0; index < 72; index++) {
    const th = (index / 72) * TAU;
    let y = -0.95 * Math.cos(th);
    let x = 0.8 * Math.sin(th);
    if (y > 0) {
      const k = y / 0.95;
      x *= 1 - 0.55 * k ** 1.6;
      y += 0.22 * k ** 3;
      y *= 1 + 0.2 * jaw * k;
    }
    x *= 1 + 0.09 * Math.exp(-(((y - 0.05) / 0.28) ** 2));
    pts.push([x, y]);
  }
  return pts;
}

function horn(side: number, length: number): P[] {
  const base: P = [side * 0.36, -0.8];
  const ctrl: P = [side * 1.05, -1];
  // The two horns are not twins: his left curls higher and further.
  const tip: P = [side * (side < 0 ? 0.74 : 0.66), side < 0 ? -1.96 : -1.82];
  const n = 18;
  const centre = quad(base, ctrl, tip, n).slice(0, Math.max(2, Math.round(n * clamp(length)) + 1));
  const left: P[] = [];
  const right: P[] = [];
  const m = centre.length;
  for (let index = 0; index < m; index++) {
    const a = nth(centre, Math.max(0, index - 1));
    const b = nth(centre, Math.min(m - 1, index + 1));
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length_ = Math.hypot(dx, dy) || 1;
    const w = 0.15 * (1 - index / (n + 1));
    const c = nth(centre, index);
    left.push([c[0] - (dy / length_) * w, c[1] + (dx / length_) * w]);
    right.push([c[0] + (dy / length_) * w, c[1] - (dx / length_) * w]);
  }
  return [...left, ...right.toReversed()];
}

/** How open each eyelid is at `time`: each eye blinks on its own clock, the right one late and shallow. */
function lids(time: number, fear: number): [number, number] {
  const period = lerp(104, 58, fear);
  const one = (lag: number, depth: number): number => {
    const b = ((time + lag) / period) % 1;
    return b < 0.07 ? 1 - depth * Math.sin((Math.PI * b) / 0.07) : 1;
  };
  return [one(0, 1), one(-3, 0.75)];
}

interface Part {
  pts: P[];
  closed: boolean;
  eye?: -1 | 1;
}

/** An ear, a brow and an eye on one side of the face: `s` is -1 for his left, 1 for his right. */
function sideParts(
  s: -1 | 1,
  { m, fear, open }: { m: number; fear: number; open: [number, number] }
): Part[] {
  const lead = s < 0;
  const ear: Part = {
    pts: [
      [s * 0.77, -0.28],
      [s * 1.18, -0.62],
      [s * 0.8, 0.02],
    ],
    closed: false,
  };
  // Brows: a V of menace when delighted (his left arched higher), raised at the middle in
  // terror (his right higher, the brow that gives way first).
  const arch = lead ? 0.05 * m : 0.05 * fear;
  const inner: P = [s * 0.1, lerp(-0.6, -0.3, m) - arch];
  const outer: P = [s * 0.58, lerp(-0.4, -0.54, m) - arch * 1.4];
  const brow: Part = {
    pts: quad(inner, [s * 0.34, lerp(-0.62, -0.36, m) - arch * 1.6], outer, 6),
    closed: false,
  };
  // Eyes: slanted almonds when delighted, wide rings in terror; his left the larger.
  const size = lead ? 1.07 : 0.93;
  const ex = s * 0.3;
  const ey = -0.2;
  const hw = lerp(0.14, 0.18, m) * size;
  const hh = lerp(0.14, 0.05, m) * size * (lead ? open[0] : open[1]);
  const slant = lerp(0, 0.05, m) * (lead ? 1.2 : 0.8);
  const eye: P[] = [];
  for (let index = 0; index < 20; index++) {
    const a = (index / 20) * TAU;
    const px = Math.cos(a) * hw;
    eye.push([
      ex + px,
      ey +
        Math.sin(a) * Math.max(0.004, hh) * (1 - 0.3 * Math.abs(Math.cos(a))) +
        (s * px * slant) / hw,
    ]);
  }
  return [ear, brow, { pts: eye, closed: true, eye: s }];
}

/**
 * The grin: too wide for the face, its corners past the cheeks, and lopsided, his left corner
 * hitched higher. Too many teeth: a long upper row of thin fangs and a lower row pointing up at them.
 */
function grinParts({ m, jaw, chin }: { m: number; jaw: number; chin: number }): Part[] {
  const g = (m - 0.5) * 2;
  const drop = 0.5 + 0.28 * jaw;
  const left: P = [-0.78, 0.12 - 0.12 * g];
  const right: P = [0.72, 0.2 - 0.06 * g];
  const smile = quad(left, [0.03, lerp(0.35, drop + 0.28, g) + chin], right, 24);
  const lip = quad(left, [0.02, 0.33], right, 24);
  const out: Part[] = [
    { pts: smile, closed: false },
    { pts: lip, closed: false },
  ];
  const upper = 17;
  for (let index = 1; index < upper; index++) {
    const s = index / upper;
    const a = nth(lip, Math.round(s * 24));
    const b = nth(smile, Math.round(s * 24));
    const length = (0.45 + 0.25 * Math.sin(index * 2.3) ** 2) * (index % 4 === 2 ? 1.25 : 1);
    out.push({
      pts: [
        [a[0] - 0.018, a[1]],
        [lerp(a[0], b[0], 0.5), lerp(a[1], b[1], length)],
        [a[0] + 0.018, a[1]],
      ],
      closed: false,
    });
  }
  const lower = 12;
  for (let index = 1; index < lower; index++) {
    const s = (index + 0.5) / (lower + 1);
    const b = nth(smile, Math.round(s * 24));
    const a = nth(lip, Math.round(s * 24));
    out.push({
      pts: [
        [b[0] - 0.02, b[1]],
        [lerp(b[0], a[0], 0.02), lerp(b[1], a[1], 0.4 + 0.15 * Math.sin(index * 1.7) ** 2)],
        [b[0] + 0.02, b[1]],
      ],
      closed: false,
    });
  }
  return out;
}

/** Terror: a mouth hanging below the nose, never reaching it, pulled to one side, and the cheeks drawn down. */
function screamParts({ m, jaw, chin }: { m: number; jaw: number; chin: number }): Part[] {
  const f = 1 - m * 2;
  const rx = 0.11 + 0.1 * jaw + 0.03 * f;
  const ry = 0.07 + 0.2 * jaw + 0.04 * f;
  const cy = 0.5 + 0.12 * jaw;
  const mouth: P[] = [];
  for (let index = 0; index < 24; index++) {
    const a = (index / 24) * TAU;
    const skew = 0.04 * Math.sin(a) * f;
    mouth.push([0.02 + Math.cos(a) * rx + skew, cy + Math.sin(a) * ry]);
  }
  return [
    { pts: mouth, closed: true },
    {
      pts: [
        [-0.5, 0.18],
        [-0.36, 0.34],
        [-0.41, 0.56 + chin],
      ],
      closed: false,
    },
    {
      pts: [
        [0.5, 0.2],
        [0.38, 0.38],
        [0.4, 0.58 + chin],
      ],
      closed: false,
    },
  ];
}

/** The goatee and the hatching on his cheek. */
function chinParts(chin: number): Part[] {
  const gy = 1.02 * (1 + chin);
  const out: Part[] = [
    {
      pts: [
        [-0.16, gy],
        [-0.1, gy + 0.28],
        [0, gy + 0.5],
        [0.1, gy + 0.28],
        [0.16, gy],
      ],
      closed: false,
    },
  ];
  for (let index = 0; index < 6; index++) {
    const y = 0.02 + index * 0.07;
    out.push({
      pts: [
        [-0.66 + index * 0.02, y],
        [-0.5 + index * 0.03, y + 0.1],
      ],
      closed: false,
    });
  }
  return out;
}

/** The parts of the face at a mood and jaw, in draw-on order, each an open or closed polyline. */
function parts(mood: number, jaw: number, horns: number, open: [number, number]): Part[] {
  const m = (mood + 1) / 2;
  const fear = clamp(-mood);
  const out: Part[] = [];
  if (horns > 0) {
    out.push({ pts: horn(-1, horns), closed: true }, { pts: horn(1, horns), closed: true });
  }
  const chin = 0.2 * jaw;
  out.push(
    { pts: headOutline(jaw), closed: true },
    ...sideParts(-1, { m, fear, open }),
    ...sideParts(1, { m, fear, open }),
    {
      pts: [
        [0.02, -0.08],
        [0.08, 0.14],
        [-0.03, 0.17],
      ],
      closed: false,
    },
    {
      pts: [
        [-0.52, -0.7],
        [0, -0.48],
        [0.52, -0.7],
      ],
      closed: false,
    },
    ...(m > 0.5 ? grinParts({ m, jaw, chin }) : screamParts({ m, jaw, chin })),
    ...chinParts(chin)
  );
  return out;
}

/**
 * The Devil as an engraved line drawing: horns, face, ears, brows, eyes, grin
 * or scream, goatee and hatching, every stroke boiling a few times a second and
 * drawn on part after part. His eyes blink apart and differ in size.
 */
export function drawDevil(g: G, time: number, pose: DevilPose): void {
  const fear = clamp(-pose.mood);
  const blinkOpen = lids(time, fear);
  const open: [number, number] = [blinkOpen[0] * (pose.lids ?? 1), blinkOpen[1] * (pose.lids ?? 1)];
  const list = parts(pose.mood, pose.jaw, pose.horns, open);
  const total = list.length;
  const reach = clamp(pose.draw) * total;
  const place = placer(time, pose);
  const tear = tearer(pose);
  g.save();
  g.lineCap = 'round';
  g.lineJoin = 'round';
  fillHead(g, { list, pose, reach, place });
  for (let pi = 0; pi < total; pi++) {
    const p = clamp(reach - pi);
    if (p <= 0) {
      break;
    }
    const part = list[pi];
    if (part === undefined) {
      continue;
    }
    const pts = tear(
      part.pts.map((q, index) => place(q, index, pi)),
      pi
    );
    g.strokeStyle = rgba(pose.line, 0.25);
    g.lineWidth = pose.lineWidth * 3.2;
    polyline(g, pts, p, part.closed);
    g.strokeStyle = pose.line;
    g.lineWidth = pose.lineWidth;
    polyline(g, pts, p, part.closed);
    if (part.eye !== undefined && p >= 1) {
      pupil(g, { pts, side: part.eye, open, pose, time });
    }
  }
  g.restore();
}

/** Where a point of the face lands on the frame: boiled, trembling, tilted, scaled and placed. */
function placer(time: number, pose: DevilPose): (p: P, index: number, pi: number) => P {
  const t = time / 60;
  const trembleX = pose.tremble * Math.sin(t * 61) * Math.sin(t * 13.7);
  const trembleY = pose.tremble * Math.sin(t * 47 + 1) * Math.sin(t * 9.1);
  const tilt = pose.tilt ?? 0;
  const cos = Math.cos(tilt);
  const sin = Math.sin(tilt);
  return (p, index, pi) => {
    const jx = boil(time, pi * 97 + index, 9) * 0.008;
    const jy = boil(time, pi * 89 + index + 7, 9) * 0.008;
    const x = p[0] + jx + trembleX;
    const y = p[1] + jy + trembleY;
    return [pose.x + (x * cos - y * sin) * pose.scale, pose.y + (x * sin + y * cos) * pose.scale];
  };
}

/** A part torn loose: its whole stroke moves as one piece, turning and shrinking into the pull. */
function tearer(pose: DevilPose): (pts: P[], pi: number) => P[] {
  const shatter = pose.shatter ?? 0;
  const px = pose.pullX ?? pose.x;
  const py = pose.pullY ?? pose.y;
  return (pts, pi) => {
    if (shatter <= 0) {
      return pts;
    }
    const cx = pts.reduce((s, q) => s + q[0], 0) / pts.length;
    const cy = pts.reduce((s, q) => s + q[1], 0) / pts.length;
    const order = hash(pi, 91);
    const k = clamp((shatter - order * 0.45) / 0.55);
    const e = k * k * (3 - 2 * k);
    const a = e * (1.6 + 1.2 * hash(pi, 92));
    const r = 1 - e;
    const dx = cx - px;
    const dy = cy - py;
    const nx = px + (dx * Math.cos(a) - dy * Math.sin(a)) * r;
    const ny = py + (dx * Math.sin(a) + dy * Math.cos(a)) * r;
    const spin = e * (hash(pi, 93) - 0.5) * 3;
    const sc = 1 - 0.8 * e;
    return pts.map(([x, y]) => {
      const qx = (x - cx) * sc;
      const qy = (y - cy) * sc;
      return [
        nx + qx * Math.cos(spin) - qy * Math.sin(spin),
        ny + qx * Math.sin(spin) + qy * Math.cos(spin),
      ];
    });
  };
}

/** The head's fill, once its outline is drawn on and while the face is whole. */
function fillHead(
  g: G,
  {
    list,
    pose,
    reach,
    place,
  }: {
    list: readonly Part[];
    pose: DevilPose;
    reach: number;
    place: (p: P, index: number, pi: number) => P;
  }
): void {
  const outlineIndex = pose.horns > 0 ? 2 : 0;
  const outlinePart = list[outlineIndex];
  const shatter = pose.shatter ?? 0;
  if (
    pose.fill === null ||
    reach < outlineIndex + 1 ||
    outlinePart === undefined ||
    shatter >= 0.05
  ) {
    return;
  }
  const outline = outlinePart.pts.map((p, index) => place(p, index, outlineIndex));
  g.fillStyle = pose.fill;
  g.beginPath();
  for (const [index, [x, y]] of outline.entries()) {
    if (index === 0) {
      g.moveTo(x, y);
    } else {
      g.lineTo(x, y);
    }
  }
  g.fill();
}

/** An eye's iris ring and slit pupil, at the drawn eye's centre, while its lid is open. */
function pupil(
  g: G,
  {
    pts,
    side,
    open,
    pose,
    time,
  }: { pts: readonly P[]; side: -1 | 1; open: [number, number]; pose: DevilPose; time: number }
): void {
  const lead = side < 0;
  const lid = lead ? open[0] : open[1];
  if (lid < 0.25) {
    return;
  }
  const fear = clamp(-pose.mood);
  const m = (pose.mood + 1) / 2;
  const t = time / 60;
  const cx = pts.reduce((s, q) => s + q[0], 0) / pts.length;
  const cy = pts.reduce((s, q) => s + q[1], 0) / pts.length;
  // Terror pins the pupils small; one darts a beat behind the other.
  const rate = lead ? 23 : 17;
  const phase = lead ? 0 : 1.3;
  const dart = fear > 0.2 ? Math.sin(t * rate + phase) * 0.03 * fear : 0;
  const look = ((pose.look ?? 0) * 0.07 + dart) * pose.scale * (lead ? 1 : 0.85);
  const size = (lead ? 1.1 : 0.85) * pose.scale;
  g.fillStyle = pose.eye;
  g.beginPath();
  const lookY = (pose.lookY ?? 0) * 0.03 * pose.scale;
  // An iris ring around the slit, so the stare reads at any size.
  g.strokeStyle = rgba(pose.eye, 0.5);
  g.lineWidth = Math.max(1.5, pose.lineWidth * 0.6);
  g.beginPath();
  g.ellipse(cx + look, cy + lookY, size * 0.06, size * 0.06 * lid, 0, 0, TAU);
  g.stroke();
  g.beginPath();
  g.ellipse(
    cx + look,
    cy + lookY,
    size * lerp(0.03, 0.022, m),
    size * lerp(0.03, 0.075, m) * lid,
    0,
    0,
    TAU
  );
  g.fill();
}
