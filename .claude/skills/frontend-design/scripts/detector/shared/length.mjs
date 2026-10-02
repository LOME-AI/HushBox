// Reducing a CSS length to pixels, for every reader in the detector.
//
// Both analysis engines price font sizes, and a length priced differently by
// each is a divergence between them, so the reduction lives here once and each
// engine calls it: the regex engine on the declarations it matches in source
// text, the static-HTML engine on the values its cascade resolved.

/**
 * The argument of a `clamp()` that prices it: its minimum endpoint.
 *
 * `clamp(min, preferred, max)` renders as exactly one size at any one viewport
 * width, so the spread between its endpoints is a range no single rendering of
 * the page shows. The minimum is the size at the narrowest viewport, which is
 * where type that reads flat is least escapable — so that is the endpoint a
 * reader who cannot open a browser assumes.
 *
 * A first argument carrying a comma of its own (`clamp(min(1rem, 2vw), …)`)
 * comes back unbalanced and reduces to nothing, which is the same answer a unit
 * this module cannot reduce gets.
 *
 * @param {string | null | undefined} value
 * @returns {string | null}
 */
function clampMinimumArgument(value) {
  const match = /^clamp\(\s*([^,]+),/i.exec(String(value ?? '').trim());
  return match ? /** @type {string} */ (match[1]).trim() : null;
}

/**
 * A number with no unit after it.
 *
 * Its meaning is the reader's, never this module's: a multiple of the font size
 * to {@link resolveLineHeightPx}, and pixels to {@link reduceFontSizePx}. Each
 * reader is picked by what prices the value, never by whether the value is a
 * length — because whether a bare number reaches a length at all is a property
 * of the DOCUMENT rather than of the declaration, so no property is one where a
 * bare number simply is a length and none is one where it simply is not.
 *
 * Measured in Chromium, Firefox and WebKit, one page per document mode: a
 * standards-mode document drops `letter-spacing: 1.2`, `font-size: 14` and
 * `padding-top: 14` outright, and a quirks-mode document computes every one of
 * them to pixels under the unitless-length quirk. `line-height: 1.2` is the
 * same ratio of the element's own font size under both, which is what makes it
 * the value {@link resolveLineHeightPx} prices — not that it is the one
 * property whose bare number is a length.
 */
const BARE_NUMBER = /^-?\d*\.?\d+$/;

/** The answer for a value this module cannot reduce at any basis. */
const NOT_A_LENGTH = Object.freeze({ px: null, basisDependent: false });

/** What a reader passes {@link reduceLengthPx} when every value it hands over
 *  is in a unit that consumes no basis. The number reaches no answer; the
 *  reduction's own `basisDependent` is what says so, never this constant. */
const NO_BASIS = 0;

/**
 * A `padding` or `margin` declaration written in `rem`, in source text.
 *
 * `rem` and no other unit: a spacing value in `em` or a percentage is a
 * multiple of a font size this reader has no element to look up, so admitting
 * one would price it from a stand-in and put a spacing step on the page that no
 * rendering of it shows. Widening the unit means declining the reductions that
 * come back basis-dependent, not rounding them into the scale.
 */
const REM_SPACING_DECLARATION =
  /(?:padding|margin)(?:-(?:top|right|bottom|left))?\s*:\s*([\d.]+rem)/gi;

/**
 * @typedef {{ px: number | null, basisDependent: boolean }} Reduction
 */

/**
 * A CSS length in pixels, carrying the one fact a reader pricing an element
 * into a scale needs and a reader asking only whether the value reduces does
 * not: whether the number came out of the basis it was given.
 *
 * The two questions come apart wherever the basis is a stand-in for one the
 * reader has no document to read. Whether a length reduces is the same answer
 * at every basis, so a reader asking that passes any number and discards it.
 * What the length reduces TO is that number times a factor, so a reader pricing
 * from a stand-in would put a size on the page that no rendering of it shows —
 * `basisDependent` is what lets that reader decline instead of inventing one.
 *
 * `rem` is not basis-dependent: it is a multiple of the root font size, read
 * here as the default rather than from the caller's basis.
 *
 * Null is the answer for a unit there is nothing here to measure against — a
 * viewport unit with no viewport, an absolute unit with no device — and for a
 * {@link BARE_NUMBER}, which this function prices in no property at all: what
 * one is worth belongs to the reader that asked for it.
 *
 * @param {string | null | undefined} value
 * @param {number} fontSizePx
 * @returns {Reduction}
 */
function reduceLengthPx(value, fontSizePx) {
  const text = String(value ?? '').trim();
  if (!text || text === 'normal' || text === 'auto' || text === 'inherit') return NOT_A_LENGTH;
  const clampMinimum = clampMinimumArgument(text);
  if (clampMinimum !== null) return reduceLengthPx(clampMinimum, fontSizePx);
  const num = parseFloat(text);
  if (Number.isNaN(num)) return NOT_A_LENGTH;
  if (text.endsWith('px')) return { px: num, basisDependent: false };
  if (text.endsWith('rem')) return { px: num * 16, basisDependent: false };
  if (text.endsWith('em')) return { px: num * fontSizePx, basisDependent: true };
  if (text.endsWith('%')) return { px: (num / 100) * fontSizePx, basisDependent: true };
  return NOT_A_LENGTH;
}

/**
 * A CSS length in pixels, or null where this module cannot reduce it.
 *
 * The reducibility half of {@link reduceLengthPx}, for every reader that asks
 * whether a value reduces and not what a stand-in basis would make of it.
 * Returning a number where nothing reduces would price an element at a size the
 * page never renders, and a fabricated size is worse than a missing one: it
 * makes every rule reading it confidently wrong about the page rather than
 * silent about one element.
 *
 * @param {string | null | undefined} value
 * @param {number} fontSizePx
 * @returns {number | null}
 */
function resolveLengthPx(value, fontSizePx) {
  return reduceLengthPx(value, fontSizePx).px;
}

/**
 * A font size in a position that prices a bare number, reduced to pixels.
 *
 * Two positions do: a style object, where `{fontSize: 14}` renders at 14px, and
 * a presentation attribute, where `font-size="14"` is 14 user units. A
 * stylesheet declaration is neither — the same three characters are priced
 * there by the document rather than by the position ({@link BARE_NUMBER}) — so
 * the reading is here and not in {@link reduceLengthPx}: the unit of a bare
 * number is the context's, and this module holds one reader per context.
 *
 * @param {string | null | undefined} value
 * @param {number} fontSizePx
 * @returns {Reduction}
 */
function reduceFontSizePx(value, fontSizePx) {
  const text = String(value ?? '').trim();
  if (BARE_NUMBER.test(text)) return { px: parseFloat(text), basisDependent: false };
  return reduceLengthPx(text, fontSizePx);
}

/**
 * A `line-height` in pixels, or null where it cannot be reduced.
 *
 * The one reader that prices a {@link BARE_NUMBER} as a multiple: `line-height:
 * 1.2` is 1.2 times the element's own font size, in every document mode, so the
 * multiple is read here and nowhere else.
 *
 * @param {string | null | undefined} value
 * @param {number} fontSizePx
 * @returns {number | null}
 */
function resolveLineHeightPx(value, fontSizePx) {
  const px = resolveLengthPx(value, fontSizePx);
  if (px !== null) return px;
  const text = String(value ?? '').trim();
  return BARE_NUMBER.test(text) ? parseFloat(text) * fontSizePx : null;
}

/**
 * The pixel size of a font-size the static cascade has already computed, or
 * null where the cascade could not reduce the declaration and left it verbatim.
 *
 * Reading such a value with `parseFloat` takes the leading number off `4vw` and
 * prices the element at 4px, so every reader of a computed font size goes
 * through here instead. The cascade emits a plain `<number>px` string for every
 * font-size declaration it reduced and for every size a utility class states,
 * which is what makes the shape a sound test — and it is a sound test for a font
 * size alone, because the other values it stores unreduced sit on other
 * properties, deliberately so wherever one inherits as a ratio, and no reader of
 * a size reads those properties. `RATIO_INHERITED_FORM` in
 * `detector/engines/static-html/css-cascade.mjs` is what decides that.
 *
 * @param {string | null | undefined} value
 * @returns {number | null}
 */
function computedFontSizePx(value) {
  const match = /^\s*(-?\d*\.?\d+)px\s*$/.exec(String(value ?? ''));
  return match ? parseFloat(/** @type {string} */ (match[1])) : null;
}

/**
 * Every `padding`/`margin` declaration a source writes in `rem`, in pixels,
 * rounded the way a spacing scale is counted.
 *
 * Both engines' monotonous-spacing rules read these declarations out of the
 * same source text, and a declaration priced differently by each is a
 * divergence between them — so the pattern that finds one and the arithmetic
 * that reduces it live here once and each engine calls it.
 *
 * The reading is the pricing one: the number goes into a scale of spacing
 * values, where a size that came out of a stand-in basis would be a step the
 * page never renders. {@link REM_SPACING_DECLARATION} admits only the unit that
 * consumes no basis, which is what makes the basis passed below unreachable
 * rather than assumed.
 *
 * @param {string | null | undefined} text
 * @returns {number[]}
 */
function remSpacingPxValues(text) {
  /** @type {number[]} */
  const values = [];
  for (const match of String(text ?? '').matchAll(REM_SPACING_DECLARATION)) {
    const { px } = reduceLengthPx(/** @type {string} */ (match[1]), NO_BASIS);
    if (px !== null) values.push(Math.round(px));
  }
  return values;
}

export {
  BARE_NUMBER,
  clampMinimumArgument,
  computedFontSizePx,
  reduceFontSizePx,
  reduceLengthPx,
  remSpacingPxValues,
  resolveLengthPx,
  resolveLineHeightPx,
};
