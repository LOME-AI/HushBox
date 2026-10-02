import { describe, expect, it } from 'vitest';

import { HEIGHT, WIDTH } from '../time/grid.js';

import { LABEL_INK, labelImage, sheetLayout } from './contact-sheet.js';

import type { LabelImage } from './contact-sheet.js';

const ROW = [0, 1, 2, 3, 4, 5, 6, 7].map((frame) => ({ frame }));

/** Frames as the items a sheet lays out. */
function items(...frames: number[]): { frame: number }[] {
  return frames.map((frame) => ({ frame }));
}

/** The RGBA value of one label pixel. */
function pixelAt(image: LabelImage, x: number, y: number): number[] {
  const offset = (y * image.width + x) * 4;
  return Array.from({ length: 4 }, (_, channel) => image.pixels[offset + channel] ?? Number.NaN);
}

describe('sheetLayout', () => {
  it('keeps the frame aspect in each thumbnail', () => {
    const { thumbWidth, thumbHeight } = sheetLayout(items(0));

    expect(thumbWidth / thumbHeight).toBe(WIDTH / HEIGHT);
  });

  it('puts the first thumbnail one gap in from the top-left corner', () => {
    const layout = sheetLayout(items(0));

    expect(layout.tiles[0]).toMatchObject({ left: layout.gap, top: layout.gap });
  });

  it('places thumbnails left to right, a gap apart', () => {
    const layout = sheetLayout(items(0, 1));

    expect(layout.tiles[1]?.left).toBe(2 * layout.gap + layout.thumbWidth);
  });

  it('starts a new row after a full row', () => {
    const layout = sheetLayout([...ROW, { frame: 8 }]);

    expect(layout.tiles[8]).toMatchObject({
      left: layout.gap,
      top: 2 * layout.gap + layout.thumbHeight + layout.labelHeight,
    });
  });

  it('holds a full row of thumbnails across its width', () => {
    const layout = sheetLayout(ROW);

    expect(layout.width).toBe(layout.gap + ROW.length * (layout.thumbWidth + layout.gap));
  });

  it('narrows to the thumbnails when they fill less than a row', () => {
    const layout = sheetLayout(items(0, 1));

    expect(layout.width).toBe(layout.gap + 2 * (layout.thumbWidth + layout.gap));
  });

  it('holds every row down its height', () => {
    const layout = sheetLayout([...ROW, { frame: 8 }]);

    expect(layout.height).toBe(
      layout.gap + 2 * (layout.thumbHeight + layout.labelHeight + layout.gap)
    );
  });

  it('keeps each item on its tile', () => {
    expect(sheetLayout([{ frame: 3, file: 'a.png' }]).tiles[0]).toMatchObject({
      frame: 3,
      file: 'a.png',
    });
  });

  it('centres each label in the strip under its thumbnail', () => {
    const layout = sheetLayout(items(120));

    expect(layout.tiles[0]).toMatchObject({
      labelTop: layout.gap + layout.thumbHeight + (layout.labelHeight - labelImage('0').height) / 2,
    });
  });

  it('refuses a sheet of no frames', () => {
    expect(() => sheetLayout([])).toThrow('a contact sheet needs at least one frame');
  });
});

describe('labelImage', () => {
  it('sets digits side by side, a scaled pixel apart', () => {
    const one = labelImage('0');

    expect(labelImage('120').width).toBe(3 * one.width + 2 * (one.width / 5));
  });

  it('draws in RGBA, four bytes a pixel', () => {
    const image = labelImage('7');

    expect(image.pixels.length).toBe(image.width * image.height * 4);
  });

  it("inks the pixels a digit's pattern sets", () => {
    const image = labelImage('1');
    const scale = image.width / 5;

    expect(pixelAt(image, 2 * scale, 0)).toEqual([...LABEL_INK, 255]);
  });

  it('leaves the rest transparent', () => {
    expect(pixelAt(labelImage('1'), 0, 0)).toEqual([0, 0, 0, 0]);
  });

  it('draws each of the ten digits differently', () => {
    const drawn = new Set(
      Array.from({ length: 10 }, (_, digit) => labelImage(String(digit)).pixels.join(','))
    );

    expect(drawn.size).toBe(10);
  });

  it('refuses a character that is not a digit, naming it', () => {
    expect(() => labelImage('1a')).toThrow('a label holds digits only, got "a"');
  });
});
