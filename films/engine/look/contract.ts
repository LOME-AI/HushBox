import { z } from 'zod';

import { filmSpecInputSchema } from '../film/spec.js';
import { rand } from '../rand/rand.js';

import type { ComponentType } from 'react';
import type { BrandColors } from '../visual/brand-tokens.js';
import type { PostSettings } from '../visual/gl/index.js';
import type { LogoPart } from './logo.js';

/** The context each canvas kind a look may choose gives it to draw with. */
interface CanvasContexts {
  '2d': CanvasRenderingContext2D;
  webgl2: WebGL2RenderingContext;
}

/** The canvas a look draws into: a 2D canvas or a WebGL2 one, the look's choice. */
export type LookCanvas = keyof CanvasContexts;

/** A canvas the host lends a look beside its own, with the context the look draws it with. */
export interface LookSurface<K extends LookCanvas = LookCanvas> {
  canvas: HTMLCanvasElement;
  context: CanvasContexts[K];
}

/** A part of the brand mark, as a look fills it. */
export interface LookLogoPart extends LogoPart {
  /** The outline as a path a 2D context fills, strokes or clips to. */
  path: Path2D;
}

/** The brand logo, decoded from its file before the first frame. */
export interface LookLogo {
  /**
   * The file as decoded: straight alpha, no colour conversion. A 2D context
   * draws it with `drawImage`, and a WebGL2 one uploads it with `texImage2D`.
   */
  image: ImageBitmap;
  width: number;
  height: number;
  /**
   * The mark, traced from the file's alpha every time a film loads, one part
   * per connected shape, in the file's pixel space: filled at the file's size
   * and place, the parts cover the file's opaque pixels.
   */
  parts: readonly LookLogoPart[];
}

/** What the look host hands `renderFrame` on every call. */
export interface LookContext<K extends LookCanvas = LookCanvas> {
  /**
   * The look's own canvas, the frame's size, cleared before every call: a 2D
   * context is reset whole, and a WebGL2 context has its default framebuffer
   * bound, the full viewport set, the scissor test off, every channel writable
   * and the colour buffer cleared to transparent. The host reads the canvas as
   * sRGB, as a 2D context writes it, so a WebGL2 look writes sRGB-encoded colour.
   */
  canvas: HTMLCanvasElement;
  context: CanvasContexts[K];
  width: number;
  height: number;
  fps: number;
  /**
   * The instant this call draws, in frames. It is `frame` itself unless the look
   * opts into motion blur, when each call draws one sub-frame instant around it.
   * Motion reads `time`; a cut or a change that must land on a frame reads `frame`.
   */
  time: number;
  /** A generator of values in [0, 1), seeded from the film's or take's seed and the key. */
  random: (key: string) => () => number;
  /** The brand colours of the dark theme, as the brand stylesheet writes them. */
  brand: BrandColors;
  /**
   * Every loaded font as the CSS family a canvas `font` takes: the brand stacks
   * under `sans`, `serif` and `mono`, and each open-licence family under the name
   * of its directory in the package's fonts directory.
   */
  fonts: Readonly<Record<string, string>>;
  /** The brand logo, for the look to draw as it chooses; the host draws nothing with it. */
  logo: LookLogo;
  /** True in the contrast pass: the look draws everything but its text. */
  hideText: boolean;
  /**
   * The canvas in front of the UI layer, for a look that has one; null for a
   * look without. It is the frame's size and of the same kind as `canvas`,
   * cleared the same way before every call, and the browser shows it as drawn:
   * no post chain, and under motion blur only what the call at the frame's own
   * instant drew, so a look with a UI layer takes an odd `motionBlur`.
   */
  front: LookSurface<K> | null;
  /**
   * The UI layer's pixels on a frame the look places as `'texture'`, rendered
   * from the same live components as a frame that shows the layer: the frame's
   * size, sRGB, not premultiplied. Null on every other frame. They are imagery,
   * so `hideText` leaves them drawn.
   */
  ui: ImageBitmap | null;
}

/**
 * Where a look's UI layer sits on a frame: under the front canvas, over it,
 * not shown, or not shown and handed to `renderFrame` as `ctx.ui`. Every
 * placement is over the look's own canvas.
 */
export const UI_PLACEMENTS = ['behind', 'front', 'hidden', 'texture'] as const;

/** One of {@link UI_PLACEMENTS}. */
export type UiPlacement = (typeof UI_PLACEMENTS)[number];

/** What the look host hands a look's UI component on every frame. */
export type UiContext = Pick<
  LookContext,
  'width' | 'height' | 'fps' | 'random' | 'brand' | 'fonts'
>;

/** A look's UI component's props: the frame it draws and what the host lends it. */
export interface UiProps {
  frame: number;
  ctx: UiContext;
}

const roleSchema = filmSpecInputSchema.shape.text.element.shape.role;

/** Where something was drawn, in composition pixels. */
const drawnBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});

const textBoxSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  box: drawnBoxSchema,
  fontSizePx: z.number().positive(),
  role: roleSchema,
});

/** One piece of text a look drew, as `renderFrame` reports it. */
export type TextBox = z.infer<typeof textBoxSchema>;

const logoBoxSchema = z.object({
  id: z.string().min(1),
  /**
   * The box the whole logo image rests in, transparent margin included: the
   * verify gate resamples what is drawn inside it to the image's size and
   * compares it with the image's opaque pixels. Reported only on frames where
   * the mark is meant to be the logo at rest.
   */
  box: drawnBoxSchema.extend({ width: z.number().positive(), height: z.number().positive() }),
  role: z.literal('logo'),
});

/** Where a look drew the brand mark at rest, as `renderFrame` reports it beside its text. */
export type LogoBox = z.infer<typeof logoBoxSchema>;

/** A box `renderFrame` reports: a piece of text, or the brand mark at rest. */
export type LookBox = TextBox | LogoBox;

const lookBoxSchema = z.discriminatedUnion('role', [textBoxSchema, logoBoxSchema]);

/** A look's picture: frame `frame` drawn into `ctx.canvas`, returning the text and resting marks it drew. */
export type RenderFrame<K extends LookCanvas> = (
  frame: number,
  ctx: LookContext<K>
) => readonly LookBox[];

function functionSchema<T>(): z.ZodType<T> {
  return z.custom<T>((value) => typeof value === 'function', { message: 'expected a function' });
}

/** The layers a look opts into beside its picture, whatever its canvas. */
const optInShape = {
  /** Motion-blur samples across the shutter; absent draws each frame's own instant only. */
  motionBlur: z.int().min(1).optional(),
  /** The post chain's settings for a frame; absent leaves the chain's effects at 0. */
  post: functionSchema<(frame: number) => PostSettings>().optional(),
  /** The UI layer: real `@hushbox/ui` components drawn from the frame inside `ProductFrame`. */
  Ui: functionSchema<ComponentType<UiProps>>().optional(),
  /** Where the UI layer sits on a frame; required beside `Ui`. */
  placeUi: functionSchema<(frame: number) => UiPlacement>().optional(),
};

const lookModuleSchema = z.discriminatedUnion('context', [
  z.object({
    context: z.literal('2d'),
    renderFrame: functionSchema<RenderFrame<'2d'>>(),
    ...optInShape,
  }),
  z.object({
    context: z.literal('webgl2'),
    renderFrame: functionSchema<RenderFrame<'webgl2'>>(),
    ...optInShape,
  }),
]);

/** A look module's exports, checked. */
export type LoadedLook = z.infer<typeof lookModuleSchema>;

/**
 * A look module's exports, crossing an untyped boundary (a bundler context), so
 * they are parsed; a module that breaks the contract is refused naming the look
 * and the export at fault.
 */
export function lookModuleOf(where: string, exports: unknown): LoadedLook {
  const parsed = lookModuleSchema.safeParse(exports);
  if (!parsed.success) {
    throw new Error(
      `${where}: a look module exports renderFrame(frame, ctx) and its canvas as context ('2d' or 'webgl2'), and may export motionBlur (a whole number of samples), post(frame), and a UI layer as Ui with placeUi(frame)\n${z.prettifyError(parsed.error)}`
    );
  }
  const look = parsed.data;
  if ((look.Ui === undefined) !== (look.placeUi === undefined)) {
    throw new Error(
      `${where}: a look with a UI layer exports both Ui and placeUi(frame), and this one exports only ${look.Ui === undefined ? 'placeUi' : 'Ui'}`
    );
  }
  if (look.Ui !== undefined && (look.motionBlur ?? 1) % 2 === 0) {
    throw new Error(
      `${where}: a look with a UI layer takes an odd motionBlur, so that the frame's own instant is one of its sub-frames and draws the front canvas; got ${String(look.motionBlur)}`
    );
  }
  return look;
}

/** Where `placeUi` put the UI layer on a frame, refused naming the look and the frame. */
export function uiPlacementOf(where: string, frame: number, returned: unknown): UiPlacement {
  const placement = UI_PLACEMENTS.find((candidate) => candidate === returned);
  if (placement === undefined) {
    throw new Error(
      `${where}: frame ${String(frame)}: placeUi(frame) returns one of ${UI_PLACEMENTS.join(', ')}, got ${JSON.stringify(returned)}`
    );
  }
  return placement;
}

/** What `renderFrame` returned for a frame, refused naming the look, the frame and the box at fault. */
export function textBoxesOf(where: string, frame: number, returned: unknown): LookBox[] {
  const parsed = z.array(lookBoxSchema).safeParse(returned);
  if (!parsed.success) {
    throw new Error(
      `${where}: frame ${String(frame)}: renderFrame returns the text it drew as a list of boxes, each with an id, its text, a finite box, a finite font size above 0 and a role, and may report the brand mark at rest as a box with an id, a finite box of positive size and the role logo\n${z.prettifyError(parsed.error)}`
    );
  }
  return parsed.data;
}

/** A frame's boxes parted into its text, which the text checks read, and its resting marks. */
export function splitLookBoxes(boxes: readonly LookBox[]): { text: TextBox[]; logos: LogoBox[] } {
  const text: TextBox[] = [];
  const logos: LogoBox[] = [];
  for (const box of boxes) {
    if (box.role === 'logo') {
      logos.push(box);
    } else {
      text.push(box);
    }
  }
  return { text, logos };
}

/**
 * The seeded source a look draws its random values from: a generator per key,
 * seeded from the film's or take's seed and the key, so a take and the film it
 * is ported to draw the same values.
 */
export function lookRandom(seed: string): (key: string) => () => number {
  return (key) => rand(`${seed}/${key}`);
}
