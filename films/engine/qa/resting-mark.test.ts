import { createRequire } from 'node:module';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import {
  RESTING_MARK_CONTRAST,
  RESTING_MARK_COLOUR_DIFFERENCE,
  RESTING_MARK_FLOOR,
  RESTING_MARK_PROPORTION,
  deltaE2000,
  labOf,
  markImageOf,
  measureRestingMark,
  restingMarkGate,
  restingRunEnds,
} from './resting-mark.js';

import type { LogoBox } from '../look/contract.js';
import type { Raster } from './raster.js';
import type { MarkImage, RestingMark } from './resting-mark.js';

const FIELD = [26, 24, 22] as const;
const RED = [236, 71, 85] as const;

/**
 * A 6×5 mark of two parts: a 3×3 block and a one-pixel dot, with a
 * transparent margin, as a logo file's opaque pixels.
 */
const ROWS = ['......', '.###..', '.###.#', '.###..', '......'];
const MARK: MarkImage = {
  width: 6,
  height: 5,
  mask: Uint8Array.from(ROWS.join(''), (cell) => (cell === '#' ? 1 : 0)),
  colour: RED,
};

type Colour = readonly [number, number, number];

/** A frame of the field colour, or of the colour each row's `background` gives it. */
function frame(
  width: number,
  height: number,
  background: (row: number) => Colour = () => FIELD
): Raster {
  const data = new Uint8Array(width * height * 3);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      data.set(background(row), (row * width + column) * 3);
    }
  }
  return { width, height, channels: 3, data };
}

/** Each `#` cell of the rows, as its column and row. */
function cells(rows: readonly string[]): [number, number][] {
  return rows.flatMap((line, y) =>
    [...line.matchAll(/#/g)].map((match): [number, number] => [match.index, y])
  );
}

interface Paint {
  at: { x: number; y: number };
  scale?: number;
  rows?: readonly string[];
  colour?: Colour;
}

/** The raster with the rows' `#` cells painted, each as a `scale`-pixel square from (x, y). */
function painted(raster: Raster, { at, scale = 1, rows = ROWS, colour = RED }: Paint): Raster {
  const data = Uint8Array.from(raster.data);
  for (const [x, y] of cells(rows)) {
    for (let pixel = 0; pixel < scale * scale; pixel++) {
      const column = at.x + x * scale + (pixel % scale);
      const row = at.y + y * scale + Math.floor(pixel / scale);
      data.set(colour, (row * raster.width + column) * raster.channels);
    }
  }
  return { ...raster, data };
}

/** A background that brightens from row to row. */
function ramp(row: number): Colour {
  return [20 + row * 8, 30 + row * 4, 40];
}

function box(x: number, y: number, scale = 1): LogoBox {
  return {
    id: 'mark',
    box: { x, y, width: MARK.width * scale, height: MARK.height * scale },
    role: 'logo',
  };
}

function measured(drawn: Raster, mark: LogoBox = box(4, 3)): RestingMark {
  return measureRestingMark({ frame: 7, mark, drawn, logo: MARK });
}

type Matched = Extract<RestingMark, { outside: null }>;

/** The measure of a mark whose box lies inside the frame. */
function matched(drawn: Raster, mark: LogoBox = box(4, 3)): Matched {
  const measure = measured(drawn, mark);
  if (measure.outside !== null) {
    throw new Error(`the box ${measure.outside} lies outside the frame`);
  }
  return measure;
}

describe('measureRestingMark', () => {
  it('matches the exact mark drawn at 1:1 in its box', () => {
    expect(measured(painted(frame(20, 12), { at: { x: 4, y: 3 } }))).toMatchObject({
      frame: 7,
      id: 'mark',
      iou: 1,
      outside: null,
    });
  });

  it('compares a mark drawn at 1:1 on the logo file’s grid', () => {
    expect(matched(painted(frame(20, 12), { at: { x: 4, y: 3 } })).grid).toEqual({
      width: 6,
      height: 5,
      across: 'file',
      down: 'file',
    });
  });

  it('compares a mark drawn at half size on the box’s grid', () => {
    const half: LogoBox = { id: 'mark', box: { x: 4, y: 3, width: 3, height: 2.5 }, role: 'logo' };

    expect(matched(frame(20, 12), half).grid).toEqual({
      width: 3,
      height: 2,
      across: 'box',
      down: 'box',
    });
  });

  it('compares a mark drawn wider than the file and shorter on each axis’s coarser grid', () => {
    const wide: LogoBox = { id: 'mark', box: { x: 2, y: 3, width: 12, height: 2.5 }, role: 'logo' };

    expect(matched(frame(20, 12), wide).grid).toEqual({
      width: 6,
      height: 2,
      across: 'file',
      down: 'box',
    });
  });

  it('reads the exact mark’s box as the logo file’s proportions', () => {
    expect(matched(painted(frame(20, 12), { at: { x: 4, y: 3 } })).proportion).toBe(0);
  });

  it('reads a box twice as wide as the file’s proportions as 100 % off them', () => {
    const wide: LogoBox = { id: 'mark', box: { x: 2, y: 3, width: 12, height: 5 }, role: 'logo' };

    expect(matched(frame(20, 12), wide).proportion).toBeCloseTo(1, 12);
  });

  it('reads the mark colour and its surroundings from the drawn pixels', () => {
    expect(measured(painted(frame(20, 12), { at: { x: 4, y: 3 } }))).toMatchObject({
      colour: RED,
      surroundings: FIELD,
    });
  });

  it('reads no colour difference for a mark drawn in the logo file’s colour', () => {
    expect(matched(painted(frame(20, 12), { at: { x: 4, y: 3 } })).deltaE).toBe(0);
  });

  it('reads the colour difference of a mark drawn in another colour', () => {
    const blue: Colour = [71, 160, 236];
    const drawn = painted(frame(20, 12), { at: { x: 4, y: 3 }, colour: blue });

    expect(matched(drawn).deltaE).toBeCloseTo(deltaE2000(labOf(RED), labOf(blue)), 12);
  });

  it('reads the mark’s WCAG contrast against its surroundings', () => {
    const white: Colour = [255, 255, 255];
    const black: Colour = [0, 0, 0];
    const drawn = painted(
      frame(20, 12, () => black),
      { at: { x: 4, y: 3 }, colour: white }
    );

    expect(matched(drawn).contrast).toBeCloseTo(21, 12);
  });

  it('reads a knockout, the mark in the ground’s colour on a field of the logo’s, as the ground’s colour', () => {
    const knockout = painted(
      frame(20, 12, () => RED),
      { at: { x: 4, y: 3 }, colour: FIELD }
    );

    expect(measured(knockout)).toMatchObject({ iou: 1, colour: FIELD, surroundings: RED });
  });

  it('matches the exact mark drawn at 2× in a box twice the size', () => {
    const drawn = painted(frame(20, 16), { at: { x: 2, y: 3 }, scale: 2 });

    expect(measured(drawn, box(2, 3, 2)).iou).toBe(1);
  });

  it('counts a file pixel whose 2× block is three quarters mark as mark', () => {
    const drawn = painted(frame(20, 16), { at: { x: 2, y: 3 }, scale: 2 });
    // The dot's block at 2×: file pixel (5, 2) covers drawn pixels x 12–13, y 7–8; clear the one its centre touches last.
    drawn.data.set(FIELD, (8 * 20 + 13) * 3);

    expect(measured(drawn, box(2, 3, 2)).iou).toBe(1);
  });

  it('leaves out a file pixel whose 2× block is one quarter mark', () => {
    const drawn = painted(frame(20, 16), { at: { x: 2, y: 3 }, scale: 2 });
    // One drawn pixel of the transparent file pixel (0, 0)'s block, x 2–3, y 3–4: the one its centre touches last.
    drawn.data.set(RED, (4 * 20 + 3) * 3);

    expect(measured(drawn, box(2, 3, 2)).iou).toBe(1);
  });

  it('compares a mark drawn at half size with the file box-filtered down to the box', () => {
    // At half size the box's drawn pixels x 4–6, y 3–4 each cover a 2×2 block of the file. The
    // blocks at least half opaque are file columns 2–3 of rows 0–1, and columns 0–1 and 2–3 of rows 2–3.
    const drawn = painted(frame(20, 12), { at: { x: 4, y: 3 }, rows: ['.#.', '##.'] });
    const half: LogoBox = { id: 'mark', box: { x: 4, y: 3, width: 3, height: 2.5 }, role: 'logo' };

    expect(measured(drawn, half).iou).toBe(1);
  });

  it('weighs each file pixel by the share of a drawn pixel’s footprint it covers', () => {
    // Box x 4.2–7.2, y 3.2–5.7 at half size: drawn pixel (5, 3) covers file rows 0–1.6 and columns
    // 1.6–3.6, and only file row 1's 0.6 of that height is opaque, 0.375 of the footprint. Counting
    // every file pixel it touches whole would read half of it opaque and call it mark.
    const drawn = painted(frame(20, 12), { at: { x: 4, y: 3 }, rows: ['...', '.#.'] });
    const half: LogoBox = {
      id: 'mark',
      box: { x: 4.2, y: 3.2, width: 3, height: 2.5 },
      role: 'logo',
    };

    expect(measured(drawn, half).iou).toBe(1);
  });

  it('matches the exact mark on a background that changes from row to row', () => {
    const drawn = painted(frame(20, 12, ramp), { at: { x: 4, y: 3 } });

    expect(measured(drawn).iou).toBe(1);
  });

  it('reads a four-channel raster as it reads a three-channel one', () => {
    const three = painted(frame(20, 12), { at: { x: 4, y: 3 } });
    const data = new Uint8Array(20 * 12 * 4);
    for (let pixel = 0; pixel < 20 * 12; pixel++) {
      data.set([...three.data.subarray(pixel * 3, pixel * 3 + 3), 255], pixel * 4);
    }

    expect(measured({ width: 20, height: 12, channels: 4, data }).iou).toBe(1);
  });

  it('matches a mark drawn one pixel right of its box by its overlap alone', () => {
    // Shifted, the block's 9 pixels overlap the file's block on 6 and the dot leaves the box: 6 of 13.
    expect(measured(painted(frame(20, 12), { at: { x: 5, y: 3 } })).iou).toBe(6 / 13);
  });

  it('matches a mark missing its dot by the parts it drew', () => {
    const rows = ROWS.map((line) => line.replace(/#$/, '.'));

    expect(measured(painted(frame(20, 12), { at: { x: 4, y: 3 }, rows })).iou).toBe(9 / 10);
  });

  it('matches nothing in a box where nothing is drawn', () => {
    expect(measured(frame(20, 12)).iou).toBe(0);
  });

  it('reads a box that reaches past the frame as outside it, naming the box', () => {
    expect(measured(frame(20, 12), box(16, 3)).outside).toBe('x 16–22, y 3–8');
  });

  it('reads a box that starts above the frame as outside it', () => {
    expect(measured(frame(20, 12), box(4, -1)).iou).toBeNull();
  });

  it('reads a box that fits the frame to its last pixel as inside it', () => {
    expect(measured(painted(frame(10, 5), { at: { x: 4, y: 0 } }), box(4, 0)).iou).toBe(1);
  });

  it('matches nothing in a box too small to hold a drawn pixel', () => {
    const speck: LogoBox = {
      id: 'mark',
      box: { x: 4, y: 3, width: 0.4, height: 0.4 },
      role: 'logo',
    };

    expect(measured(painted(frame(20, 12), { at: { x: 4, y: 3 } }), speck)).toMatchObject({
      iou: 0,
      deltaE: Number.NaN,
      contrast: Number.NaN,
    });
  });

  it('refuses a logo image with no pixel inside the mark', () => {
    const blank: MarkImage = { ...MARK, mask: new Uint8Array(MARK.mask.length) };

    expect(() =>
      measureRestingMark({ frame: 7, mark: box(4, 3), drawn: frame(20, 12), logo: blank })
    ).toThrow(/pixels inside the mark and outside it/);
  });

  it('refuses a mask that is not one value for each pixel of the logo image', () => {
    const short: MarkImage = { ...MARK, mask: new Uint8Array(3) };

    expect(() =>
      measureRestingMark({ frame: 7, mark: box(4, 3), drawn: frame(20, 12), logo: short })
    ).toThrow(/6×5 .*30 values, got 3/);
  });

  it('refuses a logo colour that is not three channels', () => {
    const grey: MarkImage = { ...MARK, colour: [128] };

    expect(() =>
      measureRestingMark({ frame: 7, mark: box(4, 3), drawn: frame(20, 12), logo: grey })
    ).toThrow(/logo colour holds 3 channels, got 1/);
  });
});

describe('labOf', () => {
  it('reads sRGB white as CIELAB L 100 with no chroma', () => {
    const [lightness, a, b] = labOf([255, 255, 255]);

    expect([lightness, Math.abs(a), Math.abs(b)].map((value) => Number(value.toFixed(2)))).toEqual([
      100, 0, 0,
    ]);
  });

  it('reads sRGB black as CIELAB L 0', () => {
    expect(labOf([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it('reads sRGB red as CIELAB (53.24, 80.09, 67.20) under D65', () => {
    expect(labOf([255, 0, 0]).map((value) => Number(value.toFixed(2)))).toEqual([
      53.24, 80.09, 67.2,
    ]);
  });

  it('reads a dark grey on the linear segment of CIELAB’s lightness curve', () => {
    // sRGB 1 is linear light 1 / 255 / 12.92, below (6 / 29)³: L = 903.3 × Y.
    expect(labOf([1, 1, 1])[0]).toBeCloseTo((24_389 / 27) * (1 / 255 / 12.92), 3);
  });
});

describe('deltaE2000', () => {
  // Pairs and expected differences from Sharma, Wu and Dalal, "The CIEDE2000 color-difference
  // formula: implementation notes, supplementary test data, and mathematical observations" (2005).
  const SHARMA: [readonly [number, number, number], readonly [number, number, number], number][] = [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 0, 0], [50, -1, 2], 2.3669],
    [[50, 2.49, -0.001], [50, -2.49, 0.0009], 7.1792],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
  ];

  it.each(SHARMA)('gives Sharma’s difference between %j and %j', (one, two, expected) => {
    expect(deltaE2000(one, two)).toBeCloseTo(expected, 4);
  });

  it('gives no difference between a colour and itself', () => {
    expect(deltaE2000([53.24, 80.09, 67.2], [53.24, 80.09, 67.2])).toBe(0);
  });

  it('gives no difference between two neutral greys of one lightness', () => {
    expect(deltaE2000([40, 0, 0], [40, 0, 0])).toBe(0);
  });

  it('gives the same difference in both directions', () => {
    const [one, two] = [labOf([236, 71, 85]), labOf([71, 160, 236])];

    expect(deltaE2000(one, two)).toBeCloseTo(deltaE2000(two, one), 12);
  });
});

describe('markImageOf', () => {
  const PIXELS = {
    width: 3,
    height: 1,
    data: [236, 71, 85, 255, 237, 71, 85, 255, 0, 0, 0, 0],
  };

  it('reads the mark as the pixels at or above half alpha', () => {
    expect([...markImageOf(PIXELS).mask]).toEqual([1, 1, 0]);
  });

  it('reads the logo colour as the median of the opaque pixels’ colours', () => {
    expect(markImageOf(PIXELS).colour).toEqual([236, 71, 85]);
  });

  it('keeps the file’s size', () => {
    expect(markImageOf(PIXELS)).toMatchObject({ width: 3, height: 1 });
  });
});

function mark(iou: number | null, frameNumber = 7, look: Partial<Matched> = {}): RestingMark {
  return iou === null
    ? { frame: frameNumber, id: 'mark', iou, outside: 'x 16–22, y 3–8' }
    : {
        frame: frameNumber,
        id: 'mark',
        iou,
        outside: null,
        proportion: 0,
        colour: RED,
        surroundings: FIELD,
        deltaE: 0,
        contrast: 4.2,
        grid: { width: 6, height: 5, across: 'file', down: 'file' },
        ...look,
      };
}

describe('restingMarkGate', () => {
  it('passes a resting mark at the floor', () => {
    expect(restingMarkGate('film', [mark(RESTING_MARK_FLOOR)]).passed).toBe(true);
  });

  it('fails a resting mark just below the floor', () => {
    expect(restingMarkGate('film', [mark(0.989_999)]).passed).toBe(false);
  });

  it('names the film, the frame, the mark and its match when it fails', () => {
    expect(restingMarkGate('film', [mark(0.9624)]).failures).toEqual([
      'film: resting-mark: frame 7, mark "mark": the pixels drawn in its box, box-filtered to the logo file’s 6×5, match the file’s opaque pixels at IoU 0.96240, below 0.99',
    ]);
  });

  it('names the comparison at the box’s resolution for a mark drawn smaller than the file', () => {
    const smaller = mark(0.9624, 7, {
      grid: { width: 420, height: 423, across: 'box', down: 'box' },
    });

    expect(restingMarkGate('film', [smaller]).failures).toEqual([
      'film: resting-mark: frame 7, mark "mark": the pixels drawn in its box, read at the box’s 420×423, match the logo file box-filtered down to that size at IoU 0.96240, below 0.99',
    ]);
  });

  it('names a grid at the file’s resolution on one axis and the box’s on the other', () => {
    const mixed = mark(0.9624, 7, { grid: { width: 6, height: 2, across: 'file', down: 'box' } });

    expect(restingMarkGate('film', [mixed]).failures).toEqual([
      'film: resting-mark: frame 7, mark "mark": the pixels drawn in its box and the logo file, each box-filtered to a 6×2 grid (the file’s resolution across, the box’s down), match at IoU 0.96240, below 0.99',
    ]);
  });

  it('fails a resting mark whose match is not a number', () => {
    expect(restingMarkGate('film', [mark(Number.NaN)]).passed).toBe(false);
  });

  it('fails a resting mark whose box leaves the frame, naming the box', () => {
    expect(restingMarkGate('film', [mark(null)]).failures).toEqual([
      'film: resting-mark: frame 7, mark "mark": its box x 16–22, y 3–8 reaches outside the frame',
    ]);
  });

  it('passes a box whose proportions are 1 % off the file’s', () => {
    expect(
      restingMarkGate('film', [mark(1, 7, { proportion: RESTING_MARK_PROPORTION })]).passed
    ).toBe(true);
  });

  it('fails a box whose proportions are more than 1 % off the file’s, naming the cause', () => {
    expect(restingMarkGate('film', [mark(1, 7, { proportion: 1 })]).failures).toEqual([
      'film: resting-mark-proportion: frame 7, mark "mark": its box’s proportions differ from the logo file’s by 100.00 %, above 1 %',
    ]);
  });

  it('fails a box whose proportions are not a number', () => {
    expect(restingMarkGate('film', [mark(1, 7, { proportion: Number.NaN })]).passed).toBe(false);
  });

  it('passes a mark colour ΔE00 3 from the file’s', () => {
    expect(
      restingMarkGate('film', [mark(1, 7, { deltaE: RESTING_MARK_COLOUR_DIFFERENCE })]).passed
    ).toBe(true);
  });

  it('fails a mark colour more than ΔE00 3 from the file’s, naming the colour', () => {
    expect(
      restingMarkGate('film', [mark(1, 7, { deltaE: 41.5, colour: [71, 160, 236] })]).failures
    ).toEqual([
      'film: resting-mark-colour: frame 7, mark "mark": its colour rgb(71, 160, 236) differs from the logo file’s by ΔE00 41.50, above 3',
    ]);
  });

  it('fails a mark colour whose difference is not a number', () => {
    expect(restingMarkGate('film', [mark(1, 7, { deltaE: Number.NaN })]).passed).toBe(false);
  });

  it('passes a mark at 3:1 against its surroundings', () => {
    expect(restingMarkGate('film', [mark(1, 7, { contrast: RESTING_MARK_CONTRAST })]).passed).toBe(
      true
    );
  });

  it('fails a mark below 3:1 against its surroundings, naming both colours', () => {
    expect(
      restingMarkGate('film', [
        mark(1, 7, { contrast: 1.0042, colour: RED, surroundings: [235, 71, 85] }),
      ]).failures
    ).toEqual([
      'film: resting-mark-contrast: frame 7, mark "mark": its colour rgb(236, 71, 85) against its surroundings rgb(235, 71, 85) contrasts at 1.00:1, below 3:1',
    ]);
  });

  it('fails a mark whose contrast is not a number', () => {
    expect(restingMarkGate('film', [mark(1, 7, { contrast: Number.NaN })]).passed).toBe(false);
  });

  it('writes a colour read as a mean to the nearest level', () => {
    expect(
      restingMarkGate('film', [mark(1, 7, { deltaE: 9, colour: [70.6, 160.2, 235.5] })]).failures
    ).toEqual([
      'film: resting-mark-colour: frame 7, mark "mark": its colour rgb(71, 160, 236) differs from the logo file’s by ΔE00 9.00, above 3',
    ]);
  });

  it('is the gate named logo', () => {
    expect(restingMarkGate('film', []).gate).toBe('logo');
  });

  it('reports the lowest match among the resting marks it read', () => {
    expect(restingMarkGate('film', [mark(1, 3), mark(0.995, 9)]).measured[0]).toBe(
      '2 resting marks on 2 frames; lowest IoU 0.99500 (frame 9, mark "mark")'
    );
  });

  it('reports one resting mark on one frame in the singular', () => {
    expect(restingMarkGate('film', [mark(1, 3)]).measured[0]).toBe(
      '1 resting mark on 1 frame; lowest IoU 1.00000 (frame 3, mark "mark")'
    );
  });

  it('reports the largest proportion difference, colour difference and lowest contrast it read', () => {
    const marks = [
      mark(1, 3, { proportion: 0.002, deltaE: 0.4, contrast: 3.5 }),
      mark(1, 9, { proportion: 0.001, deltaE: 1.25, contrast: 4.5 }),
    ];

    expect(restingMarkGate('film', marks).measured.slice(1)).toEqual([
      'largest proportion difference 0.20 % (frame 3, mark "mark")',
      'largest colour difference ΔE00 1.25 (frame 9, mark "mark")',
      'lowest contrast 3.50:1 (frame 3, mark "mark")',
    ]);
  });

  it('reports that no resting mark could be matched when every box leaves the frame', () => {
    expect(restingMarkGate('film', [mark(null)]).measured).toEqual([
      '1 resting mark on 1 frame; none could be matched',
    ]);
  });

  it('reports when no compared frame reports a resting mark', () => {
    expect(restingMarkGate('film', []).measured).toEqual([
      'no compared frame reports a resting mark',
    ]);
  });
});

/** One resting mark per listed frame, all in one box unless `boxes` places a frame elsewhere. */
function resting(
  frames: readonly number[],
  boxes: Record<number, LogoBox['box']> = {}
): [number, LogoBox[]][] {
  return frames.map((frameNumber) => [
    frameNumber,
    [{ ...box(4, 3), box: boxes[frameNumber] ?? box(4, 3).box }],
  ]);
}

describe('restingRunEnds', () => {
  it('gives the first and the last frame of each run of consecutive frames, ascending', () => {
    expect(restingRunEnds(resting([12, 10, 11, 30, 31, 32, 33]))).toEqual([10, 12, 30, 33]);
  });

  it('gives a run of one frame once', () => {
    expect(restingRunEnds(resting([5, 9]))).toEqual([5, 9]);
  });

  it('gives a run of two frames as both', () => {
    expect(restingRunEnds(resting([5, 6]))).toEqual([5, 6]);
  });

  it('gives nothing for no frames', () => {
    expect(restingRunEnds([])).toEqual([]);
  });

  it('skips a frame that reports no resting mark', () => {
    expect(restingRunEnds([[3, []], ...resting([4, 5, 6])])).toEqual([4, 6]);
  });

  it('breaks a run where the box moves, giving each box its first and last frame', () => {
    const moved = { ...box(4, 3).box, y: 40 };

    expect(restingRunEnds(resting([0, 1, 2, 3, 4, 5], { 3: moved, 4: moved, 5: moved }))).toEqual([
      0, 2, 3, 5,
    ]);
  });

  it('breaks a run where the box changes size alone', () => {
    const grown = { ...box(4, 3).box, width: 7 };

    expect(restingRunEnds(resting([0, 1, 2, 3], { 2: grown, 3: grown }))).toEqual([0, 1, 2, 3]);
  });

  it('keeps a run whose box holds still', () => {
    expect(restingRunEnds(resting([0, 1, 2, 3]))).toEqual([0, 3]);
  });

  it('follows each mark’s runs on its own', () => {
    const other: LogoBox = { ...box(9, 3), id: 'other' };
    const rendered: [number, LogoBox[]][] = [0, 1, 2, 3].map((frameNumber) => [
      frameNumber,
      frameNumber < 2 ? [box(4, 3), other] : [box(4, 3)],
    ]);

    expect(restingRunEnds(rendered)).toEqual([0, 1, 3]);
  });
});

const LOGO_FILE = createRequire(import.meta.url).resolve('@hushbox/ui/assets/HushBoxLogo.png');

/** The logo file drawn over the field at a scale from (x, y), nearest-neighbour, as a frame. */
async function logoFrame({
  scale,
  at,
}: {
  scale: number;
  at: { x: number; y: number };
}): Promise<{ drawn: Raster; logo: MarkImage }> {
  const { data, info } = await sharp(LOGO_FILE)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const logo = markImageOf({ ...info, data });
  const drawn = frame(info.width * 2 + 40, info.height * 2 + 40);
  for (let row = 0; row < info.height * scale; row++) {
    for (let column = 0; column < info.width * scale; column++) {
      const source = Math.floor(row / scale) * info.width + Math.floor(column / scale);
      if (logo.mask[source] === 1) {
        drawn.data.set(RED, ((at.y + row) * drawn.width + at.x + column) * 3);
      }
    }
  }
  return { drawn, logo };
}

describe('the brand logo file at rest', () => {
  it('matches the file drawn at 1:1', async () => {
    const { drawn, logo } = await logoFrame({ scale: 1, at: { x: 20, y: 20 } });
    const mark: LogoBox = {
      id: 'mark',
      box: { x: 20, y: 20, width: logo.width, height: logo.height },
      role: 'logo',
    };

    expect(measureRestingMark({ frame: 0, mark, drawn, logo }).iou).toBe(1);
  });

  it('matches the file drawn at 2×', async () => {
    const { drawn, logo } = await logoFrame({ scale: 2, at: { x: 20, y: 20 } });
    const mark: LogoBox = {
      id: 'mark',
      box: { x: 20, y: 20, width: logo.width * 2, height: logo.height * 2 },
      role: 'logo',
    };

    expect(measureRestingMark({ frame: 0, mark, drawn, logo }).iou).toBe(1);
  });

  it('falls below the floor when the file is drawn one pixel right of its box', async () => {
    const { drawn, logo } = await logoFrame({ scale: 1, at: { x: 21, y: 20 } });
    const mark: LogoBox = {
      id: 'mark',
      box: { x: 20, y: 20, width: logo.width, height: logo.height },
      role: 'logo',
    };

    expect(measureRestingMark({ frame: 0, mark, drawn, logo }).iou).toBeLessThan(
      RESTING_MARK_FLOOR
    );
  });

  it('reads the file’s own colour, equal to the brand red', async () => {
    const { logo } = await logoFrame({ scale: 1, at: { x: 20, y: 20 } });

    expect(logo.colour).toEqual([236, 71, 85]);
  });

  it('matches the exact mark drawn at 0.875×', async () => {
    const { drawn, logo } = await coveredLogoFrame({ scale: 0.875, at: { x: 20, y: 20.5 } });

    expect(
      measureRestingMark({ frame: 0, mark: scaledBox(logo, 0.875, 20, 20.5), drawn, logo }).iou
    ).toBeGreaterThanOrEqual(RESTING_MARK_FLOOR);
  });

  it('falls below the floor when the mark drawn at 0.875× sits one pixel right of its box', async () => {
    const { drawn, logo } = await coveredLogoFrame({ scale: 0.875, at: { x: 21, y: 20.5 } });

    expect(
      measureRestingMark({ frame: 0, mark: scaledBox(logo, 0.875, 20, 20.5), drawn, logo }).iou
    ).toBeLessThan(RESTING_MARK_FLOOR);
  });
});

function scaledBox(logo: MarkImage, scale: number, x: number, y: number): LogoBox {
  return {
    id: 'mark',
    box: { x, y, width: logo.width * scale, height: logo.height * scale },
    role: 'logo',
  };
}

/** The length of `[from, to)` that lies inside `[low, high)`. */
function overlap(from: number, to: number, low: number, high: number): number {
  return Math.max(0, Math.min(to, high) - Math.max(from, low));
}

/** The share of drawn pixel (column, row)'s area that the file's opaque pixels, drawn as squares of side `scale` from `at`, cover. */
function coveredShare(
  logo: MarkImage,
  { scale, at }: { scale: number; at: { x: number; y: number } },
  column: number,
  row: number
): number {
  const top = Math.max(0, Math.floor((row - at.y) / scale));
  const bottom = Math.min(logo.height, Math.ceil((row + 1 - at.y) / scale));
  const left = Math.max(0, Math.floor((column - at.x) / scale));
  const right = Math.min(logo.width, Math.ceil((column + 1 - at.x) / scale));
  let covered = 0;
  for (let y = top; y < bottom; y++) {
    const tall = overlap(row, row + 1, at.y + y * scale, at.y + (y + 1) * scale);
    for (let x = left; x < right; x++) {
      const wide = overlap(column, column + 1, at.x + x * scale, at.x + (x + 1) * scale);
      covered += tall * wide * (logo.mask[y * logo.width + x] ?? 0);
    }
  }
  return covered;
}

/**
 * The logo file's opaque pixels drawn as squares of side `scale` from (x, y)
 * over the field, each drawn pixel blending the red and the field by the share
 * of its area the squares cover: the exact mark as an ideal anti-aliasing
 * rasterizer draws it at any scale and position.
 */
async function coveredLogoFrame({
  scale,
  at,
}: {
  scale: number;
  at: { x: number; y: number };
}): Promise<{ drawn: Raster; logo: MarkImage }> {
  const { data, info } = await sharp(LOGO_FILE)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const logo = markImageOf({ ...info, data });
  const drawn = frame(Math.ceil(info.width * scale) + 60, Math.ceil(info.height * scale) + 60);
  for (let row = 0; row < drawn.height; row++) {
    for (let column = 0; column < drawn.width; column++) {
      const covered = coveredShare(logo, { scale, at }, column, row);
      const colour = FIELD.map((field, channel) =>
        Math.round(field + covered * ((RED[channel] ?? 0) - field))
      );
      drawn.data.set(colour, (row * drawn.width + column) * 3);
    }
  }
  return { drawn, logo };
}
