import { THUMB_REST, drawGirl, drawLeftHand, drawLeftThumb, drawRightHand, handPhone, posedLag } from './girl.js';
import { fontOf, glow, line, poly, sketchRect } from './ink.js';
import { drawFalling, drawPile } from './letters.js';
import {
  APP,
  CX,
  DEFAULT,
  GOLD,
  H,
  NIGHT,
  PLAYFUL,
  TAU,
  W,
  applyCam,
  bf,
  clamp,
  env,
  hs,
  impact,
  inCubic,
  inOut,
  keyed,
  lerp,
  logZoom,
  outCubic,
  prog,
  rgba,
  smooth,
  springOf,
  toScreen,
} from './kit.js';
import { BACKSPACE, IDLE_VIEW, SEND as SEND_KEY, barRects, drawPhone, keyCenter, nameplate, questionLayout, setBarFrame } from './phone.js';
import {
  BAR_BEATS,
  DELETE_AT,
  DOUBT,
  FAN,
  IMAGE,
  LAMP,
  LANTERN,
  LIFT,
  MORPH,
  NAMES,
  NAME_BEATS,
  PICK,
  QUESTION,
  ROW_BEATS,
  SEARCH,
  SEARCH_OUT,
  SEND,
  SIGN,
  SLAB_BEATS,
  TYPE_AT,
} from './score.js';
import { HALL_ROWS, drawFront, drawHall, drawLobby, drawSeatRow, drawSign, rowBar, signRect, slabQuad } from './sets.js';

import type { Boil } from './ink.js';
import type { Cam, G, Pt } from './kit.js';
import type { Hands, Pose, PoseKey } from './girl.js';
import type { PhoneView } from './phone.js';
import type { FrontState, Rect } from './sets.js';
import type { LookBox, LookContext, TextBox } from '../../../../engine/look/index.js';

type Ctx = LookContext<'2d'>;

export interface ShotArgs {
  g: G;
  ctx: Ctx;
  frame: number;
  time: number;
  seed: number;
  red: string;
}

const INK = NIGHT.ink;

export function boilOf(a: ShotArgs, amp = 1.4, k = 0): Boil {
  return { time: a.time, seed: a.seed + k, amp };
}

/** The night behind the phone: indigo and a pool of the screen's warm light. */
function phoneBackdrop(g: G, time: number): void {
  g.fillStyle = NIGHT.wall;
  g.fillRect(-1400, -1400, W + 2800, H + 3800);
  const grad = g.createRadialGradient(CX, 900, 100, CX, 900, 1400);
  grad.addColorStop(0, rgba(NIGHT.glow, 0.32));
  grad.addColorStop(0.5, rgba(NIGHT.glow, 0.08));
  grad.addColorStop(1, rgba(NIGHT.glow, 0));
  g.fillStyle = grad;
  g.fillRect(-1400, -1400, W + 2800, H + 3800);
  g.fillStyle = rgba(NIGHT.wallDeep, 0.6);
  g.beginPath();
  g.ellipse(CX + 320 + 6 * Math.sin(time * 0.02), -120, 520, 260, 0.2, 0, TAU);
  g.fill();
}

/** The thumb while typing: on each character's key on the frame it appears, hopping between keys. */
function typingThumb(time: number, at: readonly number[], text: string): { tip: Pt; press: number } | null {
  for (let k = 0; k < at.length - 1; k++) {
    const a = at[k] as number;
    const b = at[k + 1] as number;
    if (time >= a && time < b) {
      const u = (time - a) / Math.max(1, b - a);
      const p = keyCenter(text.charAt(k));
      const q = keyCenter(text.charAt(k + 1));
      return { tip: [lerp(p[0], q[0], u), lerp(p[1], q[1], u) - 26 * Math.sin(Math.PI * u)], press: 1 - Math.sin(Math.PI * u) };
    }
  }
  return null;
}

type TipKey = readonly [number, Pt, number];

/** A thumb moving through keyed places and presses. */
function thumbAlong(time: number, keys: readonly TipKey[]): { tip: Pt; press: number } {
  const x = keyed(time, keys.map(([f, p]) => [f, p[0]] as const));
  const y = keyed(time, keys.map(([f, p]) => [f, p[1]] as const));
  const press = keyed(time, keys.map(([f, , pr]) => [f, pr] as const));
  return { tip: [x, y], press };
}

/** The phone and the close-up hands holding it, in the phone's own px. Returns its copy boxes. */
function phoneInHands(a: ShotArgs, view: PhoneView, h: Hands, b: Boil): TextBox[] {
  drawLeftHand(a.g, h, a.time, a.seed, INK);
  const boxes = drawPhone(a.g, a.ctx, view, a.time, INK, a.red, b);
  drawLeftThumb(a.g, h, a.time, a.seed, INK);
  drawRightHand(a.g, h, a.time, a.seed, INK);
  return boxes;
}

// ---------------------------------------------------------------- 1 hook: beats 0-4

/** Where the pile sits below the phone in the close-up's px, and its scale there. */
const HOOK_PILE: Pt = [690, 2150];
const HOOK_PILE_SCALE = 1.75;

/** The floor under her hands, in the close-up's px: boards running away, lit by the screen. */
function hookFloor(g: G, b: Boil): void {
  g.fillStyle = NIGHT.floor;
  g.fillRect(-1400, 1880, W + 2800, 1600);
  const grad = g.createRadialGradient(640, 2100, 40, 640, 2100, 760);
  grad.addColorStop(0, rgba(NIGHT.glow, 0.28));
  grad.addColorStop(1, rgba(NIGHT.glow, 0));
  g.fillStyle = grad;
  g.fillRect(-400, 1880, W + 800, 1000);
  for (let i = -6; i <= 8; i++) {
    line(g, [[540 + i * 150, 1880], [540 + i * 300, 2700]], 3, rgba(NIGHT.rimSoft, 0.6), b);
  }
  // Her knee, out of the light at the left.
  g.fillStyle = rgba('#2f3d6c', 0.85);
  g.beginPath();
  g.ellipse(80, 2120, 300, 170, -0.3, 0, TAU);
  g.fill();
}

/** Beats 0-4: she is already deleting the question; its letters fall off the composer onto the pile. */
export function shotHook(a: ShotArgs): LookBox[] {
  const { g, ctx, frame, time } = a;
  const b = boilOf(a);
  const u = prog(time, 0, bf(3));
  const tilt = inOut(prog(time, bf(3), bf(4)));
  const cam: Cam = {
    z: logZoom(0.84, 0.88, smooth(u)) * logZoom(1, 1.04, tilt),
    cx: 560 + 8 * Math.sin(time * 0.012),
    cy: lerp(1450, 1500, smooth(u)) + 200 * tilt,
    roll: 0.012 * Math.sin(time * 0.015),
  };
  phoneBackdrop(g, time);
  g.save();
  applyCam(g, cam);
  hookFloor(g, b);
  drawPile(g, ctx, time, INK, HOOK_PILE, HOOK_PILE_SCALE);
  const kept = DELETE_AT.filter((f) => f > frame).length;
  // Each pop is a tap of the backspace; then the key is held for the race.
  const pops = DELETE_AT.filter((f) => f <= frame && f > frame - 6 && f <= bf(3.25));
  const tap = pops.length > 0 ? Math.exp(-0.5 * (frame - Math.max(...pops))) : 0;
  const lastPop = Math.max(...DELETE_AT);
  const th = thumbAlong(time, [
    [0, [BACKSPACE[0], BACKSPACE[1] - 6], 0.85],
    [lastPop + 2, [BACKSPACE[0], BACKSPACE[1] - 6], 0.9],
    [lastPop + 12, [800, 1520], 0],
  ]);
  const h: Hands = { tip: [th.tip[0], th.tip[1] + 6 * tap], press: Math.min(1, th.press + 0.15 * tap), tap: clamp(env(time, [bf(1.5), bf(2)], 3)), grip: 0, squash: 0.5 * tap };
  const view: PhoneView = {
    ...IDLE_VIEW,
    typed: kept,
    caret: true,
    keyDown: h.press > 0.8 ? BACKSPACE : null,
    copyId: frame < bf(3) ? 'doubt' : null,
    copyChars: DOUBT.length,
  };
  const boxes = phoneInHands(a, view, h, b);
  drawFalling(g, ctx, questionLayout(g, ctx).glyphs, time, INK, HOOK_PILE, HOOK_PILE_SCALE);
  g.restore();
  return boxes;
}

// ---------------------------------------------------------------- 2 want: beats 4-8

/** The heap in the lobby, beside where she sits, and its scale there. */
export const LOBBY_PILE: Pt = [820, 1700];
export const LOBBY_PILE_SCALE = 1.25;

const SIT: Pose = {
  x: 560,
  y: 1660,
  scale: 1.9,
  facing: -1,
  spine: 0.3,
  neck: 0.42,
  head: 0.32,
  back: 0,
  armN: 0.55,
  elbowN: 0.9,
  armF: 0.7,
  elbowF: 1.2,
  legN: 1.75,
  kneeN: -2.35,
  legF: 1.62,
  kneeF: -2.2,
  brow: -0.7,
  blink: 0,
  smile: -0.5,
  open: 0,
};

const WANT_KEYS: readonly (readonly [number, PoseKey])[] = [
  [bf(4) - 6, { spine: 0.45, neck: 0.55, head: 0.42, brow: -0.95, smile: -0.8 }],
  [bf(4.75), { spine: 0.36 }],
  [bf(5.5) - 6, { spine: 0.02, neck: -0.42, head: -0.55, brow: 0.55, smile: 0, open: 0.45, armN: 0.35, elbowN: 0.55 }],
  [bf(6), { armF: 2.05, elbowF: 0.25, open: 0.1, brow: 0.85 }],
  [bf(6.5), { smile: 0.7, open: 0 }],
  [bf(6.75), { armF: 1.8, elbowF: 0.5 }],
  [bf(7.25), { armN: 0.55, elbowN: 1.45, head: 0.28, neck: 0.32, spine: 0.24, armF: 0.6, elbowF: 1.0, smile: 0.55, brow: 0.45 }],
];

/** Beats 4-8: by the heap, worried; she looks up at the blank board, reaches toward it, smiles, and lifts the phone again. */
export function shotWant(a: ShotArgs): LookBox[] {
  const { g, ctx, time } = a;
  const b = boilOf(a);
  const u = smooth(prog(time, bf(4), bf(8)));
  const cam: Cam = { z: logZoom(1.22, 1.42, u), cx: lerp(470, 400, u), cy: lerp(1300, 1250, u), roll: 0.008 * Math.sin(time * 0.02) };
  g.save();
  applyCam(g, cam);
  drawLobby(g, { night: 1, street: false, dawn: 0, pages: [], pageFace: () => undefined, board: true }, b);
  // The want: a little light finds the blank board as she looks at it.
  glow(g, 252, 1230, 300, NIGHT.moon, 0.16 * smooth(prog(time, bf(5.5), bf(6.5))));
  drawPile(g, ctx, time, INK, LOBBY_PILE, LOBBY_PILE_SCALE);
  const { pose, lag } = posedLag(SIT, WANT_KEYS, time, a.seed);
  let phone: Pt = [400, 1480];
  drawGirl(g, pose, {
    time,
    seed: a.seed,
    ink: INK,
    night: 0.3,
    lag,
    holding: (gg, j) => {
      phone = handPhone(gg, j, true, pose.scale, NIGHT.glow, 1, b, INK);
    },
  });
  glow(g, phone[0], phone[1] - 20, 300, NIGHT.glow, 0.26);
  g.restore();
  return [];
}

// ---------------------------------------------------------------- 3 send: beats 8-12

/** Beats 8-12: she finishes typing it again; her thumb hovers at Send, pulls back, and strikes; it goes up the chat. */
export function shotSend(a: ShotArgs): LookBox[] {
  const { g, frame, time } = a;
  const b = boilOf(a);
  const inhale = bf(11);
  // The inhale: her hands and the phone rise on the breath, the camera leaning in with them.
  const breath = frame >= inhale && frame < SEND ? Math.max(0, springOf(time, inhale - 1, PLAYFUL)) : 0;
  const cam: Cam = {
    z: Math.exp(keyed(time, [[bf(8), Math.log(1.2)], [SEND, Math.log(1.28)], [bf(12), Math.log(1.24)]])) * (1 + 0.03 * breath),
    cx: 540,
    cy: keyed(time, [[bf(8), 1070], [SEND, 1090], [SEND + 14, 760], [bf(12), 700]]),
    roll: -0.025 + 0.008 * Math.sin(time * 0.02),
  };
  phoneBackdrop(g, time);
  g.save();
  applyCam(g, cam);
  // The phone breathes in her hands the whole shot, and lifts on the inhale.
  g.translate(0, 5 * Math.sin(time * 0.1) - 22 * breath);
  const lastTyped = TYPE_AT.at(-1) as number;
  const typing = typingThumb(time, TYPE_AT.slice(37), QUESTION.slice(37));
  // The hover never holds still: it drifts toward Send, trembling more the nearer it gets, backs away on the inhale, winds up and strikes.
  const near = clamp(prog(time, lastTyped + 10, bf(10.25)));
  const shake = time > lastTyped + 6 && time < SEND - 6 ? 2.5 + 4 * near : 0;
  const tremble = [shake * Math.sin(time * 1.3), shake * 0.8 * Math.sin(time * 1.7 + 1)];
  const hover = thumbAlong(time, [
    [lastTyped, keyCenter('?'), 1],
    [lastTyped + 10, [700, 1320], 0],
    [bf(9.25), [770, 1270], 0.05],
    [bf(9.75), [SEND_KEY[0] - 40, SEND_KEY[1] + 50], 0.2],
    [bf(10.25), [SEND_KEY[0] - 12, SEND_KEY[1] + 18], 0.32],
    [bf(10.75), [SEND_KEY[0] - 30, SEND_KEY[1] + 40], 0.22],
    [inhale, [SEND_KEY[0] - 22, SEND_KEY[1] + 30], 0.26],
    [bf(12), [830, 1520], 0],
  ]);
  // On the inhale the thumb snaps back and up, fast at first: the wind-up.
  const back = outCubic(prog(time, inhale, inhale + 9));
  const wound: Pt = [lerp(SEND_KEY[0] - 22, 770, back), lerp(SEND_KEY[1] + 30, 1420, back)];
  const off = inOut(prog(time, SEND + 8, bf(12)));
  const strike =
    time > SEND + 8
      ? { tip: [lerp(SEND_KEY[0], 830, off), lerp(SEND_KEY[1], 1520, off)] as Pt, press: 1 - off }
      : time > SEND - 6
        ? { tip: [lerp(770, SEND_KEY[0], inCubic(prog(time, SEND - 6, SEND))), lerp(1420, SEND_KEY[1], inCubic(prog(time, SEND - 6, SEND)))] as Pt, press: inCubic(prog(time, SEND - 6, SEND)) }
        : time >= inhale
          ? { tip: wound, press: lerp(0.26, 0, back) }
          : hover;
  const th = typing !== null && time < lastTyped ? typing : { tip: [strike.tip[0] + tremble[0]!, strike.tip[1] + tremble[1]!] as Pt, press: strike.press };
  const hit = frame >= SEND ? Math.exp(-0.3 * (time - SEND)) : 0;
  const h: Hands = { tip: th.tip, press: th.press, tap: 0, grip: clamp(env(time, [SEND], 8)), squash: hit };
  const sent = frame >= SEND;
  const view: PhoneView = {
    ...IDLE_VIEW,
    typed: sent ? 0 : TYPE_AT.filter((f) => f <= frame).length,
    caret: sent,
    press: clamp(env(time, [SEND], 4)),
    sent: sent ? springOf(time, SEND - 1, DEFAULT) : -1,
    keyDown: th.press > 0.8 ? th.tip : null,
    copyId: sent ? null : 'question',
    copyChars: QUESTION.length,
    bubbleCopyId: sent ? 'question' : null,
  };
  const boxes = phoneInHands(a, view, h, b);
  if (time >= SEND && time < SEND + 20) {
    const w = (time - SEND) / 20;
    g.strokeStyle = rgba(APP.fg, 0.5 * (1 - w));
    g.lineWidth = 4;
    g.beginPath();
    g.arc(SEND_KEY[0], SEND_KEY[1], 40 + 120 * w, 0, TAU);
    g.stroke();
  }
  g.restore();
  return boxes;
}

// ---------------------------------------------------------------- 4 seats: beats 12-16

/** The phone held up over her shoulder in the hall, and its scale there. */
const HALL_PHONE: Pt = [650, 1340];
const HALL_PHONE_SCALE = 0.16;

const HALL_SIT: Pose = {
  x: 470,
  y: 1840,
  scale: 1.9,
  facing: 1,
  spine: 0.05,
  neck: 0.2,
  head: 0.15,
  back: 1,
  armN: 0.9,
  elbowN: 1.0,
  armF: 0.7,
  elbowF: 1.2,
  legN: 1.6,
  kneeN: -1.6,
  legF: 1.5,
  kneeF: -1.5,
  brow: 0.4,
  blink: 0,
  smile: 0.2,
  open: 0,
};

function hallCam(time: number): Cam {
  const pull = inOut(prog(time, bf(13.75), bf(15.25)));
  const z = logZoom(7.1, 1.05, pull) * logZoom(1, 0.97, prog(time, bf(15.25), bf(16)));
  const cx = lerp(660, 540, pull);
  const cy = lerp(1360, 1170, pull);
  return { z, cx, cy, roll: 0.006 * Math.sin(time * 0.02) };
}

/** Phone px to the hall, for the phone held at `at`. */
function phoneToWorld(p: Pt, at: Pt, scale: number): Pt {
  return [at[0] + (p[0] - 540) * scale, at[1] + (p[1] - 840) * scale];
}

/** Each bar's flight: its own take-off, arc height, turn and easing, so no two move alike. */
const FLIGHTS = [
  { off: 14, arc: 120, turn: 0.5 },
  { off: 18, arc: 210, turn: -0.7 },
  { off: 22, arc: 160, turn: 0.35 },
  { off: 27, arc: 260, turn: -0.45 },
] as const;

/** Beats 12-16: over her shoulder, the answer's code draws a chart; the camera pulls back as its bars fly into the hall and become rows. */
export function shotSeats(a: ShotArgs): LookBox[] {
  const { g, frame, time } = a;
  const b = boilOf(a);
  setBarFrame(bf(12.25));
  const cam = hallCam(time);
  const heights = BAR_BEATS.map((beat) => Math.max(0, springOf(time, bf(beat) - 3, PLAYFUL)));
  const lowered = Math.max(0, springOf(time, bf(15), DEFAULT));
  const at: Pt = [lerp(HALL_PHONE[0], 610, lowered), lerp(HALL_PHONE[1], 1560, lowered)];
  // A bar stays on the screen until it takes off.
  const takeoff = (r: number): number => bf(ROW_BEATS[r] as number) - (FLIGHTS[r] as (typeof FLIGHTS)[number]).off;
  const onScreen = heights.map((hgt, i) => (frame < takeoff(3 - i) ? hgt : 0));
  g.save();
  applyCam(g, cam);
  drawHall(g, b, smooth(prog(time, bf(15), bf(16))));
  for (let r = HALL_ROWS.length - 1; r >= 0; r--) {
    const land = bf(ROW_BEATS[r] as number);
    if (frame >= land) {
      drawSeatRow(g, r, time, land, b);
    }
  }
  const { pose, lag } = posedLag(HALL_SIT, [[bf(15.25) - 5, { back: 0.25, neck: -0.25, head: -0.3, brow: 0.95, smile: 0.85, open: 0.35 }], [bf(15.75), { open: 0, smile: 1 }]], time, a.seed);
  const cuffL = phoneToWorld([70, 1830], at, HALL_PHONE_SCALE);
  const cuffR = phoneToWorld([1010, 1830], at, HALL_PHONE_SCALE);
  glow(g, at[0], at[1], 340, NIGHT.glow, 0.35);
  drawGirl(g, pose, { time, seed: a.seed, ink: INK, night: 0.4, backView: true, lag, noHands: true, reach: { near: cuffR, far: cuffL, bendN: -1, bendF: -1 } });
  g.save();
  g.translate(at[0], at[1]);
  g.scale(HALL_PHONE_SCALE, HALL_PHONE_SCALE);
  g.translate(-540, -840);
  const view: PhoneView = { ...IDLE_VIEW, keyboard: false, sent: 1, answer: springOf(time, bf(12) - 4, DEFAULT), bars: onScreen };
  const h: Hands = { tip: THUMB_REST, press: 0, tap: 0, grip: 0 };
  phoneInHands({ ...a, g }, view, h, b);
  g.restore();
  // The bars in flight, in the hall's space: each leaves its place on the screen and tips over into its row.
  const rects = barRects({ ...IDLE_VIEW, bars: [1, 1, 1, 1] });
  for (let r = 0; r < HALL_ROWS.length; r++) {
    const land = bf(ROW_BEATS[r] as number);
    const t0 = takeoff(r);
    if (frame < t0 || frame >= land) {
      continue;
    }
    const fl = FLIGHTS[r] as (typeof FLIGHTS)[number];
    const bar = rects[3 - r] as Rect;
    const corners: Pt[] = [
      [bar.x, bar.y + bar.h],
      [bar.x, bar.y],
      [bar.x + bar.w, bar.y],
      [bar.x + bar.w, bar.y + bar.h],
    ];
    const s = corners.map((p) => phoneToWorld(p, at, HALL_PHONE_SCALE));
    const row = rowBar(r);
    const e: Pt[] = [
      [row.x, row.y],
      [row.x + row.w, row.y],
      [row.x + row.w, row.y + row.h],
      [row.x, row.y + row.h],
    ];
    const m = r % 2 === 0 ? inOut(prog(time, t0, land)) : outCubic(prog(time, t0, land));
    const lift = fl.arc * Math.sin(Math.PI * m);
    const quad = s.map((p, k) => [lerp(p[0], e[k]![0], m), lerp(p[1], e[k]![1], m) - lift] as Pt);
    const c: Pt = [(quad[0]![0] + quad[2]![0]) / 2, (quad[0]![1] + quad[2]![1]) / 2];
    const turn = fl.turn * Math.sin(Math.PI * m);
    const turned = quad.map(([x, y]) => [c[0] + (x - c[0]) * Math.cos(turn) - (y - c[1]) * Math.sin(turn), c[1] + (x - c[0]) * Math.sin(turn) + (y - c[1]) * Math.cos(turn)] as Pt);
    glow(g, c[0], c[1], 220, GOLD, 0.3);
    poly(g, turned, GOLD, '#3a3028', 4, b);
  }
  g.restore();
  return [];
}

// ---------------------------------------------------------------- 5 search: beats 16-20

const SEARCH_SCROLL = 820;

/** Beats 16-20: the search answer, its model and its row, held as one read; its sources fan and lift off one by one. */
export function shotSearch(a: ShotArgs): LookBox[] {
  const { g, frame, time } = a;
  const b = boilOf(a);
  const u = smooth(prog(time, bf(16), bf(20)));
  const cam: Cam = { z: logZoom(1.26, 1.3, u), cx: 577, cy: lerp(650, 615, u), roll: 0.008 * Math.sin(time * 0.02) };
  phoneBackdrop(g, time);
  g.save();
  applyCam(g, cam);
  const h: Hands = { tip: [THUMB_REST[0] + 10 * Math.sin(time * 0.03), THUMB_REST[1]], press: 0, tap: 0, grip: 0 };
  // Each source launches fast off the fan, the first already rising on the cue's frame.
  const lifts = [0, 7, 3, 11, 5, 9].map((off) => prog(time, LIFT + off - 3, LIFT + off + 15) ** 0.8);
  // The answer scrolls up after its sources, under the header, before the cut.
  // A small dip first, the anticipation, then up and away.
  const p = prog(time, SEARCH_OUT, bf(20) - 2);
  const away = inCubic(p) - 0.05 * Math.sin(Math.PI * clamp(p * 2.5));
  const view: PhoneView = {
    ...IDLE_VIEW,
    keyboard: false,
    sent: 1,
    answer: 1,
    bars: [1, 1, 1, 1],
    search: springOf(time, SEARCH - 4, PLAYFUL),
    fan: Math.max(0, springOf(time, FAN - 3, PLAYFUL)),
    lifts,
    sway: time,
    scroll: SEARCH_SCROLL + 760 * away,
    searchCopy: frame < SEARCH_OUT,
  };
  const boxes = phoneInHands(a, view, h, b);
  g.restore();
  return boxes;
}

// ---------------------------------------------------------------- 6 street: beats 20-24

const STAND: Pose = {
  x: 600,
  y: 1236,
  scale: 1.15,
  facing: 1,
  spine: 0.05,
  neck: 0.1,
  head: -0.05,
  back: 0,
  armN: 0.6,
  elbowN: 1.5,
  armF: 0.15,
  elbowF: 0.3,
  legN: 0.04,
  kneeN: -0.04,
  legF: -0.06,
  kneeF: 0.02,
  brow: 0.5,
  blink: 0,
  smile: 0.3,
  open: 0,
};

/** Her inside the glass, lit by her phone. */
function insideFigure(a: ShotArgs, base: Pose, keys: readonly (readonly [number, PoseKey])[]): (g: G) => void {
  return (g) => {
    g.fillStyle = '#0d1026';
    g.fillRect(280, 840, 520, 640);
    const b = boilOf(a, 1.1, 5);
    const { pose, lag } = posedLag(base, keys, a.time, a.seed);
    const j = drawGirl(g, pose, { time: a.time, seed: a.seed, ink: INK, night: 0.4, lag, holding: (gg, jj) => void handPhone(gg, jj, true, pose.scale, NIGHT.glow, 1, b, INK) });
    glow(g, j.wristN[0], j.wristN[1] - 30, 300, NIGHT.glow, 0.5);
  };
}

function frontBase(a: ShotArgs, inside: (g: G) => void): FrontState {
  return { night: 1, slabs: [1, 1, 1, 1, 1, 1], lamp: 1, lampLit: 1, sign: 0, bulbs: 0, name: 0, nameLit: 0, paper: 0, open: 0, inside, ctx: a.ctx };
}

/** Each source's fall: its start across the top, its spin, its sway and its fall time. */
const FALLS = [
  { x: 120, y: -260, spin: 1.4, sway: 60, frames: 22 },
  { x: 760, y: -180, spin: -1.1, sway: -40, frames: 18 },
  { x: 380, y: -320, spin: 0.8, sway: 90, frames: 26 },
  { x: 940, y: -240, spin: -1.7, sway: -70, frames: 20 },
  { x: 220, y: -150, spin: -0.6, sway: 50, frames: 17 },
  { x: 600, y: -300, spin: 1.2, sway: -80, frames: 24 },
] as const;

/** Beats 20-24: the sources fall on their own paths and slap down as the street; the lamp springs up; she looks out. */
export function shotStreet(a: ShotArgs): LookBox[] {
  const { g, frame, time } = a;
  const b = boilOf(a);
  const start = bf(20);
  const cam: Cam = {
    z: Math.exp(keyed(time, [[start, Math.log(1.45)], [bf(22.25), Math.log(1.0)], [bf(24), Math.log(1.16)]], outCubic)),
    cx: keyed(time, [[start, 600], [bf(22.25), 540]], outCubic),
    cy: keyed(time, [[start, 1470], [bf(22.25), 1010], [bf(24), 930]], outCubic),
    roll: 0.006 * Math.sin(time * 0.02),
  };
  const slabs = SLAB_BEATS.map((beat) => (frame >= bf(beat) ? 1 : 0));
  const slabAge = SLAB_BEATS.map((beat) => time - bf(beat));
  const state: FrontState = {
    ...frontBase(a, insideFigure(a, STAND, [[bf(21), { head: -0.25, neck: -0.1, open: 0.3, brow: 0.8 }], [LAMP - 2, { smile: 0.9, open: 0, head: -0.1 }], ...LOOK_AT_CARD])),
    slabs,
    slabAge,
    lamp: frame >= LAMP - 3 ? Math.max(0, springOf(time, LAMP - 3, PLAYFUL)) : 0,
    lampLit: smooth(prog(time, LAMP + 4, LAMP + 14)),
  };
  g.save();
  applyCam(g, cam);
  drawFront(g, state, b);
  SLAB_BEATS.forEach((beat, i) => {
    const t = time - bf(beat);
    if (t >= 0 && t < 14) {
      const q = slabQuad(i);
      const cx = (q[0]![0] + q[2]![0]) / 2;
      const cy = (q[0]![1] + q[2]![1]) / 2;
      for (let k = 0; k < 6; k++) {
        const ang = (k / 6) * Math.PI + Math.PI + hs(i * 7 + k, 3) * 0.2;
        const r0 = 60 + t * 6;
        line(g, [[cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0 * 0.35], [cx + Math.cos(ang) * (r0 + 22), cy + Math.sin(ang) * (r0 + 22) * 0.35]], 3, rgba(NIGHT.rim, 1 - t / 14), null);
      }
    }
  });
  g.restore();
  // The sources falling into place, on the frame, each on its own path.
  SLAB_BEATS.forEach((beat, i) => {
    const land = bf(beat);
    const fl = FALLS[i] as (typeof FALLS)[number];
    if (frame >= land || time < land - fl.frames) {
      return;
    }
    const m = inCubic(prog(time, land - fl.frames, land));
    const q = slabQuad(i).map((p) => toScreen(cam, p));
    const w = 250;
    const h = 165;
    const start: Pt[] = [[fl.x, fl.y], [fl.x + w, fl.y], [fl.x + w, fl.y + h], [fl.x, fl.y + h]];
    const flat = start.map((p, k) => [lerp(p[0], q[k]![0], m) + fl.sway * Math.sin(Math.PI * m), lerp(p[1], q[k]![1], m)] as Pt);
    const c0: Pt = [(flat[0]![0] + flat[2]![0]) / 2, (flat[0]![1] + flat[2]![1]) / 2];
    // Stretched along its fall as it speeds up, so the slap that follows reads as a squash.
    const st = 0.4 * m * m;
    const quad = flat.map(([x, y]) => [c0[0] + (x - c0[0]) * (1 - 0.25 * st), c0[1] + (y - c0[1]) * (1 + st)] as Pt);
    const c: Pt = [(quad[0]![0] + quad[2]![0]) / 2, (quad[0]![1] + quad[2]![1]) / 2];
    const spin = fl.spin * (1 - m);
    const turned = quad.map(([x, y]) => [c[0] + (x - c[0]) * Math.cos(spin) - (y - c[1]) * Math.sin(spin), c[1] + (x - c[0]) * Math.sin(spin) + (y - c[1]) * Math.cos(spin)] as Pt);
    poly(g, turned, '#f4ecd9', '#3a3028', 4, b);
    const dot: Pt = [lerp(turned[0]![0], turned[2]![0], 0.18), lerp(turned[0]![1], turned[2]![1], 0.25)];
    g.fillStyle = ['#6aa7d8', '#7bbf86', '#e0a14a', '#9a86d6', '#58b3b0', '#d68a6a'][i] as string;
    g.beginPath();
    g.arc(dot[0], dot[1], 12 * (1 - 0.5 * m), 0, TAU);
    g.fill();
  });
  // The image answer rises out of her phone, through the glass, and starts to sketch; it is held across the cut.
  if (frame >= IMAGE - 3) {
    g.save();
    applyCam(g, cam);
    imageCard(g, a.ctx, cardRect(time), cardTilt(time), sketchOf(time), clamp((time - IMAGE + 3) / 4), b);
    g.restore();
  }
  return [];
}

// ---------------------------------------------------------------- 7 sign: beats 24-29

const NAME_CARDS = [
  { name: 'Night Owl', model: 'Claude Sonnet 5.5' },
  { name: 'Lantern', model: 'Mistral Large 3' },
  { name: 'Little Light', model: 'Llama 4 Maverick' },
  { name: 'The Moth', model: 'Qwen3.8 27B' },
] as const;
const PICKED = 1;

/** The names stack over the left door, clear of her face behind the right one. */
function nameCard(i: number): Rect {
  return { x: 96, y: 900 + i * 94, w: 420, h: 84 };
}

/** The marquee sketch the image answer draws, as polylines in a unit box. */
const SKETCH: readonly (readonly Pt[])[] = [
  [[0.08, 0.3], [0.92, 0.3], [0.92, 0.62], [0.08, 0.62], [0.08, 0.3]],
  [[0.16, 0.38], [0.84, 0.38], [0.84, 0.54], [0.16, 0.54], [0.16, 0.38]],
  [[0.2, 0.62], [0.2, 0.95]],
  [[0.8, 0.62], [0.8, 0.95]],
  [[0.36, 0.95], [0.36, 0.72], [0.64, 0.72], [0.64, 0.95]],
  [[0.5, 0.72], [0.5, 0.95]],
  [[0.08, 0.3], [0.5, 0.12], [0.92, 0.3]],
];

function drawSketch(g: G, r: Rect, p: number, b: Boil): void {
  const total = SKETCH.length;
  SKETCH.forEach((stroke, i) => {
    const k = clamp(p * total - i);
    if (k <= 0) {
      return;
    }
    const n = stroke.length - 1;
    const reach = n * k;
    const pts: Pt[] = [];
    for (let s = 0; s <= Math.ceil(reach) && s <= n; s++) {
      const u = Math.min(1, reach - s + 1);
      const a0 = stroke[Math.max(0, s - 1)] as Pt;
      const a1 = stroke[s] as Pt;
      const q: Pt = s === 0 ? a1 : [lerp(a0[0], a1[0], Math.min(1, u)), lerp(a0[1], a1[1], Math.min(1, u))];
      pts.push([r.x + q[0] * r.w, r.y + q[1] * r.h]);
    }
    // Points close either side of each corner, so the smoothed stroke keeps its corners square.
    const sharp = pts.flatMap((p, k): Pt[] => {
      const next = pts[k + 1];
      return next === undefined ? [p] : [p, [lerp(p[0], next[0], 0.06), lerp(p[1], next[1], 0.06)], [lerp(p[0], next[0], 0.94), lerp(p[1], next[1], 0.94)]];
    });
    line(g, sharp, 4, '#b8892f', b);
  });
  if (p > 0.6) {
    for (let k = 0; k < 10; k++) {
      g.fillStyle = rgba('#b8892f', clamp((p - 0.6) * 4));
      g.beginPath();
      g.arc(r.x + (0.1 + 0.08 * k) * r.w, r.y + 0.3 * r.h, 4, 0, TAU);
      g.fill();
    }
  }
}

/** She looks up after the image answer as it rises out of her phone. */
const LOOK_AT_CARD: readonly (readonly [number, PoseKey])[] = [[IMAGE + 2, { head: -0.42, neck: -0.2, open: 0.4, brow: 0.9, smile: 0.5 }]];

/** Where the image answer hovers over the doors, in the front's px, and where it rises from: her phone. */
const CARD_REST: Rect = { x: 350, y: 600, w: 380, h: 310 };
const CARD_FROM: Pt = [640, 1060];

/** The image answer's place: up out of her phone on an arc with an overshoot, then bobbing where it hovers. */
function cardRect(time: number): Rect {
  const grow = Math.max(0, springOf(time, IMAGE - 3, DEFAULT));
  const bob = 7 * Math.sin((time - IMAGE) * 0.08) * clamp(grow);
  const w = lerp(40, CARD_REST.w, grow);
  const h = lerp(34, CARD_REST.h, grow);
  const cx = lerp(CARD_FROM[0], CARD_REST.x + CARD_REST.w / 2, grow) - 70 * Math.sin(Math.PI * clamp(grow));
  const cy = lerp(CARD_FROM[1], CARD_REST.y + CARD_REST.h / 2, grow) + bob;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

function cardTilt(time: number): number {
  return 0.025 * Math.sin((time - IMAGE) * 0.05) + 0.2 * (1 - clamp(springOf(time, IMAGE - 3, DEFAULT)));
}

function sketchOf(time: number): number {
  return prog(time, IMAGE + 10, MORPH - 10);
}

/** The image answer: a paper card with its model's nameplate and the marquee sketch drawing itself. */
function imageCard(g: G, ctx: Ctx, r: Rect, tilt: number, sketch: number, alpha: number, b: Boil): void {
  if (alpha <= 0 || r.w < 2) {
    return;
  }
  const k = r.w / CARD_REST.w;
  g.save();
  g.globalAlpha = alpha;
  g.translate(r.x + r.w / 2, r.y + r.h / 2);
  g.rotate(tilt);
  g.translate(-(r.x + r.w / 2), -(r.y + r.h / 2));
  glow(g, r.x + r.w / 2, r.y + r.h / 2, 320 * k, NIGHT.glow, 0.3);
  sketchRect(g, r.x, r.y, r.w, r.h, '#f4ecd9', '#3a3028', 4, b);
  g.font = fontOf(ctx, 'sans', 600, 38 * k);
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  g.fillStyle = '#4a3f34';
  g.fillText('Seedream 5.0', r.x + 22 * k, r.y + 50 * k);
  drawSketch(g, { x: r.x + 18 * k, y: r.y + 66 * k, w: r.w - 36 * k, h: r.h - 80 * k }, sketch, b);
  g.restore();
}

/** Beats 24-29: the image answer, held, morphs into the marquee, which lands; a beat later four names rise one by one; she picks; LANTERN lights. */
export function shotSign(a: ShotArgs): LookBox[] {
  const { g, ctx, frame, time } = a;
  const b = boilOf(a);
  const cam: Cam = {
    z: Math.exp(keyed(time, [[bf(24), Math.log(1.4)], [MORPH, Math.log(1.45)], [SIGN + 6, Math.log(1.12)], [NAMES, Math.log(1.06)], [PICK, Math.log(1.1)], [bf(29), Math.log(1.17)]])),
    cx: 540,
    cy: keyed(time, [[bf(24), 760], [MORPH, 750], [SIGN + 6, 820], [NAMES, 900], [PICK, 880], [bf(29), 830]]),
    roll: 0.006 * Math.sin(time * 0.02),
  };
  const insideKeys: (readonly [number, PoseKey])[] = [
    ...LOOK_AT_CARD,
    [MORPH, { head: -0.62, neck: -0.32, open: 0.25 }],
    [NAMES - 6, { head: 0.15, neck: 0.1, open: 0, brow: 0.7 }],
    [PICK - 5, { elbowN: 1.8, head: 0.35 }],
    [PICK + 4, { elbowN: 1.5, head: 0.1, brow: 0.9, smile: 0.8 }],
    [LANTERN - 2, { neck: -0.3, head: -0.5, open: 0.5 }],
    [LANTERN + 14, { open: 0, smile: 1 }],
  ];
  const landed = frame >= SIGN;
  const age = time - SIGN;
  const state: FrontState = {
    ...frontBase(a, insideFigure(a, STAND, insideKeys)),
    sign: landed ? 1 : 0,
    signDrop: landed ? -18 * Math.exp(-0.14 * age) * Math.sin(0.45 * age) : 0,
    signSquash: landed ? impact(age) : 0,
    bulbs: smooth(prog(time, SIGN + 3, SIGN + 21)),
    name: frame >= LANTERN - 2 ? 1 : 0,
    nameLit: prog(time, LANTERN - 2, LANTERN + 10),
    nameAge: time - (LANTERN - 2),
  };
  g.save();
  applyCam(g, cam);
  drawFront(g, state, b);
  const sr = signRect();
  if (frame < MORPH) {
    // The wind-up: the card crouches, squashing down, and is fully crouched on the morph's frame.
    const crouch = smooth(prog(time, MORPH - 8, MORPH));
    const r = cardRect(time);
    const cr: Rect = { x: r.x - 0.06 * r.w * crouch, y: r.y + 0.16 * r.h * crouch + 10 * crouch, w: r.w * (1 + 0.12 * crouch), h: r.h * (1 - 0.16 * crouch) };
    imageCard(g, ctx, cr, cardTilt(time), sketchOf(time), 1, b);
  } else if (frame < SIGN) {
    // The morph: released from its crouch, the card stretches as it rises and widens into the marquee, its paper darkening into the sign's.
    const p = prog(time, MORPH, SIGN);
    const m = p * (0.6 + 0.4 * p);
    const from = cardRect(MORPH);
    const r: Rect = { x: lerp(from.x, sr.x, m), y: lerp(from.y, sr.y, m), w: lerp(from.w, sr.w, m), h: lerp(from.h, sr.h, m) };
    const st = Math.sin(Math.PI * m);
    g.save();
    g.translate(r.x + r.w / 2, r.y + r.h / 2);
    g.scale(1 - 0.12 * st, 1 + 0.28 * st);
    g.translate(-(r.x + r.w / 2), -(r.y + r.h / 2));
    g.save();
    g.translate(r.x, r.y);
    g.scale(r.w / sr.w, r.h / sr.h);
    g.translate(-sr.x, -sr.y);
    drawSign(g, { ...state, sign: 0.5 * smooth(prog(time, MORPH + 1, SIGN - 2)), bulbs: 0, name: 0, signDrop: 0, signSquash: 0 }, b);
    g.restore();
    imageCard(g, ctx, r, cardTilt(MORPH) * (1 - m), 1, 1 - smooth(prog(time, MORPH + 3, SIGN - 3)), b);
    g.restore();
  }
  // The names: four answers to one message, each rising on its own beat and settling with an overshoot,
  // drawn bottom first so a card overshooting upward slides under the one above it.
  [...NAME_CARDS.entries()].reverse().forEach(([i, item]) => {
    const start = bf(NAME_BEATS[i] as number) - 3;
    if (time < start || frame >= LANTERN) {
      return;
    }
    const chosen = i === PICKED;
    const k = springOf(time, start, DEFAULT);
    const drop = chosen ? 0 : inCubic(prog(time, PICK + 1 + i, PICK + 12 + i));
    if (drop >= 1) {
      return;
    }
    let r = nameCard(i);
    // Landed, each card keeps bobbing on its own phase until the pick.
    const bob = 4 * Math.sin(time * 0.09 + i * 1.7) * clamp(k);
    r = { ...r, y: r.y + (1 - k) * 130 + drop * 280 + bob };
    let rot = (1 - k) * (i % 2 === 0 ? -0.22 : 0.18) + drop * (i % 2 === 0 ? 0.3 : -0.3);
    let alpha = clamp((time - start) / 4) * (1 - drop);
    let stretch = 0;
    if (chosen && frame >= PICK + 9) {
      const fly = inOut(prog(time, PICK + 9, LANTERN));
      const inner: Rect = { x: sr.x + 34, y: sr.y + 34, w: sr.w - 68, h: sr.h - 68 };
      r = { x: lerp(r.x, inner.x, fly), y: lerp(r.y, inner.y, fly), w: lerp(r.w, inner.w, fly), h: lerp(r.h, inner.h, fly) };
      stretch = Math.sin(Math.PI * fly);
      rot = 0;
      alpha *= 1 - smooth(prog(time, LANTERN - 5, LANTERN));
    }
    const sc = chosen && frame >= PICK ? 1 + 0.08 * Math.exp(-0.2 * (time - PICK)) : 1;
    g.save();
    g.globalAlpha = alpha;
    g.translate(r.x + r.w / 2, r.y + r.h / 2);
    g.rotate(rot);
    g.scale(sc * (1 - 0.15 * stretch), sc * (1 + 0.35 * stretch));
    g.translate(-(r.x + r.w / 2), -(r.y + r.h / 2));
    g.fillStyle = APP.paper;
    g.strokeStyle = chosen && frame >= PICK ? GOLD : rgba(APP.muted, 0.4);
    g.lineWidth = chosen && frame >= PICK ? 5 : 2;
    g.beginPath();
    g.roundRect(r.x, r.y, r.w, r.h, 16);
    g.fill();
    g.stroke();
    if (!(chosen && frame >= PICK + 9)) {
      nameplate(g, ctx, item.model, r.x + 20, r.y + 28, 21);
      g.font = fontOf(ctx, 'serif', 700, 38);
      g.fillStyle = APP.fg;
      g.textAlign = 'left';
      g.textBaseline = 'alphabetic';
      g.fillText(item.name, r.x + 20, r.y + 70);
    }
    if (chosen && frame >= PICK) {
      glow(g, r.x + r.w / 2, r.y + r.h / 2, 240, GOLD, 0.35 * Math.exp(-0.08 * (time - PICK)));
    }
    g.restore();
  });
  // Her tap on the pick: a ring round the chosen name.
  if (time >= PICK && time < PICK + 16) {
    const w = (time - PICK) / 16;
    const r = nameCard(PICKED);
    g.strokeStyle = rgba(GOLD, 0.8 * (1 - w));
    g.lineWidth = 5;
    g.beginPath();
    g.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2 + 30 * w, r.h / 2 + 30 * w, 0, 0, TAU);
    g.stroke();
  }
  // LANTERN lights with a burst of gold.
  if (time >= LANTERN) {
    glow(g, sr.x + sr.w / 2, sr.y + sr.h / 2, 520, GOLD, 0.55 * Math.exp(-0.12 * (time - LANTERN)));
  }
  g.restore();
  void H;
  void QUESTION;
  return [];
}
