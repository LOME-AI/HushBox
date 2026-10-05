import { CX, CY, GLIDE, bf, hash, springs, wander } from './kit.js';

import type { G, Spring } from './kit.js';

/**
 * The world is a set of flat layers at depths along the view axis, seen by one
 * camera: a point (x, y) on the layer at depth z lands on screen at
 * CX + (x − X)·F/(z − Z), CY + (y − Y)·F/(z − Z). At Z = 0 the facade (z = 1000)
 * is drawn at scale 1, so its coordinates are the frame's.
 */
export const F = 1000;
/** The facade and its doors. */
export const Z_FACADE = 1000;
/** Her and the pile of letters, just inside the doors. */
export const Z_HER = 1150;
/** Where she stands at dawn, in the doorway. */
export const Z_STAND = 1060;
/** The rows of seats, nearest first. */
export const Z_ROWS = [1300, 1400, 1500, 1600] as const;
/** The back wall and the screen. */
export const Z_SCREEN = 1900;
/** The ground every layer stands on. */
export const FLOOR_Y = 1500;

export interface Cam {
  X: number;
  Y: number;
  Z: number;
  roll: number;
}

/** A camera key: at `beat`, glide toward these values (any left out keep their last target). */
interface Key {
  beat: number;
  x?: number;
  y?: number;
  /** Distance from the camera to the screen's plane: zoom is sprung in its log. */
  d?: number;
  s?: Spring;
}

const LONG: Spring = { hz: 0.55, damp: 3.2 };
const FLIGHT: Spring = { hz: 0.32, damp: 2.6 };

const START = { x: 470, y: 1360, d: 960 };

/** The screen's centre height: the flight ends on it. */
function SCREEN_CENTRE_Y(): number {
  return 1182.5;
}

/** The camera's last distance to the screen: the screen covers the frame with room to spare. */
export const END_D = 104;
/** From this beat the camera is held exactly where its springs are, so the end card is still. */
export const REST_BEAT = 55.5;

const SNAP: Spring = { hz: 1.3, damp: 6.5 };

const KEYS: readonly Key[] = [
  // Frame 0 is low and close on the pile as the letters land; the camera rises to her face.
  { beat: 0, x: 430, y: 1272, d: 985, s: { hz: 0.55, damp: 3.4 } },
  // In close on her face as she reaches for Send; out wide as she pulls back.
  { beat: 3, x: 410, y: 1352, d: 870 },
  { beat: 4.5, x: 440, y: 1236, d: 1090 },
  // Down into the pile as the words fall; back up to her as she types again.
  { beat: 5.5, x: 470, y: 1404, d: 905 },
  { beat: 7.5, x: 426, y: 1262, d: 1010 },
  { beat: 8.5, x: 420, d: 1060 },
  // A push on Send, then back to show the hall.
  { beat: 10.5, x: 440, d: 960, s: { hz: 1.2, damp: 5 } },
  { beat: 11.5, x: 470, y: 1180, d: 1150 },
  // In on her face as the chart delights her; back out as the rows land round her.
  { beat: 14.5, x: 412, y: 1330, d: 990, s: { hz: 1.1, damp: 5 } },
  { beat: 16, x: 470, y: 1170, d: 1260 },
  // Up with her as she stands, then back through the doors to the street before the search arrives.
  { beat: 18.25, y: 1128 },
  { beat: 19.25, x: 540, y: 1100, d: 1720, s: GLIDE },
  { beat: 23, y: 830, d: 1880 },
  // The names: a slow push on the doors, her behind the glass; in on her face for the tap; up to the sign as the name flies.
  { beat: 28, x: 520, y: 1160, d: 1560, s: LONG },
  { beat: 31, x: 404, y: 1336, d: 965, s: SNAP },
  { beat: 32, x: 540, y: 700, d: 1600, s: { hz: 0.9, damp: 4.5 } },
  { beat: 33.3, x: 545, y: 1110, d: 1700, s: LONG },
  { beat: 36, x: 575, y: 1135, d: 1530 },
  { beat: 38.5, x: 640, y: 1188, d: 1310, s: LONG },
  { beat: 42, x: 540, y: 1010, d: 1640, s: LONG },
  // In on her and the board as she throws.
  { beat: 44.5, x: 520, y: 1050, d: 1560, s: LONG },
  // Onto the last letter as it lands, filling the frame; back out through the silence for OPEN.
  { beat: 46.25, x: 678, y: 690, d: 1035, s: SNAP },
  { beat: 47.5, x: 540, y: 900, d: 1880, s: { hz: 1.5, damp: 7.5 } },
  // In through the doorway to her face for the cheer.
  { beat: 49.75, x: 372, y: 1318, d: 1000, s: SNAP },
  // The flight starts a few frames before its beat, so it is already moving on the cue.
  { beat: 51 - 8 / 30, x: 540, y: SCREEN_CENTRE_Y(), d: END_D, s: FLIGHT },
];


function track(time: number, pick: (key: Key) => number | undefined, start: number, log: boolean): number {
  const keys: [number, number, Spring?][] = [];
  for (const key of KEYS) {
    const value = pick(key);
    if (value !== undefined) {
      const target = log ? Math.log(value) : value;
      keys.push(key.s === undefined ? [bf(key.beat), target] : [bf(key.beat), target, key.s]);
    }
  }
  return springs(time, log ? Math.log(start) : start, keys, GLIDE);
}

/** The camera at a frame instant: sprung keys, a breath of hand-held wander, held still from the rest beat. */
export function cameraAt(time: number): Cam {
  const t = Math.min(time, bf(REST_BEAT));
  const rest = time >= bf(REST_BEAT);
  // From the rest beat the camera holds where its springs are on that frame, so it never jumps.
  const X = track(t, (k) => k.x, START.x, false);
  const Y = track(t, (k) => k.y, START.y, false);
  const D = Math.exp(track(t, (k) => k.d, START.d, true));
  // A hand-held breath, which dies away into the flight and the still end card.
  const breath = rest ? 0 : Math.max(0, 1 - Math.max(0, t - bf(50)) / 30);
  const wx = 1.6 * breath * wander(t / 50, 3);
  const wy = 1.2 * breath * wander(t / 47, 7);
  return {
    X: X + wx,
    Y: Y + wy,
    Z: 1900 - D,
    roll: rest ? 0 : 0.004 * breath * wander(t / 70, 11),
  };
}

/**
 * How far the app floats up while the camera tilts down to the pile: the
 * composer rides with the room, so the dive to the pile is a new picture.
 */
export function uiLift(cam: Cam): number {
  return Math.max(0, cam.Y - 1272) * 3;
}

export function scaleAt(cam: Cam, z: number): number {
  return F / (z - cam.Z);
}

/** Whether a layer at depth z is in front of the camera far enough to draw. */
export function visible(cam: Cam, z: number, near = 12): boolean {
  return z - cam.Z > near;
}

/** A world point on the layer at depth z, on screen (roll included). */
export function proj(cam: Cam, x: number, y: number, z: number): [number, number] {
  const s = scaleAt(cam, z);
  const px = (x - cam.X) * s;
  const py = (y - cam.Y) * s;
  const c = Math.cos(cam.roll);
  const r = Math.sin(cam.roll);
  return [CX + px * c - py * r, CY + px * r + py * c];
}

/** Sets `g` to draw on the layer at depth z: world units in, screen pixels out. */
export function onLayer(g: G, cam: Cam, z: number): number {
  const s = scaleAt(cam, z);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.translate(CX, CY);
  g.rotate(cam.roll);
  g.scale(s, s);
  g.translate(-cam.X, -cam.Y);
  return s;
}

/** Sets `g` to screen pixels with the camera's roll, for shapes projected point by point. */
export function onScreen(g: G, cam: Cam | null): void {
  g.setTransform(1, 0, 0, 1, 0, 0);
  if (cam !== null && cam.roll !== 0) {
    g.translate(CX, CY);
    g.rotate(cam.roll);
    g.translate(-CX, -CY);
  }
}

/**
 * A quad on the ground (y = FLOOR_Y, or `y`) between depths z0 and z1 and
 * across x0..x1, traced as a screen path (identity transform expected).
 */
export function groundQuad(g: G, cam: Cam, x0: number, x1: number, z0: number, z1: number, y = FLOOR_Y): boolean {
  // Ground closer than the near distance would project without bound: it is clipped there, or left out.
  const near = cam.Z + 60;
  if (Math.max(z0, z1) <= near) {
    g.beginPath();
    return false;
  }
  if (z0 < near) {
    z0 = near;
  }
  if (z1 < near) {
    z1 = near;
  }
  const a = proj(cam, x0, y, z0);
  const b = proj(cam, x1, y, z0);
  const c = proj(cam, x1, y, z1);
  const d = proj(cam, x0, y, z1);
  g.beginPath();
  g.moveTo(a[0], a[1]);
  g.lineTo(b[0], b[1]);
  g.lineTo(c[0], c[1]);
  g.lineTo(d[0], d[1]);
  g.closePath();
  return true;
}

/** A vertical quad spanning depth: from (x0, z0) to (x1, z1), between heights y0 and y1, as a screen path. */
export function wallQuad(g: G, cam: Cam, x0: number, z0: number, x1: number, z1: number, y0: number, y1: number): void {
  const a = proj(cam, x0, y0, z0);
  const b = proj(cam, x1, y0, z1);
  const c = proj(cam, x1, y1, z1);
  const d = proj(cam, x0, y1, z0);
  g.beginPath();
  g.moveTo(a[0], a[1]);
  g.lineTo(b[0], b[1]);
  g.lineTo(c[0], c[1]);
  g.lineTo(d[0], d[1]);
  g.closePath();
}

void hash;
void CY;
