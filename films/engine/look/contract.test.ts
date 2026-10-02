import { describe, expect, it } from 'vitest';

import {
  lookModuleOf,
  lookRandom,
  splitLookBoxes,
  textBoxesOf,
  uiPlacementOf,
} from './contract.js';

import type { LogoBox, TextBox } from './contract.js';

function renderFrame(): TextBox[] {
  return [];
}

function post(): { bloom: number; aberration: number; vignette: number; flash: number } {
  return { bloom: 0, aberration: 0, vignette: 0, flash: 0 };
}

function Ui(): null {
  return null;
}

function placeUi(): 'front' {
  return 'front';
}

const BOX: TextBox = {
  id: 'line',
  text: 'Every frame from code.',
  box: { x: 120, y: 900, width: 840, height: 110 },
  fontSizePx: 84,
  role: 'headline',
};

const LOGO: LogoBox = {
  id: 'mark',
  box: { x: 300, y: 1240, width: 480, height: 483 },
  role: 'logo',
};

describe('lookModuleOf', () => {
  it('reads a look that draws on a 2D canvas', () => {
    const look = lookModuleOf('films/a-film', { context: '2d', renderFrame });

    expect(look.context).toBe('2d');
    expect(look.renderFrame).toBe(renderFrame);
  });

  it('reads a look that draws on a WebGL2 canvas', () => {
    expect(lookModuleOf('films/a-film', { context: 'webgl2', renderFrame }).context).toBe('webgl2');
  });

  it('reads the motion-blur samples and the post chain a look opts into', () => {
    const look = lookModuleOf('films/a-film', { context: '2d', renderFrame, motionBlur: 4, post });

    expect(look.motionBlur).toBe(4);
    expect(look.post).toBe(post);
  });

  it('leaves motion blur and the post chain off when the look names neither', () => {
    const look = lookModuleOf('films/a-film', { context: '2d', renderFrame });

    expect(look.motionBlur).toBeUndefined();
    expect(look.post).toBeUndefined();
  });

  it('refuses a look module with no renderFrame, naming the look and the export', () => {
    expect(() => lookModuleOf('films/a-film', { context: '2d' })).toThrow(
      /films\/a-film: .*renderFrame[\s\S]*→ at renderFrame/
    );
  });

  it('refuses a renderFrame that is not a function, naming the export', () => {
    expect(() => lookModuleOf('films/a-film', { context: '2d', renderFrame: 12 })).toThrow(
      /→ at renderFrame/
    );
  });

  it('refuses a look module that names no canvas, naming the export', () => {
    expect(() => lookModuleOf('films/a-film', { renderFrame })).toThrow(/→ at context/);
  });

  it('refuses a canvas other than 2d or webgl2', () => {
    expect(() => lookModuleOf('films/a-film', { context: 'webgpu', renderFrame })).toThrow(
      /→ at context/
    );
  });

  it('accepts one motion-blur sample, the fewest', () => {
    expect(
      lookModuleOf('films/a-film', { context: '2d', renderFrame, motionBlur: 1 }).motionBlur
    ).toBe(1);
  });

  it.each([0, 2.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses %s motion-blur samples, naming the export',
    (motionBlur) => {
      expect(() =>
        lookModuleOf('films/a-film', { context: '2d', renderFrame, motionBlur })
      ).toThrow(/→ at motionBlur/);
    }
  );

  it('refuses a post chain that is not a function, naming the export', () => {
    expect(() =>
      lookModuleOf('films/a-film', { context: '2d', renderFrame, post: { bloom: 1 } })
    ).toThrow(/→ at post/);
  });

  it('reads a UI layer and where it sits', () => {
    const look = lookModuleOf('films/a-film', { context: 'webgl2', renderFrame, Ui, placeUi });

    expect(look.Ui).toBe(Ui);
    expect(look.placeUi).toBe(placeUi);
  });

  it('leaves the UI layer off when the look names none', () => {
    const look = lookModuleOf('films/a-film', { context: '2d', renderFrame });

    expect(look.Ui).toBeUndefined();
    expect(look.placeUi).toBeUndefined();
  });

  it('refuses a UI component that is not a function, naming the export', () => {
    expect(() =>
      lookModuleOf('films/a-film', { context: '2d', renderFrame, Ui: 'panel', placeUi })
    ).toThrow(/→ at Ui/);
  });

  it('refuses a placement that is not a function, naming the export', () => {
    expect(() =>
      lookModuleOf('films/a-film', { context: '2d', renderFrame, Ui, placeUi: 'front' })
    ).toThrow(/→ at placeUi/);
  });

  it('refuses a UI component without its placement, naming the look and the missing export', () => {
    expect(() => lookModuleOf('films/a-film', { context: '2d', renderFrame, Ui })).toThrow(
      /films\/a-film: a look with a UI layer exports both Ui and placeUi\(frame\), and this one exports only Ui/
    );
  });

  it('refuses a placement without its UI component, naming the look and the missing export', () => {
    expect(() => lookModuleOf('films/a-film', { context: '2d', renderFrame, placeUi })).toThrow(
      /films\/a-film: .*exports only placeUi/
    );
  });

  it('accepts a UI layer beside an odd motion blur, whose frame instant is a sub-frame', () => {
    const look = lookModuleOf('films/a-film', {
      context: '2d',
      renderFrame,
      Ui,
      placeUi,
      motionBlur: 3,
    });

    expect(look.motionBlur).toBe(3);
  });

  it('refuses a UI layer beside an even motion blur, naming the look and the samples', () => {
    expect(() =>
      lookModuleOf('films/a-film', { context: '2d', renderFrame, Ui, placeUi, motionBlur: 4 })
    ).toThrow(/films\/a-film: a look with a UI layer takes an odd motionBlur.*got 4/);
  });

  it('accepts an even motion blur on a look with no UI layer', () => {
    expect(
      lookModuleOf('films/a-film', { context: '2d', renderFrame, motionBlur: 2 }).motionBlur
    ).toBe(2);
  });
});

describe('uiPlacementOf', () => {
  it.each(['behind', 'front', 'hidden', 'texture'] as const)('reads %s', (placement) => {
    expect(uiPlacementOf('films/a-film', 3, placement)).toBe(placement);
  });

  it('refuses any other value, naming the look, the frame and the value', () => {
    expect(() => uiPlacementOf('films/a-film', 3, 'above')).toThrow(
      /films\/a-film: frame 3: placeUi\(frame\) returns one of behind, front, hidden, texture, got "above"/
    );
  });

  it('refuses a placement of null, naming it', () => {
    expect(() => uiPlacementOf('films/a-film', 3, null)).toThrow(/frame 3: .*got null/);
  });
});

describe('textBoxesOf', () => {
  it('returns the text boxes a frame drew', () => {
    expect(textBoxesOf('films/a-film', 12, [BOX])).toEqual([BOX]);
  });

  it('accepts a frame that drew no text', () => {
    expect(textBoxesOf('films/a-film', 12, [])).toEqual([]);
  });

  it('refuses a return value that is not a list of boxes, naming the look and the frame', () => {
    expect(() => textBoxesOf('films/a-film', 12, null)).toThrow(
      /films\/a-film: frame 12: renderFrame returns/
    );
  });

  it.each(['x', 'y', 'width', 'height'] as const)(
    'refuses a box whose %s is not finite, naming the box',
    (key) => {
      const bad = { ...BOX, box: { ...BOX.box, [key]: Number.NaN } };

      expect(() => textBoxesOf('films/a-film', 12, [bad])).toThrow(
        new RegExp(String.raw`frame 12: [\s\S]*→ at \[0\]\.box\.${key}`)
      );
    }
  );

  it('refuses a box that reaches to infinity, naming it', () => {
    const bad = { ...BOX, box: { ...BOX.box, width: Number.POSITIVE_INFINITY } };

    expect(() => textBoxesOf('films/a-film', 12, [bad])).toThrow(/→ at \[0\]\.box\.width/);
  });

  it('accepts a box of zero width and height, the smallest', () => {
    const empty = { ...BOX, box: { ...BOX.box, width: 0, height: 0 } };

    expect(textBoxesOf('films/a-film', 12, [empty])).toEqual([empty]);
  });

  it('refuses a box of negative width, naming it', () => {
    const bad = { ...BOX, box: { ...BOX.box, width: -Number.MIN_VALUE } };

    expect(() => textBoxesOf('films/a-film', 12, [bad])).toThrow(/→ at \[0\]\.box\.width/);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0])(
    'refuses a font size of %s, naming it',
    (fontSizePx) => {
      expect(() => textBoxesOf('films/a-film', 12, [{ ...BOX, fontSizePx }])).toThrow(
        /→ at \[0\]\.fontSizePx/
      );
    }
  );

  it('accepts the smallest font size above 0', () => {
    const tiny = { ...BOX, fontSizePx: Number.MIN_VALUE };

    expect(textBoxesOf('films/a-film', 12, [tiny])).toEqual([tiny]);
  });

  it('refuses a box with no box, naming it', () => {
    const bare = { id: BOX.id, text: BOX.text, fontSizePx: BOX.fontSizePx, role: BOX.role };

    expect(() => textBoxesOf('films/a-film', 12, [bare])).toThrow(/→ at \[0\]\.box/);
  });

  it('refuses a role the spec does not know, naming it', () => {
    expect(() => textBoxesOf('films/a-film', 12, [{ ...BOX, role: 'caption' }])).toThrow(
      /→ at \[0\]\.role/
    );
  });

  it('refuses a box with an empty id, naming it', () => {
    expect(() => textBoxesOf('films/a-film', 12, [{ ...BOX, id: '' }])).toThrow(/→ at \[0\]\.id/);
  });

  it('returns a resting mark beside the text boxes', () => {
    expect(textBoxesOf('films/a-film', 12, [BOX, LOGO])).toEqual([BOX, LOGO]);
  });

  it.each(['width', 'height'] as const)(
    'refuses a resting mark whose box has no %s, naming it',
    (key) => {
      const flat = { ...LOGO, box: { ...LOGO.box, [key]: 0 } };

      expect(() => textBoxesOf('films/a-film', 12, [flat])).toThrow(
        new RegExp(String.raw`→ at \[0\]\.box\.${key}`)
      );
    }
  );

  it('accepts a resting mark whose box has the smallest width and height above 0', () => {
    const tiny = {
      ...LOGO,
      box: { ...LOGO.box, width: Number.MIN_VALUE, height: Number.MIN_VALUE },
    };

    expect(textBoxesOf('films/a-film', 12, [tiny])).toEqual([tiny]);
  });

  it.each(['x', 'y', 'width', 'height'] as const)(
    'refuses a resting mark whose %s is not finite, naming it',
    (key) => {
      const bad = { ...LOGO, box: { ...LOGO.box, [key]: Number.NaN } };

      expect(() => textBoxesOf('films/a-film', 12, [bad])).toThrow(
        new RegExp(String.raw`→ at \[0\]\.box\.${key}`)
      );
    }
  );

  it('refuses a resting mark with an empty id, naming it', () => {
    expect(() => textBoxesOf('films/a-film', 12, [{ ...LOGO, id: '' }])).toThrow(/→ at \[0\]\.id/);
  });
});

describe('splitLookBoxes', () => {
  it('parts the text boxes from the resting marks, each in the order reported', () => {
    const support: TextBox = { ...BOX, id: 'second', role: 'support' };
    const second: LogoBox = { ...LOGO, id: 'mark-2' };

    expect(splitLookBoxes([LOGO, BOX, second, support])).toEqual({
      text: [BOX, support],
      logos: [LOGO, second],
    });
  });
});

/** The first four values a generator gives. */
function draws(next: () => number): number[] {
  return Array.from({ length: 4 }, () => next());
}

describe('lookRandom', () => {
  it('gives the same values for the same seed and key', () => {
    expect(draws(lookRandom('seed')('stars'))).toEqual(draws(lookRandom('seed')('stars')));
  });

  it('gives other values for another key', () => {
    expect(draws(lookRandom('seed')('stars'))).not.toEqual(draws(lookRandom('seed')('dust')));
  });

  it('gives other values for another seed', () => {
    expect(draws(lookRandom('seed')('stars'))).not.toEqual(draws(lookRandom('other')('stars')));
  });

  it('keeps every value in [0, 1)', () => {
    expect(draws(lookRandom('seed')('stars')).every((value) => value >= 0 && value < 1)).toBe(true);
  });
});
