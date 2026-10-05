import { FLOOR_Y, Z_FACADE, Z_ROWS, Z_SCREEN, groundQuad, onLayer, onScreen, proj, scaleAt, visible, wallQuad } from './camera.js';
import { CX, DEFAULT, FPB, H, HEAVY, INK, PLAYFUL, SNAPPY, TAU, W, bf, clamp, hash, keyed, lerp, mix, prog, rgba, roundRect, smooth, spring } from './kit.js';
import { BEAT } from './score.js';

import type { Cam } from './camera.js';
import type { Box, G } from './kit.js';

// ---------------------------------------------------------------- geometry (facade units, z = 1000)

export const BUILDING = { x0: 110, x1: 970, top: 250 };
export const SIGN: Box = { x: 160, y: 318, w: 760, h: 272 };
export const NAME_PANEL: Box = { x: 214, y: 374, w: 652, h: 160 };
export const BOARD: Box = { x: 236, y: 618, w: 608, h: 134 };
export const OPENING = { x0: 260, x1: 820, y0: 790, y1: FLOOR_Y };
const RAIL_TOP = 818;
const RAIL_BOTTOM = 1438;
export const GLASS_L: Box = { x: 270, y: RAIL_TOP, w: 267, h: RAIL_BOTTOM - RAIL_TOP };
export const GLASS_R: Box = { x: 543, y: RAIL_TOP, w: 267, h: RAIL_BOTTOM - RAIL_TOP };
/** The screen on the back wall of the hall (z = Z_SCREEN). */
export const SCREEN: Box = { x: 340, y: 1070, w: 400, h: 225 };
/** Seats per row, nearest row first. */
export const ROW_SEATS = [14, 13, 12, 11] as const;
export const SEAT_PITCH = 36;
export const SEAT_H = 98;

/** A row's box on its own layer: centred, standing on the floor. */
export function rowBox(r: number): Box {
  const n = ROW_SEATS[r] ?? 10;
  const w = n * SEAT_PITCH;
  return { x: CX - w / 2, y: FLOOR_Y - SEAT_H, w, h: SEAT_H };
}

/** The twelve sidewalk slabs the search lays: six across, two deep, nearest row last. */
export function slab(i: number): { x0: number; x1: number; z0: number; z1: number } {
  const col = i % 6;
  const row = Math.floor(i / 6);
  return { x0: 110 + col * 143.3, x1: 110 + (col + 1) * 143.3, z0: 1000 - row * 95, z1: 1000 - (row + 1) * 95 };
}
/** The order the slabs land in, four to a half beat, from the doors outward. */
export const SLAB_ORDER = [2, 3, 8, 9, 1, 4, 7, 10, 0, 5, 6, 11] as const;
export const CHIP_HUES = ['#5b7fd6', '#3fa38a', '#c58b2f', '#7a63c9', '#2f8fb8', '#8a9a3c', '#b0679a', '#4a6fa5', '#c07a4a', '#5aa36a', '#6b6fd0', '#a58a3f'] as const;

// ---------------------------------------------------------------- light over time

/** 1 through the night, falling to 0 as dawn rises. */
export function nightness(time: number): number {
  return 1 - smooth(prog(time, bf(BEAT.dawn), bf(BEAT.dawn + 5)));
}

/** The sky, top to horizon, by time. */
function skyColors(time: number): [string, string, string] {
  const top = keyed(time, [
    [bf(30), '#0c1230'],
    [bf(34), '#070b1f'],
    [bf(BEAT.dawn), '#0a1030'],
    [bf(BEAT.dawn + 3), '#5d6fb4'],
    [bf(48), '#8fb2e2'],
  ]);
  const mid = keyed(time, [
    [bf(30), '#1b1d48'],
    [bf(34), '#12143a'],
    [bf(BEAT.dawn), '#1a1b46'],
    [bf(BEAT.dawn + 3), '#c99ab8'],
    [bf(48), '#f0c9b4'],
  ]);
  const low = keyed(time, [
    [bf(30), '#30285a'],
    [bf(34), '#221d4c'],
    [bf(BEAT.dawn), '#2b2556'],
    [bf(BEAT.dawn + 3), '#f2a982'],
    [bf(48), '#f8dcb0'],
  ]);
  return [top, mid, low];
}

export function drawSky(g: G, cam: Cam, time: number): void {
  onScreen(g, null);
  const [top, mid, low] = skyColors(time);
  // The horizon sits on the camera's eye line.
  const horizon = proj(cam, 0, 960, 8000)[1];
  const grad = g.createLinearGradient(0, horizon - 1500, 0, horizon + 200);
  grad.addColorStop(0, top);
  grad.addColorStop(0.6, mid);
  grad.addColorStop(1, low);
  g.fillStyle = grad;
  g.fillRect(-50, -50, W + 100, H + 100);
  const night = nightness(time);
  // The sun, rising behind the right-hand roofs at dawn.
  const sunUp = smooth(prog(time, bf(BEAT.dawn), bf(52)));
  if (sunUp > 0) {
    const [sx, sy] = proj(cam, 1150, 700 - 380 * sunUp, 6000);
    const glow = g.createRadialGradient(sx, sy, 0, sx, sy, 900);
    glow.addColorStop(0, rgba('#fff2cf', 0.75 * sunUp));
    glow.addColorStop(0.25, rgba('#ffd7a0', 0.35 * sunUp));
    glow.addColorStop(1, rgba('#ffd7a0', 0));
    g.fillStyle = glow;
    g.fillRect(-50, -50, W + 100, H + 100);
  }
  // Stars, twinkling apart, smaller as the sky brightens.
  for (let i = 0; i < 90; i++) {
    const [x, y] = proj(cam, hash(i, 1) * 3000 - 960, hash(i, 2) * 1700 - 900, 5000);
    const tw = 0.55 + 0.45 * Math.sin(time * (0.05 + 0.08 * hash(i, 3)) + hash(i, 4) * TAU);
    const r = (0.8 + 1.6 * hash(i, 5)) * night * (0.6 + 0.4 * tw);
    if (r > 0.15) {
      g.fillStyle = rgba('#fdf6e4', 0.5 + 0.5 * tw);
      g.beginPath();
      g.arc(x, y, r, 0, TAU);
      g.fill();
    }
  }
  // The moon, a crescent that sinks as dawn comes.
  const [mx, my] = proj(cam, -120, -40 + 260 * (1 - night), 5000);
  const mr = 34;
  g.fillStyle = mix('#f4ecd6', '#f7e8e0', 1 - night);
  g.beginPath();
  g.arc(mx, my, mr, 0, TAU);
  g.fill();
  g.fillStyle = top;
  g.beginPath();
  g.arc(mx + 14, my - 8, mr * 0.9, 0, TAU);
  g.fill();
}

// ---------------------------------------------------------------- the street

/** The ground before anything is laid, and the street the search lays, slab by slab. */
export function drawStreet(g: G, cam: Cam, time: number, slabLanded: (i: number) => number): void {
  // Once the camera is through the doors the street is behind it.
  if (cam.Z + 20 >= Z_FACADE) {
    return;
  }
  onScreen(g, cam);
  const night = nightness(time);
  // Bare ground, far to near.
  const bare = mix('#0f0e18', '#8c7f78', 1 - night);
  g.fillStyle = bare;
  groundQuad(g, cam, -2400, 3400, Z_FACADE, Math.max(cam.Z + 20, 200));
  g.fill();
  // The road rolls out from the left on its beat, its dashes behind it.
  const roll = spring(time, bf(BEAT.road) - 6, DEFAULT);
  if (roll > 0) {
    const reach = lerp(-2400, 3400, clamp(roll));
    const z1 = Math.max(cam.Z + 20, 420);
    if (z1 < 790) {
      g.fillStyle = mix(INK.asphalt, '#6d6a78', 1 - night);
      groundQuad(g, cam, -2400, reach, 790, z1);
      g.fill();
      g.fillStyle = mix('#e9e1c8', '#f8f1dc', 1 - night);
      for (let i = -12; i < 22; i++) {
        const x0 = i * 180;
        if (x0 + 90 > reach) {
          break;
        }
        groundQuad(g, cam, x0, Math.min(x0 + 90, reach), 612, 600);
        g.fill();
      }
      // The curb.
      g.fillStyle = mix('#2a2838', '#a39890', 1 - night);
      groundQuad(g, cam, -2400, reach, 810, 790);
      g.fill();
    }
  }
  // The slabs: each lands from its source chip and settles with a squash.
  for (let i = 0; i < 12; i++) {
    const landed = slabLanded(i);
    if (landed < 0) {
      continue;
    }
    const s = slab(i);
    if (s.z1 <= cam.Z + 20) {
      continue;
    }
    const settle = 1 - 0.25 * (1 - clamp(spring(time, landed, SNAPPY)));
    const midX = (s.x0 + s.x1) / 2;
    const hw = ((s.x1 - s.x0) / 2 - 4) * settle;
    const hue = CHIP_HUES[i] ?? '#666666';
    const base = mix(mix(INK.paving, hue, 0.35), mix(INK.pavingDay, hue, 0.2), 1 - night);
    g.fillStyle = base;
    groundQuad(g, cam, midX - hw, midX + hw, s.z0 - 3, s.z1 + 3);
    g.fill();
    // A lighter lip on the far edge of each slab.
    g.fillStyle = mix(base, '#ffffff', 0.18);
    groundQuad(g, cam, midX - hw, midX + hw, s.z0 - 3, s.z0 - 9);
    g.fill();
  }
}

// ---------------------------------------------------------------- the neighbours and the facade

function neighbourWindows(g: G, time: number, x0: number, x1: number, top: number, seed: number): void {
  const night = nightness(time);
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 6; col++) {
      const x = x0 + 50 + col * 130;
      const y = top + 60 + row * 140;
      if (x + 60 > x1 || y + 90 > FLOOR_Y - 120) {
        continue;
      }
      const id = row * 6 + col + seed;
      const on = hash(id, 9) < 0.42;
      // The lit windows go dark one by one through dawn, each on a beat.
      const off = bf(BEAT.dawn) + Math.floor(hash(id, 10) * 8) * FPB;
      const lit = on && time < off;
      g.fillStyle = lit ? mix('#ffcf7a', '#ffe1a8', hash(id, 11)) : mix('#1a1a2c', '#9fb2c8', 1 - night);
      roundRect(g, x, y, 60, 90, 4);
      g.fill();
    }
  }
}

export function drawNeighbours(g: G, cam: Cam, time: number): void {
  if (!visible(cam, Z_FACADE)) {
    return;
  }
  onLayer(g, cam, Z_FACADE);
  const night = nightness(time);
  g.fillStyle = mix('#151427', '#8e7f8c', 1 - night);
  g.fillRect(-1400, 430, 1510, 1100);
  g.fillStyle = mix('#19172c', '#a7909a', 1 - night);
  g.fillRect(970, 372, 1500, 1160);
  neighbourWindows(g, time, -1400, 110, 430, 0);
  neighbourWindows(g, time, 970, 2400, 372, 100);
}

/** The facade's stone at a frame instant: the image the model draws is painted on the same stone. */
export function INK_WALL(time: number): string {
  return mix(INK.wall, INK.wallDay, 1 - nightness(time));
}

/** The wall of her building, with the door opening cut out of it. */
export function drawFacade(g: G, cam: Cam, time: number): void {
  if (!visible(cam, Z_FACADE)) {
    return;
  }
  onLayer(g, cam, Z_FACADE);
  const night = nightness(time);
  const wall = INK_WALL(time);
  const trim = mix(INK.trim, INK.trimDay, 1 - night);
  g.beginPath();
  g.rect(BUILDING.x0, BUILDING.top, BUILDING.x1 - BUILDING.x0, FLOOR_Y - BUILDING.top);
  g.rect(OPENING.x0, OPENING.y0, OPENING.x1 - OPENING.x0, OPENING.y1 - OPENING.y0);
  g.fillStyle = wall;
  g.fill('evenodd');
  // Courses of the stone.
  g.fillStyle = rgba('#000000', 0.07);
  for (let y = BUILDING.top + 70; y < FLOOR_Y; y += 64) {
    g.fillRect(BUILDING.x0, y, OPENING.x0 - BUILDING.x0, 3);
    g.fillRect(OPENING.x1, y, BUILDING.x1 - OPENING.x1, 3);
    if (y < OPENING.y0) {
      g.fillRect(OPENING.x0, y, OPENING.x1 - OPENING.x0, 3);
    }
  }
  // Cornice, pilasters and the door surround.
  g.fillStyle = trim;
  g.fillRect(BUILDING.x0 - 18, BUILDING.top - 10, BUILDING.x1 - BUILDING.x0 + 36, 44);
  g.fillRect(BUILDING.x0, BUILDING.top, 34, FLOOR_Y - BUILDING.top);
  g.fillRect(BUILDING.x1 - 34, BUILDING.top, 34, FLOOR_Y - BUILDING.top);
  g.beginPath();
  g.rect(OPENING.x0 - 22, OPENING.y0 - 22, OPENING.x1 - OPENING.x0 + 44, OPENING.y1 - OPENING.y0 + 22);
  g.rect(OPENING.x0, OPENING.y0, OPENING.x1 - OPENING.x0, OPENING.y1 - OPENING.y0);
  g.fill('evenodd');
  // The step.
  g.fillStyle = mix('#211c2a', '#8f7f72', 1 - night);
  g.fillRect(OPENING.x0 - 40, FLOOR_Y - 6, OPENING.x1 - OPENING.x0 + 80, 12);
}

// ---------------------------------------------------------------- the sign and the board

/** Where each bulb of the marquee sits, round its border, in facade units. */
function bulbs(): [number, number][] {
  const out: [number, number][] = [];
  const { x, y, w, h } = SIGN;
  const inset = 22;
  const step = 38;
  for (let px = x + inset; px <= x + w - inset; px += step) {
    out.push([px, y + inset + 18]);
  }
  for (let py = y + inset + 18 + step; py <= y + h - inset; py += step) {
    out.push([x + w - inset, py]);
  }
  for (let px = x + w - inset; px >= x + inset; px -= step) {
    out.push([px, y + h - inset]);
  }
  for (let py = y + h - inset - step; py > y + inset + 18; py -= step) {
    out.push([x + inset, py]);
  }
  return out;
}
const BULBS = bulbs();

export interface SignState {
  /** 0 to 1: how many bulbs are lit, chasing round from the top left. */
  bulbs: number;
  /** The beat the chase steps on, so a lit bulb pulses with the music. */
  chase: number;
  /** The name's glow: 0 dark, 1 lit. */
  name: number;
  /** Day: 0 at night, 1 in the morning. */
  day: number;
}

/**
 * The marquee and the letter board, drawn in facade units: the art the image
 * model draws and the sign that lands on the building are this one drawing.
 */
export function drawSignArt(g: G, state: SignState): void {
  const { x, y, w, h } = SIGN;
  // The crest above the panel.
  g.fillStyle = mix('#3c2f52', '#6b5a7e', state.day);
  g.beginPath();
  g.moveTo(x + w / 2 - 150, y + 6);
  g.lineTo(x + w / 2 - 110, y - 28);
  g.lineTo(x + w / 2 + 110, y - 28);
  g.lineTo(x + w / 2 + 150, y + 6);
  g.closePath();
  g.fill();
  g.fillStyle = mix('#2a2140', '#57486a', state.day);
  roundRect(g, x, y, w, h, 34);
  g.fill();
  g.strokeStyle = mix('#c99a4a', '#e2bd78', state.day);
  g.lineWidth = 6;
  roundRect(g, x + 8, y + 8, w - 16, h - 16, 28);
  g.stroke();
  // The name panel.
  g.fillStyle = mix('#14101f', '#2a2236', state.day);
  roundRect(g, NAME_PANEL.x, NAME_PANEL.y, NAME_PANEL.w, NAME_PANEL.h, 14);
  g.fill();
  if (state.name > 0) {
    const glow = g.createRadialGradient(x + w / 2, NAME_PANEL.y + NAME_PANEL.h / 2, 10, x + w / 2, NAME_PANEL.y + NAME_PANEL.h / 2, w * 0.6);
    glow.addColorStop(0, rgba(INK.gold, 0.25 * state.name));
    glow.addColorStop(1, rgba(INK.gold, 0));
    g.fillStyle = glow;
    roundRect(g, NAME_PANEL.x, NAME_PANEL.y, NAME_PANEL.w, NAME_PANEL.h, 14);
    g.fill();
  }
  const lit = Math.round(state.bulbs * BULBS.length);
  BULBS.forEach(([bx, by], i) => {
    const on = i < lit;
    // The chase: every third bulb brightens on each beat, stepping round.
    const step = state.chase === 0.5 ? 0.86 : (i + Math.floor(state.chase)) % 3 === 0 ? 1 : 0.72;
    g.fillStyle = on ? rgba(INK.bulb, step) : mix('#3a3046', '#7a6a70', state.day);
    g.beginPath();
    g.arc(bx, by, on ? 7.5 : 6, 0, TAU);
    g.fill();
    if (on && step === 1) {
      g.fillStyle = rgba(INK.gold, 0.22);
      g.beginPath();
      g.arc(bx, by, 17, 0, TAU);
      g.fill();
    }
  });
  // The letter board under the marquee: black felt, three rails.
  g.fillStyle = mix('#b89a5e', '#d8bb80', state.day);
  roundRect(g, BOARD.x - 10, BOARD.y - 10, BOARD.w + 20, BOARD.h + 20, 10);
  g.fill();
  g.fillStyle = INK.felt;
  roundRect(g, BOARD.x, BOARD.y, BOARD.w, BOARD.h, 6);
  g.fill();
  g.fillStyle = rgba('#ffffff', 0.05);
  for (let i = 1; i < 6; i++) {
    g.fillRect(BOARD.x + 8, BOARD.y + (BOARD.h * i) / 6, BOARD.w - 16, 2);
  }
}

/** The sign on the building once it has landed: from the land frame it springs onto the wall. */
export function drawSign(g: G, cam: Cam, time: number): void {
  if (!visible(cam, Z_FACADE) || time < bf(BEAT.sign)) {
    return;
  }
  onLayer(g, cam, Z_FACADE);
  // It slams onto its fixings: squashed on the frame it lands, springing back past its shape.
  const settle = spring(time, bf(BEAT.sign), PLAYFUL);
  const cy = SIGN.y + SIGN.h;
  g.save();
  g.translate(CX, cy);
  g.scale(1 + 0.07 * (1 - settle), 1 - 0.1 * (1 - settle));
  g.translate(-CX, -cy);
  const day = 1 - nightness(time);
  // The bulbs come lit, as the image drew them; from their beat the chase runs, a step a beat.
  const chase = time < bf(BEAT.bulbs) ? 0.5 : time / FPB;
  const bulbsOn = 1;
  // The bulbs flare as the sign hits the wall.
  if (time >= bf(BEAT.sign) && time < bf(BEAT.sign) + 6) {
    const flare = g.createRadialGradient(CX, SIGN.y + SIGN.h / 2, 40, CX, SIGN.y + SIGN.h / 2, SIGN.w * 0.75);
    flare.addColorStop(0, rgba(INK.bulb, 0.35 * (1 - (time - bf(BEAT.sign)) / 6)));
    flare.addColorStop(1, rgba(INK.bulb, 0));
    g.fillStyle = flare;
    g.fillRect(SIGN.x - 200, SIGN.y - 200, SIGN.w + 400, SIGN.h + 400);
  }
  const name = clamp(spring(time, bf(BEAT.lit), SNAPPY));
  drawSignArt(g, { bulbs: bulbsOn, chase, name, day });
  // The board lights on the open beat.
  const board = clamp(spring(time, bf(BEAT.open), SNAPPY));
  if (board > 0) {
    const glow = g.createLinearGradient(0, BOARD.y, 0, BOARD.y + BOARD.h);
    glow.addColorStop(0, rgba('#fff3d6', 0.12 * board));
    glow.addColorStop(1, rgba('#fff3d6', 0.04 * board));
    g.fillStyle = glow;
    roundRect(g, BOARD.x, BOARD.y, BOARD.w, BOARD.h, 6);
    g.fill();
  }
  g.restore();
}

// ---------------------------------------------------------------- the doors

/** How far the doors have swung open, 0 shut to 1 wide (about 80 degrees). */
export function doorsOpen(time: number): number {
  return clamp(spring(time, bf(BEAT.doors), DEFAULT), 0, 1.04);
}

/** Clips `g` (screen space) to the door opening, the only place the hall shows from the street. */
export function clipOpening(g: G, cam: Cam): void {
  onScreen(g, cam);
  const a = proj(cam, OPENING.x0, OPENING.y0, Z_FACADE);
  const b = proj(cam, OPENING.x1, OPENING.y1, Z_FACADE);
  g.beginPath();
  g.rect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
  g.clip();
}

function glassEdges(g: G, box: Box, night: number, near: number): void {
  g.strokeStyle = rgba('#dfe6ff', 0.22 + 0.1 * (1 - night));
  g.lineWidth = 2;
  g.strokeRect(box.x, box.y, box.w, box.h);
  if (near <= 0) {
    return;
  }
  // A reflection: two thin diagonal streaks across the glass.
  g.save();
  g.beginPath();
  g.rect(box.x, box.y, box.w, box.h);
  g.clip();
  g.strokeStyle = rgba('#ffffff', (0.05 + 0.04 * (1 - night)) * near);
  g.lineWidth = 26;
  g.beginPath();
  g.moveTo(box.x - 40, box.y + box.h * 0.55);
  g.lineTo(box.x + box.w + 40, box.y + box.h * 0.2);
  g.stroke();
  g.lineWidth = 8;
  g.beginPath();
  g.moveTo(box.x - 40, box.y + box.h * 0.66);
  g.lineTo(box.x + box.w + 40, box.y + box.h * 0.31);
  g.stroke();
  g.restore();
}

/** The two glass doors: shut, they frame the hall; from the doors beat they swing out towards the street. */
export function drawDoors(g: G, cam: Cam, time: number): void {
  if (!visible(cam, Z_FACADE)) {
    return;
  }
  const night = nightness(time);
  const metal = mix('#5d5868', '#b7ada2', 1 - night);
  const open = doorsOpen(time);
  if (open <= 0) {
    onLayer(g, cam, Z_FACADE);
    g.fillStyle = metal;
    g.fillRect(OPENING.x0, OPENING.y0, OPENING.x1 - OPENING.x0, RAIL_TOP - OPENING.y0);
    g.fillRect(OPENING.x0, RAIL_BOTTOM, OPENING.x1 - OPENING.x0, OPENING.y1 - RAIL_BOTTOM);
    g.fillRect(OPENING.x0, OPENING.y0, GLASS_L.x - OPENING.x0, OPENING.y1 - OPENING.y0);
    g.fillRect(GLASS_R.x + GLASS_R.w, OPENING.y0, OPENING.x1 - GLASS_R.x - GLASS_R.w, OPENING.y1 - OPENING.y0);
    // Where the two panes meet: a hairline of light.
    g.fillStyle = rgba('#e8ecff', 0.16);
    g.fillRect(CX - 1.5, RAIL_TOP, 3, RAIL_BOTTOM - RAIL_TOP);
    // Close to the glass its reflections fall away, as they do when you press your face to a window.
    const near = clamp((2.4 - scaleAt(cam, Z_FACADE)) / 1.4);
    glassEdges(g, GLASS_L, night, near);
    glassEdges(g, GLASS_R, night, near);
    return;
  }
  // Each door swings out about its hinge: its free edge comes towards the camera.
  const angle = (80 * Math.PI) / 180 * open;
  for (const side of [-1, 1] as const) {
    const hinge = side < 0 ? OPENING.x0 : OPENING.x1;
    const free = hinge - side * 280 * Math.cos(angle);
    const zFree = Z_FACADE - 280 * Math.sin(angle);
    if (!visible(cam, zFree, 30)) {
      continue;
    }
    onScreen(g, cam);
    g.fillStyle = rgba(mix('#9fb3d6', '#dfe8f2', 1 - night), 0.28);
    wallQuad(g, cam, hinge, Z_FACADE, free, zFree, OPENING.y0 + 4, OPENING.y1 - 4);
    g.fill();
    g.strokeStyle = metal;
    g.lineWidth = Math.max(2, 10 * (1000 / (zFree - cam.Z)));
    g.stroke();
    g.fillStyle = metal;
    wallQuad(g, cam, hinge, Z_FACADE, free, zFree, RAIL_BOTTOM, OPENING.y1 - 4);
    g.fill();
  }
}

// ---------------------------------------------------------------- the paper on the glass

/** The four sheets on the glass, from inside: top left, top right, bottom left, bottom right. */
export function sheetBox(i: number): Box {
  const glass = i % 2 === 0 ? GLASS_L : GLASS_R;
  const half = glass.h / 2;
  return { x: glass.x + 5, y: glass.y + 5 + (i >= 2 ? half : 0), w: glass.w - 10, h: half - 10 };
}

/**
 * How much of a sheet still hangs, 1 whole to 0 peeled: from its peel beat its
 * top edge falls to its foot.
 */
export function sheetLeft(i: number, time: number): number {
  const beat = BEAT.peels[i] ?? 0;
  return 1 - clamp(spring(time, bf(beat), DEFAULT), 0, 1);
}

/** The blank backs of the sheets, backlit from inside, drawn on the glass (z = 1000). */
export function drawPaper(g: G, cam: Cam, time: number, landed: (i: number) => boolean): void {
  if (!visible(cam, Z_FACADE)) {
    return;
  }
  onLayer(g, cam, Z_FACADE);
  const night = nightness(time);
  for (let i = 0; i < 4; i++) {
    if (!landed(i)) {
      continue;
    }
    const left = sheetLeft(i, time);
    if (left <= 0.002) {
      continue;
    }
    const b = sheetBox(i);
    const top = b.y + b.h * (1 - left);
    // The paper is lit from inside; the light breathes on each beat, as a screen does when a film plays.
    const flicker = 0.045 * night * Math.exp(-5 * (((time / FPB) % 1 + 1) % 1));
    const paper = mix(mix('#f2dfb8', INK.paper, 1 - night), '#fff8e8', flicker * 4);
    const glow = g.createRadialGradient(b.x + b.w / 2, b.y + b.h * 0.6, 10, b.x + b.w / 2, b.y + b.h * 0.6, b.h);
    glow.addColorStop(0, mix(paper, '#fff6e0', 0.5 * night));
    glow.addColorStop(1, mix(paper, INK.paperShade, 0.5));
    g.fillStyle = glow;
    g.fillRect(b.x, top, b.w, b.y + b.h - top);
    // The curl at the falling edge.
    if (left < 1) {
      const curl = 26 * Math.sin(Math.PI * left);
      g.fillStyle = mix(INK.paperShade, '#8a7c66', 0.4);
      g.beginPath();
      g.moveTo(b.x, top);
      g.lineTo(b.x + b.w, top);
      g.lineTo(b.x + b.w - 6, top + curl);
      g.lineTo(b.x + 6, top + curl);
      g.closePath();
      g.fill();
    }
  }
}

/**
 * Light that crosses the paper from the street: a passing car's headlights
 * throw the door frames' shadows across it, left to right, centred on the
 * car's beat; and at dawn a bar of sunlight snaps onto it on its beat.
 */
export function drawStreetLight(g: G, cam: Cam, time: number): void {
  if (!visible(cam, Z_FACADE)) {
    return;
  }
  onLayer(g, cam, Z_FACADE);
  g.save();
  g.beginPath();
  for (let i = 0; i < 4; i++) {
    const b = sheetBox(i);
    const top = b.y + b.h * (1 - sheetLeft(i, time));
    g.rect(b.x, top, b.w, b.y + b.h - top);
  }
  g.clip();
  const u = prog(time, bf(BEAT.car - 0.75), bf(BEAT.car + 0.75));
  if (u > 0 && u < 1) {
    // The headlights are low and to one side, so the shadows fall well off the frames that cast them.
    const shift = 150 + (u - 0.5) * 900;
    const strength = Math.sin(Math.PI * u);
    // The headlights' wash, and across it the shadows of the meeting stiles and the mid rail.
    g.fillStyle = rgba('#fff2cf', 0.22 * strength);
    g.fillRect(OPENING.x0, OPENING.y0, OPENING.x1 - OPENING.x0, OPENING.y1 - OPENING.y0);
    g.fillStyle = rgba('#3a2c2a', 0.5 * strength);
    for (const x of [GLASS_L.x + GLASS_L.w, GLASS_L.x - 4, GLASS_R.x + GLASS_R.w]) {
      const sx = x + shift;
      g.beginPath();
      g.moveTo(sx - 9, RAIL_TOP);
      g.lineTo(sx + 9, RAIL_TOP);
      g.lineTo(sx + 9 + shift * 0.35, RAIL_BOTTOM);
      g.lineTo(sx - 9 + shift * 0.35, RAIL_BOTTOM);
      g.closePath();
      g.fill();
    }
    g.fillRect(OPENING.x0, GLASS_L.y + GLASS_L.h / 2 - 7 + shift * 0.05, OPENING.x1 - OPENING.x0, 14);
  }
  // Dawn: a slanting bar of sunlight snaps onto the paper on its beat and widens.
  const sun = time < bf(BEAT.dawn) - 2 ? 0 : clamp(spring(time, bf(BEAT.dawn) - 2, SNAPPY), 0, 1.15);
  if (sun > 0) {
    const w = 60 + 170 * sun;
    g.fillStyle = rgba('#ffcf86', 0.38);
    g.beginPath();
    g.moveTo(560 - w, RAIL_TOP);
    g.lineTo(560 + w, RAIL_TOP);
    g.lineTo(420 + w, RAIL_BOTTOM);
    g.lineTo(420 - w, RAIL_BOTTOM);
    g.closePath();
    g.fill();
  }
  g.restore();
}

// ---------------------------------------------------------------- the hall behind the doors

/** How lit the hall is: dark with only her phone, then the screen's glow, then morning through the doors. */
function hallLight(time: number): { screen: number; day: number } {
  return { screen: clamp(spring(time, bf(BEAT.rows[0]), DEFAULT)), day: 1 - nightness(time) };
}

export function drawHallShell(g: G, cam: Cam, time: number, screenLit: boolean): void {
  const { screen, day } = hallLight(time);
  onLayer(g, cam, Z_SCREEN);
  const wall = mix(mix('#120e1c', '#1a1426', screen), '#3a2c3c', day * 0.6);
  g.fillStyle = wall;
  g.fillRect(-2600, -1400, 6280, 2900);
  // Her phone's cool light, thrown on the wall behind her while the room is dark.
  const dark = 1 - Math.max(screen, day);
  if (dark > 0) {
    const pool = g.createRadialGradient(410, 1330, 20, 410, 1330, 620);
    pool.addColorStop(0, rgba(INK.glow, 0.2 * dark));
    pool.addColorStop(0.5, rgba(INK.glow, 0.07 * dark));
    pool.addColorStop(1, rgba(INK.glow, 0));
    g.fillStyle = pool;
    g.fillRect(-300, 600, 1400, 1100);
  }
  // The screen's light on the back wall.
  if (screenLit) {
    const cx = SCREEN.x + SCREEN.w / 2;
    const cy = SCREEN.y + SCREEN.h / 2;
    const glow = g.createRadialGradient(cx, cy, 40, cx, cy, 700);
    glow.addColorStop(0, rgba('#8a86c8', 0.28 * screen));
    glow.addColorStop(1, rgba('#8a86c8', 0));
    g.fillStyle = glow;
    g.fillRect(-1000, 300, 3080, 1200);
  }
  // Before the screen lands, a paler patch on the wall where it will hang.
  if (time < bf(BEAT.rows[0])) {
    g.fillStyle = rgba('#ffffff', 0.025);
    g.fillRect(SCREEN.x, SCREEN.y, SCREEN.w, SCREEN.h);
  }
  // Side walls and the floor, in perspective.
  onScreen(g, cam);
  const side = mix(mix('#120e1a', '#1d1728', screen), '#4a3848', day * 0.6);
  g.fillStyle = side;
  wallQuad(g, cam, 150, Math.max(cam.Z + 20, Z_FACADE), 150, Z_SCREEN, -600, FLOOR_Y);
  g.fill();
  wallQuad(g, cam, 930, Math.max(cam.Z + 20, Z_FACADE), 930, Z_SCREEN, -600, FLOOR_Y);
  g.fill();
  const floor = mix(mix('#151019', '#1f1826', screen), '#5a4448', day * 0.55);
  g.fillStyle = floor;
  groundQuad(g, cam, 150, 930, Math.max(cam.Z + 20, Z_FACADE), Z_SCREEN);
  g.fill();
  // The morning light falling through the open doors onto the floor.
  if (day > 0) {
    g.fillStyle = rgba('#ffd9a8', 0.18 * day);
    groundQuad(g, cam, OPENING.x0 + 20, OPENING.x1 - 20, Math.max(cam.Z + 20, Z_FACADE), 1450);
    g.fill();
  }
  // The aisle runner rolls out from the screen towards the doors as the seats land.
  const runner = clamp(spring(time, bf(BEAT.rows[3]), HEAVY));
  if (runner > 0) {
    g.fillStyle = mix(mix('#2b1f3a', '#3a2848', screen), '#6a4a5a', day * 0.5);
    groundQuad(g, cam, CX - 42, CX + 42, Math.max(cam.Z + 20, lerp(Z_SCREEN, 1240, runner)), Z_SCREEN);
    g.fill();
  }
}

/**
 * The screen on the back wall once the document card has landed there: the
 * card's charcoal lights up as a cinema screen; as the camera flies down the
 * hall an iris of charcoal opens from its centre for the mark.
 */
export function drawScreen(g: G, cam: Cam, time: number, ui: string, iris: { x: number; y: number }): void {
  if (time < bf(BEAT.rows[0]) || !visible(cam, Z_SCREEN)) {
    return;
  }
  onLayer(g, cam, Z_SCREEN);
  const light = clamp(spring(time, bf(BEAT.rows[0]) - 2, SNAPPY));
  const day = 1 - nightness(time);
  g.fillStyle = mix(ui, mix(INK.screen, '#fff7ea', day * 0.5), light);
  g.fillRect(SCREEN.x, SCREEN.y, SCREEN.w, SCREEN.h);
  const open = spring(time, bf(BEAT.fly) + 6, DEFAULT);
  if (open > 0) {
    g.save();
    g.beginPath();
    g.rect(SCREEN.x, SCREEN.y, SCREEN.w, SCREEN.h);
    g.clip();
    g.fillStyle = ui;
    g.beginPath();
    g.arc(iris.x, iris.y, Math.max(0, open) * 520, 0, TAU);
    g.fill();
    g.restore();
  }
  g.strokeStyle = mix('#3a3046', '#7a6a70', day);
  g.lineWidth = 6;
  g.strokeRect(SCREEN.x - 3, SCREEN.y - 3, SCREEN.w + 6, SCREEN.h + 6);
}

/** One row of seats on its layer: `split` 0 is the bar it came from, 1 the separate seats. */
export function drawRow(g: G, cam: Cam, r: number, split: number, squash: number, time: number): void {
  const z = Z_ROWS[r] ?? 1300;
  if (!visible(cam, z)) {
    return;
  }
  onLayer(g, cam, z);
  const box = rowBox(r);
  const n = ROW_SEATS[r] ?? 10;
  const day = 1 - nightness(time);
  const seat = mix(mix('#2f356a', '#3e4680', 0.6), '#56609c', day * 0.5);
  const top = mix('#4a5394', '#7882c2', day * 0.5);
  const gap = 4 * split;
  const h = SEAT_H * (1 - 0.25 * squash);
  for (let i = 0; i < n; i++) {
    const x = box.x + i * SEAT_PITCH + gap / 2;
    const w = SEAT_PITCH - gap;
    // Each seat back is round-topped; the gaps open between them.
    g.fillStyle = seat;
    roundRect(g, x, FLOOR_Y - h, w, h, lerp(4, 12, split));
    g.fill();
    g.fillStyle = top;
    roundRect(g, x + 3, FLOOR_Y - h + 3, w - 6, 14, 7);
    g.fill();
  }
}

/** The bars a chart draws, one per row of seats: its value and the row it becomes. */
export const CHART_VALUES = [11, 12, 13, 14] as const;

void W;
void H;
void HEAVY;
void PLAYFUL;
void Z_ROWS;
