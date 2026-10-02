import type { OverlayRect, OverlaySize } from './click-overlay-boxes.js';

/**
 * The step tokens of the shared sequential ramp, in order, as the heat's canvas
 * asks the theme for them.
 *
 * Named here rather than built from an index so the tokens the canvas reads are
 * the literal strings the reader's own union admits: a template built at runtime
 * would take a token the stylesheet never declared past the compiler and reach
 * the reader as a refusal nobody can see coming.
 */
export const SEQUENTIAL_TOKENS = ['--seq-1', '--seq-2', '--seq-3', '--seq-4', '--seq-5'] as const;

/** How many steps the ramp ranks a magnitude into. */
export const RAMP_STEPS = SEQUENTIAL_TOKENS.length;

/** One counted element, as the heat reads it. */
export interface HeatSource {
  /**
   * The element's own box, in the coordinates of whatever the framed page
   * positions it against: its document, or its viewport where it is pinned.
   */
  readonly rect: OverlayRect;
  /** What the read counted against the name a click on that element carries. */
  readonly visitors: number;
  /**
   * Whether the framed page holds the element against its viewport. A pinned
   * element's field is painted over the frame rather than over the page, so it
   * stays on the element while the page scrolls beneath it.
   */
  readonly pinned: boolean;
}

/** One soft field, ready to paint, in the framed page's own coordinates. */
export interface HeatField {
  readonly centreX: number;
  readonly centreY: number;
  /** How far the field reaches either side of its centre, and above and below. */
  readonly radiusX: number;
  readonly radiusY: number;
  /** Which ramp step carries this element's count, from 1 to `RAMP_STEPS`. */
  readonly step: number;
  /** Which of the two surfaces the field is painted on, carried from its source. */
  readonly pinned: boolean;
}

/**
 * How far past its own edge a field bleeds before it has faded out. Short on
 * purpose: the bleed is the only part of a field that sits over something the
 * read never counted, so it is kept to about a line of body text.
 */
const FEATHER = 22;

/** Extra bleed the busiest element on the page earns, on top of the feather. */
const REACH = 30;

/** `value` brought inside `[low, high]`. */
function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * Which ramp step carries `visitors` against the busiest element on the page.
 *
 * Linear in that share, and the one channel that carries the count: the field's
 * opacity is a constant and its reach is a matter of softness, so what the
 * legend states about the ramp is the whole of what the heat encodes. A counted
 * element never lands below the first step, because the palest step stands
 * barely off the page it is drawn over and a field fainter still would say
 * "nobody clicked here", which is the one thing a counted element does not say.
 */
function rampStep(visitors: number, most: number): number {
  return clamp(Math.ceil((visitors / most) * RAMP_STEPS), 1, RAMP_STEPS);
}

/** The busiest count among `sources`, or zero where nothing was counted. */
function busiest(sources: readonly HeatSource[]): number {
  return Math.max(0, ...sources.map((candidate) => candidate.visitors));
}

/** Which band of `bands` the middle of `source` falls in, over a page `contentHeight` tall. */
function bandOf(source: HeatSource, contentHeight: number, bands: number): number {
  const middle = source.rect.top + source.rect.height / 2;
  return clamp(Math.floor((middle / contentHeight) * bands), 0, bands - 1);
}

/** Everything `sources` counted between them. */
function counted(sources: readonly HeatSource[]): number {
  let sum = 0;
  for (const source of sources) sum += source.visitors;
  return sum;
}

/**
 * One field per counted element, shaped by that element's own box.
 *
 * An element nobody clicked earns no field at all rather than the palest one:
 * its badge states the zero, and a shade cannot say "no" on a ramp whose first
 * step is already all but invisible.
 *
 * The pinned elements are ranked here together with the rest of the page rather
 * than on a scale of their own, because the two sets are painted on different
 * surfaces and a reader compares them as one picture: two normalisations would
 * put the same shade on two different counts.
 */
export function heatFields(sources: readonly HeatSource[]): readonly HeatField[] {
  const most = busiest(sources);
  if (most === 0) return [];
  return sources
    .filter((candidate) => candidate.visitors > 0)
    .map((candidate) => {
      const share = candidate.visitors / most;
      const bleed = FEATHER + REACH * share;
      return {
        centreX: candidate.rect.left + candidate.rect.width / 2,
        centreY: candidate.rect.top + candidate.rect.height / 2,
        radiusX: candidate.rect.width / 2 + bleed,
        radiusY: candidate.rect.height / 2 + bleed,
        step: rampStep(candidate.visitors, most),
        pinned: candidate.pinned,
      };
    });
}

/** The counted range a legend states the ramp spans, or null where nothing was counted. */
export function heatRange(
  sources: readonly HeatSource[]
): { readonly least: number; readonly most: number } | null {
  const figures = sources.map((candidate) => candidate.visitors).filter((visitors) => visitors > 0);
  if (figures.length === 0) return null;
  return { least: Math.min(...figures), most: Math.max(...figures) };
}

/**
 * The page's clicks summed into `bands` horizontal slices, each as a ramp step
 * or zero, so a rail beside a scrolling frame can say which parts of the page
 * the counts are in.
 *
 * Zero is its own answer rather than the first step, for the reason `heatFields`
 * draws no field at all: a band with nothing counted in it is told from a band
 * with a little by carrying no shade, never by carrying a fainter one. Both the
 * rail and the fields rank against their own busiest reading through the same
 * step function, so the two encodings cannot disagree about what a shade means.
 */
export function railBands(
  sources: readonly HeatSource[],
  contentHeight: number,
  bands: number
): readonly number[] {
  // A pinned element is over every part of the page and in none of them, so it
  // bands nowhere: putting its count in the band its viewport box happens to
  // fall in would claim the page holds it there.
  const placed = sources.filter((source) => !source.pinned);
  const sums = Array.from({ length: bands }, (_unused, band) =>
    counted(placed.filter((source) => bandOf(source, contentHeight, bands) === band))
  );
  const most = Math.max(0, ...sums);
  if (most === 0) return sums.map(() => 0);
  return sums.map((sum) => (sum === 0 ? 0 : rampStep(sum, most)));
}

/**
 * How solid a field is at its centre. A constant rather than a second channel
 * for the count: the ramp step already carries that, and an opacity carrying it
 * too would put the legend's claim about the ramp in two places at once.
 */
const HEAT_ALPHA = 0.62;

/** Where the field is still at full strength before it starts to fade. */
const HEAT_CORE = 0.5;

/** How much of its strength a field keeps where the fade begins. */
const HEAT_CORE_ALPHA = 0.55;

/** A colour the ramp's tokens are written as, which an alpha channel appends to. */
const SIX_DIGIT_HEX = /^#[\da-f]{6}$/i;

/**
 * `colour` at `alpha`, as a canvas colour.
 *
 * The alpha rides as the fourth channel of the token's own value rather than
 * being rebuilt as an `rgba()` literal, so every colour the canvas paints with
 * is the text the stylesheet resolved and nothing here invents a channel of it.
 * A value the ramp did not resolve to six-digit hex is refused rather than
 * substituted, for the reason the theme reader refuses an empty one: a canvas
 * handed a colour it cannot parse keeps silently painting the last one.
 */
function atAlpha(colour: string, alpha: number): string {
  if (!SIX_DIGIT_HEX.test(colour)) {
    throw new Error(`paintHeat: the ramp resolved to ${colour}, which is not six-digit hex`);
  }
  return `${colour}${Math.round(alpha * 255)
    .toString(16)
    .padStart(2, '0')}`;
}

/**
 * Whether the canvas took the paint, asked of the canvas rather than assumed.
 *
 * A canvas the browser will not allocate is the quietest failure on this panel:
 * it reports the size it was asked for, accepts every drawing call, throws
 * nothing, and reads back empty. So the claim "the heat is drawn" is settled by
 * reading a pixel the paint must have filled: the centre of a field, which is
 * the one place on the canvas a field is at full strength. A field whose centre
 * the canvas does not cover is no evidence either way and is passed over; where
 * none of them is covered there is nothing to read and nothing is claimed.
 */
function paintLanded(
  context: CanvasRenderingContext2D,
  size: OverlaySize,
  fields: readonly HeatField[]
): boolean {
  const covered = fields.find(
    (field) =>
      field.centreX >= 0 &&
      field.centreX < size.width &&
      field.centreY >= 0 &&
      field.centreY < size.height
  );
  if (covered === undefined) return true;
  const pixel = context.getImageData(
    Math.floor(covered.centreX),
    Math.floor(covered.centreY),
    1,
    1
  );
  /* v8 ignore next 2 -- a one-pixel read always yields four channels, so the
     fallback is the compiler asking about an index it cannot prove rather than
     a state anything reaches. */
  return (pixel.data[3] ?? 0) > 0;
}

/**
 * Draw `fields` over the whole of a canvas of `size`, each in the ramp colour
 * its step names, and say whether the canvas took the paint.
 *
 * The field is an ellipse rather than a circle because it stands for one
 * element's box: the context is scaled to the field's own radii and a unit
 * circle drawn inside it, so a wide link warms a wide area and a tall one a
 * tall area. `colours` is the ramp as the theme resolved it this paint, so a
 * theme change repaints in the new values without anything here remembering the
 * old ones; the caller reads them, because a runtime with no 2d context to hand
 * out must not ask the theme for colours nothing will paint with.
 */
export function paintHeat(
  context: CanvasRenderingContext2D,
  size: OverlaySize,
  fields: readonly HeatField[],
  colours: readonly string[]
): boolean {
  context.clearRect(0, 0, size.width, size.height);
  // Walked by step rather than by field, so a colour is taken from the ramp
  // rather than looked up per field, and so the busier fields paint over the
  // quieter ones where two of them overlap.
  for (const [index, colour] of colours.entries()) {
    for (const field of fields) {
      if (field.step !== index + 1) continue;
      const gradient = context.createRadialGradient(0, 0, 0, 0, 0, 1);
      gradient.addColorStop(0, atAlpha(colour, HEAT_ALPHA));
      gradient.addColorStop(HEAT_CORE, atAlpha(colour, HEAT_ALPHA * HEAT_CORE_ALPHA));
      gradient.addColorStop(1, atAlpha(colour, 0));
      context.save();
      context.translate(field.centreX, field.centreY);
      context.scale(field.radiusX, field.radiusY);
      context.fillStyle = gradient;
      context.beginPath();
      context.arc(0, 0, 1, 0, Math.PI * 2);
      context.fill();
      context.restore();
    }
  }
  return paintLanded(context, size, fields);
}
