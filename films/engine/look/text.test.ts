import { describe, expect, it } from 'vitest';

import { createTextCollector, lookTextLine, mergeFrameText } from './text.js';

import type { LogoBox, LookBox, TextBox } from './contract.js';

function box(id: string, x: number, fontSizePx = 84): TextBox {
  return {
    id,
    text: `text ${id}`,
    box: { x, y: 100, width: 200, height: 90 },
    fontSizePx,
    role: 'support',
  };
}

function mark(x: number): LogoBox {
  return { id: 'mark', box: { x, y: 600, width: 480, height: 483 }, role: 'logo' };
}

describe('mergeFrameText', () => {
  it("keeps one call's boxes as they are", () => {
    expect(mergeFrameText('films/a', 3, [[box('a', 10), box('b', 400)]])).toEqual([
      box('a', 10),
      box('b', 400),
    ]);
  });

  it('reports a text drawn at several sub-frames as the box covering all of them', () => {
    const [merged] = mergeFrameText('films/a', 3, [[box('a', 10)], [box('a', 30)]]);

    expect(merged?.box).toEqual({ x: 10, y: 100, width: 220, height: 90 });
  });

  it('reports the smallest font size a text was drawn at across the sub-frames', () => {
    expect(mergeFrameText('films/a', 3, [[box('a', 10, 90)], [box('a', 10, 84)]])).toEqual([
      box('a', 10, 84),
    ]);
  });

  it('keeps a text drawn at only some sub-frames', () => {
    expect(
      mergeFrameText('films/a', 3, [[box('a', 10)], [box('a', 10), box('b', 500)]]).map(
        ({ id }) => id
      )
    ).toEqual(['a', 'b']);
  });

  it('refuses one id reporting different words across the sub-frames, naming it', () => {
    expect(() =>
      mergeFrameText('films/a', 3, [[box('a', 10)], [{ ...box('a', 10), text: 'other' }]])
    ).toThrow(/films\/a: frame 3: text box "a"/);
  });

  it('refuses one id reporting different roles across the sub-frames, naming it', () => {
    expect(() =>
      mergeFrameText('films/a', 3, [[box('a', 10)], [{ ...box('a', 10), role: 'headline' }]])
    ).toThrow(/text box "a"/);
  });

  it('reports a resting mark drawn at several sub-frames as the box covering all of them', () => {
    expect(mergeFrameText('films/a', 3, [[mark(300)], [mark(302)]])).toEqual([
      { ...mark(300), box: { x: 300, y: 600, width: 482, height: 483 } },
    ]);
  });

  it('refuses one id reporting a resting mark and a text across the sub-frames, naming it', () => {
    expect(() => mergeFrameText('films/a', 3, [[box('mark', 10)], [mark(300)]])).toThrow(
      /films\/a: frame 3: text box "mark"/
    );
  });

  it('refuses one id reporting a text and then a resting mark across the sub-frames, naming it', () => {
    expect(() => mergeFrameText('films/a', 3, [[mark(300)], [box('mark', 10)]])).toThrow(
      /text box "mark"/
    );
  });
});

describe('lookTextLine', () => {
  it('writes a frame and its boxes as one prefixed JSON line', () => {
    expect(lookTextLine(7, [box('a', 10)])).toBe(
      `films-look-text: ${JSON.stringify({ frame: 7, boxes: [box('a', 10)] })}`
    );
  });
});

describe('createTextCollector', () => {
  it("hands over a frame's text once every sample of it has drawn", () => {
    const frames: [number, LookBox[]][] = [];
    const collector = createTextCollector({
      where: 'films/a',
      samples: 2,
      onFrame: (frame, boxes) => frames.push([frame, boxes]),
    });

    collector.add(4, [box('a', 10)]);
    expect(frames).toEqual([]);
    collector.add(4, [box('a', 30)]);

    expect(frames).toEqual([
      [4, [{ ...box('a', 10), box: { x: 10, y: 100, width: 220, height: 90 } }]],
    ]);
  });

  it('starts over when a later frame draws before the earlier one finished', () => {
    const frames: number[] = [];
    const collector = createTextCollector({
      where: 'films/a',
      samples: 2,
      onFrame: (frame) => frames.push(frame),
    });

    collector.add(4, []);
    collector.add(5, []);
    collector.add(5, []);

    expect(frames).toEqual([5]);
  });

  it('hands over a frame again when it is drawn again', () => {
    const frames: number[] = [];
    const collector = createTextCollector({
      where: 'films/a',
      samples: 1,
      onFrame: (frame) => frames.push(frame),
    });

    collector.add(4, []);
    collector.add(4, []);

    expect(frames).toEqual([4, 4]);
  });
});
