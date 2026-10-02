import { describe, expect, it } from 'vitest';
import { heatFields, heatRange, paintHeat, railBands, RAMP_STEPS } from './click-heat.js';
import type { HeatSource } from './click-heat.js';

/** A counted element, stated at the size the framed page laid it out at. */
function source(visitors: number, top = 0): HeatSource {
  return { rect: { left: 100, top, width: 200, height: 40 }, visitors, pinned: false };
}

/** A counted element the framed page pins to its own viewport. */
function pinned(visitors: number, top = 0): HeatSource {
  return { ...source(visitors, top), pinned: true };
}

describe('heatFields', () => {
  it('draws no field for an element nobody clicked, which has no warmth to state', () => {
    expect(heatFields([source(0)])).toEqual([]);
  });

  it('centres a field on the box of the element it stands for', () => {
    const [field] = heatFields([source(5)]);
    expect(field).toMatchObject({ centreX: 200, centreY: 20 });
  });

  it('gives the most-clicked element the ramp top step', () => {
    const [hottest] = heatFields([source(32), source(1, 400)]);
    expect(hottest?.step).toBe(RAMP_STEPS);
  });

  it('gives the least-clicked element the ramp first step', () => {
    const fields = heatFields([source(32), source(1, 400)]);
    expect(fields[1]?.step).toBe(1);
  });

  it('shades by the share of the busiest element rather than by the count itself', () => {
    const halved = heatFields([source(20), source(10, 400)]);
    const doubled = heatFields([source(40), source(20, 400)]);
    expect(halved[1]?.step).toBe(doubled[1]?.step);
  });

  it('reaches further past the box for a busier element than for a quiet one', () => {
    const fields = heatFields([source(32), source(1, 400)]);
    expect(fields[0]?.radiusX).toBeGreaterThan(fields[1]?.radiusX ?? 0);
  });

  it('shapes the field to the box, so a wide element spreads wider than it is tall', () => {
    const [field] = heatFields([source(9)]);
    expect(field?.radiusX).toBeGreaterThan(field?.radiusY ?? 0);
  });
});

describe('heatRange', () => {
  it('states the counted range the ramp spans', () => {
    expect(heatRange([source(32), source(3, 400), source(0, 800)])).toEqual({ least: 3, most: 32 });
  });

  it('states no range where nothing was counted, so a legend can say so instead', () => {
    expect(heatRange([source(0)])).toBeNull();
  });
});

describe('railBands', () => {
  it('bands the page by where its counted elements sit', () => {
    expect(railBands([source(10, 0), source(10, 900)], 1000, 2)).toEqual([RAMP_STEPS, RAMP_STEPS]);
  });

  it('leaves a band with no counted click unshaded, which no ramp step can say', () => {
    expect(railBands([source(10, 0)], 1000, 2)).toEqual([RAMP_STEPS, 0]);
  });

  it('ranks a quieter band below the busiest one', () => {
    const bands = railBands([source(20, 0), source(1, 900)], 1000, 2);
    expect(bands[1]).toBeLessThan(bands[0] ?? 0);
  });

  it('counts an element in the band its middle falls in', () => {
    expect(railBands([source(10, 480)], 1000, 2)).toEqual([0, RAMP_STEPS]);
  });

  it('keeps an element at the very foot of the page inside the last band', () => {
    expect(railBands([source(10, 1000)], 1000, 2)).toEqual([0, RAMP_STEPS]);
  });

  it('shades nothing where the page has no counted element at all', () => {
    expect(railBands([source(0, 0)], 1000, 2)).toEqual([0, 0]);
  });
});

/** What one `createRadialGradient` call was handed, stop by stop. */
interface RecordedGradient {
  readonly stops: [number, string][];
  addColorStop: (offset: number, colour: string) => void;
}

/**
 * A 2d context that records what the heat asked it to draw, and hands back
 * `alpha` where the heat reads a painted pixel back. A real canvas too large
 * for the browser to allocate takes every drawing call without complaint and
 * reads back empty, which is the state `alpha: 0` stands for.
 */
function recordingContext(alpha = 158): {
  readonly context: CanvasRenderingContext2D;
  readonly gradients: RecordedGradient[];
  readonly cleared: [number, number, number, number][];
  readonly read: [number, number][];
  readonly fills: number;
} {
  const gradients: RecordedGradient[] = [];
  const cleared: [number, number, number, number][] = [];
  const read: [number, number][] = [];
  const counted = { fills: 0 };
  const context = {
    getImageData: (x: number, y: number): ImageData => {
      read.push([x, y]);
      return { data: Uint8ClampedArray.from([0, 0, 0, alpha]) } as ImageData;
    },
    clearRect: (x: number, y: number, width: number, height: number): void => {
      cleared.push([x, y, width, height]);
    },
    createRadialGradient: (): RecordedGradient => {
      const stops: [number, string][] = [];
      const gradient: RecordedGradient = {
        stops,
        addColorStop: (offset: number, colour: string): void => {
          stops.push([offset, colour]);
        },
      };
      gradients.push(gradient);
      return gradient;
    },
    save: (): void => undefined,
    restore: (): void => undefined,
    translate: (): void => undefined,
    scale: (): void => undefined,
    beginPath: (): void => undefined,
    arc: (): void => undefined,
    fill: (): void => {
      counted.fills += 1;
    },
    fillStyle: '' as string | CanvasGradient,
  };
  return {
    context: context as unknown as CanvasRenderingContext2D,
    gradients,
    cleared,
    read,
    get fills(): number {
      return counted.fills;
    },
  };
}

/** The canvas the heat is drawn over, at the framed page's own extent. */
const CANVAS = { width: 400, height: 900 } as const;

/** The five ramp colours, as the theme resolves them. */
const COLOURS = ['#e8eef8', '#cddbf1', '#a9c2e7', '#82a8db', '#5b8ccb'] as const;

describe('paintHeat', () => {
  it('clears the whole canvas before it draws, so a redraw states only the current counts', () => {
    const recorder = recordingContext();
    paintHeat(recorder.context, CANVAS, heatFields([source(9)]), COLOURS);
    expect(recorder.cleared).toEqual([[0, 0, 400, 900]]);
  });

  it('paints one field per counted element', () => {
    const recorder = recordingContext();
    paintHeat(recorder.context, CANVAS, heatFields([source(9), source(4, 400)]), COLOURS);
    expect(recorder.fills).toBe(2);
  });

  it('paints a field in the ramp colour its own step resolved to', () => {
    const recorder = recordingContext();
    paintHeat(recorder.context, CANVAS, heatFields([source(9)]), COLOURS);
    expect(recorder.gradients[0]?.stops[0]?.[1]).toContain(COLOURS[4]);
  });

  it('fades a field out by the same colour own alpha channel, inventing no second colour', () => {
    const recorder = recordingContext();
    paintHeat(recorder.context, CANVAS, heatFields([source(9)]), COLOURS);
    const stops = recorder.gradients[0]?.stops ?? [];
    expect(stops.at(-1)).toEqual([1, `${COLOURS[4]}00`]);
  });

  it('says the paint landed when the canvas reads back what it was painted with', () => {
    const recorder = recordingContext();
    expect(paintHeat(recorder.context, CANVAS, heatFields([source(9)]), COLOURS)).toBe(true);
    expect(recorder.read).toEqual([[200, 20]]);
  });

  it('says the paint did not land when the canvas reads back empty where a field is', () => {
    const recorder = recordingContext(0);
    expect(paintHeat(recorder.context, CANVAS, heatFields([source(9)]), COLOURS)).toBe(false);
  });

  it('claims nothing about a canvas it was given no field to paint', () => {
    const recorder = recordingContext(0);
    expect(paintHeat(recorder.context, CANVAS, [], COLOURS)).toBe(true);
    expect(recorder.read).toEqual([]);
  });

  it('claims nothing where every field it was given falls outside the canvas', () => {
    const recorder = recordingContext(0);
    const fields = heatFields([source(9, 2000)]);
    expect(paintHeat(recorder.context, CANVAS, fields, COLOURS)).toBe(true);
    expect(recorder.read).toEqual([]);
  });

  it('refuses a ramp colour the theme did not resolve to six-digit hex', () => {
    const recorder = recordingContext();
    expect(() => {
      paintHeat(recorder.context, CANVAS, heatFields([source(9)]), [
        ...COLOURS.slice(0, 4),
        'oklch(0.8 0.1 250)',
      ]);
    }).toThrow(/six-digit hex/i);
  });
});

describe('heatFields, over a page that pins some of its elements', () => {
  it('keeps a field on the same side of the frame as the element it stands for', () => {
    const fields = heatFields([source(9), pinned(4, 400)]);
    expect(fields.map((field) => field.pinned)).toEqual([false, true]);
  });

  it('ranks a pinned element against the same busiest count as the rest of the page', () => {
    const fields = heatFields([pinned(32), source(16, 400)]);
    expect(fields.map((field) => field.step)).toEqual([RAMP_STEPS, 3]);
  });
});

describe('railBands, over a page that pins some of its elements', () => {
  it('bands nothing for a pinned element, which sits at no place in the page', () => {
    expect(railBands([pinned(10, 0)], 1000, 2)).toEqual([0, 0]);
  });

  it('still bands the elements the page does lay out', () => {
    expect(railBands([pinned(10, 0), source(10, 900)], 1000, 2)).toEqual([0, RAMP_STEPS]);
  });
});
