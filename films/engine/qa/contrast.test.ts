import { describe, expect, it } from 'vitest';

import {
  containmentGate,
  contrastGate,
  contrastRatio,
  measureContainment,
  measureContrast,
} from './contrast.js';
import { relativeLuminance } from './raster.js';

import type { TextBox } from '../look/index.js';
import type { TextPair } from './contrast.js';
import type { Raster } from './raster.js';

const WIDTH = 20;
const HEIGHT = 10;

/** A frame of one grey. */
function field(grey: number): Raster {
  return {
    width: WIDTH,
    height: HEIGHT,
    channels: 3,
    data: new Uint8Array(WIDTH * HEIGHT * 3).fill(grey),
  };
}

interface Area {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The raster with the area painted one grey, clipped to the frame. */
function painted(raster: Raster, { x, y, width, height }: Area, grey: number): Raster {
  const data = Uint8Array.from(raster.data);
  for (let row = Math.max(0, y); row < Math.min(raster.height, y + height); row++) {
    for (let column = Math.max(0, x); column < Math.min(raster.width, x + width); column++) {
      data.fill(grey, (row * raster.width + column) * 3, (row * raster.width + column) * 3 + 3);
    }
  }
  return { ...raster, data };
}

function text(id: string, box: Area, role: TextBox['role'] = 'headline'): TextBox {
  return { id, text: id, box, fontSizePx: 84, role };
}

/** The box the glyphs of the default pair sit in. */
const BOX: Area = { x: 2, y: 2, width: 6, height: 4 };
/** Where the default pair's glyphs are drawn, inside {@link BOX}. */
const GLYPHS: Area = { x: 3, y: 3, width: 4, height: 2 };

/** Light glyphs over a dark field, reported in {@link BOX}. */
function pair(overrides: Partial<TextPair> = {}): TextPair {
  const hidden = field(26);
  return {
    frame: 3,
    boxes: [text('headline', BOX)],
    text: painted(hidden, GLYPHS, 242),
    hidden,
    ...overrides,
  };
}

describe('contrastRatio', () => {
  it('is 21 between white and black', () => {
    expect(contrastRatio(1, 0)).toBeCloseTo(21, 12);
  });

  it('is the same either way round', () => {
    expect(contrastRatio(0.2, 0.7)).toBe(contrastRatio(0.7, 0.2));
  });

  it('is 1 between equal luminances', () => {
    expect(contrastRatio(0.3, 0.3)).toBe(1);
  });
});

describe('measureContrast', () => {
  it('reads the text colour from the pixels that change inside the box', () => {
    const [measure] = measureContrast(pair());

    expect(measure?.ratio).toBe(
      contrastRatio(relativeLuminance(242, 242, 242), relativeLuminance(26, 26, 26))
    );
  });

  it('reads the glyph core, not the edge pixels a glyph only partly covers', () => {
    const edged = painted(painted(field(26), BOX, 60), GLYPHS, 242);
    const hidden = field(26);

    expect(measureContrast(pair({ text: edged, hidden }))[0]?.ratio).toBe(
      measureContrast(pair())[0]?.ratio
    );
  });

  it('judges light text against the bright end of the background inside its box', () => {
    const hidden = painted(field(26), { x: 2, y: 2, width: 6, height: 1 }, 200);
    const [measure] = measureContrast(pair({ hidden, text: painted(hidden, GLYPHS, 242) }));

    expect(measure?.ratio).toBeLessThan(2);
  });

  it('judges dark text against the dark end of the background inside its box', () => {
    const hidden = painted(field(230), { x: 2, y: 2, width: 6, height: 1 }, 40);
    const [measure] = measureContrast(pair({ hidden, text: painted(hidden, GLYPHS, 20) }));

    expect(measure?.ratio).toBeLessThan(2);
  });

  it('reads the background only inside the box', () => {
    const hidden = painted(field(26), { x: 10, y: 0, width: 10, height: 10 }, 240);

    expect(measureContrast(pair({ hidden, text: painted(hidden, GLYPHS, 242) }))[0]?.ratio).toBe(
      measureContrast(pair())[0]?.ratio
    );
  });

  it('cannot measure a box in which no pixel changes', () => {
    expect(measureContrast(pair({ text: field(26) }))).toEqual([
      { frame: 3, id: 'headline', ratio: null },
    ]);
  });

  it('cannot measure a box with no pixel inside the frame', () => {
    const outside = text('headline', { x: 40, y: 2, width: 6, height: 4 });

    expect(measureContrast(pair({ boxes: [outside] }))[0]?.ratio).toBeNull();
  });

  it('clips a box that runs past the frame to the pixels inside it', () => {
    const past = text('headline', { x: -5, y: -5, width: 13, height: 40 });

    expect(measureContrast(pair({ boxes: [past] }))[0]?.ratio).toBe(
      measureContrast(pair())[0]?.ratio
    );
  });

  it('measures copy only', () => {
    expect(measureContrast(pair({ boxes: [text('caption', BOX, 'imagery')] }))).toEqual([]);
  });

  it('refuses a pair whose rasters differ in size', () => {
    expect(() => measureContrast(pair({ hidden: { ...field(26), width: 10 } }))).toThrow(
      /frame 3: the text and hidden-text renders differ in size/
    );
  });
});

describe('contrastGate', () => {
  it('passes light text over a dark background', () => {
    expect(contrastGate('film', [measureContrast(pair())]).passed).toBe(true);
  });

  it('fails text in the background colour, naming the film, the rule, the frame and the text id', () => {
    const hidden = painted(field(26), { x: 0, y: 3, width: 20, height: 1 }, 30);
    const measures = measureContrast(pair({ hidden, text: painted(hidden, GLYPHS, 26) }));

    expect(contrastGate('film', [measures]).failures).toEqual([
      'film: contrast: frame 3, text "headline": 1.04:1 against the background inside its box, below 4.5:1',
    ]);
  });

  it('accepts a contrast of 4.5:1', () => {
    // Grey 117 against black is 4.56:1; grey 116 is 4.49:1.
    const hidden = field(0);

    expect(
      contrastGate('film', [measureContrast(pair({ hidden, text: painted(hidden, GLYPHS, 117) }))])
        .passed
    ).toBe(true);
  });

  it('fails a contrast just under 4.5:1', () => {
    const hidden = field(0);

    expect(
      contrastGate('film', [measureContrast(pair({ hidden, text: painted(hidden, GLYPHS, 116) }))])
        .passed
    ).toBe(false);
  });

  it('refuses a ratio that is not a number, naming the text', () => {
    expect(contrastGate('film', [[{ frame: 3, id: 'line', ratio: Number.NaN }]]).failures).toEqual([
      'film: contrast: frame 3, text "line": NaN:1 against the background inside its box, below 4.5:1',
    ]);
  });

  it('leaves a box it cannot measure to the containment gate', () => {
    expect(contrastGate('film', [[{ frame: 3, id: 'line', ratio: null }]]).passed).toBe(true);
  });

  it('reports the lowest contrast it measured', () => {
    expect(contrastGate('film', [measureContrast(pair())]).measured[0]).toMatch(
      /^1 copy box on 1 probe frame; lowest contrast 1\d\.\d\d:1 \(frame 3, text "headline"\)$/
    );
  });

  it('says so when no box could be measured', () => {
    expect(contrastGate('film', [[{ frame: 3, id: 'line', ratio: null }]]).measured).toEqual([
      '1 copy box on 1 probe frame; none could be measured',
    ]);
  });

  it('says so when no probe frame holds copy text', () => {
    expect(contrastGate('film', []).measured).toEqual(['no probe frame holds copy text']);
  });
});

describe('measureContainment', () => {
  it('counts every differing pixel of a look that keeps its text inside its box', () => {
    expect(measureContainment(pair())).toEqual({
      frame: 3,
      boxes: 1,
      differing: 8,
      strays: 0,
      strayLargest: 0,
      strayBounds: null,
      empty: [],
    });
  });

  it('counts a pixel that differs outside every box, with the area they span', () => {
    const stray = painted(pair().text, { x: 12, y: 6, width: 3, height: 2 }, 242);

    expect(measureContainment(pair({ text: stray }))).toMatchObject({
      strays: 6,
      strayBounds: { x: 12, y: 6, width: 3, height: 2 },
    });
  });

  it('gives the largest change of any colour channel among the pixels outside every box', () => {
    const stray = painted(pair().text, { x: 12, y: 6, width: 3, height: 2 }, 31);

    expect(measureContainment(pair({ text: stray })).strayLargest).toBe(5);
  });

  it('counts a pixel the box covers only in part as inside it', () => {
    const fractional = text('headline', { x: 2.5, y: 2.5, width: 5, height: 3 });

    expect(measureContainment(pair({ boxes: [fractional] })).strays).toBe(0);
  });

  it('names a box in which no pixel differs', () => {
    const boxes = [text('headline', BOX), text('undrawn', { x: 12, y: 2, width: 6, height: 4 })];

    expect(measureContainment(pair({ boxes })).empty).toEqual(['undrawn']);
  });

  it('holds imagery boxes too', () => {
    const boxes = [text('caption', BOX, 'imagery')];

    expect(measureContainment(pair({ boxes })).strays).toBe(0);
  });

  it('refuses a pair whose rasters differ in size', () => {
    expect(() => measureContainment(pair({ hidden: { ...field(26), height: 5 } }))).toThrow(
      /differ in size/
    );
  });
});

describe('containmentGate', () => {
  it('passes a look whose text lies inside its boxes', () => {
    expect(containmentGate('film', [measureContainment(pair())]).passed).toBe(true);
  });

  it('fails text drawn outside its box, naming the frame and where it was drawn', () => {
    const stray = painted(pair().text, { x: 12, y: 6, width: 3, height: 2 }, 242);

    expect(containmentGate('film', [measureContainment(pair({ text: stray }))]).failures).toEqual([
      'film: text-outside-box: frame 3: 6 pixels differ between the text and hidden-text renders outside every reported box, within x 12–15, y 6–8; largest difference 216',
    ]);
  });

  it('fails a reported box with nothing drawn in it, naming the text', () => {
    const boxes = [text('headline', BOX), text('undrawn', { x: 12, y: 2, width: 6, height: 4 })];

    expect(containmentGate('film', [measureContainment(pair({ boxes }))]).failures).toEqual([
      'film: empty-text-box: frame 3, text "undrawn": no pixel differs inside its reported box between the text and hidden-text renders',
    ]);
  });

  it('fails a look that ignores hideText once for the frame, not once per box', () => {
    const boxes = [text('headline', BOX), text('other', { x: 12, y: 2, width: 6, height: 4 })];
    const same = pair({ boxes, hidden: pair().text });

    expect(containmentGate('film', [measureContainment(same)]).failures).toEqual([
      'film: hide-text: frame 3: the frame reports 2 text boxes, yet no pixel differs between the text and hidden-text renders; the look draws its text whatever hideText says',
    ]);
  });

  it('fails text drawn on a frame that reports no box', () => {
    expect(containmentGate('film', [measureContainment(pair({ boxes: [] }))]).failures).toEqual([
      'film: text-outside-box: frame 3: 8 pixels differ between the text and hidden-text renders outside every reported box, within x 3–7, y 3–5; largest difference 216',
    ]);
  });

  it('counts a frame that reports no box among the frames it checked', () => {
    const empty = measureContainment(pair({ boxes: [], text: field(26) }));

    expect(containmentGate('film', [measureContainment(pair()), empty]).measured).toEqual([
      '1 text box on 2 probe frames; 8 differing pixels, 0 outside every box',
    ]);
  });

  it('passes a frame with no boxes and no text', () => {
    expect(
      containmentGate('film', [measureContainment(pair({ boxes: [], text: field(26) }))]).passed
    ).toBe(true);
  });

  it('reports the frames and boxes it checked', () => {
    expect(containmentGate('film', [measureContainment(pair())]).measured).toEqual([
      '1 text box on 1 probe frame; 8 differing pixels, 0 outside every box',
    ]);
  });

  it('says so when it checked no probe frame', () => {
    expect(containmentGate('film', []).measured).toEqual(['no probe frame checked']);
  });
});

/** The default pair with the text render's area outside the box set to one grey. */
function strayed(area: Area, grey: number): TextPair {
  return pair({ text: painted(pair().text, area, grey) });
}

function judged(measure: TextPair): ReturnType<typeof containmentGate> {
  return containmentGate('film', [measureContainment(measure)]);
}

describe('containmentGate on a small difference outside every box', () => {
  it('passes an 8×4 block in which every pixel is 8 levels off', () => {
    expect(judged(strayed({ x: 10, y: 2, width: 8, height: 4 }, 34)).passed).toBe(true);
  });

  it('passes a 6×6 blob 3 levels off', () => {
    expect(judged(strayed({ x: 12, y: 2, width: 6, height: 6 }, 23)).passed).toBe(true);
  });

  it('passes a single channel value 1 level off', () => {
    const measure = pair();
    const text = { ...measure.text, data: Uint8Array.from(measure.text.data) };
    text.data[(8 * WIDTH + 15) * 3 + 2] = 27;

    expect(judged({ ...measure, text }).passed).toBe(true);
  });

  it('passes 64 differing pixels 8 levels off', () => {
    expect(judged(strayed({ x: 10, y: 0, width: 8, height: 8 }, 34)).passed).toBe(true);
  });

  it('fails 65 differing pixels, naming the count and the largest difference', () => {
    const measure = strayed({ x: 10, y: 0, width: 8, height: 8 }, 27);
    const text = painted(measure.text, { x: 18, y: 0, width: 1, height: 1 }, 27);

    expect(judged({ ...measure, text }).failures).toEqual([
      'film: text-outside-box: frame 3: 65 pixels differ between the text and hidden-text renders outside every reported box, within x 10–19, y 0–8; largest difference 1',
    ]);
  });

  it('fails one pixel 9 levels off', () => {
    expect(judged(strayed({ x: 15, y: 8, width: 1, height: 1 }, 35)).failures).toEqual([
      'film: text-outside-box: frame 3: 1 pixel differs between the text and hidden-text renders outside every reported box, within x 15–16, y 8–9; largest difference 9',
    ]);
  });

  it('fails a 104×104 black square', () => {
    const side = 120;
    const hidden: Raster = {
      width: side,
      height: side,
      channels: 3,
      data: new Uint8Array(side * side * 3).fill(20),
    };
    const text = painted(hidden, { x: 8, y: 8, width: 104, height: 104 }, 0);

    expect(judged({ frame: 3, boxes: [], text, hidden }).failures).toEqual([
      'film: text-outside-box: frame 3: 10816 pixels differ between the text and hidden-text renders outside every reported box, within x 8–112, y 8–112; largest difference 20',
    ]);
  });

  it('names each frame it passed with a small difference', () => {
    const small = measureContainment(strayed({ x: 10, y: 2, width: 8, height: 4 }, 34));

    expect(containmentGate('film', [measureContainment(pair()), small]).measured[1]).toBe(
      'passed with a small difference outside every box: frame 3 (32 pixels, largest 8)'
    );
  });
});
