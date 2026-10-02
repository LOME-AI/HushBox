import { describe, expect, it } from 'vitest';

import { lookTextLine } from '../look/text.js';
import { FPS } from '../time/grid.js';
import {
  SAFE_BOX,
  SIZE_FLOOR_PX,
  claimsGate,
  insideRect,
  overlaps,
  parseLookTextLine,
  readQa,
} from './claims.js';

import type { LogoBox, TextBox } from '../look/index.js';
import type { ClaimsEvidence, Rect } from './claims.js';

/** The layout engine's smallest step: Chrome lays boxes out in sixty-fourths of a pixel. */
const STEP = 1 / 64;

describe('SAFE_BOX', () => {
  it('is the box x 65–888, y 288–1248 on the portrait frame', () => {
    expect(SAFE_BOX).toEqual({ x: 65, y: 288, width: 823, height: 960 });
  });
});

describe('insideRect', () => {
  const box: Rect = { x: 100, y: 200, width: 300, height: 400 };

  it('accepts a rect lying wholly inside', () => {
    expect(insideRect({ x: 150, y: 250, width: 100, height: 100 }, box)).toBe(true);
  });

  it('accepts a rect equal to the box', () => {
    expect(insideRect(box, box)).toBe(true);
  });

  it('refuses a rect starting one step left of the box', () => {
    expect(insideRect({ ...box, x: 100 - STEP, width: 300 - STEP }, box)).toBe(false);
  });

  it('refuses a rect starting one step above the box', () => {
    expect(insideRect({ ...box, y: 200 - STEP, height: 400 - STEP }, box)).toBe(false);
  });

  it('refuses a rect ending one step right of the box', () => {
    expect(insideRect({ ...box, width: 300 + STEP }, box)).toBe(false);
  });

  it('refuses a rect ending one step below the box', () => {
    expect(insideRect({ ...box, height: 400 + STEP }, box)).toBe(false);
  });

  it('refuses a rect with a coordinate that is not a number', () => {
    expect(insideRect({ ...box, x: Number.NaN }, box)).toBe(false);
  });

  it('refuses a rect with a size that is not a number', () => {
    expect(insideRect({ ...box, height: Number.NaN }, box)).toBe(false);
  });
});

describe('overlaps', () => {
  const a: Rect = { x: 100, y: 100, width: 200, height: 100 };

  it('finds two rects sharing an area overlapping', () => {
    expect(overlaps(a, { x: 250, y: 150, width: 200, height: 100 })).toBe(true);
  });

  it('finds a rect inside another overlapping it', () => {
    expect(overlaps(a, { x: 150, y: 120, width: 10, height: 10 })).toBe(true);
  });

  it('finds rects that only touch side by side apart', () => {
    expect(overlaps(a, { x: 300, y: 100, width: 50, height: 100 })).toBe(false);
  });

  it('finds rects crossing by one step side by side overlapping', () => {
    expect(overlaps(a, { x: 300 - STEP, y: 100, width: 50, height: 100 })).toBe(true);
  });

  it('finds rects that only touch one above the other apart', () => {
    expect(overlaps(a, { x: 100, y: 200, width: 200, height: 50 })).toBe(false);
  });

  it('finds rects crossing by one step one above the other overlapping', () => {
    expect(overlaps(a, { x: 100, y: 200 - STEP, width: 200, height: 50 })).toBe(true);
  });

  it('finds a rect to the left apart', () => {
    expect(overlaps(a, { x: 0, y: 100, width: 100, height: 100 })).toBe(false);
  });

  it('finds a rect above apart', () => {
    expect(overlaps(a, { x: 100, y: 0, width: 200, height: 100 })).toBe(false);
  });

  it('counts a rect with a coordinate that is not a number as overlapping', () => {
    expect(overlaps(a, { x: Number.NaN, y: 1000, width: 10, height: 10 })).toBe(true);
  });

  it('counts a rect with a size that is not a number as overlapping', () => {
    expect(overlaps({ ...a, width: Number.NaN }, { x: 1000, y: 1000, width: 10, height: 10 })).toBe(
      true
    );
  });
});

/** A box inside the safe box, at its top, of a size every role passes. */
function box(id: string, overrides: Partial<TextBox> = {}): TextBox {
  return {
    id,
    text: id,
    box: { x: SAFE_BOX.x, y: SAFE_BOX.y, width: 200, height: 90 },
    fontSizePx: SIZE_FLOOR_PX.headline,
    role: 'headline',
    ...overrides,
  };
}

/** The box moved down the safe box by `rows` of 100 px, so boxes on different rows never overlap. */
function row(id: string, rows: number, overrides: Partial<TextBox> = {}): TextBox {
  return box(id, {
    box: { x: SAFE_BOX.x, y: SAFE_BOX.y + rows * 100, width: 200, height: 90 },
    ...overrides,
  });
}

/** Every frame of `[from, to)` holding the same boxes. */
function held(from: number, to: number, boxes: readonly TextBox[]): Map<number, TextBox[]> {
  return new Map(Array.from({ length: to - from }, (_, index) => [from + index, [...boxes]]));
}

function evidence(
  frames: ReadonlyMap<number, readonly TextBox[]>,
  rows: ClaimsEvidence['rows'] = []
): ClaimsEvidence {
  return { rows, frames };
}

describe('SIZE_FLOOR_PX', () => {
  it('holds headline and end-card (cta) text to 84 px and support text to 44 px', () => {
    expect(SIZE_FLOOR_PX).toEqual({ headline: 84, cta: 84, support: 44 });
  });
});

describe('parseLookTextLine', () => {
  const boxes = [box('a1')];

  it('reads the frame of a look text line', () => {
    expect(parseLookTextLine(lookTextLine(12, boxes))?.frame).toBe(12);
  });

  it('reads the boxes of a look text line', () => {
    expect(parseLookTextLine(lookTextLine(12, boxes))?.boxes).toEqual(boxes);
  });

  it('reads a resting mark beside the text boxes of a look text line', () => {
    const mark: LogoBox = {
      id: 'mark',
      box: { x: 300, y: 1240, width: 480, height: 483 },
      role: 'logo',
    };

    expect(parseLookTextLine(lookTextLine(12, [...boxes, mark]))?.boxes).toEqual([...boxes, mark]);
  });

  it('passes over a line that is not a look text line', () => {
    expect(parseLookTextLine('another console line')).toBeNull();
  });

  it('refuses a look text line that holds no JSON', () => {
    expect(() => parseLookTextLine('films-look-text: {')).toThrow(/holds no JSON/);
  });

  it('refuses a look text line whose frame is not a whole frame', () => {
    expect(() => parseLookTextLine('films-look-text: {"frame":1.5,"boxes":[]}')).toThrow(
      /look text line/
    );
  });

  it('refuses a look text line whose box breaks the text box contract', () => {
    expect(() => parseLookTextLine('films-look-text: {"frame":3,"boxes":[{"id":"a1"}]}')).toThrow(
      /frame 3/
    );
  });
});

describe('claimsGate: the safe box', () => {
  it('passes a box inside the safe box', () => {
    expect(claimsGate('film', evidence(held(0, 2, [box('a1')]))).passed).toBe(true);
  });

  it('fails a copy box that leaves the safe box, naming the rule, the frames and the text', () => {
    const outside = box('a1', {
      box: { x: SAFE_BOX.x - 1, y: SAFE_BOX.y, width: 200, height: 90 },
    });

    expect(claimsGate('film', evidence(held(4, 7, [outside]))).failures).toEqual([
      'film: safe-box: frames 4–6, text "a1": at frame 4 its box x 64–264, y 288–378 leaves the safe box x 65–888, y 288–1248',
    ]);
  });

  it('lets imagery sit outside the safe box', () => {
    const imagery = box('caption', {
      role: 'imagery',
      box: { x: 0, y: 1600, width: 200, height: 40 },
      fontSizePx: 10,
    });

    expect(claimsGate('film', evidence(held(0, 2, [imagery]))).passed).toBe(true);
  });
});

describe('claimsGate: overlap', () => {
  it('fails two copy boxes that overlap, naming both', () => {
    expect(claimsGate('film', evidence(held(0, 1, [box('a1'), box('a2')]))).failures).toEqual([
      'film: overlap: frame 0, text "a1": at frame 0 its box overlaps the box of text "a2"',
    ]);
  });

  it('passes copy boxes on separate rows', () => {
    expect(claimsGate('film', evidence(held(0, 1, [row('a1', 0), row('a2', 1)]))).passed).toBe(
      true
    );
  });

  it('lets imagery overlap copy', () => {
    const imagery = box('caption', { role: 'imagery', fontSizePx: 10 });

    expect(claimsGate('film', evidence(held(0, 1, [box('a1'), imagery]))).passed).toBe(true);
  });
});

describe('claimsGate: the size floor', () => {
  it('accepts a headline at 84 px', () => {
    expect(claimsGate('film', evidence(held(0, 1, [box('a1', { fontSizePx: 84 })]))).passed).toBe(
      true
    );
  });

  it('fails a headline at 83 px, naming its size and its floor', () => {
    expect(
      claimsGate('film', evidence(held(0, 1, [box('a1', { fontSizePx: 83 })]))).failures
    ).toEqual([
      'film: size-floor: frame 0, text "a1": at frame 0 a headline set at 83 px, below 84 px',
    ]);
  });

  it('fails a headline whose size is not a number', () => {
    expect(
      claimsGate('film', evidence(held(0, 1, [box('a1', { fontSizePx: Number.NaN })]))).failures
    ).toEqual([
      'film: size-floor: frame 0, text "a1": at frame 0 a headline set at NaN px, which is not a finite size',
    ]);
  });

  it('fails a headline whose size is infinite', () => {
    const infinite = box('a1', { fontSizePx: Number.POSITIVE_INFINITY });

    expect(claimsGate('film', evidence(held(0, 1, [infinite]))).failures).toEqual([
      'film: size-floor: frame 0, text "a1": at frame 0 a headline set at Infinity px, which is not a finite size',
    ]);
  });

  it('fails support text whose size is not a number', () => {
    const support = box('lt', { role: 'support', fontSizePx: Number.NaN });

    expect(claimsGate('film', evidence(held(0, 1, [support]))).passed).toBe(false);
  });

  it('fails a cta, the end card, at 83 px', () => {
    const cta = box('url', { role: 'cta', fontSizePx: 83 });

    expect(claimsGate('film', evidence(held(0, 1, [cta]))).passed).toBe(false);
  });

  it('accepts support text at 44 px', () => {
    const support = box('lt', { role: 'support', fontSizePx: 44 });

    expect(claimsGate('film', evidence(held(0, 1, [support]))).passed).toBe(true);
  });

  it('fails support text at 43 px', () => {
    const support = box('lt', { role: 'support', fontSizePx: 43 });

    expect(claimsGate('film', evidence(held(0, 1, [support]))).passed).toBe(false);
  });

  it('sets no floor for imagery', () => {
    const imagery = box('caption', { role: 'imagery', fontSizePx: 1 });

    expect(claimsGate('film', evidence(held(0, 1, [imagery]))).passed).toBe(true);
  });
});

describe('claimsGate: reading time', () => {
  const line = { id: 'a1', role: 'headline', from: 10, to: 10 + FPS } as const;

  it('passes a copy row whose box is on screen on every frame of its span', () => {
    expect(claimsGate('film', evidence(held(10, 10 + FPS, [box('a1')]), [line])).passed).toBe(true);
  });

  it('fails a copy row removed before its span ends, naming the frames it is missing on', () => {
    expect(claimsGate('film', evidence(held(10, 40, [box('a1')]), [line])).failures).toEqual([
      `film: reading-time: frames 40–${String(9 + FPS)}, text "a1": absent from ${String(FPS - 30)} of the ${String(FPS)} frames of its span, frames 10–${String(9 + FPS)}`,
    ]);
  });

  it('fails a copy row missing from a frame inside its span', () => {
    const frames = held(10, 10 + FPS, [box('a1')]);
    frames.set(20, []);

    expect(claimsGate('film', evidence(frames, [line])).failures).toEqual([
      `film: reading-time: frame 20, text "a1": absent from 1 of the ${String(FPS)} frames of its span, frames 10–${String(9 + FPS)}`,
    ]);
  });

  it('asks nothing of an imagery row', () => {
    const imagery = { id: 'caption', role: 'imagery', from: 0, to: FPS } as const;

    expect(claimsGate('film', evidence(new Map(), [imagery])).passed).toBe(true);
  });
});

describe('claimsGate: failures across frames', () => {
  it('lists separate runs of frames a rule broke on', () => {
    const outside = box('a1', { box: { x: 0, y: SAFE_BOX.y, width: 200, height: 90 } });
    const frames = new Map([
      [1, [outside]],
      [2, [outside]],
      [5, [outside]],
      [3, [box('a1')]],
    ]);

    expect(claimsGate('film', evidence(frames)).failures[0]).toMatch(
      /^film: safe-box: frames 1–2, 5, text "a1": at frame 1 /
    );
  });

  it('names each text that broke a rule once', () => {
    const small = [box('a1', { fontSizePx: 60 }), row('a2', 1, { fontSizePx: 60 })];

    expect(claimsGate('film', evidence(held(0, 3, small))).failures).toHaveLength(2);
  });
});

describe('claimsGate: what it measured', () => {
  it('reports the frames and copy rows it read', () => {
    const line = { id: 'a1', role: 'headline', from: 0, to: 2 } as const;

    expect(claimsGate('film', evidence(held(0, 2, [box('a1')]), [line])).measured).toEqual([
      '2 frames of text boxes; 1 copy row held across its span; smallest copy text 84 px (frame 0, text "a1")',
    ]);
  });

  it('says so when no frame holds copy text', () => {
    expect(claimsGate('film', evidence(held(0, 2, []))).measured).toEqual([
      '2 frames of text boxes; 0 copy rows held across their spans; no frame holds copy text',
    ]);
  });
});

describe('readQa', () => {
  it('is off when the input props do not set qa', () => {
    expect(readQa({})).toBe(false);
  });

  it('is on when qa is true', () => {
    expect(readQa({ qa: true })).toBe(true);
  });

  it('is off when qa is false', () => {
    expect(readQa({ qa: false })).toBe(false);
  });

  it('ignores the other input props', () => {
    expect(readQa({ qa: true, offSafe: true })).toBe(true);
  });

  it('refuses a qa that is not a boolean, naming it', () => {
    expect(() => readQa({ qa: 'true' })).toThrow(/input prop qa must be true or false, got "true"/);
  });
});
