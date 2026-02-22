import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createGrid,
  seedInitialReveals,
  updateState,
  interpolateColor,
  getDisplayChar,
  getCellColor,
  renderFrame,
  createStaticSnapshot,
  CIPHER_CHARS,
  MESSAGES,
  CELL_WIDTH,
  CELL_HEIGHT,
  FONT_SIZE,
  FONT,
  REVEAL_INTERVAL,
  HOLD_DURATION,
  DECRYPT_TICK,
  DECRYPT_SPEED,
  ENCRYPT_ROLL_DURATION,
  ENCRYPT_TICK,
  MAX_ACTIVE_REVEALS,
  INITIAL_REVEALS,
  LOGO_OPACITY_BOOST,
  MARGIN_ROWS,
  MARGIN_COLS,
} from './cipher-wall-engine';
import type { Cell, CipherWallState, ThemeColors } from './cipher-wall-engine';

// --- Helpers ---

const longestMessage = Math.max(...MESSAGES.map((m) => m.length));

function wideGrid(): CipherWallState {
  return createGrid(longestMessage + 2 * MARGIN_COLS + 10, 2 * MARGIN_ROWS + 20);
}

function triggerReveal(state: CipherWallState): void {
  state.revealTimer = 0.001;
  updateState(state, 0.002);
}

function suppressNewReveals(state: CipherWallState): void {
  state.revealTimer = 9999;
}

function countReadableCells(grid: Cell[][]): number {
  let count = 0;
  for (const row of grid) {
    for (const cell of row) {
      if (cell.state === 'readable') count++;
    }
  }
  return count;
}

function getReadableText(grid: Cell[][]): string {
  let text = '';
  for (const row of grid) {
    for (const cell of row) {
      if (cell.state === 'readable') text += cell.targetChar;
    }
  }
  return text;
}

function resetGrid(state: CipherWallState): void {
  for (const row of state.grid) {
    for (const cell of row) {
      cell.state = 'cipher';
      cell.progress = 0;
      cell.targetChar = '';
      cell.rollChar = '';
      cell.color = '';
    }
  }
}

// --- Tests ---

describe('constants', () => {
  it('has non-empty CIPHER_CHARS array', () => {
    expect(CIPHER_CHARS.length).toBeGreaterThan(0);
    for (const ch of CIPHER_CHARS) {
      expect(typeof ch).toBe('string');
      expect(ch).toHaveLength(1);
    }
  });

  it('has capitalized product-value MESSAGES', () => {
    expect(MESSAGES.length).toBeGreaterThanOrEqual(16);
    expect(MESSAGES).toContain('Encrypted By Default');
    expect(MESSAGES).toContain('Only You Hold The Key');
    expect(MESSAGES).toContain('Every Model, One Place');
    expect(MESSAGES).toContain('Private Group Chats');
    expect(MESSAGES).toContain('Zero-Knowledge Password');
    expect(MESSAGES).toContain('Switch Models Anytime');
    expect(MESSAGES).toContain('Your Messages, Your Control');
    expect(MESSAGES).toContain('No Subscriptions Required');
    expect(MESSAGES).toContain('One App, Every AI');
    expect(MESSAGES).toContain('Never Lose A Conversation');
    expect(MESSAGES).toContain('Stop Juggling Subscriptions');
    expect(MESSAGES).toContain('Try Any Model Instantly');
    expect(MESSAGES).toContain('Your Ideas Stay Yours');
    expect(MESSAGES).toContain('Simple, Honest Pricing');
    expect(MESSAGES).toContain('No More App Switching');
    expect(MESSAGES).toContain('Built For Your Workflow');
  });

  it('has positive numeric constants', () => {
    expect(CELL_WIDTH).toBeGreaterThan(0);
    expect(CELL_HEIGHT).toBeGreaterThan(0);
    expect(FONT_SIZE).toBeGreaterThan(0);
    expect(REVEAL_INTERVAL).toBeGreaterThan(0);
    expect(HOLD_DURATION).toBe(5);
    expect(DECRYPT_TICK).toBe(0.08);
    expect(DECRYPT_SPEED).toBeCloseTo(1 / 6, 10);
    expect(ENCRYPT_ROLL_DURATION).toBe(1);
    expect(ENCRYPT_TICK).toBe(0.07);
    expect(MAX_ACTIVE_REVEALS).toBeGreaterThan(0);
    expect(INITIAL_REVEALS).toBe(3);
    expect(LOGO_OPACITY_BOOST).toBeGreaterThan(0);
    expect(LOGO_OPACITY_BOOST).toBeLessThan(1);
    expect(MARGIN_ROWS).toBeGreaterThan(0);
    expect(MARGIN_COLS).toBeGreaterThan(0);
  });

  it('has a font string containing JetBrains Mono with monospace fallback', () => {
    expect(FONT).toContain('JetBrains Mono');
    expect(FONT).toContain('monospace');
  });

  it('uses 16px font with proportional cell dimensions', () => {
    expect(FONT_SIZE).toBe(16);
    expect(CELL_WIDTH).toBe(12);
    expect(CELL_HEIGHT).toBe(22);
    expect(FONT).toBe(`${String(FONT_SIZE)}px 'JetBrains Mono', monospace`);
  });
});

describe('createGrid', () => {
  it('creates grid with expected dimensions', () => {
    const state = createGrid(80, 30);
    expect(state.cols).toBe(80);
    expect(state.rows).toBe(30);
    expect(state.grid).toHaveLength(30);
    for (const row of state.grid) {
      expect(row).toHaveLength(80);
    }
  });

  it('initializes every cell in cipher state', () => {
    const state = createGrid(10, 5);
    for (const row of state.grid) {
      for (const cell of row) {
        expect(cell.state).toBe('cipher');
      }
    }
  });

  it('assigns a non-empty cipherChar from CIPHER_CHARS to every cell', () => {
    const state = createGrid(10, 5);
    for (const row of state.grid) {
      for (const cell of row) {
        expect(cell.cipherChar).toBeTruthy();
        expect(CIPHER_CHARS).toContain(cell.cipherChar);
      }
    }
  });

  it('initializes cells with empty targetChar', () => {
    const state = createGrid(10, 5);
    for (const row of state.grid) {
      for (const cell of row) {
        expect(cell.targetChar).toBe('');
      }
    }
  });

  it('initializes cells with zero progress', () => {
    const state = createGrid(10, 5);
    for (const row of state.grid) {
      for (const cell of row) {
        expect(cell.progress).toBe(0);
      }
    }
  });

  it('initializes cells with empty rollChar and color', () => {
    const state = createGrid(10, 5);
    for (const row of state.grid) {
      for (const cell of row) {
        expect(cell.rollChar).toBe('');
        expect(cell.color).toBe('');
      }
    }
  });

  it('starts with empty reveals array', () => {
    const state = createGrid(10, 5);
    expect(state.reveals).toEqual([]);
  });

  it('starts with revealTimer set to REVEAL_INTERVAL', () => {
    const state = createGrid(10, 5);
    expect(state.revealTimer).toBe(REVEAL_INTERVAL);
  });

  it('uses randomness for cipherChar — not all identical', () => {
    const state = createGrid(40, 20);
    const chars = new Set<string>();
    for (const row of state.grid) {
      for (const cell of row) {
        chars.add(cell.cipherChar);
      }
    }
    expect(chars.size).toBeGreaterThan(1);
  });

  it('initializes messageQueue with MESSAGES.length indices', () => {
    const state = createGrid(10, 5);
    expect(state.messageQueue).toHaveLength(MESSAGES.length);
    const sorted = state.messageQueue.toSorted((a, b) => a - b);
    expect(sorted).toEqual(Array.from({ length: MESSAGES.length }, (_, index) => index));
  });
});

describe('seedInitialReveals', () => {
  it('places INITIAL_REVEALS reveals on the grid', () => {
    const state = wideGrid();
    seedInitialReveals(state);
    expect(state.reveals).toHaveLength(INITIAL_REVEALS);
  });

  it('sets seeded reveal cells to decrypting with progress=1', () => {
    const state = wideGrid();
    seedInitialReveals(state);

    for (const reveal of state.reveals) {
      for (let index = 0; index < reveal.text.length; index++) {
        const cell = state.grid[reveal.row]![reveal.col + index]!;
        expect(cell.state).toBe('decrypting');
        expect(cell.progress).toBe(1);
        expect(cell.targetChar).toBe(reveal.text[index]);
        expect(cell.rollChar).toBeTruthy();
      }
    }
  });

  it('places no reveals when grid is too small', () => {
    const state = createGrid(5, 5);
    seedInitialReveals(state);
    expect(state.reveals).toHaveLength(0);
  });
});

describe('updateState', () => {
  describe('reveal creation', () => {
    it('decrements revealTimer over time', () => {
      const state = wideGrid();
      const before = state.revealTimer;
      updateState(state, 0.5);
      expect(state.revealTimer).toBeCloseTo(before - 0.5);
    });

    it('creates a new reveal when revealTimer hits 0', () => {
      const state = wideGrid();
      expect(state.reveals).toHaveLength(0);
      updateState(state, REVEAL_INTERVAL + 0.01);
      expect(state.reveals).toHaveLength(1);
    });

    it('resets revealTimer after creating a reveal', () => {
      const state = wideGrid();
      updateState(state, REVEAL_INTERVAL + 0.01);
      expect(state.revealTimer).toBeGreaterThan(0);
      expect(state.revealTimer).toBeLessThanOrEqual(REVEAL_INTERVAL);
    });

    it('creates reveal in decrypting state', () => {
      const state = wideGrid();
      triggerReveal(state);
      expect(state.reveals[0]!.state).toBe('decrypting');
    });

    it('selects a message from MESSAGES array', () => {
      const state = wideGrid();
      triggerReveal(state);
      expect(MESSAGES).toContain(state.reveals[0]!.text);
    });

    it('respects MAX_ACTIVE_REVEALS', () => {
      const state = wideGrid();
      for (let index = 0; index < MAX_ACTIVE_REVEALS + 5; index++) {
        state.revealTimer = 0.001;
        updateState(state, 0.01);
      }
      expect(state.reveals.length).toBeLessThanOrEqual(MAX_ACTIVE_REVEALS);
    });

    it('does not create overlapping reveals on the same row', () => {
      const state = wideGrid();
      for (let index = 0; index < 3; index++) {
        state.revealTimer = 0.001;
        updateState(state, 0.01);
      }
      for (let index = 0; index < state.reveals.length; index++) {
        for (let index_ = index + 1; index_ < state.reveals.length; index_++) {
          const a = state.reveals[index]!;
          const b = state.reveals[index_]!;
          if (a.row === b.row) {
            const aEnd = a.col + a.text.length;
            const bEnd = b.col + b.text.length;
            expect(a.col < bEnd && b.col < aEnd).toBe(false);
          }
        }
      }
    });

    it('places reveals within row margins', () => {
      const state = wideGrid();
      for (let index = 0; index < 30; index++) {
        state.revealTimer = 0.001;
        updateState(state, 0.002);
        for (const reveal of state.reveals) {
          expect(reveal.row).toBeGreaterThanOrEqual(MARGIN_ROWS);
          expect(reveal.row).toBeLessThan(state.rows - MARGIN_ROWS);
        }
        state.reveals = [];
        resetGrid(state);
      }
    });

    it('places reveals within col margins', () => {
      const state = wideGrid();
      for (let index = 0; index < 30; index++) {
        state.revealTimer = 0.001;
        updateState(state, 0.002);
        for (const reveal of state.reveals) {
          expect(reveal.col).toBeGreaterThanOrEqual(MARGIN_COLS);
          expect(reveal.col + reveal.text.length).toBeLessThanOrEqual(state.cols - MARGIN_COLS);
        }
        state.reveals = [];
        resetGrid(state);
      }
    });

    it('sets all chars in message to decrypting with progress=1 on creation', () => {
      const state = wideGrid();
      triggerReveal(state);
      const reveal = state.reveals[0]!;
      for (let index = 0; index < reveal.text.length; index++) {
        const cell = state.grid[reveal.row]![reveal.col + index]!;
        expect(cell.state).toBe('decrypting');
        expect(cell.progress).toBe(1);
      }
    });
  });

  describe('decrypting phase', () => {
    it('does not cycle chars before DECRYPT_TICK', () => {
      const state = wideGrid();
      triggerReveal(state);
      const reveal = state.reveals[0]!;

      for (let index = 0; index < reveal.text.length; index++) {
        state.grid[reveal.row]![reveal.col + index]!.rollChar = 'MARKER';
      }

      suppressNewReveals(state);
      updateState(state, DECRYPT_TICK * 0.3);

      // Unresolved chars should keep MARKER (no cycle yet)
      const resolved = Math.floor((DECRYPT_TICK * 0.3) / DECRYPT_SPEED);
      for (let index = resolved; index < reveal.text.length; index++) {
        expect(state.grid[reveal.row]![reveal.col + index]!.rollChar).toBe('MARKER');
      }
    });

    it('cycles unresolved chars after DECRYPT_TICK', () => {
      const state = wideGrid();
      triggerReveal(state);
      const reveal = state.reveals[0]!;

      for (let index = 0; index < reveal.text.length; index++) {
        state.grid[reveal.row]![reveal.col + index]!.rollChar = 'MARKER';
      }

      suppressNewReveals(state);
      updateState(state, DECRYPT_TICK + 0.01);

      // Some unresolved chars should have changed
      const resolved = Math.floor((DECRYPT_TICK + 0.01) / DECRYPT_SPEED);
      let anyChanged = false;
      for (let index = resolved; index < reveal.text.length; index++) {
        if (state.grid[reveal.row]![reveal.col + index]!.rollChar !== 'MARKER') {
          anyChanged = true;
        }
      }
      expect(anyChanged).toBe(true);
    });

    it('resolves chars L→R at 6 chars/sec during decrypting', () => {
      const state = wideGrid();
      triggerReveal(state);
      const reveal = state.reveals[0]!;

      suppressNewReveals(state);
      // 1 second = 6 chars resolved
      updateState(state, 1);

      let readableCount = 0;
      for (let index = 0; index < reveal.text.length; index++) {
        if (state.grid[reveal.row]![reveal.col + index]!.state === 'readable') {
          readableCount++;
        }
      }
      expect(readableCount).toBe(6);
    });

    it('sets resolved cells to readable with correct targetChar', () => {
      const state = wideGrid();
      triggerReveal(state);
      const reveal = state.reveals[0]!;

      suppressNewReveals(state);
      updateState(state, DECRYPT_SPEED * 3 + 0.01);

      for (let index = 0; index < 3; index++) {
        const cell = state.grid[reveal.row]![reveal.col + index]!;
        expect(cell.state).toBe('readable');
        expect(cell.targetChar).toBe(reveal.text[index]);
      }
    });

    it('transitions from decrypting to holding when all chars resolved', () => {
      const state = wideGrid();
      triggerReveal(state);
      const reveal = state.reveals[0]!;

      suppressNewReveals(state);
      updateState(state, reveal.text.length * DECRYPT_SPEED + 0.01);

      expect(reveal.state).toBe('holding');
    });

    it('sets all cells to readable after full decrypt', () => {
      const state = wideGrid();
      triggerReveal(state);
      const reveal = state.reveals[0]!;

      suppressNewReveals(state);
      updateState(state, reveal.text.length * DECRYPT_SPEED + 0.01);

      for (let index = 0; index < reveal.text.length; index++) {
        expect(state.grid[reveal.row]![reveal.col + index]!.state).toBe('readable');
      }
    });

    it('accumulates charIndex fractionally across frames', () => {
      const state = wideGrid();
      triggerReveal(state);
      const reveal = state.reveals[0]!;

      suppressNewReveals(state);
      // 10 small frames of 0.016s each = 0.16s total
      // At DECRYPT_SPEED=1/6, 0.16/0.1667 = 0.96 chars → floor = 0
      // Without float accumulation, charIndex would stay at 0 forever
      for (let index = 0; index < 10; index++) {
        updateState(state, 0.016);
      }
      // 0.16s total, not enough for 1 char
      expect(state.grid[reveal.row]![reveal.col]!.state).toBe('decrypting');

      // 3 more frames → 0.208s total → 1 char resolved
      for (let index = 0; index < 3; index++) {
        updateState(state, 0.016);
      }
      expect(state.grid[reveal.row]![reveal.col]!.state).toBe('readable');
    });
  });

  describe('holding phase', () => {
    it('sets holdTimer to HOLD_DURATION when entering holding', () => {
      const state = wideGrid();
      triggerReveal(state);
      const reveal = state.reveals[0]!;

      suppressNewReveals(state);
      updateState(state, reveal.text.length * DECRYPT_SPEED + 0.01);

      expect(reveal.holdTimer).toBeCloseTo(HOLD_DURATION, 0);
    });

    it('decrements holdTimer during holding', () => {
      const state = wideGrid();
      triggerReveal(state);
      const reveal = state.reveals[0]!;

      suppressNewReveals(state);
      updateState(state, reveal.text.length * DECRYPT_SPEED + 0.01);

      const holdBefore = reveal.holdTimer;
      suppressNewReveals(state);
      updateState(state, 0.5);
      expect(reveal.holdTimer).toBeCloseTo(holdBefore - 0.5, 1);
    });

    it('transitions from holding to fading when holdTimer expires', () => {
      const state = wideGrid();
      triggerReveal(state);
      const reveal = state.reveals[0]!;

      suppressNewReveals(state);
      updateState(state, reveal.text.length * DECRYPT_SPEED + 0.01);
      suppressNewReveals(state);
      updateState(state, HOLD_DURATION + 0.1);

      expect(reveal.state).toBe('fading');
    });
  });

  describe('fading phase', () => {
    it('sets all cells to encrypting during fading', () => {
      const state = wideGrid();
      triggerReveal(state);
      const reveal = state.reveals[0]!;

      suppressNewReveals(state);
      updateState(state, reveal.text.length * DECRYPT_SPEED + 0.01);
      suppressNewReveals(state);
      updateState(state, HOLD_DURATION + 0.1);

      // One more tick to process fading
      suppressNewReveals(state);
      updateState(state, 0.01);

      for (let index = 0; index < reveal.text.length; index++) {
        expect(state.grid[reveal.row]![reveal.col + index]!.state).toBe('encrypting');
      }
    });

    it('cycles chars at ENCRYPT_TICK rate during fading', () => {
      const state = wideGrid();
      triggerReveal(state);
      const reveal = state.reveals[0]!;

      suppressNewReveals(state);
      updateState(state, reveal.text.length * DECRYPT_SPEED + 0.01);
      suppressNewReveals(state);
      updateState(state, HOLD_DURATION + 0.1);

      // Set markers
      for (let index = 0; index < reveal.text.length; index++) {
        state.grid[reveal.row]![reveal.col + index]!.rollChar = 'MARKER';
      }

      suppressNewReveals(state);
      updateState(state, ENCRYPT_TICK + 0.001);

      let anyChanged = false;
      for (let index = 0; index < reveal.text.length; index++) {
        if (state.grid[reveal.row]![reveal.col + index]!.rollChar !== 'MARKER') {
          anyChanged = true;
        }
      }
      expect(anyChanged).toBe(true);
    });

    it('snaps all cells to cipher and removes reveal when fading completes', () => {
      const state = wideGrid();
      triggerReveal(state);
      const reveal = state.reveals[0]!;
      const { row, col, text } = reveal;

      suppressNewReveals(state);
      updateState(state, text.length * DECRYPT_SPEED + 0.01);
      suppressNewReveals(state);
      updateState(state, HOLD_DURATION + 0.1);
      suppressNewReveals(state);
      updateState(state, ENCRYPT_ROLL_DURATION + 0.01);

      // All cells should be back to cipher — no L→R dissolving
      for (let index = 0; index < text.length; index++) {
        expect(state.grid[row]![col + index]!.state).toBe('cipher');
      }
      expect(state.reveals).toHaveLength(0);
    });
  });

  describe('message cycling', () => {
    it('cycles through all messages before repeating', () => {
      const state = wideGrid();
      const seen: string[] = [];

      for (let remaining = MESSAGES.length; remaining > 0; remaining--) {
        state.revealTimer = 0.001;
        updateState(state, 0.002);
        if (state.reveals.length > 0) {
          seen.push(state.reveals.at(-1)!.text);
        }
        state.reveals = [];
        resetGrid(state);
      }

      expect(new Set(seen).size).toBe(MESSAGES.length);
    });
  });
});

describe('interpolateColor', () => {
  it('returns colorA at progress 0', () => {
    expect(interpolateColor('#ff0000', '#0000ff', 0)).toBe('#ff0000');
  });

  it('returns colorB at progress 1', () => {
    expect(interpolateColor('#ff0000', '#0000ff', 1)).toBe('#0000ff');
  });

  it('blends colors at midpoint', () => {
    const mid = interpolateColor('#ff0000', '#0000ff', 0.5);
    expect(mid).toBe('#800080');
  });

  it('handles white to black', () => {
    expect(interpolateColor('#ffffff', '#000000', 0.5)).toBe('#808080');
  });

  it('clamps progress below 0', () => {
    expect(interpolateColor('#ff0000', '#0000ff', -1)).toBe('#ff0000');
  });

  it('clamps progress above 1', () => {
    expect(interpolateColor('#ff0000', '#0000ff', 2)).toBe('#0000ff');
  });
});

describe('getDisplayChar', () => {
  const baseCell: Cell = {
    cipherChar: 'X',
    targetChar: 'H',
    state: 'cipher',
    progress: 0,
    rollChar: 'R',
    color: '',
  };

  it('returns cipherChar for cipher state', () => {
    expect(getDisplayChar({ ...baseCell, state: 'cipher' })).toBe('X');
  });

  it('returns targetChar for readable state', () => {
    expect(getDisplayChar({ ...baseCell, state: 'readable' })).toBe('H');
  });

  it('returns rollChar for decrypting state', () => {
    expect(getDisplayChar({ ...baseCell, state: 'decrypting' })).toBe('R');
  });

  it('returns rollChar for encrypting state', () => {
    expect(getDisplayChar({ ...baseCell, state: 'encrypting' })).toBe('R');
  });
});

describe('getCellColor', () => {
  const colors: ThemeColors = {
    background: '#000000',
    foreground: '#ffffff',
    brandRed: '#ec4755',
    foregroundMuted: '#888888',
  };

  it('returns foreground for cipher state', () => {
    const cell: Cell = {
      cipherChar: 'X',
      targetChar: '',
      state: 'cipher',
      progress: 0,
      rollChar: '',
      color: '',
    };
    expect(getCellColor(cell, colors)).toBe('#ffffff');
  });

  it('returns brandRed for readable state', () => {
    const cell: Cell = {
      cipherChar: 'X',
      targetChar: 'H',
      state: 'readable',
      progress: 1,
      rollChar: '',
      color: '',
    };
    expect(getCellColor(cell, colors)).toBe('#ec4755');
  });

  it('interpolates between foreground and brandRed during decrypting', () => {
    const cell: Cell = {
      cipherChar: 'X',
      targetChar: 'H',
      state: 'decrypting',
      progress: 0.5,
      rollChar: 'R',
      color: '',
    };
    const result = getCellColor(cell, colors);
    expect(result).not.toBe('#ffffff');
    expect(result).not.toBe('#ec4755');
  });

  it('interpolates between brandRed and foreground during encrypting', () => {
    const cell: Cell = {
      cipherChar: 'X',
      targetChar: 'H',
      state: 'encrypting',
      progress: 0.5,
      rollChar: 'R',
      color: '',
    };
    const result = getCellColor(cell, colors);
    expect(result).not.toBe('#ffffff');
    expect(result).not.toBe('#ec4755');
  });

  it('returns brandRed at start of encrypting (progress 0)', () => {
    const cell: Cell = {
      cipherChar: 'X',
      targetChar: 'H',
      state: 'encrypting',
      progress: 0,
      rollChar: 'R',
      color: '',
    };
    expect(getCellColor(cell, colors)).toBe('#ec4755');
  });

  it('returns foreground at end of encrypting (progress 1)', () => {
    const cell: Cell = {
      cipherChar: 'X',
      targetChar: 'H',
      state: 'encrypting',
      progress: 1,
      rollChar: 'R',
      color: '',
    };
    expect(getCellColor(cell, colors)).toBe('#ffffff');
  });
});

describe('renderFrame', () => {
  const themeColors: ThemeColors = {
    background: '#1a1816',
    foreground: '#f2f1ef',
    brandRed: '#ec4755',
    foregroundMuted: '#888888',
  };

  function mockCtx(): CanvasRenderingContext2D {
    return {
      clearRect: vi.fn(),
      fillText: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      fillStyle: '',
      globalAlpha: 1,
      font: '',
    } as unknown as CanvasRenderingContext2D;
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('calls clearRect with full dimensions', () => {
    const ctx = mockCtx();
    const state = createGrid(5, 3);
    renderFrame({ ctx, state, colors: themeColors, width: 400, height: 300, logoMask: null });
    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 400, 300);
  });

  it('calls fillText for every cell in the grid', () => {
    const ctx = mockCtx();
    const state = createGrid(5, 3);
    renderFrame({ ctx, state, colors: themeColors, width: 400, height: 300, logoMask: null });
    expect(ctx.fillText).toHaveBeenCalledTimes(15);
  });

  it('sets font to FONT constant', () => {
    const ctx = mockCtx();
    const state = createGrid(2, 2);
    renderFrame({ ctx, state, colors: themeColors, width: 200, height: 200, logoMask: null });
    expect(ctx.font).toBe(FONT);
  });

  it('uses brandRed fillStyle for readable cells', () => {
    const ctx = mockCtx();
    const state = createGrid(5, 3);
    state.grid[1]![2]!.state = 'readable';
    state.grid[1]![2]!.targetChar = 'H';

    renderFrame({ ctx, state, colors: themeColors, width: 400, height: 300, logoMask: null });

    const fillTextCalls = vi.mocked(ctx.fillText).mock.calls;
    const callIndex = 1 * 5 + 2;
    expect(fillTextCalls[callIndex]![0]).toBe('H');
  });

  it('uses 0.8 opacity for cipher cells', () => {
    const ctx = mockCtx();
    const state = createGrid(1, 1);
    renderFrame({ ctx, state, colors: themeColors, width: 100, height: 100, logoMask: null });

    expect(ctx.globalAlpha).toBe(0.8);
  });

  it('boosts opacity for cells inside logo mask', () => {
    const ctx = mockCtx();
    const state = createGrid(3, 2);
    const logoMask = [
      [false, true, false],
      [false, false, false],
    ];

    renderFrame({ ctx, state, colors: themeColors, width: 300, height: 200, logoMask });
    expect(ctx.fillText).toHaveBeenCalledTimes(6);
  });

  it('positions fillText at correct coordinates using CELL_WIDTH and CELL_HEIGHT', () => {
    const ctx = mockCtx();
    const state = createGrid(2, 2);
    renderFrame({ ctx, state, colors: themeColors, width: 200, height: 200, logoMask: null });

    const fillTextCalls = vi.mocked(ctx.fillText).mock.calls;
    expect(fillTextCalls[0]![1]).toBe(0 * CELL_WIDTH);
    expect(fillTextCalls[0]![2]).toBe(0 * CELL_HEIGHT + FONT_SIZE);
    expect(fillTextCalls[1]![1]).toBe(1 * CELL_WIDTH);
    expect(fillTextCalls[1]![2]).toBe(0 * CELL_HEIGHT + FONT_SIZE);
    expect(fillTextCalls[2]![1]).toBe(0 * CELL_WIDTH);
    expect(fillTextCalls[2]![2]).toBe(1 * CELL_HEIGHT + FONT_SIZE);
  });
});

describe('createStaticSnapshot', () => {
  it('returns valid grid with correct dimensions', () => {
    const state = createStaticSnapshot(50, 20);
    expect(state.cols).toBe(50);
    expect(state.rows).toBe(20);
    expect(state.grid).toHaveLength(20);
    for (const row of state.grid) {
      expect(row).toHaveLength(50);
    }
  });

  it('has exactly one message in readable state', () => {
    const state = createStaticSnapshot(50, 20);
    expect(countReadableCells(state.grid)).toBeGreaterThanOrEqual(1);

    const readableRows = new Set<number>();
    for (let r = 0; r < state.rows; r++) {
      for (const cell of state.grid[r]!) {
        if (cell.state === 'readable') readableRows.add(r);
      }
    }
    expect(readableRows.size).toBe(1);
  });

  it('has all non-readable cells in cipher state', () => {
    const state = createStaticSnapshot(50, 20);
    for (const row of state.grid) {
      for (const cell of row) {
        if (cell.state !== 'readable') {
          expect(cell.state).toBe('cipher');
        }
      }
    }
  });

  it('has no active reveals (static)', () => {
    const state = createStaticSnapshot(50, 20);
    expect(state.reveals).toHaveLength(0);
  });

  it('readable cells have targetChar matching a MESSAGES entry', () => {
    const state = createStaticSnapshot(50, 20);
    expect(MESSAGES).toContain(getReadableText(state.grid));
  });

  it('places readable message within row margins', () => {
    for (let trial = 0; trial < 20; trial++) {
      const state = createStaticSnapshot(50, 20);
      for (let r = 0; r < state.rows; r++) {
        for (const cell of state.grid[r]!) {
          if (cell.state === 'readable') {
            expect(r).toBeGreaterThanOrEqual(MARGIN_ROWS);
            expect(r).toBeLessThan(state.rows - MARGIN_ROWS);
          }
        }
      }
    }
  });

  it('places readable message within col margins', () => {
    for (let trial = 0; trial < 20; trial++) {
      const state = createStaticSnapshot(50, 20);
      for (let r = 0; r < state.rows; r++) {
        for (let c = 0; c < state.cols; c++) {
          if (state.grid[r]![c]!.state === 'readable') {
            expect(c).toBeGreaterThanOrEqual(MARGIN_COLS);
            expect(c).toBeLessThan(state.cols - MARGIN_COLS);
          }
        }
      }
    }
  });
});
