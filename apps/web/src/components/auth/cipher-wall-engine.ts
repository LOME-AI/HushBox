import { getSecureRandomIndex, getSecureRandomElement } from '@hushbox/shared';

// --- Interfaces ---

export interface Cell {
  cipherChar: string;
  targetChar: string;
  state: 'cipher' | 'decrypting' | 'readable' | 'encrypting';
  progress: number;
  rollChar: string;
  color: string;
}

export interface MessageReveal {
  row: number;
  col: number;
  text: string;
  charIndex: number;
  state: 'decrypting' | 'holding' | 'fading';
  holdTimer: number;
  rollTimer: number;
  rollTickTimer: number;
}

export interface CipherWallState {
  grid: Cell[][];
  cols: number;
  rows: number;
  reveals: MessageReveal[];
  revealTimer: number;
  messageQueue: number[];
}

export interface ThemeColors {
  background: string;
  foreground: string;
  brandRed: string;
  foregroundMuted: string;
}

// --- Constants ---

export const CELL_WIDTH = 12;
export const CELL_HEIGHT = 22;
export const FONT_SIZE = 16;
export const FONT = `${String(FONT_SIZE)}px 'JetBrains Mono', monospace`;
export const REVEAL_INTERVAL = 3;
export const HOLD_DURATION = 5;
export const DECRYPT_TICK = 0.08;
export const DECRYPT_SPEED = 1 / 6;
export const ENCRYPT_ROLL_DURATION = 1;
export const ENCRYPT_TICK = 0.07;
export const MAX_ACTIVE_REVEALS = 6;
export const INITIAL_REVEALS = 3;
export const LOGO_OPACITY_BOOST = 0.15;
export const MARGIN_ROWS = 2;
export const MARGIN_COLS = 5;

export const MESSAGES: readonly string[] = [
  'Encrypted By Default',
  'Only You Hold The Key',
  'Every Model, One Place',
  'Private Group Chats',
  'Zero-Knowledge Password',
  'Switch Models Anytime',
  'Your Messages, Your Control',
  'No Subscriptions Required',
  'One App, Every AI',
  'Never Lose A Conversation',
  'Stop Juggling Subscriptions',
  'Try Any Model Instantly',
  'Your Ideas Stay Yours',
  'Simple, Honest Pricing',
  'No More App Switching',
  'Built For Your Workflow',
];

export const CIPHER_CHARS: readonly string[] = [
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  'A',
  'B',
  'C',
  'D',
  'E',
  'F',
  '#',
  '%',
  '&',
  '@',
  '$',
  '*',
  '+',
  '=',
  '~',
  '{',
  '}',
  '[',
  ']',
  '<',
  '>',
  '/',
  '\\',
  '|',
  '^',
  '`',
  ':',
  ';',
  '!',
  '?',
];

// --- Helpers ---

/** Strict cell lookup — throws if out of bounds. */
function getCell(grid: Cell[][], row: number, col: number): Cell {
  const r = grid[row];
  const cell = r?.[col];
  if (!cell) throw new Error(`Cell [${String(row)},${String(col)}] out of bounds`);
  return cell;
}

// --- Grid Creation ---

export function randomCipherChar(): string {
  return getSecureRandomElement(CIPHER_CHARS);
}

function createMessageQueue(): number[] {
  const indices = Array.from({ length: MESSAGES.length }, (_, index) => index);
  for (let index = indices.length - 1; index > 0; index--) {
    const index_ = getSecureRandomIndex(index + 1);
    const a = indices[index];
    const b = indices[index_];
    if (a !== undefined && b !== undefined) {
      indices[index] = b;
      indices[index_] = a;
    }
  }
  return indices;
}

export function createGrid(cols: number, rows: number): CipherWallState {
  const grid: Cell[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < cols; c++) {
      row.push({
        cipherChar: randomCipherChar(),
        targetChar: '',
        state: 'cipher',
        progress: 0,
        rollChar: '',
        color: '',
      });
    }
    grid.push(row);
  }
  return {
    grid,
    cols,
    rows,
    reveals: [],
    revealTimer: REVEAL_INTERVAL,
    messageQueue: createMessageQueue(),
  };
}

function initializeRevealCells(grid: Cell[][], reveal: MessageReveal): void {
  for (let index = 0; index < reveal.text.length; index++) {
    const cell = getCell(grid, reveal.row, reveal.col + index);
    cell.state = 'decrypting';
    cell.targetChar = reveal.text.charAt(index);
    cell.rollChar = randomCipherChar();
    cell.progress = 1;
  }
}

export function seedInitialReveals(state: CipherWallState): void {
  for (let index = 0; index < INITIAL_REVEALS; index++) {
    const reveal = tryPlaceReveal(state);
    if (reveal) {
      state.reveals.push(reveal);
      initializeRevealCells(state.grid, reveal);
    }
  }
}

// --- Color Interpolation ---

function parseHex(hex: string): [number, number, number] {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return [r, g, b];
}

const clamp = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));

function toHex(r: number, g: number, b: number): string {
  return `#${clamp(r).toString(16).padStart(2, '0')}${clamp(g).toString(16).padStart(2, '0')}${clamp(b).toString(16).padStart(2, '0')}`;
}

export function interpolateColor(colorA: string, colorB: string, progress: number): string {
  const t = Math.max(0, Math.min(1, progress));
  const [rA, gA, bA] = parseHex(colorA);
  const [rB, gB, bB] = parseHex(colorB);
  return toHex(rA + (rB - rA) * t, gA + (gB - gA) * t, bA + (bB - bA) * t);
}

// --- Cell Display Helpers ---

export function getDisplayChar(cell: Cell): string {
  switch (cell.state) {
    case 'cipher': {
      return cell.cipherChar;
    }
    case 'readable': {
      return cell.targetChar;
    }
    case 'decrypting':
    case 'encrypting': {
      return cell.rollChar;
    }
  }
}

export function getCellColor(cell: Cell, colors: ThemeColors): string {
  switch (cell.state) {
    case 'cipher': {
      return colors.foreground;
    }
    case 'readable': {
      return colors.brandRed;
    }
    case 'decrypting': {
      return interpolateColor(colors.foreground, colors.brandRed, cell.progress);
    }
    case 'encrypting': {
      return interpolateColor(colors.brandRed, colors.foreground, cell.progress);
    }
  }
}

// --- State Update ---

function overlapsExistingReveal(
  reveals: MessageReveal[],
  row: number,
  col: number,
  length: number
): boolean {
  for (const r of reveals) {
    if (r.row !== row) continue;
    const rEnd = r.col + r.text.length;
    const newEnd = col + length;
    if (col < rEnd && r.col < newEnd) return true;
  }
  return false;
}

function tryPlaceReveal(state: CipherWallState): MessageReveal | undefined {
  if (state.messageQueue.length === 0) {
    state.messageQueue = createMessageQueue();
  }
  const index = state.messageQueue[0];
  if (index === undefined) return undefined;
  const text = MESSAGES[index];
  if (!text) return undefined;

  const availableRows = state.rows - 2 * MARGIN_ROWS;
  const availableCols = state.cols - 2 * MARGIN_COLS - text.length + 1;
  if (availableRows <= 0 || availableCols <= 0) return undefined;

  for (let attempt = 0; attempt < 20; attempt++) {
    const row = MARGIN_ROWS + getSecureRandomIndex(availableRows);
    const col = MARGIN_COLS + getSecureRandomIndex(availableCols);
    if (!overlapsExistingReveal(state.reveals, row, col, text.length)) {
      state.messageQueue.shift();
      return {
        row,
        col,
        text,
        charIndex: 0,
        state: 'decrypting',
        holdTimer: 0,
        rollTimer: 0,
        rollTickTimer: 0,
      };
    }
  }
  return undefined;
}

function updateDecryptingPhase(reveal: MessageReveal, grid: Cell[][], dt: number): boolean {
  reveal.charIndex += dt / DECRYPT_SPEED;
  const resolved = Math.min(Math.floor(reveal.charIndex), reveal.text.length);

  for (let index = 0; index < resolved; index++) {
    const cell = getCell(grid, reveal.row, reveal.col + index);
    cell.state = 'readable';
    cell.targetChar = reveal.text.charAt(index);
    cell.progress = 1;
  }

  reveal.rollTickTimer += dt;
  if (reveal.rollTickTimer >= DECRYPT_TICK) {
    reveal.rollTickTimer -= DECRYPT_TICK;
    for (let index = resolved; index < reveal.text.length; index++) {
      getCell(grid, reveal.row, reveal.col + index).rollChar = randomCipherChar();
    }
  }

  if (resolved >= reveal.text.length) {
    reveal.state = 'holding';
    reveal.holdTimer = HOLD_DURATION;
    reveal.charIndex = 0;
  }
  return false;
}

function updateHoldingPhase(reveal: MessageReveal, grid: Cell[][], dt: number): boolean {
  reveal.holdTimer -= dt;
  if (reveal.holdTimer <= 0) {
    reveal.state = 'fading';
    reveal.rollTimer = ENCRYPT_ROLL_DURATION;
    reveal.rollTickTimer = 0;
    for (let index = 0; index < reveal.text.length; index++) {
      getCell(grid, reveal.row, reveal.col + index).rollChar = randomCipherChar();
    }
  }
  return false;
}

function snapCellsToCipher(grid: Cell[][], reveal: MessageReveal): void {
  for (let index = 0; index < reveal.text.length; index++) {
    const cell = getCell(grid, reveal.row, reveal.col + index);
    cell.state = 'cipher';
    cell.targetChar = '';
    cell.progress = 0;
    cell.rollChar = '';
    cell.color = '';
    cell.cipherChar = randomCipherChar();
  }
}

function updateFadingPhase(reveal: MessageReveal, grid: Cell[][], dt: number): boolean {
  reveal.rollTimer -= dt;
  reveal.rollTickTimer += dt;

  const progress = Math.min(1, Math.max(0, 1 - reveal.rollTimer / ENCRYPT_ROLL_DURATION));
  const changeRoll = reveal.rollTickTimer >= ENCRYPT_TICK;

  for (let index = 0; index < reveal.text.length; index++) {
    const cell = getCell(grid, reveal.row, reveal.col + index);
    cell.state = 'encrypting';
    cell.progress = progress;
    if (changeRoll) {
      cell.rollChar = randomCipherChar();
    }
  }

  if (changeRoll) {
    reveal.rollTickTimer -= ENCRYPT_TICK;
  }

  if (reveal.rollTimer <= 0) {
    snapCellsToCipher(grid, reveal);
    return true;
  }
  return false;
}

function updateReveal(reveal: MessageReveal, grid: Cell[][], dt: number): boolean {
  switch (reveal.state) {
    case 'decrypting': {
      return updateDecryptingPhase(reveal, grid, dt);
    }
    case 'holding': {
      return updateHoldingPhase(reveal, grid, dt);
    }
    case 'fading': {
      return updateFadingPhase(reveal, grid, dt);
    }
  }
}

export function updateState(state: CipherWallState, dt: number): void {
  state.revealTimer -= dt;

  if (state.revealTimer <= 0 && state.reveals.length < MAX_ACTIVE_REVEALS) {
    const reveal = tryPlaceReveal(state);
    if (reveal) {
      state.reveals.push(reveal);
      initializeRevealCells(state.grid, reveal);
    }
    state.revealTimer = REVEAL_INTERVAL;
  }

  const toRemove: number[] = [];
  for (const [index, reveal] of state.reveals.entries()) {
    if (updateReveal(reveal, state.grid, dt)) toRemove.push(index);
  }
  for (let index = toRemove.length - 1; index >= 0; index--) {
    const removeAt = toRemove[index];
    if (removeAt !== undefined) state.reveals.splice(removeAt, 1);
  }
}

// --- Rendering ---

const CIPHER_BASE_OPACITY = 0.8;
const READABLE_OPACITY = 1;

function getCellOpacity(cell: Cell, isInLogo: boolean): number {
  let alpha: number;
  switch (cell.state) {
    case 'cipher': {
      alpha = CIPHER_BASE_OPACITY;
      break;
    }
    case 'readable': {
      alpha = READABLE_OPACITY;
      break;
    }
    case 'decrypting': {
      alpha = CIPHER_BASE_OPACITY + (READABLE_OPACITY - CIPHER_BASE_OPACITY) * cell.progress;
      break;
    }
    case 'encrypting': {
      alpha = READABLE_OPACITY - (READABLE_OPACITY - CIPHER_BASE_OPACITY) * cell.progress;
      break;
    }
  }
  if (isInLogo) alpha += LOGO_OPACITY_BOOST;
  return Math.min(1, alpha);
}

export interface RenderFrameInput {
  ctx: CanvasRenderingContext2D;
  state: CipherWallState;
  colors: ThemeColors;
  width: number;
  height: number;
  logoMask: boolean[][] | null;
}

export function renderFrame(input: Readonly<RenderFrameInput>): void {
  const { ctx, state, colors, width, height, logoMask } = input;
  ctx.clearRect(0, 0, width, height);
  ctx.font = FONT;

  for (let r = 0; r < state.rows; r++) {
    for (let c = 0; c < state.cols; c++) {
      const cell = getCell(state.grid, r, c);
      const ch = getDisplayChar(cell);
      const color = getCellColor(cell, colors);
      const isInLogo = logoMask?.[r]?.[c] === true;
      const alpha = getCellOpacity(cell, isInLogo);

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.fillText(ch, c * CELL_WIDTH, r * CELL_HEIGHT + FONT_SIZE);
      ctx.restore();
    }
  }
}

// --- Reduced Motion ---

export function createStaticSnapshot(cols: number, rows: number): CipherWallState {
  const state = createGrid(cols, rows);
  const text = getSecureRandomElement(MESSAGES);

  const availableRows = rows - 2 * MARGIN_ROWS;
  const availableCols = cols - 2 * MARGIN_COLS - text.length + 1;

  if (availableRows > 0 && availableCols > 0) {
    const row = MARGIN_ROWS + getSecureRandomIndex(availableRows);
    const col = MARGIN_COLS + getSecureRandomIndex(availableCols);

    for (let index = 0; index < text.length; index++) {
      const cell = getCell(state.grid, row, col + index);
      cell.state = 'readable';
      cell.targetChar = text.charAt(index);
      cell.progress = 1;
    }
  }

  state.reveals = [];
  return state;
}
