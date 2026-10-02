// A verdict both analysis engines reach from the same raw source text.
//
// Each of these was written once per engine — the regex engine's whole-file
// analyzers, and `checkHtmlPatterns` in
// `.claude/skills/frontend-design/scripts/detector/rules/checks.mjs`, which the
// static-HTML engine calls — over the same characters, by the same arithmetic,
// reporting the same snippet. Two copies of one verdict are the
// duplication `docs/CODE-RULES.md` §One Implementation, Shared names, and the
// drift was not hypothetical: the copies already collected their inputs in
// different orders.
//
// The membership of this module is derived rather than listed. A verdict
// belongs here when both engines read it off the same source text and report
// the same thing. Two other shapes look like this one and are not it:
//
//   * a rule the engines read from DIFFERENT inputs — a resolved cascade on one
//     side and source text on the other — is two detectors of one anti-pattern
//     rather than two copies of one detector, and each keeps its own reading;
//   * a rule whose engines report different SETS from the same text — the regex
//     engine's matchers run per line and report every match, where a
//     document-level pattern reports the first — cannot be collapsed without
//     deciding which report shape wins, which is a decision about what the
//     detector says rather than about where its code lives.

import { remSpacingPxValues } from './length.mjs';

/**
 * A `padding` or `margin` declaration in pixels, in source text.
 * @see remSpacingPxValues for the same declaration written in `rem`.
 */
const PX_SPACING_DECLARATION = /(?:padding|margin)(?:-(?:top|right|bottom|left))?\s*:\s*(\d+)px/gi;

/** A `gap` declaration in pixels, in source text. */
const PX_GAP_DECLARATION = /gap\s*:\s*(\d+)px/gi;

/** A Tailwind spacing utility, whose numeric suffix counts in quarter-rem steps. */
const TAILWIND_SPACING_UTILITY = /\b(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap)-(\d+)\b/g;

/** The pixels one step of the Tailwind spacing scale is worth. */
const TAILWIND_SPACING_STEP_PX = 4;

/** The step a spacing value is counted at, which is what makes near-equal
 *  declarations one value of a scale rather than several. Equal to
 *  {@link TAILWIND_SPACING_STEP_PX} and independent of it: one is Tailwind's
 *  scale and the other is this rule's tolerance. */
const SPACING_COUNTING_STEP_PX = 4;

/**
 * Whether a spacing a rule DECLARED counts toward the scale.
 *
 * A zero is the absence of spacing rather than a step of a rhythm, and a value
 * this large is a layout dimension written as a margin. Neither bound reaches a
 * `gap` or a utility class: those are counted at every value, which is why
 * `gap: 0px` is a step of a scale here and `padding: 0px` is not. That
 * asymmetry is the behaviour both engines already had, preserved rather than
 * decided — closing it would change what the rule reports.
 *
 * @param {number} px
 */
function isCountedSpacing(px) {
  return px > 0 && px < 200;
}

/** The spacing values a source has to state before a rhythm can be read off it. */
const SPACING_SAMPLE_FLOOR = 10;

/** The share of a source's spacing one value has to hold to read as monotonous. */
const SPACING_DOMINANCE_FLOOR = 0.6;

/** The distinct spacing values a source may state and still read as monotonous. */
const SPACING_VARIETY_CAP = 3;

/**
 * Every spacing value one source states, at the step a scale counts them in.
 *
 * @param {string} text
 * @returns {number[]}
 */
function countedSpacingPx(text) {
  /** @type {number[]} */
  const values = [];
  for (const match of text.matchAll(PX_SPACING_DECLARATION)) {
    const px = Number(match[1]);
    if (isCountedSpacing(px)) values.push(px);
  }
  for (const px of remSpacingPxValues(text)) {
    if (isCountedSpacing(px)) values.push(px);
  }
  for (const match of text.matchAll(PX_GAP_DECLARATION)) values.push(Number(match[1]));
  for (const match of text.matchAll(TAILWIND_SPACING_UTILITY)) {
    values.push(Number(match[1]) * TAILWIND_SPACING_STEP_PX);
  }
  return values.map((px) => Math.round(px / SPACING_COUNTING_STEP_PX) * SPACING_COUNTING_STEP_PX);
}

/**
 * The monotonous-spacing verdict over one source's spacing, as the snippet both
 * engines report, or null where the source states no single rhythm.
 *
 * The values are counted in one pool whatever declared them, and the pool's
 * ORDER cannot reach the answer: the only place it could is a tie at the
 * maximum, and two values tied at the top put the total at twice the maximum or
 * more, so dominance cannot pass a half — below {@link SPACING_DOMINANCE_FLOOR}
 * before the tie is ever broken. That is what makes the two engines' different
 * collection orders the same verdict, and it is driven at the tie in
 * `.claude/skills/frontend-design/scripts/detector/source-verdicts.test.mjs`.
 *
 * @param {string} source
 * @returns {string | null}
 */
function monotonousSpacingSnippet(source) {
  const counted = countedSpacingPx(String(source ?? ''));
  if (counted.length < SPACING_SAMPLE_FLOOR) return null;

  /** @type {Record<number, number>} */
  const counts = {};
  for (const px of counted) counts[px] = (counts[px] || 0) + 1;
  const dominantCount = Math.max(...Object.values(counts));
  const dominance = dominantCount / counted.length;
  const distinct = [...new Set(counted)].filter((px) => px > 0);
  if (dominance <= SPACING_DOMINANCE_FLOOR || distinct.length > SPACING_VARIETY_CAP) return null;

  const ranked = /** @type {readonly [string, number][]} */ (
    Object.entries(counts).toSorted((a, b) => b[1] - a[1])
  );
  const dominant = /** @type {readonly [string, number]} */ (ranked[0])[0];
  return `~${dominant}px used ${dominantCount}/${counted.length} times (${Math.round(dominance * 100)}%)`;
}

/**
 * A background painted a dark hex, in source text: a six-digit hex whose red
 * channel is low, or a three-digit one.
 *
 * The declaration's two forms are two patterns rather than one alternation,
 * because a match of either is a match of the whole — every reader here asks
 * only whether one exists. Both are stateless by construction: a global flag on
 * a pattern only ever asked whether it matches would carry a match position
 * from one call into the next, and both callers read this module once and ask
 * it repeatedly.
 */
const DARK_BACKGROUND_HEX =
  /background(?:-color)?\s*:\s*(?:#(?:0[0-9a-f]|1[0-9a-f]|2[0-3])[0-9a-f]{4}\b|#[01][0-9a-f]{2}\b)/i;

/** A background painted a dark `rgb()`, whose every channel is under 100. */
const DARK_BACKGROUND_RGB =
  /background(?:-color)?\s*:\s*rgb\(\s*\d{1,2}\s*,\s*\d{1,2}\s*,\s*\d{1,2}\s*\)/i;

/** A Tailwind utility painting a dark neutral background. */
const DARK_BACKGROUND_UTILITY = /\bbg-(?:gray|slate|zinc|neutral|stone)-(?:9\d{2}|800)\b/;

/** A `box-shadow` declaration, up to the end of its value. */
const BOX_SHADOW_DECLARATION = /box-shadow\s*:\s*([^;{}]+)/gi;

/** The color a shadow is painted in, as `rgb()` or `rgba()` writes it. */
const SHADOW_RGB = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/;

/** Every length in a shadow's value: a pixel length, or a bare `0`, which is how
 *  a zero length is written. */
const SHADOW_LENGTH = /(\d+)px|(?<![.\d])\b(0)\b(?![.\d])/g;

/** The channel spread below which a shadow color is grey, and a grey shadow is
 *  a shadow rather than a glow. */
const GLOW_CHROMA_FLOOR = 30;

/** The blur a shadow has to carry before it reads as a glow rather than an edge. */
const GLOW_BLUR_FLOOR_PX = 4;

/** Where in a shadow's lengths the blur radius is written. */
const SHADOW_BLUR_POSITION = 2;

/**
 * The colour a shadow glows in, or null where the shadow is no glow: painted
 * grey, or drawn too tight to read as one.
 *
 * @param {string} value
 * @returns {{ red: number, green: number, blue: number } | null}
 */
function glowColor(value) {
  const color = SHADOW_RGB.exec(value);
  if (!color) return null;
  const [red, green, blue] = [Number(color[1]), Number(color[2]), Number(color[3])];
  if (Math.max(red, green, blue) - Math.min(red, green, blue) < GLOW_CHROMA_FLOOR) return null;
  const lengths = [...value.matchAll(SHADOW_LENGTH)].map((px) => Number(px[1] || px[2] || 0));
  if ((lengths[SHADOW_BLUR_POSITION] ?? 0) <= GLOW_BLUR_FLOOR_PX) return null;
  return { red, green, blue };
}

/**
 * The dark-glow verdict over one source, or null where it states no glow on a
 * dark surface.
 *
 * `index` is where in the source the shadow was written, which the regex engine
 * turns into a line number and the static-HTML engine, whose findings carry
 * none, discards.
 *
 * @param {string} source
 * @returns {{ snippet: string, index: number } | null}
 */
function darkGlowVerdict(source) {
  const text = String(source ?? '');
  const onDark =
    DARK_BACKGROUND_HEX.test(text) ||
    DARK_BACKGROUND_RGB.test(text) ||
    DARK_BACKGROUND_UTILITY.test(text);
  if (!onDark) return null;

  for (const shadow of text.matchAll(BOX_SHADOW_DECLARATION)) {
    const glow = glowColor(/** @type {string} */ (shadow[1]));
    if (glow === null) continue;
    return {
      snippet: `Colored glow (rgb(${glow.red},${glow.green},${glow.blue})) on dark page`,
      index: /** @type {number} */ (shadow.index),
    };
  }
  return null;
}

export { darkGlowVerdict, monotonousSpacingSnippet };
