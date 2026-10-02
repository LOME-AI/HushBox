import { describe, expect, it } from 'vitest';

import {
  UI_PLAN_PREFIX,
  frameRuns,
  readUiPlanLine,
  textureFrames,
  uiFrameFile,
  uiPlanLine,
} from './ui-plan.js';

describe('uiPlanLine', () => {
  it('writes the texture frames after the plan prefix', () => {
    expect(uiPlanLine([3, 4, 9])).toBe(`${UI_PLAN_PREFIX} {"texture":[3,4,9]}`);
  });
});

describe('readUiPlanLine', () => {
  it('reads back the frames a plan line carries', () => {
    expect(readUiPlanLine(uiPlanLine([0, 1, 120]))).toEqual([0, 1, 120]);
  });

  it('reads an empty plan', () => {
    expect(readUiPlanLine(uiPlanLine([]))).toEqual([]);
  });

  it('is null for a console line that is not a plan', () => {
    expect(readUiPlanLine('films-look-text: {"frame":0,"boxes":[]}')).toBeNull();
  });

  it('refuses a plan line whose frames are not whole numbers, naming the line', () => {
    expect(() => readUiPlanLine(`${UI_PLAN_PREFIX} {"texture":[1.5]}`)).toThrow(
      /UI plan line .*texture/
    );
  });

  it('refuses a plan line that is not JSON, naming the line', () => {
    expect(() => readUiPlanLine(`${UI_PLAN_PREFIX} {texture`)).toThrow(/UI plan line/);
  });
});

/** A placement that names a place no UI layer has on frame 2. */
function asideOnFrameTwo(frame: number): string {
  return frame === 2 ? 'aside' : 'front';
}

describe('textureFrames', () => {
  it('lists every frame the look places as a texture, ascending', () => {
    expect(
      textureFrames('films/a-film', 6, (frame) => (frame % 2 === 0 ? 'texture' : 'front'))
    ).toEqual([0, 2, 4]);
  });

  it('is empty for a look that never places its UI as a texture', () => {
    expect(textureFrames('films/a-film', 4, () => 'behind')).toEqual([]);
  });

  it('asks the placement of the last frame and of no frame past it', () => {
    const asked: number[] = [];

    textureFrames('films/a-film', 3, (frame) => {
      asked.push(frame);
      return 'hidden';
    });

    expect(asked).toEqual([0, 1, 2]);
  });

  it('refuses a placement that is not one of the four, naming the look and the frame', () => {
    expect(() => textureFrames('films/a-film', 4, asideOnFrameTwo)).toThrow(
      /films\/a-film: frame 2: placeUi\(frame\) returns one of behind, front, hidden, texture, got "aside"/
    );
  });
});

describe('frameRuns', () => {
  it('is empty for no frames', () => {
    expect(frameRuns([])).toEqual([]);
  });

  it('keeps a lone frame as a run of one', () => {
    expect(frameRuns([7])).toEqual([[7, 7]]);
  });

  it('joins consecutive frames into one inclusive run', () => {
    expect(frameRuns([4, 5, 6])).toEqual([[4, 6]]);
  });

  it('starts a new run at each gap', () => {
    expect(frameRuns([1, 2, 5, 9, 10])).toEqual([
      [1, 2],
      [5, 5],
      [9, 10],
    ]);
  });

  it('sorts and deduplicates the frames it is given', () => {
    expect(frameRuns([6, 4, 5, 5])).toEqual([[4, 6]]);
  });
});

describe('uiFrameFile', () => {
  it('names a frame by its four-digit number inside the directory', () => {
    expect(uiFrameFile('films-ui', 42)).toBe('films-ui/frame-0042.png');
  });
});
