import { z } from 'zod';

/** The input props of the plan probe: the look host reports the frames that need the UI's pixels. */
export const UI_PLAN_PROPS = { filmsUiPlan: true } as const;

/** The input props of the UI pass: each frame shows the UI layer alone, on nothing. */
export const UI_PASS_PROPS = { filmsUiPass: true } as const;

/** The input props that point the look host at the UI pass's frames, under the public directory. */
export function uiFramesProps(directory: string): { filmsUiFrames: string } {
  return { filmsUiFrames: directory };
}

const uiPropsSchema = z.object({
  filmsUiPlan: z.boolean().optional(),
  filmsUiPass: z.boolean().optional(),
  /** A directory under the public directory. */
  filmsUiFrames: z.string().min(1).optional(),
});

/** What the input props ask of the UI layer. */
export interface UiRequest {
  plan: boolean;
  pass: boolean;
  /** The directory holding the UI pass's frames, or null when no pass ran. */
  frames: string | null;
}

/** Reads the UI layer's input props, refusing a value of the wrong kind by name. */
export function readUiProps(inputProps: Readonly<Record<string, unknown>>): UiRequest {
  const parsed = uiPropsSchema.safeParse(inputProps);
  if (!parsed.success) {
    throw new TypeError(
      `the UI layer's input props are flags and a directory\n${z.prettifyError(parsed.error)}`
    );
  }
  const { filmsUiPlan, filmsUiPass, filmsUiFrames } = parsed.data;
  return {
    plan: filmsUiPlan ?? false,
    pass: filmsUiPass ?? false,
    frames: filmsUiFrames ?? null,
  };
}
