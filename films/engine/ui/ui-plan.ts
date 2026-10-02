import { z } from 'zod';

import { uiPlacementOf } from '../look/contract.js';

/** The prefix of the console line on which the look host reports the frames it needs the UI's pixels for. */
export const UI_PLAN_PREFIX = 'films-ui-plan:';

const planSchema = z.object({ texture: z.array(z.int().nonnegative()) });

/** The frames a look places its UI as a texture, as the one console line the plan probe writes. */
export function uiPlanLine(texture: readonly number[]): string {
  return `${UI_PLAN_PREFIX} ${JSON.stringify({ texture })}`;
}

/** The texture frames a plan line carries, or null for a console line that is not a plan. */
export function readUiPlanLine(line: string): number[] | null {
  if (!line.startsWith(UI_PLAN_PREFIX)) {
    return null;
  }
  const body = line.slice(UI_PLAN_PREFIX.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new Error(`the UI plan line is not JSON: ${body}`, { cause: error });
  }
  const plan = planSchema.safeParse(parsed);
  if (!plan.success) {
    throw new Error(`the UI plan line ${body} does not list whole frames under texture`);
  }
  return plan.data.texture;
}

/**
 * Every frame of a piece `durationInFrames` long that `placeUi` places as a
 * texture, ascending; a placement that is not one of the four is refused
 * naming the look and the frame.
 */
export function textureFrames(
  where: string,
  durationInFrames: number,
  /** The look's `placeUi`, whose return value crosses an untyped boundary and is checked here. */
  placeUi: (frame: number) => unknown
): number[] {
  return Array.from({ length: durationInFrames }, (_, frame) => frame).filter(
    (frame) => uiPlacementOf(where, frame, placeUi(frame)) === 'texture'
  );
}

/** The frames as ascending runs of consecutive frames, each an inclusive `[first, last]`. */
export function frameRuns(frames: readonly number[]): [number, number][] {
  const runs: [number, number][] = [];
  for (const frame of [...new Set(frames)].toSorted((a, b) => a - b)) {
    const run = runs.at(-1);
    if (run?.[1] === frame - 1) {
      run[1] = frame;
    } else {
      runs.push([frame, frame]);
    }
  }
  return runs;
}

/** Where, inside a render call's own bundle, its UI pass writes the UI's pixels, as a POSIX path. */
export const UI_FRAMES_DIRECTORY = 'films-ui';

/** The file inside a UI frames directory that holds one frame's pixels. */
export function uiFrameFile(directory: string, frame: number): string {
  return `${directory}/frame-${String(frame).padStart(4, '0')}.png`;
}
