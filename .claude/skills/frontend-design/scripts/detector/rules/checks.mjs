import {
  BORDER_SAFE_TAGS,
  GENERIC_FONTS,
  KNOWN_SERIF_FONTS,
  SAFE_TAGS,
  TAILWIND_TEXT_SIZE_PX,
  TEXT_ELEMENT_SELECTOR,
  WCAG_LARGE_BOLD_TEXT_PX,
  WCAG_LARGE_TEXT_PX,
  WCAG_LARGE_TEXT_RATIO,
  WCAG_NORMAL_TEXT_RATIO,
} from '../shared/constants.mjs';
import {
  computedFontSizePx,
  resolveLengthPx,
  resolveLineHeightPx,
} from '../shared/length.mjs';
import { SCOPE_DOCUMENT, stripHtmlToText } from '../shared/page.mjs';
import { darkGlowVerdict, monotonousSpacingSnippet } from '../shared/source-verdicts.mjs';
import {
  colorToHex,
  contrastRatio,
  getHue,
  hasChroma,
  isNeutralColor,
  parseAnyColor,
  parseGradientColors,
  parseRgb,
  relativeLuminance,
} from '../shared/color.mjs';


/**
 * The element view every check reads. The static cascade's wrapper is the one
 * implementation in this tree; `getBoundingClientRect` is declared optional
 * because only a live browser provides one.
 * @typedef {import('../engines/static-html/css-cascade.mjs').StaticElement & { getBoundingClientRect?: () => DomRect | null, matches?: (selector: string) => boolean }} ElementLike
 */

/**
 * A computed style as the checks read it. The static cascade computes the
 * declared set; the members it never computes are declared optional, because
 * the same rules also run against a live CSSOM.
 * @typedef {import('../engines/static-html/css-cascade.mjs').StaticStyle & Partial<{ outline: string, insetBlock: string, insetInline: string, insetBlockStart: string, insetBlockEnd: string, insetInlineStart: string, insetInlineEnd: string }>} StyleLike
 */
/** @typedef {import('../engines/static-html/css-cascade.mjs').StaticDocument} DocumentLike */
/** @typedef {{ getComputedStyle: (el: ElementLike) => StyleLike }} WindowLike */
/**
 * A window carrying the document the cascade built, for a rule that must ask
 * whether the page states a property on an element itself. A computed style
 * cannot answer that — an inherited value and a declared one are the same string
 * there — so a rule needing the answer declares this window rather than
 * {@link WindowLike}.
 * @typedef {WindowLike & { document: DocumentLike }} WindowWithDocument
 */
/** @typedef {{ top: number, right: number, bottom: number, left: number, width: number, height: number }} DomRect */

/** One rule hit, before the registry turns it into a reported finding.
 *
 * `scope` is how a verdict states that it is a claim about the document as a
 * whole, which is what the page gate in `detector/shared/page.mjs` reads to
 * decide whether a source of component shape may carry it. A verdict that says
 * nothing is answerable on any markup and reports everywhere.
 * @typedef {{ id: string, snippet: string, scope?: string }} RuleFinding
 */

/** A colour in 8-bit sRGB with straight alpha.
 * @typedef {import('../shared/color.mjs').Rgb} Rgb
 */

/**
 * The platform's own computed style, for the callers that run these rules in a
 * live browser rather than over the static cascade.
 *
 * @param {ElementLike} el
 * @returns {StyleLike}
 */
function domComputedStyle(el) {
  return /** @type {StyleLike} */ (
    /** @type {unknown} */ (getComputedStyle(/** @type {Element} */ (/** @type {unknown} */ (el))))
  );
}

// ─── Section 3: Pure Detection ──────────────────────────────────────────────

/**
 * @param {string} tag
 * @param {Record<string, number>} widths
 * @param {Record<string, string>} colors
 * @param {number} radius
 * @returns {RuleFinding[]}
 */
function checkBorders(tag, widths, colors, radius) {
  if (BORDER_SAFE_TAGS.has(tag)) return [];
  const findings = [];
  const sides = ['Top', 'Right', 'Bottom', 'Left'];

  for (const side of sides) {
    const w = widths[side] ?? 0;
    if (w < 1 || isNeutralColor(colors[side])) continue;

    const otherSides = sides.filter((s) => s !== side);
    const maxOther = Math.max(...otherSides.map((s) => widths[s] ?? 0));
    if (!(w >= 2 && (maxOther <= 1 || w >= maxOther * 2))) continue;

    const sn = side.toLowerCase();
    const isSide = side === 'Left' || side === 'Right';

    if (isSide) {
      if (radius > 0) findings.push({ id: 'side-tab', snippet: `border-${sn}: ${w}px + border-radius: ${radius}px` });
      else if (w >= 3) findings.push({ id: 'side-tab', snippet: `border-${sn}: ${w}px` });
    } else {
      if (radius > 0 && w >= 2) findings.push({ id: 'border-accent-on-rounded', snippet: `border-${sn}: ${w}px + border-radius: ${radius}px` });
    }
  }

  return findings;
}

// Returns true if the given text is composed entirely of emoji characters
// (plus whitespace / variation selectors). Emojis render as multicolor glyphs
// regardless of CSS `color`, so contrast checks against the element's text
// color are meaningless for these nodes.
const EMOJI_CHAR_RE = /[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1F9FF}\u{1FA00}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]/u;
const EMOJI_CHARS_GLOBAL = /[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1F9FF}\u{1FA00}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]/gu;
/** @param {string | null | undefined} text */
function isEmojiOnlyText(text) {
  if (!text) return false;
  if (!EMOJI_CHAR_RE.test(text)) return false;
  return text.replace(EMOJI_CHARS_GLOBAL, '').trim() === '';
}

/**
 * Whether a contrast ratio is too low at every size the text could be: true
 * below the lenient large-text bar, false at or above the strict normal-text
 * bar, null between them.
 *
 * Size does not gate `low-contrast` — it picks which of the two bars applies —
 * so where the engine could not price a size there is no number to stand in
 * for it: any substitute picks a bar, and the bars disagree over exactly the
 * null range. The two ends are the verdicts no choice of bar can change. The
 * range between is the one where the size is load-bearing and unknown, and the
 * element carries {@link checkUnresolvableFontSizes}'s report of that, so
 * saying nothing here is not saying nothing about the element.
 *
 * @param {number} ratio
 * @returns {boolean | null}
 */
function failsEveryContrastBar(ratio) {
  if (ratio < WCAG_LARGE_TEXT_RATIO) return true;
  if (ratio >= WCAG_NORMAL_TEXT_RATIO) return false;
  return null;
}

/**
 * @param {{ tag: string, textColor: Rgb | null, bgColor: Rgb | null, effectiveBg: Rgb | null, effectiveBgStops?: readonly Rgb[] | null, fontSize: number, fontSizePriced: boolean, fontWeight: number, hasDirectText: boolean, isEmojiOnly?: boolean, bgClip?: string, bgImage?: string, classList?: string }} opts
 * @returns {RuleFinding[]}
 */
function checkColors(opts) {
  const { tag, textColor, bgColor, effectiveBg, effectiveBgStops, fontSize, fontSizePriced, fontWeight, hasDirectText, isEmojiOnly, bgClip, bgImage, classList } = opts;
  if (SAFE_TAGS.has(tag)) {
    // Exception for <a> and <button> elements styled as buttons. SAFE_TAGS
    // exists to suppress contrast noise on inline links and unstyled controls,
    // where the element has no own background and the contrast against the
    // ancestor surface is already the intended visual. When the element has
    // its own opaque background and direct text, it is a styled button — and
    // contrast on its own surface is a real, frequent bug worth flagging.
    const isStyledButton = (tag === 'a' || tag === 'button')
      && hasDirectText
      && bgColor && bgColor.a > 0.5;
    if (!isStyledButton) return [];
  }
  const findings = [];

  if (hasDirectText && textColor && !isEmojiOnly) {
    // Run background-dependent checks against either a solid bg or, if the
    // ancestor is a gradient, against every gradient stop (use the worst case).
    const bgs = effectiveBg ? [effectiveBg] : (effectiveBgStops && effectiveBgStops.length ? effectiveBgStops : null);
    if (bgs) {
      // Gray on colored background — flag if every stop is chromatic
      const textLum = relativeLuminance(textColor);
      const isGray = !hasChroma(textColor, 20) && textLum > 0.05 && textLum < 0.85;
      if (isGray && bgs.every(b => hasChroma(b, 40))) {
        const bgLabel = effectiveBg ? colorToHex(effectiveBg) : `gradient(${bgs.map(colorToHex).join(', ')})`;
        findings.push({ id: 'gray-on-color', snippet: `text ${colorToHex(textColor)} on bg ${bgLabel}` });
      }

      // Low contrast (WCAG AA) — worst case across all bg stops
      const ratios = bgs.map(b => contrastRatio(textColor, b));
      let worstIdx = 0;
      for (let i = 1; i < ratios.length; i++) {
        if ((ratios[i] ?? 0) < (ratios[worstIdx] ?? 0)) worstIdx = i;
      }
      const ratio = /** @type {number} */ (ratios[worstIdx]);
      const isLargeText = fontSize >= WCAG_LARGE_TEXT_PX || (fontSize >= WCAG_LARGE_BOLD_TEXT_PX && fontWeight >= 700);
      // A size the engine could not price selects no bar, so a finding made
      // without one rests on the lenient bar it also clears.
      const threshold = !fontSizePriced || isLargeText ? WCAG_LARGE_TEXT_RATIO : WCAG_NORMAL_TEXT_RATIO;
      const isLowContrast = fontSizePriced ? ratio < threshold : failsEveryContrastBar(ratio) === true;
      if (isLowContrast) {
        // Skip the false-positive class where text has alpha < 1 AND we
        // couldn't find an opaque ancestor (effectiveBg is null, we're
        // comparing against gradient-stop fallback). When the static cascade
        // can't resolve a `var(--X)` color token, a dark
        // section sitting between the text and the body's decorative
        // gradient is invisible to us — we end up measuring contrast
        // against the body's paper-grain noise instead of the real
        // local bg. Real low-contrast bugs use alpha=1 and have a
        // resolvable opaque ancestor; semi-transparent Tailwind tokens
        // like `text-paper/60` on `bg-ink` sections are the FP pattern.
        const isAlphaFallbackFP = !effectiveBg && (textColor.a != null && textColor.a < 1);
        if (!isAlphaFallbackFP) {
          findings.push({ id: 'low-contrast', snippet: `${ratio.toFixed(1)}:1 (need ${threshold}:1) — text ${colorToHex(textColor)} on ${colorToHex(bgs[worstIdx] ?? null)}` });
        }
      }
    }

    // AI palette: purple/violet on headings
    if (hasChroma(textColor, 50)) {
      const hue = getHue(textColor);
      if (hue >= 260 && hue <= 310 && (['h1', 'h2', 'h3'].includes(tag) || fontSize >= 20)) {
        findings.push({ id: 'ai-color-palette', snippet: `Purple/violet text (${colorToHex(textColor)}) on heading` });
      }
    }
  }

  // Gradient text
  if (bgClip === 'text' && bgImage && bgImage.includes('gradient')) {
    findings.push({ id: 'gradient-text', snippet: 'background-clip: text + gradient' });
  }

  // Tailwind class checks
  if (classList) {
    const classStr = typeof classList === 'string' ? classList : Array.from(classList).join(' ');

    const grayMatch = classStr.match(/\btext-(?:gray|slate|zinc|neutral|stone)-\d+\b/);
    const colorBgMatch = classStr.match(/\bbg-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d+\b/);
    if (grayMatch && colorBgMatch) {
      findings.push({ id: 'gray-on-color', snippet: `${grayMatch[0]} on ${colorBgMatch[0]}` });
    }

    if (/\bbg-clip-text\b/.test(classStr) && /\bbg-gradient-to-/.test(classStr)) {
      findings.push({ id: 'gradient-text', snippet: 'bg-clip-text + bg-gradient (Tailwind)' });
    }

    const purpleText = classStr.match(/\btext-(?:purple|violet|indigo)-\d+\b/);
    if (purpleText && (['h1', 'h2', 'h3'].includes(tag) || /\btext-(?:[2-9]xl)\b/.test(classStr))) {
      findings.push({ id: 'ai-color-palette', snippet: `${purpleText[0]} on heading` });
    }

    // The snippet names the class rather than the palette, which is what every
    // other verdict in this family names in both engines and what the author
    // edits. It is also the phrasing the source-text reading of this rule
    // already gave, so one verdict now reads the same whichever engine reached
    // it.
    const gradientFrom = classStr.match(/\bfrom-(?:purple|violet|indigo)-\d+\b/);
    if (gradientFrom && /\bto-(?:purple|violet|indigo|blue|cyan|pink|fuchsia)-\d+\b/.test(classStr)) {
      findings.push({ id: 'ai-color-palette', snippet: `${gradientFrom[0]} gradient` });
    }
  }

  return findings;
}

/**
 * @param {boolean} hasShadow
 * @param {boolean} hasBorder
 * @param {boolean} hasRadius
 * @param {boolean} hasBg
 */
function isCardLikeFromProps(hasShadow, hasBorder, hasRadius, hasBg) {
  if (!hasShadow && !hasBorder) return false;
  return hasRadius || hasBg;
}

/** The tags a heading is written under. Exported because both engines ask the
 *  same question of the same set, and two copies of it would drift into
 *  disagreeing about what a heading is. */
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

// Pure check: given a heading and metrics about its previousElementSibling,
// decide if the sibling is the canonical "icon-tile-stacked-above-heading" shape.
//
// Triggers when ALL of the following hold for the sibling:
//   • size 32–128px on both axes (not too small, not a hero image)
//   • aspect ratio 0.7–1.4 (squarish — excludes wide thumbnails / pill badges)
//   • has a non-transparent background-color, background-image, OR a visible border
//     (covers solid colors, white-with-border, gradients — anything that visually
//      defines a tile)
//   • border-radius < width/2 (excludes round avatars; rounded squares pass)
//   • contains an <svg> or icon-class <i> element that's smaller than the tile
//   • the tile sits above the heading (its bottom is above the heading's top)
/**
 * @param {{ headingTag: string, headingText: string, headingTop: number, siblingTag: string | null, siblingWidth: number, siblingHeight: number, siblingBottom: number, siblingBgColor: Rgb | null, siblingBgImage: string, siblingBorderWidth: number, siblingBorderRadius: number, hasIconChild: boolean, iconChildWidth: number }} opts
 * @returns {RuleFinding[]}
 */
function checkIconTile(opts) {
  const { headingTag, headingText, headingTop,
          siblingTag, siblingWidth, siblingHeight, siblingBottom,
          siblingBgColor, siblingBgImage, siblingBorderWidth, siblingBorderRadius,
          hasIconChild, iconChildWidth } = opts;
  if (!HEADING_TAGS.has(headingTag)) return [];
  if (!siblingTag) return [];
  // Don't recurse into nested headings (e.g. h2 above h3 in a section header)
  if (HEADING_TAGS.has(siblingTag)) return [];

  // Size window: 32–128px on each axis
  if (!(siblingWidth >= 32 && siblingWidth <= 128)) return [];
  if (!(siblingHeight >= 32 && siblingHeight <= 128)) return [];

  // Squarish aspect ratio
  const ratio = siblingWidth / siblingHeight;
  if (ratio < 0.7 || ratio > 1.4) return [];

  // Must have something that visually defines the tile
  const bgVisible = (siblingBgColor && siblingBgColor.a > 0.1)
    || (siblingBgImage && siblingBgImage !== 'none' && siblingBgImage !== '');
  const borderVisible = siblingBorderWidth > 0;
  if (!bgVisible && !borderVisible) return [];

  // Exclude circles (avatars). Rounded squares pass.
  if (siblingBorderRadius >= siblingWidth / 2) return [];

  // Must contain an icon element smaller than the tile
  if (!hasIconChild) return [];
  if (iconChildWidth && iconChildWidth >= siblingWidth * 0.95) return [];

  // Vertical stacking: tile must end above where the heading starts.
  // (Allow the check to skip when both top/bottom are 0 — the static cascade
  // does no layout, so rects come back as 0.)
  if (headingTop && siblingBottom && siblingBottom > headingTop + 4) return [];

  const text = (headingText || '').trim().slice(0, 60);
  return [{
    id: 'icon-tile-stack',
    snippet: `${Math.round(siblingWidth)}x${Math.round(siblingHeight)}px icon tile above ${headingTag} "${text}"`,
  }];
}

// Resolve the primary (non-generic) face from a font-family string and return
// whether the resolved primary is serif. Two paths:
//   1. Primary face is in KNOWN_SERIF_FONTS → serif.
//   2. Primary face is unknown but the stack ends in the generic `serif`
//      token → treat as serif. Authors who declare `font-family: 'X', serif`
//      almost always have a serif primary; a sans declared with a serif
//      fallback is a code smell, not the common case.
// Returns { primary, isSerif } so the snippet can name the face.
/** @param {string} fontFamily */
function resolveSerif(fontFamily) {
  if (!fontFamily) return { primary: null, isSerif: false };
  const tokens = fontFamily.split(',').map(f => f.trim().replace(/^['"]|['"]$/g, '').toLowerCase());
  const primary = tokens.find(f => f && !GENERIC_FONTS.has(f)) || null;
  if (!primary) return { primary: null, isSerif: false };
  if (KNOWN_SERIF_FONTS.has(primary)) return { primary, isSerif: true };
  if (tokens.includes('serif')) return { primary, isSerif: true };
  return { primary, isSerif: false };
}

/**
 * @param {{ tag: string, fontStyle: string, fontFamily: string, fontSize: number, headingText: string }} opts
 * @returns {RuleFinding[]}
 */
function checkItalicSerif(opts) {
  const { tag, fontStyle, fontFamily, fontSize, headingText } = opts;
  if (fontStyle !== 'italic') return [];
  // Anchor the rule on hero-scale text. h1 is the canonical hero element;
  // h2 ≥ 48px catches the cases where the design demotes the visual hero
  // to an h2 but keeps the size.
  if (tag !== 'h1' && !(tag === 'h2' && fontSize >= 48)) return [];
  if (fontSize < 48) return [];
  const { primary, isSerif } = resolveSerif(fontFamily);
  if (!isSerif) return [];

  const text = (headingText || '').trim().slice(0, 60);
  return [{
    id: 'italic-serif-display',
    snippet: `italic serif ${tag} (${primary || 'serif'}) at ${Math.round(fontSize)}px "${text}"`,
  }];
}

// Color saturation check. Returns true when the color has visible
// chroma — i.e., it's an "accent color" rather than near-neutral.
// Handles rgb()/rgba(), #hex, oklch(), and hsl(). var() refs are
// expected to be pre-resolved by the caller.
/** @param {string | null | undefined} cssColor */
function isAccentColor(cssColor) {
  if (!cssColor) return false;
  const s = String(cssColor).trim();
  // rgb / rgba — direct channel-distance check.
  const rgbStrict = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(s);
  if (rgbStrict) {
    const [, rs, gs, bs] = /** @type {readonly [string, string, string, string]} */ (
      /** @type {unknown} */ (rgbStrict)
    );
    const r = +rs, g = +gs, b = +bs;
    return (Math.max(r, g, b) - Math.min(r, g, b)) >= 40;
  }
  // #hex — 3, 4, 6, or 8 digit.
  const hexM = /^#([0-9a-f]{3,8})\b/i.exec(s);
  if (hexM) {
    let h = /** @type {string} */ (hexM[1]);
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('').slice(0, 6);
    else h = h.slice(0, 6);
    if (h.length === 6) {
      const r = parseInt(h.slice(0, 2), 16);
      const g = parseInt(h.slice(2, 4), 16);
      const b = parseInt(h.slice(4, 6), 16);
      return (Math.max(r, g, b) - Math.min(r, g, b)) >= 40;
    }
  }
  // oklch(L C H) — chroma C is what matters. Typical neutral grays
  // have C < 0.02; visible accents are 0.05+. CSS minification can
  // collapse spaces between L% and C ("oklch(43%.15 34)"), so we
  // extract all numbers and take the second rather than matching a
  // strict L-then-whitespace-then-C pattern.
  if (/^oklch\(/i.test(s)) {
    const nums = s.match(/\d*\.\d+|\d+/g);
    if (nums && nums.length >= 2) {
      const c = parseFloat(/** @type {string} */ (nums[1]));
      return !Number.isNaN(c) && c >= 0.05;
    }
  }
  // hsl(H, S%, L%) — saturation > 20% reads as accent.
  const hslM = /hsla?\(\s*[\d.]+\s*,\s*([\d.]+)%/i.exec(s);
  if (hslM) {
    const sat = parseFloat(/** @type {string} */ (hslM[1]));
    return !Number.isNaN(sat) && sat >= 20;
  }
  return false;
}

// Sibling-relationship rule. Anchor on any h1 regardless of its size, look at
// the previousElementSibling, and gate on EITHER the classic tracked-
// uppercase eyebrow OR the modern accent-colored bold eyebrow.
/**
 * @param {{ headingTag: string, headingText: string, headingFontSize: number, siblingTag: string | null, siblingText: string, siblingTextTransform: string, siblingFontSize: number, siblingLetterSpacing: number, siblingFontWeight: number, siblingColor: string }} opts
 * @returns {RuleFinding[]}
 */
function checkHeroEyebrow(opts) {
  const {
    headingTag, headingText, headingFontSize: _headingFontSize,
    siblingTag, siblingText, siblingTextTransform,
    siblingFontSize, siblingLetterSpacing,
    siblingFontWeight, siblingColor,
  } = opts;
  if (headingTag !== 'h1') return [];
  // `headingFontSize` is destructured and never read: no threshold on it anchors
  // "hero scale" here. Where the static cascade cannot reduce a declared
  // font-size to pixels (a var() the page never declares, or a unit there is
  // nothing to measure against), it leaves the value verbatim,
  // {@link computedFontSizePx} reads no number off it, and the `?? 0` in
  // {@link checkElementHeroEyebrow} hands this rule the number 0 instead — so any
  // positive threshold rejects those h1s. The remaining gates in this function
  // were judged tight enough on their own: the label they describe, sitting
  // directly above an h1, is the antipattern whatever size that h1 resolves to.
  if (!siblingTag) return [];
  // An h2 above an h1 is a different anti-pattern (heading hierarchy / dual
  // headings) — never an eyebrow.
  if (HEADING_TAGS.has(siblingTag)) return [];

  const text = (siblingText || '').trim();
  if (text.length < 2 || text.length > 60) return [];
  if (!(siblingFontSize > 0 && siblingFontSize <= 14)) return [];

  // Branch A: classic tracked-uppercase eyebrow.
  const isUppercased = siblingTextTransform === 'uppercase'
    || (/[A-Z]/.test(text) && !/[a-z]/.test(text));
  const isClassicTracked = isUppercased && siblingLetterSpacing >= 1.6;

  // Branch B: modern accent-bold eyebrow — sentence case, low
  // tracking, but bold + accent-colored. The style choices changed;
  // the pattern is the same kicker-above-headline anti-pattern.
  const weight = Number(siblingFontWeight) || 400;
  const isAccentBold = weight >= 700 && isAccentColor(siblingColor || '');

  if (!isClassicTracked && !isAccentBold) return [];

  const headingTextSnippet = (headingText || '').trim().slice(0, 60);
  const eyebrowSnippet = text.slice(0, 40);
  const style = isClassicTracked ? 'tracked-caps' : 'accent-bold';
  return [{
    id: 'hero-eyebrow-chip',
    snippet: `eyebrow chip (${style}) "${eyebrowSnippet}" above ${headingTag} "${headingTextSnippet}"`,
  }];
}

/**
 * @param {{ candidates: readonly { kickerText: string, headingTag: string, headingText: string }[], minCount?: number }} opts
 * @returns {RuleFinding[]}
 */
function checkRepeatedSectionKickers(opts) {
  const { candidates, minCount = 3 } = opts;
  if (!Array.isArray(candidates) || candidates.length < minCount) return [];
  return candidates.map(candidate => ({
    id: 'repeated-section-kickers',
    scope: SCOPE_DOCUMENT,
    snippet: `repeated section kicker "${candidate.kickerText}" before ${candidate.headingTag} "${candidate.headingText}" (${candidates.length} on page)`,
  }));
}

const LAYOUT_TRANSITION_PROPS = new Set([
  'width', 'height', 'padding', 'margin',
  'max-height', 'max-width', 'min-height', 'min-width',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
]);

/**
 * @param {{ tag: string, transitionProperty: string, animationName: string, timingFunctions: string, classList?: string }} opts
 * @returns {RuleFinding[]}
 */
function checkMotion(opts) {
  const { tag, transitionProperty, animationName, timingFunctions, classList } = opts;
  if (SAFE_TAGS.has(tag)) return [];
  const findings = [];

  // --- Bounce/elastic easing ---
  if (animationName && animationName !== 'none' && /bounce|elastic|wobble|jiggle|spring/i.test(animationName)) {
    findings.push({ id: 'bounce-easing', snippet: `animation: ${animationName}` });
  }
  if (classList && /\banimate-bounce\b/.test(classList)) {
    findings.push({ id: 'bounce-easing', snippet: 'animate-bounce (Tailwind)' });
  }

  // Every overshoot cubic-bezier the element carries (y values outside [0, 1]),
  // and each distinct curve once. The value read here is the element's animation
  // timing and its transition timing joined into one string by the caller, so a
  // curve matching twice is that join restating one curve rather than two things
  // that bounce — and a finding carrying no line and no property name has
  // nothing to tell two such rows apart with.
  if (timingFunctions) {
    const bezierRe = /cubic-bezier\(\s*([\d.-]+)\s*,\s*([\d.-]+)\s*,\s*([\d.-]+)\s*,\s*([\d.-]+)\s*\)/g;
    /** @type {Set<string>} */
    const overshooting = new Set();
    let m;
    while ((m = bezierRe.exec(timingFunctions)) !== null) {
      const y1 = parseFloat(/** @type {string} */ (m[2])),
      y2 = parseFloat(/** @type {string} */ (m[4]));
      if (y1 < -0.1 || y1 > 1.1 || y2 < -0.1 || y2 > 1.1) {
        overshooting.add(`cubic-bezier(${m[1]}, ${m[2]}, ${m[3]}, ${m[4]})`);
      }
    }
    for (const snippet of overshooting) findings.push({ id: 'bounce-easing', snippet });
  }

  // --- Layout property transition ---
  if (transitionProperty && transitionProperty !== 'all' && transitionProperty !== 'none') {
    const props = transitionProperty.split(',').map(p => p.trim().toLowerCase());
    const layoutFound = props.filter(p => LAYOUT_TRANSITION_PROPS.has(p));
    if (layoutFound.length > 0) {
      findings.push({ id: 'layout-transition', snippet: `transition: ${layoutFound.join(', ')}` });
    }
  }

  return findings;
}

/**
 * @param {{ boxShadow: string, effectiveBg: Rgb | null }} opts
 * @returns {RuleFinding[]}
 */
function checkGlow(opts) {
  const { boxShadow, effectiveBg } = opts;
  if (!boxShadow || boxShadow === 'none') return [];
  if (!effectiveBg) return [];

  // Only flag on dark backgrounds (luminance < 0.1)
  const bgLum = relativeLuminance(effectiveBg);
  if (bgLum >= 0.1) return [];

  // Split multiple shadows (commas not inside parentheses)
  const parts = boxShadow.split(/,(?![^(]*\))/);
  for (const shadow of parts) {
    const colorMatch = shadow.match(/rgba?\([^)]+\)/);
    if (!colorMatch) continue;
    const color = parseRgb(colorMatch[0]);
    if (!color || !hasChroma(color, 30)) continue;

    // Extract px values — in computed style: "color Xpx Ypx BLURpx [SPREADpx]"
    const afterColor = shadow.substring(shadow.indexOf(colorMatch[0]) + colorMatch[0].length);
    const beforeColor = shadow.substring(0, shadow.indexOf(colorMatch[0]));
    const pxVals = [...beforeColor.matchAll(/([\d.]+)px/g), ...afterColor.matchAll(/([\d.]+)px/g)]
      .map((m) => parseFloat(/** @type {string} */ (m[1])));

    // Third value is blur (offset-x, offset-y, blur, [spread])
    if (pxVals.length >= 3 && (pxVals[2] ?? 0) > 4) {
      return [{ id: 'dark-glow', snippet: `Colored glow (${colorToHex(color)}) on dark background` }];
    }
  }

  return [];
}

/**
 * Regex-on-HTML checks shared between browser and Node page-level detection.
 * These don't need DOM access, just the raw HTML string.
 */
/**
 * @param {string} html
 * @returns {RuleFinding[]}
 */
function checkHtmlPatterns(html) {
  const findings = [];

  // --- Color ---

  // AI color palette: purple/violet
  const purpleHexRe = /#(?:7c3aed|8b5cf6|a855f7|9333ea|7e22ce|6d28d9|6366f1|764ba2|667eea)\b/gi;
  if (purpleHexRe.test(html)) {
    const purpleTextRe = /(?:(?:^|;)\s*color\s*:\s*(?:.*?)(?:#(?:7c3aed|8b5cf6|a855f7|9333ea|7e22ce|6d28d9))|gradient.*?#(?:7c3aed|8b5cf6|a855f7|764ba2|667eea))/gi;
    if (purpleTextRe.test(html)) {
      findings.push({ id: 'ai-color-palette', snippet: 'Purple/violet accent colors detected' });
    }
  }

  // Gradient text (background-clip: text + gradient)
  const gradientRe = /(?:-webkit-)?background-clip\s*:\s*text/gi;
  let gm;
  while ((gm = gradientRe.exec(html)) !== null) {
    const start = Math.max(0, gm.index - 200);
    const context = html.substring(start, gm.index + gm[0].length + 200);
    if (/gradient/i.test(context)) {
      findings.push({ id: 'gradient-text', snippet: 'background-clip: text + gradient' });
      break;
    }
  }
  if (/\bbg-clip-text\b/.test(html) && /\bbg-gradient-to-/.test(html)) {
    findings.push({ id: 'gradient-text', snippet: 'bg-clip-text + bg-gradient (Tailwind)' });
  }

  // --- Layout ---

  // Monotonous spacing
  const spacingSnippet = monotonousSpacingSnippet(html);
  if (spacingSnippet !== null) {
    findings.push({ id: 'monotonous-spacing', scope: SCOPE_DOCUMENT, snippet: spacingSnippet });
  }

  // --- Motion ---

  // Bounce/elastic animation names. Every declaration the source states, not the
  // first: each is a separate place a reader has to change, and the regex
  // engine's byte-identical pattern already reports them all, so a first-only
  // report here was the same characters read into a different answer.
  const bounceRe = /animation(?:-name)?\s*:\s*([^;{}]*(?:bounce|elastic|wobble|jiggle|spring)[^;{}]*)/gi;
  let bounceMatch;
  while ((bounceMatch = bounceRe.exec(html)) !== null) {
    const bounceValue = /** @type {string} */ (bounceMatch[1]);
    const animationToken = bounceValue
      .split(/[,\s]+/)
      .find((part) => /bounce|elastic|wobble|jiggle|spring/i.test(part));
    findings.push({ id: 'bounce-easing', snippet: `animation: ${animationToken || bounceValue.trim()}` });
  }

  // Overshoot cubic-bezier, on the same reading: every curve that leaves the
  // unit square, and none that stays inside it.
  const bezierRe = /cubic-bezier\(\s*([\d.-]+)\s*,\s*([\d.-]+)\s*,\s*([\d.-]+)\s*,\s*([\d.-]+)\s*\)/g;
  let bm;
  while ((bm = bezierRe.exec(html)) !== null) {
    const y1 = parseFloat(/** @type {string} */ (bm[2])),
      y2 = parseFloat(/** @type {string} */ (bm[4]));
    if (y1 < -0.1 || y1 > 1.1 || y2 < -0.1 || y2 > 1.1) {
      findings.push({ id: 'bounce-easing', snippet: `cubic-bezier(${bm[1]}, ${bm[2]}, ${bm[3]}, ${bm[4]})` });
    }
  }

  // Layout property transitions
  const transRe = /transition(?:-property)?\s*:\s*([^;{}]+)/gi;
  let tm;
  while ((tm = transRe.exec(html)) !== null) {
    const val = /** @type {string} */ (tm[1]).toLowerCase();
    if (/\ball\b/.test(val)) continue;
    const found = val.match(/\b(?:(?:max|min)-)?(?:width|height)\b|\bpadding(?:-(?:top|right|bottom|left))?\b|\bmargin(?:-(?:top|right|bottom|left))?\b/gi);
    if (found) {
      findings.push({ id: 'layout-transition', snippet: `transition: ${found.join(', ')}` });
      break;
    }
  }

  // --- Dark glow ---

  // The verdict carries where in the source the shadow sits; a static-HTML
  // finding has no line to put it on, so this reader takes the snippet alone.
  const glow = darkGlowVerdict(html);
  if (glow !== null) {
    findings.push({ id: 'dark-glow', scope: SCOPE_DOCUMENT, snippet: glow.snippet });
  }

  // --- Provider tells (gated): repeating-gradient stripes (GPT) ---
  if (/repeating-(?:linear|radial|conic)-gradient\s*\(/i.test(html)) {
    findings.push({ id: 'repeating-stripes-gradient', snippet: 'repeating-gradient decorative stripes' });
  }

  // --- Provider tells (gated): "X theater" framing copy (GPT) ---
  // Lives here (regex-on-HTML) rather than in the text-content analyzers so it
  // runs in the bundled browser path too, not just the CLI/static path.
  {
    const tm = /\b(\w+)\s+theater\b/i.exec(stripHtmlToText(html));
    if (tm) findings.push({ id: 'theater-slop-phrase', snippet: `"${tm[0].trim()}"` });
  }

  // --- Provider tells (gated): image hover transform (Gemini) ---
  // A CSS `img...:hover { transform: ... }` rule, or a Tailwind hover:scale /
  // hover:rotate / hover:translate utility on an <img>. Each distinct
  // mechanism is its own finding.
  const imgHoverCss = /\bimg\b[^,{}]*:hover\b[^{}]*\{[^}]*\btransform\s*:\s*(?:scale|rotate|translate|matrix|skew)/i;
  if (imgHoverCss.test(html)) {
    findings.push({ id: 'image-hover-transform', snippet: 'img:hover { transform } rule' });
  }
  const imgTagRe = /<img\b[^>]*\bclass\s*=\s*"([^"]*)"/gi;
  let im;
  while ((im = imgTagRe.exec(html)) !== null) {
    if (/\bhover:(?:scale|rotate|translate|skew)-/.test(/** @type {string} */ (im[1]))) {
      findings.push({ id: 'image-hover-transform', snippet: 'Tailwind hover transform on <img>' });
    }
  }

  return findings;
}

// ─── Section 4: resolveBackground (unified) ─────────────────────────────────

// Read the element's own background color, computed-style first, with a
// fallback that parses the inline `background:` shorthand from the raw style
// attribute. The static css-tree cascade does not decompose the shorthand
// into `backgroundColor`, so without this fallback the CLI silently returns
// null for any element styled via `background: rgb(...)` or `background: #abc`.
/**
 * @param {ElementLike} el
 * @param {StyleLike} computedStyle
 */
function readOwnBackgroundColor(el, computedStyle) {
  const bg = parseRgb(computedStyle.backgroundColor);
  if (bg && bg.a >= 0.1) return bg;
  const rawStyle = el.getAttribute?.('style') || '';
  const bgMatch = rawStyle.match(/background(?:-color)?\s*:\s*([^;]+)/i);
  const inlineBg = bgMatch ? /** @type {string} */ (bgMatch[1]).trim() : '';
  if (!inlineBg) return bg;
  if (/gradient/i.test(inlineBg) || /url\s*\(/i.test(inlineBg)) return bg;
  const fromRgb = parseRgb(inlineBg);
  if (fromRgb) return fromRgb;
  const hexMatch = inlineBg.match(/#([0-9a-f]{6}|[0-9a-f]{3})\b/i);
  if (hexMatch) {
    const h = /** @type {string} */ (hexMatch[1]);
    if (h.length === 6) {
      return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
    }
    const [d0, d1, d2] = /** @type {readonly [string, string, string]} */ (
      /** @type {unknown} */ (h.split(''))
    );
    return {
      r: parseInt(d0 + d0, 16),
      g: parseInt(d1 + d1, 16),
      b: parseInt(d2 + d2, 16),
      a: 1,
    };
  }
  return bg;
}

/**
 * @param {ElementLike | null} el
 * @param {WindowLike} win
 * @param {Map<string, string> | null} [customPropMap]
 * @returns {Rgb | null}
 */
function resolveBackground(el, win, customPropMap) {
  let current = el;
  while (current && current.nodeType === 1) {
    const style = win.getComputedStyle(current);
    const bgImage = style.backgroundImage || '';
    const hasGradientOrUrl = bgImage && bgImage !== 'none' && (/gradient/i.test(bgImage) || /url\s*\(/i.test(bgImage));

    // Try the solid bg-color FIRST. If the element has both a solid color
    // and a gradient/url overlay (a common pattern: `background: var(--paper)
    // radial-gradient(...)` for paper-grain texture), the solid color is the
    // dominant visible surface for contrast purposes; the overlay is
    // decorative. The old behavior bailed on any gradient ancestor, which
    // caused massive false-positive contrast findings on grain-textured
    // body backgrounds.
    let bg = parseRgb(style.backgroundColor);
    if (!bg || bg.a < 0.1) {
      // The static cascade returns literal "var(--X)" / "oklch(...)" strings.
      // Resolve through customPropMap so Tailwind v4 color tokens become RGB.
      if (customPropMap) {
        bg = parseColorResolved(style.backgroundColor, customPropMap);
      }
      if (!bg || bg.a < 0.1) {
        // Inline-style fallback. The static cascade doesn't decompose the
        // background shorthand, so colors set via inline style are otherwise invisible.
        const rawStyle = current.getAttribute?.('style') || '';
        const bgMatch = rawStyle.match(/background(?:-color)?\s*:\s*([^;]+)/i);
        const inlineBg = bgMatch ? /** @type {string} */ (bgMatch[1]).trim() : '';
        if (inlineBg && !/gradient/i.test(inlineBg) && !/url\s*\(/i.test(inlineBg)) {
          bg = parseColorResolved(inlineBg, customPropMap) || parseAnyColor(inlineBg);
        }
      }
    }

    if (bg && bg.a > 0.1) {
      if (bg.a >= 0.5) return bg;
    }
    // No solid bg-color at this level. If THIS level has a gradient/url
    // with no underlying solid color we can read:
    //   • on body/html: assume white. Body-level gradients are almost
    //     always decorative texture (paper grain, noise) on top of a
    //     solid bg-color the page set via `background: var(--paper)`
    //     shorthand — which the static cascade can't decompose into bg-color. The
    //     downstream gradient-stops fallback path produces catastrophic
    //     false positives in this case (gradient noise stops have
    //     accidental browns/blacks that look like card backgrounds).
    //   • on other elements: bail to null and let the caller fall back
    //     to gradient stops (gradient buttons / hero sections are real
    //     bgs worth checking against).
    if (hasGradientOrUrl) {
      if (current.tagName === 'BODY' || current.tagName === 'HTML') {
        return { r: 255, g: 255, b: 255, a: 1 };
      }
      return null;
    }
    current = current.parentElement;
  }
  return { r: 255, g: 255, b: 255, a: 1 };
}

// Walk parents looking for a gradient background and return its color stops.
// Used as a fallback when resolveBackground() returns null because the
// effective background is a gradient (no single solid color to compare against).
/**
 * @param {ElementLike | null} el
 * @param {WindowLike} win
 * @returns {Rgb[]}
 */
function resolveGradientStops(el, win) {
  let current = el;
  while (current && current.nodeType === 1) {
    const style = win.getComputedStyle(current);
    const bgImage = style.backgroundImage || '';
    if (bgImage && bgImage !== 'none' && /gradient/i.test(bgImage)) {
      const stops = parseGradientColors(bgImage);
      if (stops.length > 0) return stops;
    }
    // The static cascade doesn't decompose `background:` shorthand — peek at the raw inline style
    const rawStyle = current.getAttribute?.('style') || '';
    const bgMatch = rawStyle.match(/background(?:-image)?\s*:\s*([^;]+)/i);
    const rawBg = bgMatch ? /** @type {string} */ (bgMatch[1]) : '';
    if (bgMatch && /gradient/i.test(rawBg)) {
      const stops = parseGradientColors(rawBg);
      if (stops.length > 0) return stops;
    }
    current = current.parentElement;
  }
  return [];
}

// Parse a single CSS length token to pixels. Accepts "12px", "50%", a
// shorthand like "12px 4px" (uses the first value), or empty / null.
// Returns the pixel value, or null when the input is unparseable.
// Percentages convert against `widthPx` when one is supplied. Without a
// usable width (the static cascade returns "auto" for many real-world
// elements, which parseFloat collapses to 0), fall back to the raw percentage
// number so callers gating on `> 0` (border-accent-on-rounded,
// isCardLike's hasRadius) still see a positive value, matching the
// original parseFloat("50%") === 50 behavior.
/**
 * @param {string | null | undefined} value
 * @param {number} widthPx
 * @returns {number | null}
 */
function parseRadiusToPx(value, widthPx) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const first = /** @type {string} */ (trimmed.split(/\s+/)[0]);
  const num = parseFloat(first);
  if (Number.isNaN(num)) return null;
  if (/%$/.test(first)) {
    if (widthPx && widthPx > 0) return (num / 100) * widthPx;
    return num;
  }
  return num;
}

/**
 * @param {ElementLike} _el
 * @param {StyleLike} style
 * @param {number} widthPx
 * @param {WindowLike} _win
 */
function resolveBorderRadiusPx(_el, style, widthPx, _win) {
  const fromComputed = parseRadiusToPx(style.borderRadius, widthPx);
  if (fromComputed !== null) return fromComputed;
  return 0;
}

// ─── Section 5: Element Adapters ────────────────────────────────────────────

// Resolve var(--X[, fallback]) refs in a computed-style value string.
// Recurses up to 8 levels for chained refs (--a: var(--b)). Returns
// the original string when no refs are present or the chain doesn't
// resolve. Safe to call on already-resolved values.
/**
 * @param {string} raw
 * @param {Map<string, string> | null | undefined} customPropMap
 * @param {number} [depth]
 * @returns {string}
 */
function resolveVarRefs(raw, customPropMap, depth = 0) {
  if (typeof raw !== 'string' || !raw.includes('var(')) return raw;
  if (depth > 8) return raw;
  return raw.replace(/var\(\s*(--[a-zA-Z0-9_-]+)\s*(?:,\s*([^)]+))?\)/g, (_m, name, fallback) => {
    const v = customPropMap?.get(name);
    if (v != null) return resolveVarRefs(v, customPropMap, depth + 1);
    return fallback ? resolveVarRefs(fallback.trim(), customPropMap, depth + 1) : _m;
  });
}

// Resolve var() refs in a color string (via customPropMap), then parse.
// Returns null on any failure. Used in the static-cascade path where
// getComputedStyle returns literal "var(--X)" or "oklch(...)" strings.
/**
 * @param {string | null | undefined} str
 * @param {Map<string, string> | null} [customPropMap]
 * @returns {Rgb | null}
 */
function parseColorResolved(str, customPropMap) {
  if (!str) return null;
  const resolved = customPropMap ? resolveVarRefs(str, customPropMap) : str;
  return parseAnyColor(resolved);
}

const REPEATED_KICKER_SKIP_SELECTOR = [
  'nav',
  'form',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'figure',
  'figcaption',
  'ol',
  'ul',
  'li',
  '[role="navigation"]',
  '[aria-label*="breadcrumb" i]',
  '[class*="breadcrumb" i]',
  '[aria-hidden="true"]',
  '[data-impeccable-allow-kickers]',
].join(',');

const REPEATED_KICKER_CARD_CONTEXT_SELECTOR = [
  'article',
  'button',
  'a',
  'li',
  '[role="listitem"]',
  '[role="option"]',
].join(',');

/** @param {ElementLike | null} el */
function cleanInlineText(el) {
  return [...(el?.childNodes ?? [])]
    .filter(n => n.nodeType === 3)
    .map(n => n.textContent)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {ElementLike} heading
 * @param {ElementLike} kicker
 */
function isRepeatedKickerCardContext(heading, kicker) {
  const item = heading.closest?.(REPEATED_KICKER_CARD_CONTEXT_SELECTOR);
  return Boolean(item && (!item.contains || item.contains(kicker)));
}

/**
 * @param {{ headingTag: string, headingText: string, headingFontSize: number, kickerTag: string, kickerText: string, kickerTextTransform: string, kickerFontSize: number, kickerLetterSpacing: number }} opts
 */
function isRepeatedKickerCandidate(opts) {
  const {
    headingTag,
    headingText,
    headingFontSize,
    kickerTag,
    kickerText,
    kickerTextTransform,
    kickerFontSize,
    kickerLetterSpacing,
  } = opts;
  if (!['h2', 'h3', 'h4'].includes(headingTag)) return false;
  if (!headingText || headingText.length < 3) return false;
  if (/^\/[\w-]+/i.test(headingText.replace(/^"|"$/g, '').trim())) return false;
  if (!(headingFontSize >= 20)) return false;
  if (!kickerTag || HEADING_TAGS.has(kickerTag)) return false;
  if (!['p', 'span', 'div', 'small'].includes(kickerTag)) return false;
  if (!kickerText || kickerText.length < 2 || kickerText.length > 34) return false;
  if (/^step\s*\d+/i.test(kickerText) || /^\d{1,2}$/.test(kickerText)) return false;

  const isUppercased = kickerTextTransform === 'uppercase'
    || (/[A-Z]/.test(kickerText) && !/[a-z]/.test(kickerText));
  if (!isUppercased) return false;
  if (!(kickerFontSize > 0 && kickerFontSize <= 14)) return false;
  const minTrackedSpacing = Math.max(1, kickerFontSize * 0.08);
  if (!(kickerLetterSpacing >= minTrackedSpacing)) return false;
  return true;
}

/**
 * @param {DocumentLike} doc
 * @param {(el: ElementLike) => StyleLike} getStyle
 * @param {(value: string, fontSize: number) => number} resolveLetterSpacing
 * @param {(el: ElementLike) => number} resolveElementFontSize
 */
function collectRepeatedSectionKickerCandidates(doc, getStyle, resolveLetterSpacing, resolveElementFontSize) {
  const candidates = [];
  for (const heading of doc.querySelectorAll('h2, h3, h4')) {
    if (heading.closest?.(REPEATED_KICKER_SKIP_SELECTOR)) continue;
    const kicker = heading.previousElementSibling;
    if (!kicker || kicker.closest?.(REPEATED_KICKER_SKIP_SELECTOR)) continue;
    if (isRepeatedKickerCardContext(heading, kicker)) continue;

    const kickerStyle = getStyle(kicker);
    const headingText = (heading.textContent || '').replace(/\s+/g, ' ').trim();
    const kickerText = cleanInlineText(kicker) || (kicker.textContent || '').replace(/\s+/g, ' ').trim();
    const headingFontSize = resolveElementFontSize(heading);
    const kickerFontSize = resolveElementFontSize(kicker);
    const kickerLetterSpacing = resolveLetterSpacing(kickerStyle.letterSpacing || '', kickerFontSize);

    if (!isRepeatedKickerCandidate({
      headingTag: heading.tagName.toLowerCase(),
      headingText,
      headingFontSize,
      kickerTag: kicker.tagName.toLowerCase(),
      kickerText,
      kickerTextTransform: kickerStyle.textTransform || '',
      kickerFontSize,
      kickerLetterSpacing,
    })) {
      continue;
    }

    candidates.push({
      headingTag: heading.tagName.toLowerCase(),
      headingText: headingText.replace(/^"|"$/g, '').slice(0, 60),
      kickerText: kickerText.slice(0, 40),
    });
  }
  return candidates;
}

const QUALITY_TEXT_TAGS = new Set(['p', 'li', 'td', 'th', 'dd', 'blockquote', 'figcaption']);

/** The elements `tiny-text` declines: a page sets each of these smaller than its
 *  body copy on purpose, so the size they render at is the intended one. */
const TINY_TEXT_SKIP_TAGS = new Set(['sub', 'sup', 'code', 'kbd', 'samp', 'var', 'caption', 'figcaption']);
const TINY_TEXT_SKIP_SELECTOR = [...TINY_TEXT_SKIP_TAGS].join(', ');

/** {@link HEADING_TAGS} as a selector, for the two rules that decline a heading. */
const HEADING_SELECTOR = [...HEADING_TAGS].join(', ');

/**
 * Whether the element is one of the declined elements, or sits inside one.
 *
 * The three values these rules judge — size, leading and case — each reach every
 * descendant that declares none of its own, so an exclusion reading the
 * element's own tag reported the declined element's own rendering back under the
 * tag of whatever sat inside it: a `<span>` in a bare `<sub>` was `tiny-text` at
 * the size the `<sub>` gave it. `closest` matches the element itself and so
 * subsumes the tag test; the tag test stays because it is the answer for an
 * element view that provides no `closest`.
 *
 * @param {ElementLike} el
 * @param {string} tag
 * @param {ReadonlySet<string>} tags
 * @param {string} selector
 * @returns {boolean}
 */
function isOrSitsInside(el, tag, tags, selector) {
  return tags.has(tag) || Boolean(el?.closest?.(selector));
}

// The px a Tailwind text-size utility puts on an element, or null when it carries none.
// It reads the class attribute because the utility stylesheet is not among the styles the
// cascade was built from, so on a page whose type scale is written only in utility classes
// the cascade resolves every element to one inherited default and the scale is invisible
// to it. Whether that reading may stand for an element is settled once, in
// {@link classFontSizePx}, which is this helper's only caller.
//
// A whole class token has to match, so a variant-prefixed utility (`md:text-3xl`,
// `hover:text-xs`) prices nothing: it applies at a viewport or in a state other than the one
// being read, and a size the page never shows alongside the others is not a step beside them.
/**
 * @param {ElementLike} el
 * @returns {number | null}
 */
function tailwindTextSizePx(el) {
  for (const token of (el.getAttribute?.('class') || '').split(/\s+/)) {
    const px = /** @type {Record<string, number | undefined>} */ (TAILWIND_TEXT_SIZE_PX)[token];
    if (px !== undefined) return px;
  }
  return null;
}

// The size a utility class states for an element, or null where none stands. Every
// reading that decides whether this engine can price an element's size takes the class
// from here — the static cascade, which writes the answer into the element's computed
// `font-size` so the elements below inherit it, the parent walk in
// {@link resolveFontSizePx} that the element rules read through, the eyebrow rule that
// reads a computed value instead, and the size population in
// {@link collectStaticFontSizes} that the unresolvable-size report and the hierarchy
// are built from — so no two of them can hold a size the others do not: consulted by one
// and not another, a class leaves that other standing down on an element whose size the
// page does state.
//
// A class is consulted only where the cascade specified no `font-size` for this element,
// so it fills a gap rather than overriding a size the page states. Where a rule or the
// `style` attribute did specify one, that is what renders, and letting a class outrank it
// prices the element at a size no reading of CSS produces. `hasSpecified` is answerable
// only by a document that kept its specified declarations, so a document that cannot
// answer throws here rather than silently pricing the class.
/**
 * @param {DocumentLike} doc
 * @param {ElementLike} el
 * @returns {number | null}
 */
function classFontSizePx(doc, el) {
  return doc.hasSpecified(el, 'fontSize') ? null : tailwindTextSizePx(el);
}

/** The size the document is read at above every declaration, and the size a
 *  font-relative value at the top of the tree resolves against. */
const ROOT_FONT_SIZE_PX = 16;

// One element's size, from the three facts that settle it: the size a utility
// class states for the element, the element's own font-size as the cascade left
// it, and the size the element above it was given. A class stands for the size
// where one applies; a declaration the reducer cannot price leaves the element at
// the size it inherits, which is the one size a reading of the CSS still supports.
//
// Two readers take this step and must reach the same number: the static cascade
// takes it as it computes each element, and {@link resolveFontSizePx} takes it
// again over the values the cascade left behind. They agree because a class
// writes its size into the computed `font-size` the cascade stores, so the value
// the walk reads back for a descendant is the one the class stated. A size read
// off anything but this step is one some other reader disagrees with silently.
/**
 * @param {number | null} classPx
 * @param {string} declared the element's own font-size as the cascade computed
 *   it, and empty where the element states none of its own
 * @param {number} parentPx
 * @returns {number}
 */
function usedFontSizePx(classPx, declared, parentPx) {
  if (classPx !== null) return classPx;
  return resolveLengthPx(declared, parentPx) ?? parentPx;
}

// Resolve a CSS font-size value to pixels by walking up the parent chain.
// Browsers resolve em/rem/% to px in getComputedStyle, but the static cascade
// returns the specified value verbatim — so for the static path we walk parents ourselves.
/**
 * @param {ElementLike | null} el
 * @param {WindowLike & { document?: DocumentLike }} win
 * @returns {number}
 */
function resolveFontSizePx(el, win) {
  // A live browser resolves a utility class for itself and hands this walk the
  // rendered size, so the class reading belongs to the static path alone — which
  // is the path that carries a document to ask.
  const doc = win ? /** @type {WindowLike & { document?: DocumentLike }} */ (win).document : null;
  /** @type {{ el: ElementLike, declared: string }[]} */
  const chain = []; // each element with its raw font-size string, leaf → root
  let cur = el;
  while (cur && cur.nodeType === 1) {
    const fs = (win ? win.getComputedStyle(cur) : domComputedStyle(cur)).fontSize;
    chain.push({ el: cur, declared: fs || '' });
    cur = cur.parentElement;
  }
  // Walk root → leaf, resolving each element against its parent context through
  // {@link usedFontSizePx}, which is the step the static cascade takes for the
  // same element. Reporting that a declaration could not be priced is
  // {@link checkUnresolvableFontSizes}'s job, not this walk's.
  let px = ROOT_FONT_SIZE_PX;
  for (let i = chain.length - 1; i >= 0; i--) {
    const step = /** @type {{ el: ElementLike, declared: string }} */ (chain[i]);
    px = usedFontSizePx(doc ? classFontSizePx(doc, step.el) : null, step.declared, px);
  }
  return px;
}

/** @param {string | null | undefined} value */
function cssColorIsTransparent(value) {
  if (!value) return true;
  const str = String(value).trim().toLowerCase();
  if (!str || str === 'transparent' || str === 'rgba(0, 0, 0, 0)') return true;
  const parsed = parseAnyColor(str);
  if (parsed) return (parsed.a ?? 1) <= 0.05;
  return /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0(?:\.0+)?\s*\)$/.test(str);
}

/**
 * @param {string | null | undefined} a
 * @param {string | null | undefined} b
 */
function colorsNearlyMatch(a, b) {
  const ca = parseAnyColor(a);
  const cb = parseAnyColor(b);
  if (!ca || !cb) return false;
  const alphaDelta = Math.abs((ca.a ?? 1) - (cb.a ?? 1));
  const channelDelta = Math.max(
    Math.abs(ca.r - cb.r),
    Math.abs(ca.g - cb.g),
    Math.abs(ca.b - cb.b),
  );
  return alphaDelta <= 0.03 && channelDelta <= 3;
}

/**
 * @param {WindowLike | null} win
 * @param {ElementLike} el
 */
function getComputedStyleFor(win, el) {
  if (win && typeof win.getComputedStyle === 'function') {
    try { return win.getComputedStyle(el); } catch {}
  }
  if (typeof getComputedStyle === 'function') {
    try { return domComputedStyle(el); } catch {}
  }
  return null;
}

/**
 * @param {StyleLike} style
 * @param {ElementLike} el
 * @param {WindowLike | null} win
 */
function hasVisibleBackgroundBoundary(style, el, win) {
  const bg = style?.backgroundColor || '';
  if (cssColorIsTransparent(bg)) return false;

  let parent = el?.parentElement || null;
  while (parent) {
    const parentStyle = getComputedStyleFor(win, parent);
    const parentBg = parentStyle?.backgroundColor || '';
    if (!cssColorIsTransparent(parentBg)) {
      return !colorsNearlyMatch(bg, parentBg);
    }
    parent = parent.parentElement;
  }

  return true;
}

const TEXT_EDGE_TAGS = new Set(['A', 'BUTTON', 'CODE', 'DD', 'DT', 'FIGCAPTION', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'P', 'PRE', 'SPAN', 'TD', 'TH']);

/** @param {ElementLike} node */
function hasMeaningfulDirectText(node) {
  if (!node?.childNodes) return false;
  for (const child of node.childNodes) {
    if (child.nodeType === 3 && child.textContent.trim().length > 4) return true;
  }
  return false;
}

/**
 * @param {ElementLike} el
 * @param {DomRect} rect
 */
function textDescendantsFlushSides(el, rect) {
  const flush = { top: false, right: false, bottom: false, left: false };
  if (!rect || !el?.querySelectorAll) return flush;
  const TEXT_EDGE_THRESHOLD = 4;
  const candidates = el.querySelectorAll('a, button, code, dd, dt, figcaption, h1, h2, h3, h4, h5, h6, li, p, pre, span, td, th');
  for (const node of candidates) {
    if (!TEXT_EDGE_TAGS.has(node.tagName) || !hasMeaningfulDirectText(node)) continue;
    let nodeRect = null;
    try { nodeRect = node.getBoundingClientRect(); } catch {}
    if (!nodeRect || nodeRect.width <= 0 || nodeRect.height <= 0) continue;
    if (nodeRect.bottom < rect.top || nodeRect.top > rect.bottom || nodeRect.right < rect.left || nodeRect.left > rect.right) continue;
    if (nodeRect.top - rect.top <= TEXT_EDGE_THRESHOLD) flush.top = true;
    if (rect.right - nodeRect.right <= TEXT_EDGE_THRESHOLD) flush.right = true;
    if (rect.bottom - nodeRect.bottom <= TEXT_EDGE_THRESHOLD) flush.bottom = true;
    if (nodeRect.left - rect.left <= TEXT_EDGE_THRESHOLD) flush.left = true;
  }
  return flush;
}

// Pure quality checks. Most run on computed CSS and node-only inputs. The
// static adapter passes `rect: null` because the static cascade lays nothing
// out; that drops exactly the verdicts the `rect` test dominates. The unit is
// the branch and not the rule: cramped-padding loses its padding-threshold
// verdict, keeps its flush-against-a-boundary one, and that one fires more
// freely without a rect: every rect-dependent test inside that branch is a
// restriction, so dropping the rect drops each of them.
//
// The adapter resolves font-size, line-height and letter-spacing to pixels
// before calling this so the pure function only deals with numbers.
/**
 * @param {{ el: ElementLike, tag: string, style: StyleLike, hasDirectText: boolean, textLen: number, fontSize: number, lineHeightPx: number, letterSpacingPx: number, rect?: DomRect | null, lineMax?: number, viewportWidth?: number, win?: WindowLike | null }} opts
 * @returns {RuleFinding[]}
 */
function checkQuality(opts) {
  const { el, tag, style, hasDirectText, textLen, fontSize, lineHeightPx, letterSpacingPx, rect, lineMax = 80, viewportWidth = 0, win = null } = opts;
  /** @type {RuleFinding[]} */
  const findings = [];
  // Skip browser extension injected elements
  const elId = el.id || '';
  if (elId.startsWith('claude-') || elId.startsWith('cic-')) return findings;

  // --- Line length too long --- (browser-only: needs rect.width)
  if (rect && hasDirectText && QUALITY_TEXT_TAGS.has(tag) && rect.width > 0 && textLen > lineMax) {
    const charsPerLine = rect.width / (fontSize * 0.5);
    if (charsPerLine > lineMax + 5) {
      findings.push({ id: 'line-length', snippet: `~${Math.round(charsPerLine)} chars/line (aim for <${lineMax})` });
    }
  }

  // --- Cramped padding --- (browser-only: needs rect to skip small badges/labels)
  // Vertical and horizontal thresholds are independent because line-height
  // already provides built-in vertical breathing room (the line box is taller
  // than the cap height), but horizontal has no equivalent. Both scale with
  // font-size — bigger text demands proportionally more padding.
  //   vertical:   max(4px, fontSize × 0.3)
  //   horizontal: max(8px, fontSize × 0.5)
  const isInlineCode = tag === 'code' && !(el.closest && el.closest('pre'));
  if (!isInlineCode && rect && hasDirectText && textLen > 20 && rect.width > 100 && rect.height > 30) {
    const borders = {
      top: parseFloat(style.borderTopWidth) || 0,
      right: parseFloat(style.borderRightWidth) || 0,
      bottom: parseFloat(style.borderBottomWidth) || 0,
      left: parseFloat(style.borderLeftWidth) || 0,
    };
    const borderCount = Object.values(borders).filter(w => w > 0).length;
    const hasBg = hasVisibleBackgroundBoundary(style, el, win);
    if (borderCount >= 2 || hasBg) {
      const vPads = [], hPads = [];
      if (hasBg || borders.top > 0) vPads.push(parseFloat(style.paddingTop) || 0);
      if (hasBg || borders.bottom > 0) vPads.push(parseFloat(style.paddingBottom) || 0);
      if (hasBg || borders.left > 0) hPads.push(parseFloat(style.paddingLeft) || 0);
      if (hasBg || borders.right > 0) hPads.push(parseFloat(style.paddingRight) || 0);

      const vMin = vPads.length ? Math.min(...vPads) : Infinity;
      const hMin = hPads.length ? Math.min(...hPads) : Infinity;
      const vThresh = Math.max(4, fontSize * 0.3);
      const hThresh = Math.max(8, fontSize * 0.5);

      // Emit at most one finding per element — pick whichever axis is worse.
      if (vMin < vThresh) {
        findings.push({ id: 'cramped-padding', snippet: `${vMin}px vertical padding (need ≥${vThresh.toFixed(1)}px for ${fontSize}px text)` });
      } else if (hMin < hThresh) {
        findings.push({ id: 'cramped-padding', snippet: `${hMin}px horizontal padding (need ≥${hThresh.toFixed(1)}px for ${fontSize}px text)` });
      }
    }
  }

  // --- Flush against a visible boundary ---
  // Fires when a container has a visible boundary (border, outline, OR a
  // non-transparent background) AND near-zero padding on the bounded
  // side(s) AND text-bearing children land flush against the boundary.
  //
  // Distinct from cramped-padding: that rule needs the element itself to
  // have direct text (hasDirectText). This rule targets the OPPOSITE
  // shape — a container with NO direct text, only children — which is
  // exactly what cramped-padding misses (a section wrapping a label +
  // list lands a free pass).
  //
  // The classic shape: agent writes `padding: 28px 0 0` shorthand on a
  // section that also has a border, zeroing horizontal padding so the
  // text-bearing children touch the side borders. Background and
  // outline count too: a colored card with zero padding has the same
  // visual failure mode.
  {
    const FLUSH_SKIP_TAGS = new Set(['HTML', 'BODY', 'MAIN', 'HEADER', 'FOOTER', 'NAV', 'ARTICLE', 'ASIDE', 'BUTTON', 'A', 'LABEL', 'SUMMARY', 'CODE', 'PRE', 'INPUT', 'TEXTAREA', 'SELECT', 'FORM', 'FIGURE', 'TABLE', 'TBODY', 'THEAD', 'TR', 'TD', 'TH']);
    const upperTag = tag ? tag.toUpperCase() : '';
    const elPosition = style.position || '';
    if (
      !FLUSH_SKIP_TAGS.has(upperTag) &&
      !hasDirectText &&
      !['fixed', 'absolute'].includes(elPosition) &&
      el.children && el.children.length > 0
    ) {
      const borderW = {
        top:    parseFloat(style.borderTopWidth)    || 0,
        right:  parseFloat(style.borderRightWidth)  || 0,
        bottom: parseFloat(style.borderBottomWidth) || 0,
        left:   parseFloat(style.borderLeftWidth)   || 0,
      };
      const borderVisible = {
        top:    borderW.top    > 0 && !cssColorIsTransparent(style.borderTopColor),
        right:  borderW.right  > 0 && !cssColorIsTransparent(style.borderRightColor),
        bottom: borderW.bottom > 0 && !cssColorIsTransparent(style.borderBottomColor),
        left:   borderW.left   > 0 && !cssColorIsTransparent(style.borderLeftColor),
      };
      // Outline detection. The static cascade decomposes the `border`
      // shorthand into border{Top,…}Width/Color but does NOT decompose
      // `outline` — the longhands come back empty when the value was set via
      // the shorthand. Fall back to parsing `style.outline` ourselves.
      let outlineW = parseFloat(style.outlineWidth) || 0;
      let outlineStyleVal = style.outlineStyle || '';
      let outlineColorVal = style.outlineColor || '';
      if (!outlineW && style.outline) {
        const wMatch = style.outline.match(/(\d+(?:\.\d+)?)\s*px/);
        if (wMatch) outlineW = parseFloat(/** @type {string} */ (wMatch[1])) || 0;
        if (!outlineStyleVal) {
          outlineStyleVal = /\b(solid|dashed|dotted|double|groove|ridge|inset|outset)\b/.test(style.outline) ? 'solid' : '';
        }
        if (!outlineColorVal) {
          const cMatch = style.outline.match(/(rgba?\([^)]+\)|#[0-9a-fA-F]{3,8}|[a-zA-Z]+)\s*$/);
          if (cMatch) outlineColorVal = /** @type {string} */ (cMatch[1]);
        }
      }
      const outlineVisible = outlineW > 0 && !cssColorIsTransparent(outlineColorVal) && outlineStyleVal && outlineStyleVal !== 'none';
      const bgVisible = hasVisibleBackgroundBoundary(style, el, win);

      const anyVisible = borderVisible.top || borderVisible.right || borderVisible.bottom || borderVisible.left || outlineVisible || bgVisible;
      if (anyVisible) {
        // Resolve padding to px (the static cascade returns raw "1.5rem" etc.,
        // not the computed px value; parseFloat would strip the unit and treat
        // 1.5rem as 1.5px, false-flagging legitimate insets).
        const pad = {
          top:    resolveLengthPx(style.paddingTop,    fontSize) ?? 0,
          right:  resolveLengthPx(style.paddingRight,  fontSize) ?? 0,
          bottom: resolveLengthPx(style.paddingBottom, fontSize) ?? 0,
          left:   resolveLengthPx(style.paddingLeft,   fontSize) ?? 0,
        };
        const PAD_THRESHOLD = 2;
        // Children-insulate-this-side: a side is insulated if ANY direct
        // child has its own padding ≥ 4px on that side. Rationale: in
        // typical flow, only the first/last (or leftmost/rightmost)
        // children actually sit at the parent's edges. If even one of
        // them has its own padding, the visual flush is broken on that
        // side. Classic example: a column-flow card frame where the
        // top child (header) has padding-top:12 and the bottom child
        // (footer) has padding-bottom:8 — the parent's padding:0 doesn't
        // matter; nothing is actually flush. The `any-child-insulates`
        // heuristic accepts some false negatives (a card with one heavily
        // padded middle child won't flag) for far fewer false positives.
        const CHILD_INSULATE_THRESHOLD = 4;
        const childrenInsulate = { top: false, right: false, bottom: false, left: false };
        for (const child of el.children) {
          let childStyle = getComputedStyleFor(win, child);
          if (!childStyle) continue;
          const childPad = {
            top:    resolveLengthPx(childStyle.paddingTop,    fontSize) ?? 0,
            right:  resolveLengthPx(childStyle.paddingRight,  fontSize) ?? 0,
            bottom: resolveLengthPx(childStyle.paddingBottom, fontSize) ?? 0,
            left:   resolveLengthPx(childStyle.paddingLeft,   fontSize) ?? 0,
          };
          const childMargin = {
            top:    resolveLengthPx(childStyle.marginTop,    fontSize) ?? 0,
            right:  resolveLengthPx(childStyle.marginRight,  fontSize) ?? 0,
            bottom: resolveLengthPx(childStyle.marginBottom, fontSize) ?? 0,
            left:   resolveLengthPx(childStyle.marginLeft,   fontSize) ?? 0,
          };
          if (rect && typeof child.getBoundingClientRect === 'function') {
            try {
              const childRect = child.getBoundingClientRect();
              if (childRect && childRect.width > 0 && childRect.height > 0) {
                if (childRect.top - rect.top >= CHILD_INSULATE_THRESHOLD) childrenInsulate.top = true;
                if (rect.right - childRect.right >= CHILD_INSULATE_THRESHOLD) childrenInsulate.right = true;
                if (rect.bottom - childRect.bottom >= CHILD_INSULATE_THRESHOLD) childrenInsulate.bottom = true;
                if (childRect.left - rect.left >= CHILD_INSULATE_THRESHOLD) childrenInsulate.left = true;
              }
            } catch {}
          }
          for (const s of /** @type {readonly ('top' | 'right' | 'bottom' | 'left')[]} */ ([
            'top',
            'right',
            'bottom',
            'left',
          ])) {
            if (childPad[s] >= CHILD_INSULATE_THRESHOLD || childMargin[s] >= CHILD_INSULATE_THRESHOLD) {
              childrenInsulate[s] = true;
            }
          }
        }

        const textFlush = rect ? textDescendantsFlushSides(el, rect) : null;
        const fullBleedBgBand = rect && viewportWidth > 0 && rect.width >= viewportWidth * 0.94 && bgVisible && !outlineVisible;
        const flushSides = [];
        for (const side of /** @type {readonly ('top' | 'right' | 'bottom' | 'left')[]} */ ([
          'top',
          'right',
          'bottom',
          'left',
        ])) {
          const bgBoundsSide = bgVisible && !(fullBleedBgBand && (side === 'left' || side === 'right'));
          const sideBounded = borderVisible[side] || outlineVisible || bgBoundsSide;
          if (sideBounded && pad[side] <= PAD_THRESHOLD && !childrenInsulate[side] && (!textFlush || textFlush[side])) {
            flushSides.push(side);
          }
        }

        if (flushSides.length > 0) {
          // Confirm at least one direct child has substantial text content
          // (> 4 chars). Without this, the flush is harmless: e.g. an
          // image-only card.
          let hasTextChild = false;
          for (const child of el.children) {
            const childText = (child.textContent || '').trim();
            if (childText.length > 4) { hasTextChild = true; break; }
          }
          if (hasTextChild) {
            const cls = (typeof el.className === 'string' && el.className.trim())
              ? el.className.trim().split(/\s+/)[0]
              : '';
            const boundaryParts = [];
            const borderSidesVisible = /** @type {readonly ('top' | 'right' | 'bottom' | 'left')[]} */ ([
              'top',
              'right',
              'bottom',
              'left',
            ]).filter((s) => borderVisible[s]);
            if (borderSidesVisible.length === 4) boundaryParts.push('border');
            else if (borderSidesVisible.length > 0) boundaryParts.push(`border-${borderSidesVisible.join('/')}`);
            if (outlineVisible) boundaryParts.push('outline');
            if (bgVisible) boundaryParts.push('bg');
            const sidesLabel = flushSides.length === 4 ? 'all sides' : flushSides.join('/');
            const ident = cls
              ? `<${tag.toLowerCase()}> "${cls}"`
              : `<${tag.toLowerCase()}>`;
            findings.push({
              id: 'cramped-padding',
              snippet: `${ident}: children flush against ${boundaryParts.join('+')} on ${sidesLabel} (no inset)`,
            });
          }
        }
      }
    }
  }

  // --- Body text touching viewport edge --- (browser-only: needs rect)
  // Catches the failure mode where the agent ships body paragraphs
  // with NO container providing horizontal padding — text bleeds
  // directly to the viewport edge. Different from cramped-padding,
  // which requires a colored/bordered container. Here the failure
  // is the absence of the container entirely.
  //
  // Gate aggressively to avoid false positives:
  //   - <p> or <li> only (body content; not headings, not nav, not
  //     wrappers)
  //   - text > 40 chars (paragraph-like, not a label)
  //   - rect.width > 50% of viewport (real body, not a pull-quote)
  //   - rect.left < 16 OR rect.right > viewport - 16 (actually
  //     touching the edge)
  //   - not inside <nav> or <header> (those legitimately bleed)
  //   - element itself has no background-color (intentional full-bleed
  //     sections set a bg-color and provide their own internal padding)
  if (rect && hasDirectText && textLen > 40 && ['P', 'LI'].includes(tag.toUpperCase()) && viewportWidth > 0) {
    const inNavHeader = el.closest && (el.closest('nav') || el.closest('header'));
    const hasOwnBg = style.backgroundColor && style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent';
    const isPositioned = ['fixed', 'absolute'].includes(style.position || '');
    const widthRatio = rect.width / viewportWidth;
    const leftClose = rect.left < 16;
    const rightClose = rect.right > viewportWidth - 16;
    if (!inNavHeader && !hasOwnBg && !isPositioned && widthRatio > 0.5 && (leftClose || rightClose)) {
      const which = leftClose && rightClose
        ? `left ${Math.round(rect.left)}px / right ${Math.round(viewportWidth - rect.right)}px`
        : leftClose
          ? `left ${Math.round(rect.left)}px`
          : `right ${Math.round(viewportWidth - rect.right)}px`;
      findings.push({ id: 'body-text-viewport-edge', snippet: `<${tag.toLowerCase()}> with ${textLen}-char body bleeds to viewport edge (${which})` });
    }
  }

  // --- Tight line height ---
  if (hasDirectText && textLen > 50 && !isOrSitsInside(el, tag, HEADING_TAGS, HEADING_SELECTOR)) {
    if (lineHeightPx != null && fontSize > 0) {
      const ratio = lineHeightPx / fontSize;
      if (ratio > 0 && ratio < 1.3) {
        findings.push({ id: 'tight-leading', snippet: `line-height ${ratio.toFixed(2)}x (need >=1.3)` });
      }
    }
  }

  // --- Justified text (without hyphens) ---
  if (hasDirectText && style.textAlign === 'justify') {
    const hyphens = style.hyphens || style.webkitHyphens || '';
    if (hyphens !== 'auto') {
      findings.push({ id: 'justified-text', snippet: 'text-align: justify without hyphens: auto' });
    }
  }

  // --- Tiny body text ---
  // Only flag actual body content, not UI labels (buttons, tabs, badges, captions, footer text, etc.)
  if (hasDirectText && textLen > 20 && fontSize < 12) {
    const inUIContext = el.closest && el.closest('button, a, label, summary, pre, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], nav, footer, [aria-hidden="true"], [class*="badge" i], [class*="caption" i], [class*="chip" i], [class*="code" i], [class*="console" i], [class*="diff" i], [class*="label" i], [class*="meta" i], [class*="mock" i], [class*="pill" i], [class*="preview" i], [class*="tag" i], [class*="terminal" i], [class*="writes" i]');
    const isUppercase = style.textTransform === 'uppercase';
    if (!isOrSitsInside(el, tag, TINY_TEXT_SKIP_TAGS, TINY_TEXT_SKIP_SELECTOR) && !inUIContext && !isUppercase) {
      findings.push({ id: 'tiny-text', snippet: `${fontSize}px body text` });
    }
  }

  // --- All-caps body text ---
  if (hasDirectText && textLen > 30 && style.textTransform === 'uppercase') {
    if (!isOrSitsInside(el, tag, HEADING_TAGS, HEADING_SELECTOR)) {
      findings.push({ id: 'all-caps-body', snippet: `text-transform: uppercase on ${textLen} chars of body text` });
    }
  }

  // --- Wide letter spacing on body text ---
  if (hasDirectText && textLen > 20 && style.textTransform !== 'uppercase') {
    if (letterSpacingPx != null && letterSpacingPx > 0 && fontSize > 0) {
      const trackingEm = letterSpacingPx / fontSize;
      if (trackingEm > 0.05) {
        findings.push({ id: 'wide-tracking', snippet: `letter-spacing: ${trackingEm.toFixed(2)}em on body text` });
      }
    }
  }

  // --- Crushed letter spacing (mirror of wide-tracking) ---
  // Tracking pulled tighter than ~-0.05em crushes characters into each other.
  // Optical tightening that display type legitimately wants (around -0.02em)
  // stays well above this floor.
  if (hasDirectText && textLen > 20 && fontSize > 0) {
    if (letterSpacingPx != null && letterSpacingPx < 0) {
      const trackingEm = letterSpacingPx / fontSize;
      if (trackingEm <= -0.05) {
        const excerpt = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
        findings.push({ id: 'extreme-negative-tracking', snippet: `letter-spacing: ${trackingEm.toFixed(2)}em — "${excerpt}"` });
      }
    }
  }

  return findings;
}

// Pure page-level skipped-heading walk. Takes a Document so it works against
// the static htmlparser2 document.
/**
 * @param {DocumentLike} doc
 * @returns {RuleFinding[]}
 */
function checkPageQualityFromDoc(doc) {
  const findings = [];
  const headings = doc.querySelectorAll('h1, h2, h3, h4, h5, h6');
  let prevLevel = 0;
  let prevText = '';
  for (const h of headings) {
    const level = parseInt(h.tagName[1]);
    const text = (h.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    if (prevLevel > 0 && level > prevLevel + 1) {
      findings.push({
        id: 'skipped-heading',
        scope: SCOPE_DOCUMENT,
        snippet: `<h${prevLevel}> "${prevText}" followed by <h${level}> "${text}" (missing h${prevLevel + 1})`,
      });
    }
    prevLevel = level;
    prevText = text;
  }
  return findings;
}

// Static adapters — take the pre-extracted static-cascade computed style

// The static css-tree cascade doesn't lay out OR resolve em/rem/% to px — so
// we pre-resolve every CSS length the rule needs ourselves (walking the parent
// chain for font-size inheritance), and pass `rect: null`, which drops the
// verdicts the `rect` test dominates in {@link checkQuality}.
/**
 * @param {ElementLike} el
 * @param {StyleLike} style
 * @param {string} tag
 * @param {WindowLike} window
 */
function checkElementQuality(el, style, tag, window) {
  const hasDirectText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().length > 10);
  const textLen = el.textContent?.trim().length || 0;
  const fontSize = resolveFontSizePx(el, window);
  const lineHeightPx = resolveLineHeightPx(style.lineHeight, fontSize) ?? 0;
  const letterSpacingPx = resolveLengthPx(style.letterSpacing, fontSize) ?? 0;
  return checkQuality({ el, tag, style, hasDirectText, textLen, fontSize, lineHeightPx, letterSpacingPx, rect: null, win: window });
}

/**
 * @param {string} tag
 * @param {StyleLike} style
 * @param {Record<string, { width: number, color: string }> | null} overrides
 * @param {number | null} [resolvedRadius]
 */
function checkElementBorders(tag, style, overrides, resolvedRadius) {
  const sides = ['Top', 'Right', 'Bottom', 'Left'];
  /** @type {Record<string, number>} */
  const widths = {};
  /** @type {Record<string, string>} */
  const colors = {};
  const byProperty = /** @type {Record<string, string | undefined>} */ (
    /** @type {unknown} */ (style)
  );
  for (const s of sides) {
    widths[s] = parseFloat(byProperty[`border${s}Width`] ?? '') || 0;
    colors[s] = byProperty[`border${s}Color`] || '';
    // A computed style that drops any border shorthand containing var()
    // leaves both width and color empty. When the detectHtml pre-pass pulled
    // a resolved value off the rule, use it to fill in the missing side so the
    // side-tab check can run. The static cascade resolves var() during compute,
    // so this override fallback is unused there.
    const override = overrides?.[s];
    if (widths[s] === 0 && override) {
      widths[s] = override.width;
      colors[s] = override.color;
    } else if (colors[s]?.startsWith('var(') && override) {
      // Longhand case: the computed style kept the width but left the color as
      // the literal `var(...)` string. Substitute the resolved color.
      colors[s] = override.color;
    }
  }
  // resolvedRadius lets the caller pre-resolve the radius via
  // resolveBorderRadiusPx so the value survives the static cascade's
  // shorthand serialization. Falls back to the computed value for tests
  // and callers that don't pre-resolve.
  const radius = resolvedRadius != null
    ? resolvedRadius
    : (parseFloat(style.borderRadius) || 0);
  return checkBorders(tag, widths, colors, radius);
}

/**
 * @param {ElementLike} el
 * @param {StyleLike} style
 * @param {string} tag
 * @param {WindowWithDocument} window
 * @param {Map<string, string> | null} customPropMap
 * @param {boolean} hasAnchorInheritRule
 */
function checkElementColors(el, style, tag, window, customPropMap, hasAnchorInheritRule) {
  const directText = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('');
  const hasDirectText = directText.trim().length > 0;

  const effectiveBg = resolveBackground(el, window, customPropMap);
  // The static cascade returns literal "var(--X)" / "oklch(...)" for color, so
  // plain parseRgb misses Tailwind-tokenized text colors. Resolve through the
  // customPropMap first; fall back to parseRgb for vanilla rgb() pages.
  let textColor = customPropMap ? parseColorResolved(style.color, customPropMap) : null;
  if (!textColor) textColor = parseRgb(style.color);

  // Anchor-inherit FP workaround: the static cascade's UA defaults apply a
  // link blue at high specificity. The page's `a { color: inherit }` rule
  // (Tailwind v4 preflight) loses to it even though it WINS in real browsers
  // (Chrome's UA wraps :link in :where() — zero specificity). When the page
  // declares the inherit rule AND we see the default link blue on an anchor,
  // walk to the nearest non-anchor ancestor and use its color instead.
  if (
    hasAnchorInheritRule &&
    textColor &&
    textColor.r === 0 && textColor.g === 0 && textColor.b === 238 &&
    (tag === 'a' || el.closest?.('a'))
  ) {
    let cur = el.parentElement;
    while (cur && cur.tagName !== 'HTML') {
      if (cur.tagName !== 'A') {
        const ps = window.getComputedStyle(cur);
        const inh = (customPropMap ? parseColorResolved(ps.color, customPropMap) : null) || parseRgb(ps.color);
        if (inh && !(inh.r === 0 && inh.g === 0 && inh.b === 238)) {
          textColor = inh;
          break;
        }
      }
      cur = cur.parentElement;
    }
  }

  // The priced/unpriced verdict below is the reading {@link collectStaticFontSizes}
  // makes over the same `*` population to route a declaration into the unresolvable-size
  // report, so the rule that stands down and the report that says why agree on which
  // elements those are. The size itself comes from the parent walk, which consults the
  // same class reading; where neither a class nor a reducible declaration answers, the
  // walk leaves the element at the size it inherits and the report carries the
  // declaration that could not be reduced.
  const classPx = classFontSizePx(window.document, el);
  return checkColors({
    tag,
    textColor,
    bgColor: readOwnBackgroundColor(el, style),
    effectiveBg,
    effectiveBgStops: effectiveBg ? null : resolveGradientStops(el, window),
    fontSize: resolveFontSizePx(el, window),
    fontSizePriced: classPx !== null || computedFontSizePx(style.fontSize) !== null,
    fontWeight: parseInt(style.fontWeight) || 400,
    hasDirectText,
    isEmojiOnly: isEmojiOnlyText(directText),
    bgClip: style.webkitBackgroundClip || style.backgroundClip || '',
    bgImage: style.backgroundImage || '',
    classList: elementClassList(el),
  });
}

/**
 * @param {ElementLike} el
 * @param {string} tag
 * @param {WindowLike} window
 */
function checkElementIconTile(el, tag, window) {
  if (!HEADING_TAGS.has(tag)) return [];
  const sibling = el.previousElementSibling;
  if (!sibling) return [];

  const sibStyle = window.getComputedStyle(sibling);
  // The static cascade doesn't lay out — read explicit pixel dimensions from CSS instead.
  const sibWidth = parseFloat(sibStyle.width) || 0;
  const sibHeight = parseFloat(sibStyle.height) || 0;

  const iconChild = sibling.querySelector('svg, i[data-lucide], i[class*="fa-"], i[class*="icon"]');
  let iconWidth = 0;
  if (iconChild) {
    const iconStyle = window.getComputedStyle(iconChild);
    iconWidth = parseFloat(iconStyle.width) || parseFloat(iconChild.getAttribute('width')) || 0;
  }
  // Or: tile contains an emoji/symbol character directly as its only content
  const sibDirectText = [...sibling.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('');
  const hasInlineEmojiIcon = sibling.children.length === 0 && isEmojiOnlyText(sibDirectText);

  return checkIconTile({
    headingTag: tag,
    headingText: el.textContent || '',
    headingTop: 0, // static cascade: no layout, skip vertical-stacking gate
    siblingTag: sibling.tagName.toLowerCase(),
    siblingWidth: sibWidth,
    siblingHeight: sibHeight,
    siblingBottom: 0,
    siblingBgColor: parseRgb(sibStyle.backgroundColor),
    siblingBgImage: sibStyle.backgroundImage || '',
    siblingBorderWidth: parseFloat(sibStyle.borderTopWidth) || 0,
    siblingBorderRadius: resolveBorderRadiusPx(sibling, sibStyle, sibWidth, window),
    hasIconChild: !!iconChild || hasInlineEmojiIcon,
    iconChildWidth: iconWidth,
  });
}

/**
 * @param {ElementLike} el
 * @param {StyleLike} style
 * @param {string} tag
 * @param {WindowLike} window
 */
function checkElementItalicSerif(el, style, tag, window) {
  if (tag !== 'h1' && tag !== 'h2') return [];
  return checkItalicSerif({
    tag,
    fontStyle: style.fontStyle || '',
    fontFamily: style.fontFamily || '',
    fontSize: resolveFontSizePx(el, window),
    headingText: el.textContent || '',
  });
}

/**
 * @param {ElementLike} el
 * @param {StyleLike} style
 * @param {string} tag
 * @param {WindowWithDocument} window
 * @param {Map<string, string> | null} customPropMap
 */
function checkElementHeroEyebrow(el, style, tag, window, customPropMap) {
  if (tag !== 'h1') return [];
  const sibling = el.previousElementSibling;
  if (!sibling) return [];
  const sibStyle = window.getComputedStyle(sibling);
  // These re-resolve var() refs against a caller-supplied custom-property map.
  // The static-HTML engine is this function's only caller and supplies none, and
  // its cascade substitutes var() refs while normalizing each value, so on that
  // path every one of these is a pass-through.
  const fontSizeRaw = customPropMap ? resolveVarRefs(sibStyle.fontSize, customPropMap) : sibStyle.fontSize;
  const fontWeightRaw = customPropMap ? resolveVarRefs(sibStyle.fontWeight, customPropMap) : sibStyle.fontWeight;
  const letterSpacingRaw = customPropMap ? resolveVarRefs(sibStyle.letterSpacing, customPropMap) : sibStyle.letterSpacing;
  const colorRaw = customPropMap ? resolveVarRefs(sibStyle.color, customPropMap) : sibStyle.color;
  const headingFontSizeRaw = customPropMap ? resolveVarRefs(style.fontSize, customPropMap) : style.fontSize;
  // The eyebrow's size decides this rule, and it is read off the computed value
  // rather than through {@link resolveFontSizePx} — so the class reading that walk
  // carries never reaches here, and an eyebrow whose size is stated only by a
  // utility class would be read at the size it inherits. {@link classFontSizePx} is
  // the same reading the walk takes and takes precedence the same way: it answers
  // only where the cascade specified nothing, so a size the page states still wins.
  // The `?? 0` beyond it is the rule's own contract for a declaration the cascade
  // left verbatim, which every positive threshold in {@link checkHeroEyebrow}
  // rejects.
  const siblingFontSize =
    classFontSizePx(window.document, sibling) ?? computedFontSizePx(fontSizeRaw) ?? 0;
  // resolveLengthPx returns null where it cannot reduce a length ('normal', or a
  // var() the page never declares); the `|| 0` keeps that null out of the numeric
  // gate. What arrives here is one of two forms, and this call is what reads
  // both: the static cascade stores a tracking as the pixels it renders at, or as
  // the percentage the page wrote where the value inherits as a ratio rather than
  // as a length. The number this returns is the rendered length either way.
  return checkHeroEyebrow({
    headingTag: tag,
    headingText: el.textContent || '',
    headingFontSize: computedFontSizePx(headingFontSizeRaw) ?? 0,
    siblingTag: sibling.tagName.toLowerCase(),
    siblingText: sibling.textContent || '',
    siblingTextTransform: sibStyle.textTransform || '',
    siblingFontSize,
    siblingLetterSpacing: resolveLengthPx(letterSpacingRaw, siblingFontSize) || 0,
    siblingFontWeight: parseFloat(fontWeightRaw) || 0,
    siblingColor: colorRaw || '',
  });
}

/**
 * @param {DocumentLike} doc
 * @param {WindowLike} win
 */
function checkRepeatedSectionKickersFromDoc(doc, win) {
  const candidates = collectRepeatedSectionKickerCandidates(
    doc,
    (el) => win.getComputedStyle(el),
    (value, fontSize) => resolveLengthPx(value, fontSize) || 0,
    (el) => resolveFontSizePx(el, win),
  );
  return checkRepeatedSectionKickers({ candidates });
}

/**
 * The class attribute as the checks that match utility classes against it read
 * it. {@link checkColors} and {@link checkMotion} run the same Tailwind patterns
 * over this value, so a difference in how the two are handed it would be one
 * rule seeing a class the other cannot.
 *
 * @param {ElementLike} el
 * @returns {string}
 */
function elementClassList(el) {
  return el.getAttribute?.('class') || el.className || '';
}

/**
 * Takes the element rather than its class list because the value that reaches
 * {@link checkMotion} is what decides whether the utility-class half of the rule
 * can fire at all: this call site once passed an empty string, and
 * `animate-bounce` was a registered verdict no static-HTML path could reach.
 *
 * @param {ElementLike} el
 * @param {string} tag
 * @param {StyleLike} style
 */
function checkElementMotion(el, tag, style) {
  return checkMotion({
    tag,
    transitionProperty: style.transitionProperty || '',
    animationName: style.animationName || '',
    timingFunctions: [style.animationTimingFunction, style.transitionTimingFunction].filter(Boolean).join(' '),
    classList: elementClassList(el),
  });
}

/**
 * @param {string} _tag
 * @param {StyleLike} style
 * @param {Rgb | null} effectiveBg
 */
function checkElementGlow(_tag, style, effectiveBg) {
  if (!style.boxShadow || style.boxShadow === 'none') return [];
  return checkGlow({ boxShadow: style.boxShadow, effectiveBg });
}

// ─── Section 6: Page-Level Checks ───────────────────────────────────────────

// Static page-level checks — take document/window as parameters

// The size filter and the ratio threshold below are inline literals and both element
// populations are fixed here, and this helper takes no options, so nothing a caller
// passes can narrow or widen any of them. What it finds over the detector's corpus fixtures
// is recorded, by rule id and line, in the verdict baseline the detector's own tests assert
// against.
// The font size every element on a page renders at, split into the sizes this engine
// could price and the declarations it could not. The split is made in one walk
// because the two rules built on it — {@link checkFlatTypeHierarchy} and
// {@link checkUnresolvableFontSizes} — are the two halves of one reading: a size
// that cannot be priced must stay out of the hierarchy population AND be reported,
// and a walk per rule would let those two halves disagree about which sizes those
// are.
// The two halves take different populations, and the reason is a coupling to the
// element rules rather than a property of type: `checkUnresolvableFontSizes` is what
// {@link checkElementColors} stands down onto, so its population must be no narrower
// than that rule's on any axis that narrows one — the selector the rule is registered
// under, and the sources the rule is run on at all. The contrast rule is registered on
// `*` and runs on every source the static engine parses, so a report narrower on
// either axis leaves elements the rule falls silent about with nothing saying why.
// The hierarchy is a claim about the type a page sets, so its half stays on the text
// scan's own population: counting a size the text scan never reads would change which
// pages read flat.
/**
 * @param {DocumentLike} doc
 * @param {WindowLike} win
 * @returns {{ px: number[], unreducible: string[] }}
 */
function collectStaticFontSizes(doc, win) {
  /** @type {number[]} */
  const px = [];
  /** @type {string[]} */
  const unreducible = [];
  const textElements = new Set(doc.querySelectorAll(TEXT_ELEMENT_SELECTOR));
  for (const el of doc.querySelectorAll('*')) {
    const setsTypeScale = textElements.has(el);
    const classPx = classFontSizePx(doc, el);
    if (classPx !== null) {
      if (setsTypeScale) px.push(classPx);
      continue;
    }
    const declared = String(win.getComputedStyle(el).fontSize ?? '').trim();
    const resolved = computedFontSizePx(declared);
    if (resolved !== null) {
      if (setsTypeScale) px.push(resolved);
      continue;
    }
    // An empty computed value is no declaration at all rather than one that could
    // not be reduced, so there is nothing to report and nothing to price.
    if (declared) unreducible.push(declared);
  }
  return { px, unreducible };
}

// Every font-size declaration the cascade could not reduce to pixels, reported once
// each. A viewport unit with no viewport and an absolute unit with no device are the
// common cases; `calc()` and a var() the page never declares reach it too.
//
// The engine used to price these as a multiple of the parent size, so `4vw` entered
// the hierarchy population at 64px and a page that ships flat read as steep. Dropping
// them instead would only make the engine quietly say less about the page. It reports
// them: the size it could not read is the finding.
/**
 * @param {DocumentLike} doc
 * @param {WindowLike} win
 * @returns {RuleFinding[]}
 */
function checkUnresolvableFontSizes(doc, win) {
  const declarations = [...new Set(collectStaticFontSizes(doc, win).unreducible)].sort();
  return declarations.map((declared) => ({
    id: 'unresolvable-font-size',
    snippet: `font-size: ${declared}`,
  }));
}

/**
 * @param {DocumentLike} doc
 * @param {WindowLike} win
 * @returns {RuleFinding[]}
 */
function checkFlatTypeHierarchy(doc, win) {
  const sizes = new Set();
  for (const fontSize of collectStaticFontSizes(doc, win).px) {
    // 200px is the display ceiling above which a size is decoration rather than a step in a
    // hierarchy. Nothing bounds the low end: the cascade resolves `rem`, `em` and `%` to px
    // before this reads them, so a small number here is a small rendered size rather than an
    // unresolved unit, and small type forms steps like any other.
    if (fontSize > 0 && fontSize < 200) sizes.add(Math.round(fontSize * 10) / 10);
  }
  if (sizes.size < 3) return [];

  const sorted = [...sizes].sort((a, b) => a - b);
  const ratio = sorted[sorted.length - 1] / sorted[0];
  if (ratio >= 2.0) return [];

  return [{ id: 'flat-type-hierarchy', scope: SCOPE_DOCUMENT, snippet: `Sizes: ${sorted.map(s => s + 'px').join(', ')} (ratio ${ratio.toFixed(1)}:1)` }];
}

/**
 * @param {ElementLike} el
 * @param {WindowLike} win
 */
function isCardLike(el, win) {
  const tag = el.tagName.toLowerCase();
  if (SAFE_TAGS.has(tag) || ['input', 'select', 'textarea', 'img', 'video', 'canvas', 'picture'].includes(tag)) return false;

  const style = win.getComputedStyle(el);
  const rawStyle = el.getAttribute?.('style') || '';
  const cls = el.getAttribute?.('class') || '';

  const hasShadow = (style.boxShadow && style.boxShadow !== 'none') ||
    /\bshadow(?:-sm|-md|-lg|-xl|-2xl)?\b/.test(cls) || /box-shadow/i.test(rawStyle);
  const hasBorder = /\bborder\b/.test(cls);
  const widthPx = parseFloat(style.width) || 0;
  const hasRadius = resolveBorderRadiusPx(el, style, widthPx, win) > 0 ||
    /\brounded(?:-sm|-md|-lg|-xl|-2xl|-full)?\b/.test(cls) || /border-radius/i.test(rawStyle);
  const hasBg = /\bbg-(?:white|gray-\d+|slate-\d+)\b/.test(cls) ||
    /background(?:-color)?\s*:\s*(?!transparent)/i.test(rawStyle);

  return isCardLikeFromProps(hasShadow, hasBorder, hasRadius, hasBg);
}

/**
 * @param {DocumentLike} doc
 * @param {WindowLike} win
 * @returns {RuleFinding[]}
 */
function checkPageLayout(doc, win) {
  const findings = [];

  // Nested cards
  const allEls = doc.querySelectorAll('*');
  const flaggedEls = new Set();
  for (const el of allEls) {
    if (!isCardLike(el, win)) continue;
    if (flaggedEls.has(el)) continue;

    const tag = el.tagName.toLowerCase();
    const cls = el.getAttribute?.('class') || '';
    const rawStyle = el.getAttribute?.('style') || '';

    if (['pre', 'code'].includes(tag)) continue;
    if (/\b(?:absolute|fixed)\b/.test(cls) || /position\s*:\s*(?:absolute|fixed)/i.test(rawStyle)) continue;
    if ((el.textContent?.trim().length || 0) < 10) continue;
    if (/\b(?:dropdown|popover|tooltip|menu|modal|dialog)\b/i.test(cls)) continue;

    // Walk up to find card-like ancestor
    let parent = el.parentElement;
    while (parent) {
      if (isCardLike(parent, win)) {
        flaggedEls.add(el);
        break;
      }
      parent = parent.parentElement;
    }
  }

  // Only report innermost nested cards
  for (const el of flaggedEls) {
    let isAncestorOfFlagged = false;
    for (const other of flaggedEls) {
      if (other !== el && el.contains(other)) {
        isAncestorOfFlagged = true;
        break;
      }
    }
    if (!isAncestorOfFlagged) {
      findings.push({ id: 'nested-cards', snippet: `Card inside card (${el.tagName.toLowerCase()})` });
    }
  }

  return findings;
}

// ─── Cream / beige palette (the default "tasteful" AI surface) ────────────────
// A warm, lightly-tinted off-white page background — light, with R≥G≥B and a
// small warm tint (not white, not a strong color). The current reflex surface.
/** @param {Rgb | null | undefined} rgb */
function isCreamColor(rgb) {
  if (!rgb) return false;
  const { r, g, b } = rgb;
  if (Math.min(r, g, b) < 209) return false;   // must be light
  if (!(r >= g && g >= b)) return false;        // warm ordering
  const warmth = r - b;
  return warmth >= 6 && warmth <= 48;           // tinted, not white, not strong
}

// Tailwind background utilities that render as a warm off-white surface. The
// static engine doesn't fetch Tailwind's CSS, so a `bg-amber-50` on <body>
// resolves to nothing in computed style — catch it from the class list
// instead. Candidate tokens map to their actual Tailwind hex and are still
// filtered through isCreamColor, so neutral grays (stone) and over-saturated
// shades drop out on their own.
const TAILWIND_BG_HEX = {
  'bg-amber-50': '#fffbeb', 'bg-amber-100': '#fef3c7',
  'bg-orange-50': '#fff7ed', 'bg-orange-100': '#ffedd5',
  'bg-yellow-50': '#fefce8',
  'bg-stone-50': '#fafaf9', 'bg-stone-100': '#f5f5f4', 'bg-stone-200': '#e7e5e4',
};

/** @param {string | null | undefined} cls */
function creamFromClassList(cls) {
  if (!cls) return null;
  // Arbitrary value: bg-[#f5f0e6] / bg-[rgb(245_240_230)] (underscores = spaces).
  const arb = cls.match(/\bbg-\[([^\]]+)\]/);
  const arbitrary = arb ? /** @type {string} */ (arb[1]) : '';
  if (arb && isCreamColor(parseAnyColor(arbitrary.replace(/_/g, ' ')))) return `bg-[${arbitrary}]`;
  // Named warm-light utilities.
  for (const [tok, hex] of Object.entries(TAILWIND_BG_HEX)) {
    if (new RegExp(`(^|\\s)${tok}($|\\s)`).test(cls) && isCreamColor(parseAnyColor(hex))) return tok;
  }
  return null;
}

/**
 * @param {DocumentLike} doc
 * @param {WindowLike | null} win
 * @returns {RuleFinding[]}
 */
function checkCreamPalette(doc, win) {
  /** @type {RuleFinding[]} */
  const findings = [];
  const body = doc.body || (doc.querySelector ? doc.querySelector('body') : null);
  if (!body) return findings;
  const html = doc.documentElement;
  /** @param {ElementLike} el */
  const getCS = (el) => (win ? win.getComputedStyle(el) : domComputedStyle(el));

  // 1. Computed background — covers inline / <style> / linked CSS, and Tailwind
  //    once it's actually rendered (browser path).
  let bg = readOwnBackgroundColor(body, getCS(body));
  if (!bg || bg.a === 0) {
    if (html) bg = readOwnBackgroundColor(html, getCS(html));
  }
  if (isCreamColor(bg)) {
    const cream = /** @type {Rgb} */ (bg);
    findings.push({
      id: 'cream-palette',
      scope: SCOPE_DOCUMENT,
      snippet: `cream/beige page background rgb(${cream.r}, ${cream.g}, ${cream.b})`,
    });
    return findings;
  }

  // 2. Tailwind class fallback — for the static path, where utility classes
  //    never resolve to computed CSS.
  for (const el of [body, html]) {
    const tok = creamFromClassList(el && el.getAttribute ? el.getAttribute('class') : '');
    if (tok) {
      findings.push({ id: 'cream-palette', scope: SCOPE_DOCUMENT, snippet: `cream/beige page background (Tailwind ${tok})` });
      break;
    }
  }
  return findings;
}

// ─── Oversized hero headline ────────────────────────────────────────────────
// Fires when a *long* headline is set at display size and actually dominates
// the viewport. A punchy one- or two-word headline at the same size is a
// legitimate stylistic choice, and a large-but-contained two-line hero should
// pass too — length and viewport share together are the tell.
const OVERSIZED_H1_FONT_PX = 72;
const OVERSIZED_H1_MIN_CHARS = 40;
const OVERSIZED_H1_MIN_VIEWPORT_HEIGHT_RATIO = 0.28;
const OVERSIZED_H1_MIN_VIEWPORT_AREA_RATIO = 0.25;
/**
 * @param {{ tag: string, fontSize: number, headingText: string, rect?: DomRect | null, viewportWidth?: number, viewportHeight?: number }} opts
 * @returns {RuleFinding[]}
 */
function checkOversizedH1({ tag, fontSize, headingText, rect = null, viewportWidth = 0, viewportHeight = 0 }) {
  if (tag !== 'h1') return [];
  const textLen = headingText.length;
  if (fontSize >= OVERSIZED_H1_FONT_PX && textLen >= OVERSIZED_H1_MIN_CHARS) {
    let viewportDetail = '';
    if (rect && viewportWidth > 0 && viewportHeight > 0) {
      const heightRatio = rect.height / viewportHeight;
      const areaRatio = (rect.width * rect.height) / (viewportWidth * viewportHeight);
      const dominatesViewport = heightRatio >= OVERSIZED_H1_MIN_VIEWPORT_HEIGHT_RATIO
        || areaRatio >= OVERSIZED_H1_MIN_VIEWPORT_AREA_RATIO;
      if (!dominatesViewport) return [];
      viewportDetail = `, ${Math.round(heightRatio * 100)}vh`;
    }
    return [{ id: 'oversized-h1', snippet: `${Math.round(fontSize)}px h1, ${textLen} chars${viewportDetail} "${headingText.slice(0, 60)}"` }];
  }
  return [];
}

/**
 * @param {ElementLike} el
 * @param {StyleLike} _style
 * @param {string} tag
 * @param {WindowLike} window
 */
function checkElementOversizedH1(el, _style, tag, window) {
  if (tag !== 'h1') return [];
  const fontSize = resolveFontSizePx(el, window);
  const headingText = (el.textContent || '').trim().replace(/\s+/g, ' ');
  return checkOversizedH1({ tag, fontSize, headingText });
}

// ─── GPT tell: hairline border + wide diffuse shadow (gated --gpt) ────────────
const CSS_COLOR_TOKEN_RE = /(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\([^)]*\)|#[0-9a-fA-F]{3,8}\b|\b(?:black|white|transparent|currentcolor)\b/gi;

/** @param {string} layer */
function shadowLayerAlpha(layer) {
  CSS_COLOR_TOKEN_RE.lastIndex = 0;
  const match = CSS_COLOR_TOKEN_RE.exec(layer);
  if (!match) return 1;
  if (match[0].toLowerCase() === 'transparent') return 0;
  const parsed = parseAnyColor(match[0]);
  return parsed ? (parsed.a ?? 1) : 1;
}

/**
 * @param {string | null | undefined} boxShadow
 * @param {{ minAlpha?: number }} [options]
 */
function shadowMaxBlurPx(boxShadow, { minAlpha = 0 } = {}) {
  if (!boxShadow || boxShadow === 'none') return 0;
  let maxBlur = 0;
  // Split into layers on commas not inside parentheses (rgba(...) etc.).
  for (const layer of boxShadow.split(/,(?![^()]*\))/)) {
    if (shadowLayerAlpha(layer) < minAlpha) continue;
    // Strip colors and keywords (rgba()/hsl()/hex/named/inset/px), leaving the
    // ordered length tokens: offsetX offsetY blur [spread]. The static cascade
    // keeps unitless zeros ("0 0 24px"); browsers normalize to px ("0px 0px 24px") —
    // both reduce to the same numbers here.
    const cleaned = layer.replace(CSS_COLOR_TOKEN_RE, ' ').replace(/\b[a-z]+\b/gi, ' ');
    const nums = [...cleaned.matchAll(/-?\d*\.?\d+/g)].map(m => parseFloat(m[0]));
    if (nums.length >= 3) maxBlur = Math.max(maxBlur, nums[2] ?? 0);
  }
  return maxBlur;
}

/** @param {string | null | undefined} value */
function cssColorAlpha(value) {
  if (cssColorIsTransparent(value)) return 0;
  const parsed = parseAnyColor(value);
  return parsed ? (parsed.a ?? 1) : 1;
}

/**
 * @param {{ borderWidths: readonly number[], borderColors: readonly string[], boxShadow: string }} opts
 * @returns {RuleFinding[]}
 */
function checkGptThinBorderWideShadow({ borderWidths, borderColors, boxShadow }) {
  const visibleThinBorders = borderWidths
    .map((width, index) => ({ width, alpha: cssColorAlpha(borderColors?.[index] || '') }))
    .filter(({ width, alpha }) => width > 0 && width <= 1.5 && alpha >= 0.28);
  const maxBorder = Math.max(0, ...visibleThinBorders.map(({ width }) => width));
  const blur = shadowMaxBlurPx(boxShadow, { minAlpha: 0.12 });
  if (visibleThinBorders.length >= 2 && blur >= 16) {
    return [{ id: 'gpt-thin-border-wide-shadow', snippet: `${maxBorder}px border + ${Math.round(blur)}px shadow blur` }];
  }
  return [];
}

/** @param {StyleLike} style */
function borderWidthsFromStyle(style) {
  return [
    parseFloat(style.borderTopWidth) || 0,
    parseFloat(style.borderRightWidth) || 0,
    parseFloat(style.borderBottomWidth) || 0,
    parseFloat(style.borderLeftWidth) || 0,
  ];
}

/** @param {StyleLike} style */
function borderColorsFromStyle(style) {
  return [
    style.borderTopColor || '',
    style.borderRightColor || '',
    style.borderBottomColor || '',
    style.borderLeftColor || '',
  ];
}

/**
 * @param {ElementLike} _el
 * @param {StyleLike} style
 */
function checkElementGptBorderShadow(_el, style) {
  return checkGptThinBorderWideShadow({ borderWidths: borderWidthsFromStyle(style), borderColors: borderColorsFromStyle(style), boxShadow: style.boxShadow || '' });
}

// ─── Clipped overflow container ───────────────────────────────────────────────
// A clipping container (overflow hidden/clip, not a scroll region) wrapping an
// absolutely/fixed-positioned descendant clips popovers/menus that must escape.
/** @param {ElementLike} el */
function classSelector(el) {
  const cls = (el.getAttribute ? el.getAttribute('class') : el.className) || '';
  const tokens = String(cls).trim().split(/\s+/).filter(Boolean);
  const tag = el.tagName ? el.tagName.toLowerCase() : 'el';
  return tokens.length ? `${tag}.${tokens.join('.')}` : tag;
}

/** @param {ElementLike} child */
function positionedChildIsDecorative(child) {
  if (!child || typeof child.getAttribute !== 'function') return false;
  if (child.closest?.('[aria-hidden="true"]')) return true;
  const role = (child.getAttribute('role') || '').toLowerCase();
  if (role === 'none' || role === 'presentation') return true;
  const tag = child.tagName ? child.tagName.toLowerCase() : '';
  if (['img', 'svg', 'canvas', 'video'].includes(tag)) return true;
  const ident = `${child.getAttribute('class') || ''} ${child.getAttribute('id') || ''}`;
  if (
    /\b(art|bg|background|badge|blob|crop|decor|dot|glow|grain|image|mask|ornament|overlay|photo|scrim|shadow|shine|texture)\b/i.test(ident) &&
    !positionedChildHasSubstantiveContent(child)
  ) {
    return true;
  }
  return false;
}

const POSITIONED_CHILD_INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'summary',
  'textarea',
  '[tabindex]:not([tabindex="-1"])',
  '[role="button"]',
  '[role="dialog"]',
  '[role="link"]',
  '[role="listbox"]',
  '[role="menu"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="tooltip"]',
].join(',');

/** @param {ElementLike} child */
function positionedChildHasSubstantiveContent(child) {
  const text = (child.textContent || '').replace(/\s+/g, ' ').trim();
  if (text.length > 0) return true;
  if (typeof child.matches === 'function') {
    try {
      if (child.matches(POSITIONED_CHILD_INTERACTIVE_SELECTOR)) return true;
    } catch {}
  }
  if (typeof child.querySelector === 'function') {
    try {
      if (child.querySelector(POSITIONED_CHILD_INTERACTIVE_SELECTOR)) return true;
    } catch {}
  }
  return false;
}

/** @param {ElementLike} el */
function clippingContainerIsIntentionalViewport(el) {
  if (!el || typeof el.getAttribute !== 'function') return false;
  const roleDescription = (el.getAttribute('aria-roledescription') || '').toLowerCase();
  if (/\b(carousel|slider)\b/.test(roleDescription)) return true;
  const ident = `${el.getAttribute('class') || ''} ${el.getAttribute('id') || ''}`.toLowerCase();
  return /\b(carousel|comparison|compare|fisheye|marquee|preview|scroller|slider|slideshow|split|viewport)\b/.test(ident) ||
    /\b(demo-area|demo-stage|demo-viewport)\b/.test(ident);
}

/**
 * @param {ElementLike | null} el
 * @returns {DomRect | null}
 */
function elementRect(el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return null;
  try {
    const rect = el.getBoundingClientRect();
    if (!rect) return null;
    const values = [rect.top, rect.right, rect.bottom, rect.left, rect.width, rect.height];
    if (!values.every(Number.isFinite)) return null;
    if (rect.width <= 0 && rect.height <= 0) return null;
    return rect;
  } catch {
    return null;
  }
}

/** @param {StyleLike} style */
function positionedStyleImpliesEscape(style) {
  const values = [
    style.top,
    style.right,
    style.bottom,
    style.left,
    style.inset,
    style.insetBlock,
    style.insetInline,
    style.insetBlockStart,
    style.insetBlockEnd,
    style.insetInlineStart,
    style.insetInlineEnd,
  ].filter(Boolean).map(value => String(value).trim().toLowerCase());
  for (const value of values) {
    if (/(^|[\s(])-+(?:\d|\.)/.test(value)) return true;
    if (/(^|[\s(])100(?:\.0+)?%/.test(value)) return true;
  }
  return false;
}

/**
 * @param {ElementLike} el
 * @param {ElementLike} child
 * @param {boolean} clipX
 * @param {boolean} clipY
 */
function positionedChildEscapesClip(el, child, clipX, clipY) {
  const parentRect = elementRect(el);
  const childRect = elementRect(child);
  if (!parentRect || !childRect) return null;
  const threshold = 2;
  return Boolean(
    (clipX && (childRect.left < parentRect.left - threshold || childRect.right > parentRect.right + threshold)) ||
    (clipY && (childRect.top < parentRect.top - threshold || childRect.bottom > parentRect.bottom + threshold))
  );
}

/**
 * @param {ElementLike} el
 * @param {StyleLike} style
 * @param {(el: ElementLike) => StyleLike} getStyle
 * @returns {RuleFinding[]}
 */
function checkClippedOverflow(el, style, getStyle) {
  /** @param {string} v */
  const clips = (v) => v === 'hidden' || v === 'clip';
  /** @param {string} v */
  const scrolls = (v) => v === 'auto' || v === 'scroll';
  const ox = style.overflowX || '', oy = style.overflowY || '', ov = style.overflow || '';
  const clipX = clips(ox) || clips(ov);
  const clipY = clips(oy) || clips(ov);
  const anyClip = clipX || clipY;
  const anyScroll = scrolls(ox) || scrolls(oy) || scrolls(ov);
  if (!anyClip || anyScroll) return [];
  if (clippingContainerIsIntentionalViewport(el)) return [];
  if (!el.querySelectorAll) return [];
  for (const child of el.querySelectorAll('*')) {
    const childStyle = getStyle(child);
    const pos = childStyle.position || '';
    if (pos === 'absolute' || pos === 'fixed') {
      if (positionedChildIsDecorative(child)) continue;
      const escapes = positionedChildEscapesClip(el, child, clipX, clipY);
      if (escapes === false) continue;
      if (escapes === null && !positionedStyleImpliesEscape(childStyle)) continue;
      return [{ id: 'clipped-overflow-container', snippet: `${classSelector(el)} clips a positioned child` }];
    }
  }
  return [];
}

/**
 * @param {ElementLike} el
 * @param {StyleLike} style
 * @param {string} _tag
 * @param {WindowLike} window
 */
function checkElementClippedOverflow(el, style, _tag, window) {
  return checkClippedOverflow(el, style, (n) => window.getComputedStyle(n));
}

export {
  checkBorders,
  isEmojiOnlyText,
  checkColors,
  isCardLikeFromProps,
  checkIconTile,
  resolveSerif,
  checkItalicSerif,
  isAccentColor,
  checkHeroEyebrow,
  checkRepeatedSectionKickers,
  checkMotion,
  checkGlow,
  checkHtmlPatterns,
  HEADING_TAGS,
  readOwnBackgroundColor,
  resolveBackground,
  resolveGradientStops,
  parseRadiusToPx,
  resolveBorderRadiusPx,
  resolveVarRefs,
  parseColorResolved,
  cleanInlineText,
  isRepeatedKickerCandidate,
  collectRepeatedSectionKickerCandidates,
  resolveFontSizePx,
  ROOT_FONT_SIZE_PX,
  classFontSizePx,
  usedFontSizePx,
  checkQuality,
  checkPageQualityFromDoc,
  checkElementQuality,
  checkElementBorders,
  checkElementColors,
  checkElementIconTile,
  checkElementItalicSerif,
  checkElementHeroEyebrow,
  checkRepeatedSectionKickersFromDoc,
  checkElementMotion,
  checkElementGlow,
  checkFlatTypeHierarchy,
  checkUnresolvableFontSizes,
  isCardLike,
  checkPageLayout,
  isCreamColor,
  checkCreamPalette,
  checkOversizedH1,
  checkElementOversizedH1,
  shadowMaxBlurPx,
  checkGptThinBorderWideShadow,
  checkElementGptBorderShadow,
  checkClippedOverflow,
  checkElementClippedOverflow,
};
