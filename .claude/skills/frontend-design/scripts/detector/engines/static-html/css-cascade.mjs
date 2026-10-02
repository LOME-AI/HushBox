import fs from 'node:fs';
import path from 'node:path';

import {
  ROOT_FONT_SIZE_PX,
  classFontSizePx,
  resolveVarRefs,
  usedFontSizePx,
} from '../../rules/checks.mjs';
import {
  BARE_NUMBER,
  clampMinimumArgument,
  computedFontSizePx,
  reduceFontSizePx,
  resolveLengthPx,
} from '../../shared/length.mjs';
import { parseAnyColor } from '../../shared/color.mjs';

// ---------------------------------------------------------------------------
// CSSOM CSS-variable border override map
// ---------------------------------------------------------------------------
//
// A CSSOM that drops any border shorthand containing a var() reference leaves
// the computed style with empty width, empty style, and a default black color.
// That's enough to hide the most common real-world side-tab pattern in
// AI-generated pages:
//
//   :root { --brand: #87a8ff; }
//   .card { border-left: 5px solid var(--brand); border-radius: 4px; }
//
// This pre-pass walks the stylesheets, finds any rule whose per-side or
// all-sides border property contains var(), resolves the var() against
// :root-level custom properties (read from the documentElement's computed
// style), and attaches the resolved width+color to every element that matches
// the rule's selector. A `checkElementBorders` consumer can use that map as a
// fallback whenever the computed style came back empty. The current static
// htmlparser2/css-tree cascade resolves var() itself during compute, so this
// CSSOM-based pass is unused by the static path.
//
// Limitations (intentional, to keep the pass simple):
//   * Only :root-level custom properties are resolved. Scoped overrides on
//     descendants are not tracked — uncommon in practice and would require
//     a per-element cascade walk.
//   * @media / @supports wrapped rules are ignored.
//   * The fallback only fills sides the computed style left empty, so any rule
//     whose border parses normally still wins via the computed style.


/**
 * A parsed HTML node as htmlparser2 hands it over, typed by the members this
 * cascade reads. The published node types are not reachable as a package
 * specifier from this tree, and this typedef is the whole surface used.
 *
 * @typedef {{
 *   type: string,
 *   name?: string,
 *   data?: string,
 *   attribs?: Record<string, string>,
 *   parent?: DomNode | null,
 *   prev?: DomNode | null,
 *   children?: DomNode[],
 * }} DomNode
 */

/**
 * The css-tree surface this module drives: a node's kind plus the members it
 * walks, and a list that may or may not be iterable at a given position.
 *
 * @typedef {{ forEach?: (callback: (node: CssNode) => void) => void }} CssList
 * @typedef {{
 *   type: string,
 *   name?: string,
 *   property?: string,
 *   important?: unknown,
 *   value?: unknown,
 *   prelude?: unknown,
 *   block?: { children?: CssList } | null,
 *   children?: CssList,
 * }} CssNode
 * @typedef {{
 *   parse: (text: string, options?: unknown) => CssNode,
 *   generate: (node: unknown) => string,
 * }} CssTree
 */

/**
 * The parser and selector-engine functions the static path is handed, so the
 * dynamic imports in the caller are the only place they are resolved.
 *
 * @typedef {{
 *   selectAll: (selector: string, nodes: DomNode[]) => DomNode[],
 *   selectOne: (selector: string, nodes: DomNode[]) => DomNode | null,
 *   is: (node: DomNode, selector: string) => boolean,
 *   csstree: CssTree,
 *   domutils: { textContent: (node: DomNode) => string },
 * }} StaticModules
 */

/** A computed style: every declared property, plus the CSSOM accessor.
 * @typedef {typeof STATIC_DEFAULT_STYLE & { getPropertyValue: (prop: string) => string }} StaticStyle
 */

/** Where one declaration came from, which is what decides the cascade.
 * @typedef {{ prop: string, value: string, important: boolean, inline: boolean, specificity: readonly number[], order: number, presentation?: boolean }} StaticDeclaration
 */

const BORDER_SHORTHAND_RE = /^(\d+(?:\.\d+)?)px\s+(solid|dashed|dotted|double|groove|ridge|inset|outset)\s+(.+)$/i;

// isNeutralColor only understands rgba()/oklch()/lch()/lab()/hsl()/hwb().
// CSS variables typically hold hex or named colors, so normalize those to
// rgb() before handing the value off to the shared check. Anything we don't
// recognise is passed through unchanged — isNeutralColor then treats it as
// non-neutral, which is the safer default (matches the oklch-era bugfix).
const NAMED_COLORS = {
  white: [255, 255, 255], black: [0, 0, 0], gray: [128, 128, 128],
  grey: [128, 128, 128], silver: [192, 192, 192], red: [255, 0, 0],
  green: [0, 128, 0], blue: [0, 0, 255], yellow: [255, 255, 0],
};

/**
 * @param {string | null | undefined} value
 * @returns {string | null | undefined}
 */
function normalizeColorForCheck(value) {
  if (!value) return value;
  const v = value.trim();
  const hex6 = /** @type {readonly [string, string, string, string] | null} */ (
    v.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  );
  if (hex6) {
    const [r, g, b] = [parseInt(hex6[1], 16), parseInt(hex6[2], 16), parseInt(hex6[3], 16)];
    return `rgb(${r}, ${g}, ${b})`;
  }
  const hex3 = /** @type {readonly [string, string, string, string] | null} */ (
    v.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i)
  );
  if (hex3) {
    const [r, g, b] = [
      parseInt(hex3[1] + hex3[1], 16),
      parseInt(hex3[2] + hex3[2], 16),
      parseInt(hex3[3] + hex3[3], 16),
    ];
    return `rgb(${r}, ${g}, ${b})`;
  }
  const named = /** @type {Record<string, readonly number[] | undefined>} */ (NAMED_COLORS)[
    v.toLowerCase()
  ];
  if (named) return `rgb(${named[0]}, ${named[1]}, ${named[2]})`;
  return v;
}

/**
 * @param {{ documentElement: unknown, styleSheets: Iterable<{ cssRules?: Iterable<{ type?: number, style?: Record<string, string>, selectorText?: string }> }>, querySelectorAll: (selector: string) => Iterable<unknown> }} document
 * @param {{ getComputedStyle: (element: unknown) => { getPropertyValue: (name: string) => string } }} window
 */
function buildBorderOverrideMap(document, window) {
  /** @type {Map<unknown, Record<string, { width: number, color: string | null | undefined }>>} */
  const map = new Map();
  const rootStyle = window.getComputedStyle(document.documentElement);

  /**
   * @param {string} value
   * @param {number} [depth]
   * @returns {string}
   */
  function resolveVar(value, depth = 0) {
    if (!value || depth > 10 || !value.includes('var(')) return value;
    return value.replace(
      /var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\s*\)/g,
      (/** @type {string} */ _, /** @type {string} */ name, /** @type {string | undefined} */ fallback) => {
        const v = rootStyle.getPropertyValue(name).trim();
        if (v) return resolveVar(v, depth + 1);
        if (fallback) return resolveVar(fallback.trim(), depth + 1);
        return '';
      }
    );
  }

  /** @param {string} text */
  function parseShorthand(text) {
    const m = /** @type {readonly [string, string, string, string] | null} */ (
      text.trim().match(BORDER_SHORTHAND_RE)
    );
    if (!m) return null;
    return { width: parseFloat(m[1]), color: normalizeColorForCheck(m[3]) };
  }

  // Read from the per-property accessors on rule.style. A CSSOM that preserves
  // each border-* shorthand it parsed keeps the per-side value even when the
  // overall cssText has been truncated (e.g. a `border: 1px solid var(...)`
  // followed by a `border-left: ...` loses the first declaration but keeps
  // the second).
  /** @type {readonly (readonly [string, string])[]} */
  const SIDE_PROPS = [
    ['borderLeft', 'Left'],
    ['borderRight', 'Right'],
    ['borderTop', 'Top'],
    ['borderBottom', 'Bottom'],
    ['borderInlineStart', 'Left'],
    ['borderInlineEnd', 'Right'],
  ];

  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules || []; } catch { continue; }
    for (const rule of rules) {
      // CSSStyleRule only; skip @media / @keyframes / @supports wrappers.
      if (rule.type !== 1 || !rule.style || !rule.selectorText) continue;

      /** @type {Record<string, { width: number, color: string | null | undefined }>} */
      const perSide = {};

      for (const [prop, side] of SIDE_PROPS) {
        const val = /** @type {Record<string, string>} */ (rule.style)[prop];
        if (!val || !val.includes('var(')) continue;
        const parsed = parseShorthand(resolveVar(val));
        if (parsed && parsed.color) perSide[side] = parsed;
      }

      // Uniform `border: <w> <style> var(...)` applies to every side the
      // per-side map didn't already claim.
      const borderAll = /** @type {Record<string, string>} */ (rule.style)['border'];
      if (borderAll && borderAll.includes('var(')) {
        const parsed = parseShorthand(resolveVar(borderAll));
        if (parsed && parsed.color) {
          for (const s of ['Top', 'Right', 'Bottom', 'Left']) {
            if (!perSide[s]) perSide[s] = parsed;
          }
        }
      }

      // Longhand `border-*-color: var(...)` with width/style in separate
      // declarations. Rare in AI-generated pages, but cheap to cover.
      for (const [prop, side] of /** @type {readonly (readonly [string, string])[]} */ ([
        ['borderLeftColor', 'Left'],
        ['borderRightColor', 'Right'],
        ['borderTopColor', 'Top'],
        ['borderBottomColor', 'Bottom'],
      ])) {
        const val = /** @type {Record<string, string>} */ (rule.style)[prop];
        if (!val || !val.includes('var(')) continue;
        const resolved = resolveVar(val).trim();
        if (!resolved) continue;
        // Width may or may not come from this rule — that's fine; the
        // adapter only substitutes the color when the computed style left it
        // as a literal var() string.
        if (!perSide[side]) perSide[side] = { width: 0, color: normalizeColorForCheck(resolved) };
      }

      if (Object.keys(perSide).length === 0) continue;

      /** @type {Iterable<unknown>} */
      let matched;
      try { matched = document.querySelectorAll(rule.selectorText); }
      catch { continue; }

      for (const el of matched) {
        const existing = map.get(el);
        if (existing) {
          // Later rules overwrite earlier ones — approximates source-order
          // cascade for equal-specificity rules and is good enough for the
          // uncontested var()-dropped sides we're trying to recover.
          Object.assign(existing, perSide);
        } else {
          map.set(el, { ...perSide });
        }
      }
    }
  }

  return map;
}

// ---------------------------------------------------------------------------
// Static HTML/CSS detection (default for local HTML files)
// ---------------------------------------------------------------------------

const STATIC_INHERITED_PROPS = new Set([
  'color', 'fontFamily', 'fontSize', 'fontStyle', 'fontWeight',
  'lineHeight', 'letterSpacing', 'textTransform', 'textAlign', 'hyphens',
  'webkitHyphens',
]);

const STATIC_DEFAULT_STYLE = {
  color: 'rgb(0, 0, 0)',
  backgroundColor: 'rgba(0, 0, 0, 0)',
  backgroundImage: 'none',
  borderTopWidth: '0px',
  borderRightWidth: '0px',
  borderBottomWidth: '0px',
  borderLeftWidth: '0px',
  borderTopColor: 'rgb(0, 0, 0)',
  borderRightColor: 'rgb(0, 0, 0)',
  borderBottomColor: 'rgb(0, 0, 0)',
  borderLeftColor: 'rgb(0, 0, 0)',
  borderRadius: '0px',
  outlineWidth: '0px',
  outlineColor: 'rgb(0, 0, 0)',
  outlineStyle: 'none',
  boxShadow: 'none',
  fontFamily: '',
  fontSize: '16px',
  fontStyle: 'normal',
  fontWeight: '400',
  lineHeight: 'normal',
  letterSpacing: 'normal',
  textTransform: 'none',
  textAlign: 'start',
  hyphens: 'manual',
  webkitHyphens: 'manual',
  transitionProperty: '',
  transitionTimingFunction: '',
  animationName: '',
  animationTimingFunction: '',
  webkitBackgroundClip: '',
  backgroundClip: '',
  width: '',
  height: '',
  paddingTop: '0px',
  paddingRight: '0px',
  paddingBottom: '0px',
  paddingLeft: '0px',
  marginTop: '0px',
  marginRight: '0px',
  marginBottom: '0px',
  marginLeft: '0px',
  position: 'static',
  visibility: 'visible',
  top: 'auto',
  right: 'auto',
  bottom: 'auto',
  left: 'auto',
  inset: '',
  display: '',
  overflow: 'visible',
  overflowX: 'visible',
  overflowY: 'visible',
};

// The sheet states `font-size: smaller` for `small`, for `sub` and for `sup` —
// not a length and not an `em`, but a division of the size above by 1.2. Driven
// for each tag in its own right, in Chromium, Firefox and WebKit, at seventeen
// parent sizes, at nested pairs of each tag and of one inside the other, and
// under two keyword-sized parents: every row is the parent over 1.2, with no
// step and no saturation, and it compounds per element rather than landing on a
// fixed step.
//
// The division is written out rather than rounded to a decimal because a
// four-place one reproduces the quotient at NONE of the 200,000 bases from
// 0.01px to 2000px it was checked over, and at a 14.4px parent lands 11.9995px
// under a floor the browser renders exactly on. What this produces reproduces
// the division bit for bit at every one of them.
const SMALLER_KEYWORD = `${1 / 1.2}em`;

/**
 * The `font-size` the browser's own default stylesheet states for an element,
 * written as the multiple of the size the element above renders at that it is,
 * rather than as a fixed number of pixels. Six headings, `small`, `sub` and
 * `sup`.
 *
 * This cascade is built from the page's own stylesheets, and no page carries
 * this one — so an element the sheet sizes and the page does not was priced at
 * whatever it inherited, where a browser renders it at a multiple of that. A
 * bare `<h1>` inside a 96px section is 192px rendered and was 96px here, which
 * is the ordinary shape of a heading in a sized container rather than an
 * exotic one.
 *
 * MEASURED, NOT READ OFF A SPECIFICATION, because the sheet is the browser's
 * and only a browser can say what is in it. Every value is `getComputedStyle`
 * of the element over `getComputedStyle` of its parent, in Chromium, Firefox
 * and WebKit, all three agreeing, at five parent sizes and at every sectioning
 * depth to three levels. The HTML rendering spec once sized an `h1` by that
 * depth; no engine driven still does, so depth is not a term here.
 *
 * `font-size` and nothing else. The same sheet states margins, weights and
 * display types for these elements, and no rule in this detector reads any of
 * them.
 *
 * NOT EVERY ELEMENT THE SHEET SIZES, and the line is drawn by the same
 * measurement. `pre`, `code`, `kbd` and `samp` take the monospace font
 * preference — 13px in two engines and 12px in the third — which is a user
 * setting rather than a length CSS states, and a `button` takes a platform
 * control default that differs across engines again. A value only one engine
 * would render is a worse answer than no value, so those are left out.
 *
 * WHICH RULES READ A SIZE FROM HERE IS COMPUTED, NOT WRITTEN DOWN HERE. A
 * paragraph naming them is a second copy of something the tooling already
 * derives, and a second copy that has to agree is a sync contract: it drifts,
 * and nothing catches it. `../../size-exposure/derivation.mjs` parses every
 * module this engine can load and computes, from the call graph, the registered
 * ids a size written here can reach; `../../size-exposure/sweep.mjs` drives a
 * page population against that set and throws when an admitted id goes
 * unanswered, when a declared verdict fails to move, or when a verdict moves
 * where the derivation admits none. `size-exposure.test.mjs` beside them runs
 * both on every gate run, so a tag added to this map is asked that question by
 * the suite rather than by whoever remembers to ask.
 */
const USER_AGENT_FONT_SIZE = /** @type {Record<string, string | undefined>} */ ({
  h1: '2em',
  h2: '1.5em',
  h3: '1.17em',
  h4: '1em',
  h5: '0.83em',
  h6: '0.67em',
  small: SMALLER_KEYWORD,
  sub: SMALLER_KEYWORD,
  sup: SMALLER_KEYWORD,
});

const STATIC_PROP_MAP = {
  'background-color': 'backgroundColor',
  'background-image': 'backgroundImage',
  'background-clip': 'backgroundClip',
  '-webkit-background-clip': 'webkitBackgroundClip',
  'border-radius': 'borderRadius',
  'border-top-width': 'borderTopWidth',
  'border-right-width': 'borderRightWidth',
  'border-bottom-width': 'borderBottomWidth',
  'border-left-width': 'borderLeftWidth',
  'border-top-color': 'borderTopColor',
  'border-right-color': 'borderRightColor',
  'border-bottom-color': 'borderBottomColor',
  'border-left-color': 'borderLeftColor',
  'outline-width': 'outlineWidth',
  'outline-color': 'outlineColor',
  'outline-style': 'outlineStyle',
  'box-shadow': 'boxShadow',
  'font-family': 'fontFamily',
  'font-size': 'fontSize',
  'font-style': 'fontStyle',
  'font-weight': 'fontWeight',
  'line-height': 'lineHeight',
  'letter-spacing': 'letterSpacing',
  'text-transform': 'textTransform',
  'text-align': 'textAlign',
  'hyphens': 'hyphens',
  '-webkit-hyphens': 'webkitHyphens',
  'transition-property': 'transitionProperty',
  'transition-timing-function': 'transitionTimingFunction',
  'animation-name': 'animationName',
  'animation-timing-function': 'animationTimingFunction',
  'width': 'width',
  'height': 'height',
  'padding-top': 'paddingTop',
  'padding-right': 'paddingRight',
  'padding-bottom': 'paddingBottom',
  'padding-left': 'paddingLeft',
  'margin-top': 'marginTop',
  'margin-right': 'marginRight',
  'margin-bottom': 'marginBottom',
  'margin-left': 'marginLeft',
  'position': 'position',
  'visibility': 'visibility',
  'top': 'top',
  'right': 'right',
  'bottom': 'bottom',
  'left': 'left',
  'inset': 'inset',
  'display': 'display',
  'overflow': 'overflow',
  'overflow-x': 'overflowX',
  'overflow-y': 'overflowY',
};

const STATIC_NAMED_COLORS = {
  black: { r: 0, g: 0, b: 0, a: 1 },
  white: { r: 255, g: 255, b: 255, a: 1 },
  transparent: { r: 0, g: 0, b: 0, a: 0 },
  gray: { r: 128, g: 128, b: 128, a: 1 },
  grey: { r: 128, g: 128, b: 128, a: 1 },
  silver: { r: 192, g: 192, b: 192, a: 1 },
  red: { r: 255, g: 0, b: 0, a: 1 },
  green: { r: 0, g: 128, b: 0, a: 1 },
  blue: { r: 0, g: 0, b: 255, a: 1 },
};

/**
 * @param {string} value
 * @returns {string[]}
 */
function splitCssList(value) {
  /** @type {string[]} */
  const parts = [];
  let depth = 0, quote = '', start = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = /** @type {string} */ (value[i]);
    if (quote) {
      if (ch === quote && value[i - 1] !== '\\') quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      parts.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = value.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

/**
 * @param {string} value
 * @returns {string[]}
 */
function splitCssTokens(value) {
  /** @type {string[]} */
  const tokens = [];
  let depth = 0, quote = '', current = '';
  for (let i = 0; i < value.length; i++) {
    const ch = /** @type {string} */ (value[i]);
    if (quote) {
      current += ch;
      if (ch === quote && value[i - 1] !== '\\') quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === '(') { depth++; current += ch; continue; }
    if (ch === ')') { depth = Math.max(0, depth - 1); current += ch; continue; }
    if (/\s/.test(ch) && depth === 0) {
      if (current) { tokens.push(current); current = ''; }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

/** @param {string} prop */
function cssPropToCamel(prop) {
  if (!prop) return prop;
  const mapped = /** @type {Record<string, string | undefined>} */ (STATIC_PROP_MAP)[prop];
  if (mapped) return mapped;
  return prop.replace(/-([a-z])/g, (/** @type {string} */ _m, /** @type {string} */ ch) =>
    ch.toUpperCase()
  );
}

/** @param {import('../../shared/color.mjs').Rgb | null | undefined} c */
function staticColorToCss(c) {
  if (!c) return '';
  if (c.a != null && c.a < 1) return `rgba(${c.r}, ${c.g}, ${c.b}, ${Number(c.a.toFixed(3))})`;
  return `rgb(${c.r}, ${c.g}, ${c.b})`;
}

/**
 * @param {unknown} value
 * @returns {import('../../shared/color.mjs').Rgb | null}
 */
function parseStaticColor(value) {
  const parsed = parseAnyColor(value);
  if (parsed) return parsed;
  const named = /** @type {Record<string, import('../../shared/color.mjs').Rgb | undefined>} */ (
    STATIC_NAMED_COLORS
  )[String(value || '').trim().toLowerCase()];
  return named ? { ...named } : null;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function extractStaticColor(value) {
  if (!value) return '';
  const raw = String(value).trim();
  if (/^var\(/i.test(raw)) return raw;
  const colorLike = raw.match(/(?:rgba?\([^)]+\)|oklch\([^)]+\)|oklab\([^)]+\)|lch\([^)]+\)|lab\([^)]+\)|hsla?\([^)]+\)|hwb\([^)]+\)|#[0-9a-f]{3,8}\b|\b(?:black|white|gray|grey|silver|red|green|blue|transparent)\b)/i);
  if (!colorLike) return '';
  return colorLike[0];
}

/**
 * @param {string} prop
 * @param {unknown} value
 * @param {Map<string, string>} customProps
 * @param {Record<string, string> | null | undefined} parentStyle
 * @param {number} basisPx the size a font-relative `font-size` in this
 *   declaration resolves against
 * @param {boolean} [presentation] whether a presentation attribute wrote this
 *   declaration, which is the one position this cascade prices a bare number in
 * @returns {string}
 */
function normalizeStaticCssValue(
  prop,
  value,
  customProps,
  parentStyle,
  basisPx,
  presentation = false
) {
  let resolved = resolveVarRefs(String(value || '').trim(), customProps);
  if (resolved === 'inherit') {
    return (
      parentStyle?.[prop] ||
      /** @type {Record<string, string | undefined>} */ (STATIC_DEFAULT_STYLE)[prop] ||
      ''
    );
  }
  const isModernBorderColor = /^border[A-Z][a-z]+Color$/.test(prop) && /^(?:oklch|oklab|lch|lab|hsl|hwb)\(/i.test(resolved);
  if (!isModernBorderColor && (/color$/i.test(prop) || prop === 'color' || prop === 'backgroundColor')) {
    const parsed = parseStaticColor(resolved);
    if (parsed) resolved = staticColorToCss(parsed);
  }
  // A `font-size` this cannot reduce is left verbatim, and that is what makes it
  // findable: every reader of a computed font size reads a number off a plain
  // `<number>px` value and nothing else, so an unreduced declaration reaches no
  // rule as a size the page never renders.
  //
  // `font-size` is the only length reduced here, because it is the only one whose
  // reduced pixels are the size the rules are given. Every other font-relative
  // length is a value some rule prices as a ratio AGAINST that size, and the form
  // it has to be stored in depends on the element reading it rather than on the
  // element declaring it — so {@link storeFontRelativeValues} does those, once per
  // element. A padding, a margin and a border width are reduced nowhere in this
  // module: they reach their reader verbatim, and that reader prices them against
  // the size it was given.
  if (prop === 'fontSize') {
    // `font-size="14"` states 14 user units, and the same three characters in
    // a rule are priced by the document rather than by the property
    // ({@link BARE_NUMBER}), so the reader is chosen by which of the two wrote
    // the declaration rather than by the characters, which are the same either
    // way.
    const px = presentation
      ? reduceFontSizePx(resolved, basisPx).px
      : resolveLengthPx(resolved, basisPx);
    if (px != null) resolved = `${px}px`;
  }
  return resolved;
}

/**
 * The inherited properties whose value a rule reads as a RATIO against the size
 * it prices the element at. `font-size` is not one of them: its own pixels are
 * that size.
 */
const FONT_RATIO_PROPS = /** @type {const} */ (['lineHeight', 'letterSpacing']);

/**
 * The written form each of {@link FONT_RATIO_PROPS} keeps through inheritance
 * instead of computing to a length at the element that declares it.
 *
 * The split is over the whole cross-product of {@link FONT_RATIO_PROPS} and the
 * forms the reducers in `.claude/skills/frontend-design/scripts/detector/shared/length.mjs`
 * price — `px`, `rem`, `em`, a percentage, and for `line-height` alone a bare
 * number. Each cell of it computes to an absolute length where it is declared
 * and inherits as that length, except the two here — which keep their written
 * form and re-resolve against every descendant's own font size, a different
 * length at every size below them. A form neither reducer prices — a bare number
 * in `letter-spacing` among them — reduces to nothing at any basis and is stored
 * verbatim whichever half it belongs to, because there is no length to store.
 *
 * Both members are verified by measuring layout in a browser rather than read off
 * a specification or a computed style, which keeps a percentage tracking as a
 * percentage. Declared on an element rendering at 40px and read on a descendant
 * rendering at 20px: `line-height:25%` renders 10px at both while
 * `line-height:1.2` renders 48px and 24px, and `letter-spacing:0.25em` renders
 * 10px at both while `letter-spacing:25%` renders 10px and 5px. A bare number in
 * `letter-spacing` is excluded by what prices it rather than by whether it is a
 * length, because that answer moves with the document: standards mode drops the
 * declaration, quirks mode reads it as pixels under the unitless-length quirk.
 */
const RATIO_INHERITED_FORM = /** @type {const} */ ({
  lineHeight: BARE_NUMBER,
  letterSpacing: /%$/,
});

/**
 * Whether this value of this property inherits as a ratio rather than as a
 * length — the one question that decides whether a length may be fixed for it
 * at the element that declares it.
 *
 * A `clamp()` is priced at its minimum endpoint by the reducer, so the endpoint
 * is what this asks about too: the two cannot answer about different arguments
 * without a percentage inside a clamp being reduced as though it were a length.
 *
 * @param {typeof FONT_RATIO_PROPS[number]} property
 * @param {string} value
 * @returns {boolean}
 */
function inheritsAsRatio(property, value) {
  const text = String(value).trim();
  return RATIO_INHERITED_FORM[property].test((clampMinimumArgument(text) ?? text).trim());
}

/**
 * Reduce one element's font-relative values to the lengths the page renders.
 *
 * The basis is whichever size the value resolved against in the page: a value
 * this element states resolves against this element's size, and one it inherited
 * already resolved against the parent's, so the two cases take different bases.
 * Reducing here rather than once at the element that declared the value is what
 * keeps an inherited length at the pixels it was made from, whatever sizes sit
 * between.
 *
 * A value that inherits as a RATIO is left exactly as written instead: it has no
 * length at the element that declared it, because it re-resolves against every
 * descendant's own size. {@link inheritsAsRatio} is that split.
 *
 * @param {Record<string, string>} values this element's computed values, edited
 *   in place
 * @param {Map<string, StaticDeclaration>} specifiedMap
 * @param {Map<string, string>} customProps
 * @param {{ ownPx: number, parentPx: number }} sizes this element's font size and
 *   its parent's
 * @returns {void}
 */
function storeFontRelativeValues(values, specifiedMap, customProps, sizes) {
  const { ownPx, parentPx } = sizes;
  if (ownPx <= 0) return;
  for (const property of FONT_RATIO_PROPS) {
    const value = values[property] ?? '';
    if (inheritsAsRatio(property, value)) continue;
    const basisPx = statesOwnValue(specifiedMap, customProps, property) ? ownPx : parentPx;
    const px = resolveLengthPx(value, basisPx);
    if (px === null) continue;
    values[property] = `${px}px`;
  }
}

/**
 * Whether this element states the property itself rather than taking the value
 * above it, which is what decides whose font size the value resolves against. A
 * declaration of `inherit` IS the inherited value, so its basis is the parent's
 * size like any other inherited one.
 *
 * @param {Map<string, StaticDeclaration>} specifiedMap
 * @param {Map<string, string>} customProps
 * @param {typeof FONT_RATIO_PROPS[number]} property
 * @returns {boolean}
 */
function statesOwnValue(specifiedMap, customProps, property) {
  const declaration = specifiedMap.get(property);
  if (declaration === undefined) return false;
  return resolveVarRefs(String(declaration.value || '').trim(), customProps) !== 'inherit';
}

/**
 * @param {readonly string[]} tokens
 * @returns {readonly [string, string, string, string]}
 */
function expandStaticBoxValues(tokens) {
  if (tokens.length === 0) return ['0px', '0px', '0px', '0px'];
  const [t0 = '0px', t1 = '0px', t2 = '0px', t3 = '0px'] = tokens;
  if (tokens.length === 1) return [t0, t0, t0, t0];
  if (tokens.length === 2) return [t0, t1, t0, t1];
  if (tokens.length === 3) return [t0, t1, t2, t1];
  return [t0, t1, t2, t3];
}

/** @param {string} value */
function parseStaticBorder(value) {
  const tokens = splitCssTokens(value);
  let width = '', color = '';
  for (const token of tokens) {
    if (!width && /^-?[\d.]+(?:px|rem|em|%)$/.test(token)) width = token;
    if (!color) color = extractStaticColor(token);
  }
  return { width, color };
}

/**
 * @param {string} value
 * @returns {[string, string][]}
 */
function parseStaticFont(value) {
  /** @type {[string, string][]} */
  const out = [];
  const slashParts = /** @type {readonly [string, string, string | undefined] | null} */ (
    value.match(/(?:^|\s)([\d.]+(?:px|rem|em|%))(?:\/([^\s]+))?/)
  );
  if (/\bitalic\b/i.test(value)) out.push(['fontStyle', 'italic']);
  const weight = /** @type {readonly [string, string] | null} */ (
    value.match(/\b([1-9]00|bold|normal|lighter|bolder)\b/i)
  );
  if (weight) out.push(['fontWeight', weight[1]]);
  if (slashParts) {
    out.push(['fontSize', slashParts[1]]);
    if (slashParts[2]) out.push(['lineHeight', slashParts[2]]);
    const familyStart = value.indexOf(slashParts[0]) + slashParts[0].length;
    const family = value.slice(familyStart).trim();
    if (family) out.push(['fontFamily', family]);
  }
  return out;
}

/** @param {string} value */
function parseStaticTransition(value) {
  /** @type {string[]} */
  const props = [];
  /** @type {string[]} */
  const timings = [];
  for (const item of splitCssList(value)) {
    const tokens = splitCssTokens(item);
    const timing = tokens.find(token => /^(?:ease|linear|step-|cubic-bezier\()/i.test(token));
    if (timing) timings.push(timing);
    const prop = tokens.find(token => /^[a-z-]+$/i.test(token) && !/^(?:ease|linear|infinite|alternate|forwards|backwards|both|normal|none)$/.test(token) && !/s$/.test(token));
    if (prop) props.push(prop);
  }
  return {
    property: props.join(', '),
    timing: timings.join(', '),
  };
}

/** @param {string} value */
function parseStaticAnimation(value) {
  /** @type {string[]} */
  const names = [];
  /** @type {string[]} */
  const timings = [];
  for (const item of splitCssList(value)) {
    const tokens = splitCssTokens(item);
    const timing = tokens.find(token => /^(?:ease|linear|step-|cubic-bezier\()/i.test(token));
    if (timing) timings.push(timing);
    const name = tokens.find(token =>
      /^[a-z_-][\w-]*$/i.test(token) &&
      !/^(?:ease|linear|infinite|alternate|forwards|backwards|both|normal|none|running|paused)$/.test(token)
    );
    if (name) names.push(name);
  }
  return {
    name: names.join(', '),
    timing: timings.join(', '),
  };
}

/**
 * @param {string} prop
 * @param {unknown} value
 * @returns {[string, string][]}
 */
function expandStaticDeclaration(prop, value) {
  const p = prop.toLowerCase();
  const v = String(value || '').trim();
  if (!v) return [];
  if (p.startsWith('--')) return [[p, v]];
  if (p === 'background') {
    /** @type {[string, string][]} */
    const out = [];
    const hasImage = /gradient|url\(/i.test(v);
    if (hasImage) out.push(['backgroundImage', v]);
    const beforeImage = hasImage ? v.split(/(?:repeating-)?(?:linear|radial|conic)-gradient\(|url\(/i)[0] : v;
    const color = extractStaticColor(hasImage ? beforeImage : v);
    if (color) out.push(['backgroundColor', color]);
    return out;
  }
  if (p === 'border') {
    const parsed = parseStaticBorder(v);
    /** @type {[string, string][]} */
    const out = [];
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      if (parsed.width) out.push([`border${side}Width`, parsed.width]);
      if (parsed.color) out.push([`border${side}Color`, parsed.color]);
    }
    return out;
  }
  if (p === 'outline') {
    // `outline` shorthand: width | style | color, in any order. Reuse the
    // border parser for width + color, then sniff a style keyword from the
    // tokens (solid|dashed|...). `outline: 0` (single-token zero) zeros
    // the width and effectively hides the outline.
    const tokens = splitCssTokens(v);
    const parsed = parseStaticBorder(v);
    const styleToken = tokens.find(t =>
      /^(none|hidden|solid|dashed|dotted|double|groove|ridge|inset|outset)$/i.test(t)
    );
    /** @type {[string, string][]} */
    const out = [];
    if (parsed.width) out.push(['outlineWidth', parsed.width]);
    if (parsed.color) out.push(['outlineColor', parsed.color]);
    if (styleToken) out.push(['outlineStyle', styleToken.toLowerCase()]);
    // `outline: 0` with no other tokens: explicit zero width.
    if (!parsed.width && /^0(?:px|rem|em|%)?$/.test(v.trim())) {
      out.push(['outlineWidth', '0px']);
    }
    return out;
  }
  const sideMatch = p.match(/^border-(top|right|bottom|left)$/);
  if (sideMatch) {
    const parsed = parseStaticBorder(v);
    const sideName = /** @type {string} */ (sideMatch[1]);
    const side = /** @type {string} */ (sideName[0]).toUpperCase() + sideName.slice(1);
    return [
      .../** @type {[string, string][]} */ (parsed.width ? [[`border${side}Width`, parsed.width]] : []),
      .../** @type {[string, string][]} */ (parsed.color ? [[`border${side}Color`, parsed.color]] : []),
    ];
  }
  if (p === 'border-width') {
    const vals = expandStaticBoxValues(splitCssTokens(v));
    return [
      ['borderTopWidth', vals[0]],
      ['borderRightWidth', vals[1]],
      ['borderBottomWidth', vals[2]],
      ['borderLeftWidth', vals[3]],
    ];
  }
  if (p === 'border-color') {
    const vals = expandStaticBoxValues(splitCssTokens(v));
    return [
      ['borderTopColor', vals[0]],
      ['borderRightColor', vals[1]],
      ['borderBottomColor', vals[2]],
      ['borderLeftColor', vals[3]],
    ];
  }
  if (p === 'padding') {
    const vals = expandStaticBoxValues(splitCssTokens(v));
    return [
      ['paddingTop', vals[0]],
      ['paddingRight', vals[1]],
      ['paddingBottom', vals[2]],
      ['paddingLeft', vals[3]],
    ];
  }
  if (p === 'margin') {
    const vals = expandStaticBoxValues(splitCssTokens(v));
    return [
      ['marginTop', vals[0]],
      ['marginRight', vals[1]],
      ['marginBottom', vals[2]],
      ['marginLeft', vals[3]],
    ];
  }
  if (p === 'font') return parseStaticFont(v);
  if (p === 'transition') {
    const parsed = parseStaticTransition(v);
    return [
      .../** @type {[string, string][]} */ (parsed.property ? [['transitionProperty', parsed.property]] : []),
      .../** @type {[string, string][]} */ (parsed.timing ? [['transitionTimingFunction', parsed.timing]] : []),
    ];
  }
  if (p === 'animation') {
    const parsed = parseStaticAnimation(v);
    return [
      .../** @type {[string, string][]} */ (parsed.name ? [['animationName', parsed.name]] : []),
      .../** @type {[string, string][]} */ (parsed.timing ? [['animationTimingFunction', parsed.timing]] : []),
    ];
  }
  const mapped = cssPropToCamel(p);
  if (
    /** @type {Record<string, string | undefined>} */ (STATIC_DEFAULT_STYLE)[mapped] != null ||
    STATIC_INHERITED_PROPS.has(mapped)
  ) {
    return [[mapped, v]];
  }
  return [];
}

/**
 * @param {StaticDeclaration | undefined} a
 * @param {StaticDeclaration} b
 */
function compareStaticPriority(a, b) {
  if (!a) return true;
  if (!!b.important !== !!a.important) return !!b.important;
  if (!!b.inline !== !!a.inline) return !!b.inline;
  for (let i = 0; i < 3; i++) {
    if ((b.specificity[i] || 0) !== (a.specificity[i] || 0)) {
      return (b.specificity[i] || 0) > (a.specificity[i] || 0);
    }
  }
  return b.order >= a.order;
}

/**
 * @param {string} selector
 * @returns {[number, number, number]}
 */
function staticSpecificity(selector) {
  const noWhere = selector.replace(/:where\([^)]*\)/g, '');
  const ids = (noWhere.match(/#[\w-]+/g) || []).length;
  const classes = (noWhere.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+(?:\([^)]*\))?/g) || []).length;
  const stripped = noWhere
    .replace(/#[\w-]+/g, ' ')
    .replace(/\.[\w-]+|\[[^\]]+\]|:{1,2}[\w-]+(?:\([^)]*\))?/g, ' ')
    .replace(/[*>+~(),]/g, ' ');
  const types = (stripped.match(/\b[a-zA-Z][\w-]*\b/g) || []).length;
  return [ids, classes, types];
}

/**
 * @param {Map<DomNode, Map<string, StaticDeclaration>>} specified
 * @param {DomNode} node
 * @param {string} prop
 * @param {string} value
 * @param {{ important: boolean, inline: boolean, specificity: readonly number[], order: number, presentation?: boolean }} meta
 */
function applyStaticDeclaration(specified, node, prop, value, meta) {
  let map = specified.get(node);
  if (!map) { map = new Map(); specified.set(node, map); }
  for (const [expandedProp, expandedValue] of expandStaticDeclaration(prop, value)) {
    const existing = map.get(expandedProp);
    const next = { ...meta, prop: expandedProp, value: expandedValue };
    if (compareStaticPriority(existing, next)) map.set(expandedProp, next);
  }
}

/**
 * The one presentation attribute this cascade applies.
 *
 * SVG states a style property through an attribute of the property's own name;
 * HTML defines no content attribute of this name, so the same characters on an
 * HTML element state nothing. One attribute rather than the family SVG defines,
 * because this is the property the regex engine also reads — `font-size=` is a
 * spelling of its own font-size declaration — so it is the property on which
 * the two engines can be held to one answer on one page. Every other
 * presentation attribute is a reading the static engine alone would have, which
 * is a divergence rather than the parity this exists for.
 */
const SVG_FONT_SIZE_ATTRIBUTE = 'font-size';

/** Ahead of every author rule, whose own order starts at zero. A tie between
 *  two declarations falls to the later one, so zero would order the same way;
 *  the value is a step earlier so the precedence is stated here rather than
 *  inherited from how a tie breaks. */
const PRESENTATION_ATTRIBUTE_ORDER = -1;

/**
 * What an element states through {@link SVG_FONT_SIZE_ATTRIBUTE}, or an empty
 * string where it states nothing.
 *
 * The lower-case name finds an attribute written in any case because the parse
 * folds every attribute name to it. A case-insensitive lookup here would be a
 * second mechanism for a fold the parse already performs.
 *
 * @param {DomNode} node
 * @returns {string}
 */
function svgPresentationFontSize(node) {
  return String(node.attribs?.[SVG_FONT_SIZE_ATTRIBUTE] ?? '').trim();
}

/**
 * Whether an element is one SVG states presentation attributes for: an `<svg>`
 * or a descendant of one.
 *
 * The subtree ends at a `foreignObject`'s children, which are HTML again. The
 * `foreignObject` itself is inside it, being an SVG element like any other.
 *
 * @param {DomNode} node
 * @returns {boolean}
 */
function inSvgSubtree(node) {
  if ((node.name ?? '').toLowerCase() === 'svg') return true;
  for (let cur = node.parent ?? null; cur; cur = cur.parent ?? null) {
    if (cur.type !== 'tag') continue;
    const name = (cur.name ?? '').toLowerCase();
    if (name === 'foreignobject') return false;
    if (name === 'svg') return true;
  }
  return false;
}

/**
 * @param {unknown} styleText
 * @param {number} [orderBase]
 */
function parseStaticStyleAttribute(styleText, orderBase = 0) {
  /** @type {{ prop: string, value: string, important: boolean, order: number }[]} */
  const decls = [];
  for (const part of String(styleText || '').split(';')) {
    const idx = part.indexOf(':');
    if (idx <= 0) continue;
    const prop = part.slice(0, idx).trim();
    let value = part.slice(idx + 1).trim();
    const important = /!important\s*$/i.test(value);
    value = value.replace(/\s*!important\s*$/i, '').trim();
    decls.push({ prop, value, important, order: orderBase + decls.length });
  }
  return decls;
}

/**
 * @param {string} cssText
 * @param {CssTree} csstree
 * @returns {{ selector: string, declarations: { prop: string, value: string, important: boolean }[], specificity: [number, number, number], order: number }[]}
 */
function collectStaticCssRules(cssText, csstree) {
  /** @type {{ selector: string, declarations: { prop: string, value: string, important: boolean }[], specificity: [number, number, number], order: number }[]} */
  const rules = [];
  /** @type {CssNode} */
  let ast;
  try {
    ast = csstree.parse(cssText, { positions: false, parseValue: true, parseCustomProperty: false });
  } catch {
    return rules;
  }
  let order = 0;
  /**
   * @param {CssList | undefined} list
   * @param {readonly string[]} [atRuleStack]
   * @returns {void}
   */
  const walkList = (list, atRuleStack = []) => {
    list?.forEach?.(node => {
      if (node.type === 'Rule' && node.block) {
        if (atRuleStack.some(name => /keyframes$/i.test(name))) return;
        const selectorText = csstree.generate(node.prelude).trim();
        /** @type {{ prop: string, value: string, important: boolean }[]} */
        const declarations = [];
        node.block.children?.forEach?.(child => {
          if (child.type !== 'Declaration') return;
          declarations.push({
            prop: /** @type {string} */ (child.property),
            value: csstree.generate(child.value).trim(),
            important: !!child.important,
          });
        });
        for (const selector of splitCssList(selectorText)) {
          if (selector) rules.push({ selector, declarations, specificity: staticSpecificity(selector), order: order++ });
        }
        return;
      }
      if (node.type === 'Atrule' && node.block) {
        const name = String(node.name || '').toLowerCase();
        if (name === 'media' || name === 'supports' || name === 'layer') {
          walkList(node.block.children, [...atRuleStack, name]);
        }
      }
    });
  };
  walkList(ast.children);
  return rules;
}

class StaticElement {
  /**
   * @param {DomNode} node
   * @param {StaticDocument} doc
   */
  constructor(node, doc) {
    this.node = node;
    this._doc = doc;
    this.nodeType = 1;
    this.tagName = String(node.name || '').toUpperCase();
    this.nodeName = this.tagName;
  }
  get parentElement() {
    let cur = this.node.parent;
    while (cur && cur.type !== 'tag') cur = cur.parent;
    return cur ? this._doc.wrap(cur) : null;
  }
  get previousElementSibling() {
    let cur = this.node.prev;
    while (cur && cur.type !== 'tag') cur = cur.prev;
    return cur ? this._doc.wrap(cur) : null;
  }
  get children() {
    return (this.node.children || [])
      .filter((child) => child.type === 'tag')
      .map((child) => this._doc.wrap(child));
  }
  get childNodes() {
    return (this.node.children || []).map(child => {
      if (child.type === 'text') return { nodeType: 3, textContent: child.data || '' };
      if (child.type === 'tag') return this._doc.wrap(child);
      return { nodeType: 8, textContent: child.data || '' };
    });
  }
  get textContent() {
    return this._doc.domutils.textContent(this.node);
  }
  get className() {
    return this.getAttribute('class') || '';
  }
  get id() {
    return this.getAttribute('id') || '';
  }
  /** @param {string} name */
  getAttribute(name) {
    return this.node.attribs?.[name] ?? null;
  }
  /** @param {string} selector */
  querySelector(selector) {
    try {
      const found = this._doc.selectOne(selector, this.node.children || []);
      return found ? this._doc.wrap(found) : null;
    } catch {
      return null;
    }
  }
  /** @param {string} selector */
  querySelectorAll(selector) {
    try {
      return this._doc
        .selectAll(selector, this.node.children || [])
        .map((node) => this._doc.wrap(node));
    } catch {
      return [];
    }
  }
  /** @param {string} selector */
  closest(selector) {
    /** @type {DomNode | null | undefined} */
    let cur = this.node;
    while (cur && cur.type === 'tag') {
      try {
        if (this._doc.is(cur, selector)) return this._doc.wrap(cur);
      } catch {
        return null;
      }
      cur = cur.parent;
      while (cur && cur.type !== 'tag') cur = cur.parent;
    }
    return null;
  }
  /** @param {{ node?: DomNode } | null | undefined} other */
  /** @param {{ node?: DomNode } | null | undefined} other */
  contains(other) {
    /** @type {DomNode | null | undefined} */
    let cur = other?.node || null;
    while (cur) {
      if (cur === this.node) return true;
      cur = cur.parent;
    }
    return false;
  }
}

class StaticDocument {
  /**
   * @param {DomNode} root
   * @param {StaticModules} modules
   */
  constructor(root, modules) {
    this.root = root;
    this.selectAll = modules.selectAll;
    this.selectOne = modules.selectOne;
    this.is = modules.is;
    this.domutils = modules.domutils;
    this._wrappers = new WeakMap();
    this._styleMap = new WeakMap();
    this._specifiedMap = new WeakMap();
  }
  /** @param {DomNode} node */
  wrap(node) {
    let wrapped = this._wrappers.get(node);
    if (!wrapped) {
      wrapped = new StaticElement(node, this);
      this._wrappers.set(node, wrapped);
    }
    return wrapped;
  }
  /** @param {string} selector */
  querySelectorAll(selector) {
    try {
      return this.selectAll(selector, this.root.children || []).map((node) => this.wrap(node));
    } catch {
      return [];
    }
  }
  /** @param {string} selector */
  querySelector(selector) {
    try {
      const found = this.selectOne(selector, this.root.children || []);
      return found ? this.wrap(found) : null;
    } catch {
      return null;
    }
  }
  get documentElement() {
    return this.querySelector('html');
  }
  get body() {
    return this.querySelector('body');
  }
  /**
   * @param {DomNode} node
   * @param {StaticStyle} style
   */
  setStyle(node, style) {
    this._styleMap.set(node, style);
  }
  /** @param {StaticElement} el */
  getStyle(el) {
    return this._styleMap.get(el.node) || makeStaticStyle();
  }
  /**
   * @param {DomNode} node
   * @param {Set<string>} props
   */
  setSpecified(node, props) {
    this._specifiedMap.set(node, props);
  }
  // Whether the cascade specified `prop` on this element itself, by a rule or by the
  // `style` attribute. The computed style cannot answer it: an inherited value and a
  // declared one are the same string there, and every property has a default. A caller
  // that must distinguish a size the page states from one it merely inherits asks here.
  /**
   * @param {StaticElement} el
   * @param {string} prop
   */
  hasSpecified(el, prop) {
    return this._specifiedMap.get(el.node)?.has(prop) ?? false;
  }
}

/**
 * @param {Record<string, string>} [values]
 * @returns {StaticStyle}
 */
function makeStaticStyle(values = {}) {
  const style = /** @type {StaticStyle} */ ({ ...STATIC_DEFAULT_STYLE, ...values });
  const byKey = /** @type {Record<string, string | undefined>} */ (
    /** @type {unknown} */ (style)
  );
  style.getPropertyValue = (prop) => {
    const key = cssPropToCamel(prop);
    return byKey[key] || byKey[prop] || '';
  };
  return style;
}

/** @param {StaticDocument} staticDoc */
function buildStaticWindow(staticDoc) {
  return {
    document: staticDoc,
    getComputedStyle: (/** @type {StaticElement} */ el) => staticDoc.getStyle(el),
  };
}

/**
 * @param {DomNode} root
 * @param {string} fileDir
 * @param {StaticModules} modules
 */
function collectStaticCssText(root, fileDir, modules) {
  /** @type {string[]} */
  const styleTexts = [];
  for (const styleEl of modules.selectAll('style', root.children || [])) {
    styleTexts.push(modules.domutils.textContent(styleEl));
  }
  const links = modules.selectAll('link', root.children || []);
  for (const link of links) {
    const rel = link.attribs?.['rel'] || '';
    const href = link.attribs?.['href'] || '';
    if (!/\bstylesheet\b/i.test(rel) || !href || /^(https?:)?\/\//i.test(href)) continue;
    const cssPath = path.resolve(fileDir, href);
    try {
      styleTexts.push(fs.readFileSync(cssPath, 'utf-8'));
    } catch { /* skip unreadable */ }
  }
  return styleTexts.join('\n');
}

/**
 * @param {DomNode} root
 * @param {StaticDocument} staticDoc
 * @param {string} cssText
 * @param {StaticModules} modules
 */
function buildStaticStyleMap(root, staticDoc, cssText, modules) {
  /** @type {Map<DomNode, Map<string, StaticDeclaration>>} */
  const specified = new Map();
  const allNodes = modules.selectAll('*', root.children || []);
  const rules = collectStaticCssRules(cssText, modules.csstree);

  // Applied before every rule, and at a specificity nothing can tie: a
  // presentation attribute states a property where no author rule does and
  // loses to any that does, including the least specific rule there is.
  for (const node of allNodes) {
    if (!inSvgSubtree(node)) continue;
    const stated = svgPresentationFontSize(node);
    if (!stated) continue;
    applyStaticDeclaration(specified, node, SVG_FONT_SIZE_ATTRIBUTE, stated, {
      important: false,
      specificity: [0, 0, 0],
      order: PRESENTATION_ATTRIBUTE_ORDER,
      inline: false,
      presentation: true,
    });
  }

  for (const rule of rules) {
    /** @type {DomNode[]} */
    let matched;
    try {
      matched = modules.selectAll(rule.selector, root.children || []);
    } catch {
      continue;
    }
    for (const node of matched) {
      for (const decl of rule.declarations) {
        applyStaticDeclaration(specified, node, decl.prop, decl.value, {
          important: decl.important,
          specificity: rule.specificity,
          order: rule.order,
          inline: false,
        });
      }
    }
  }

  let inlineOrder = rules.length + 1;
  for (const node of allNodes) {
    const styleText = node.attribs?.['style'];
    if (!styleText) continue;
    for (const decl of parseStaticStyleAttribute(styleText, inlineOrder)) {
      applyStaticDeclaration(specified, node, decl.prop, decl.value, {
        important: decl.important,
        specificity: [1, 0, 0],
        order: decl.order,
        inline: true,
      });
    }
    inlineOrder += 1000;
  }

  /**
   * @param {DomNode} node
   * @param {StaticStyle | null} [parentStyle]
   * @param {Map<string, string>} [parentCustom]
   * @param {number} [parentFontPx] the parent element's font size, which is what
   *   an `em` or `%` font-size on this element resolves against
   * @returns {void}
   */
  const computeNode = (
    node,
    parentStyle = null,
    parentCustom = new Map(),
    parentFontPx = ROOT_FONT_SIZE_PX
  ) => {
    const specifiedMap = specified.get(node) || new Map();
    const customProps = new Map(parentCustom);
    for (const [prop, decl] of specifiedMap) {
      if (prop.startsWith('--')) customProps.set(prop, resolveVarRefs(decl.value, customProps));
    }
    // Recorded before the declarations are normalized, because the size those
    // declarations resolve against is read back through it below.
    //
    // A presentation attribute is not a specification in the sense
    // {@link StaticDocument#hasSpecified} answers about: a reader asks that to
    // find out whether an author rule or the `style` attribute states the
    // property, because those are what a utility class this cascade never
    // parsed would lose to — and the attribute is what such a class beats. An
    // entry a rule later overrode carries the rule's own meta and stays.
    staticDoc.setSpecified(
      node,
      new Set([...specifiedMap].filter(([, decl]) => !decl.presentation).map(([prop]) => prop))
    );
    /** @type {Record<string, string>} */
    const values = {};
    for (const prop of Object.keys(STATIC_DEFAULT_STYLE)) {
      const inherited = /** @type {Record<string, string | undefined>} */ (
        /** @type {unknown} */ (parentStyle)
      )?.[prop];
      if (STATIC_INHERITED_PROPS.has(prop) && inherited != null) values[prop] = inherited;
      else values[prop] = /** @type {Record<string, string>} */ (STATIC_DEFAULT_STYLE)[prop] ?? '';
    }
    const inheritedParentStyle = /** @type {Record<string, string> | null} */ (
      /** @type {unknown} */ (parentStyle)
    );
    // `font-size` is the one property whose basis is the PARENT's size, and it is
    // the property every other basis is read off, so it is normalized first. Its
    // position in the specified map is the order the page happens to declare it
    // in, which is no statement about what a relative value beside it resolves
    // against.
    const fontSizeDecl = specifiedMap.get('fontSize');
    if (fontSizeDecl) {
      values['fontSize'] = normalizeStaticCssValue(
        'fontSize',
        fontSizeDecl.value,
        customProps,
        inheritedParentStyle,
        parentFontPx,
        fontSizeDecl.presentation === true
      );
    }
    const classPx = classFontSizePx(staticDoc, staticDoc.wrap(node));
    // A size a utility class states is this element's computed `font-size`, so
    // it is written here for the elements below to inherit. `font-size` is an
    // inherited property: leaving the value the element took from above in place
    // would hand every descendant that states none of its own the size the page
    // states somewhere ELSE, and hand an `em` or a percentage below it that same
    // wrong basis. Only a class writes here — a declaration the reducer could
    // not price stays verbatim, which is what {@link checkUnresolvableFontSizes}
    // reads to say the size could not be read at all.
    if (classPx !== null) values['fontSize'] = `${classPx}px`;
    else if (!fontSizeDecl) {
      // The default sheet is the lowest origin there is, so it is consulted
      // last and only where nothing else wrote: a rule, the `style` attribute
      // and a presentation attribute all arrive as {@link fontSizeDecl}, and a
      // utility class this cascade never parsed arrives as {@link classPx}.
      // Driven in three engines, each of those replaces the sheet's value
      // outright rather than composing with it — including an explicit
      // `inherit`, which leaves the element at the size above it and not at a
      // multiple of it.
      //
      // The value is an `em`, and it is computed by the step that computes an
      // author's `em` rather than by a second multiply here, so the two cannot
      // reach different pixels for the same ratio and the same basis.
      //
      // A size the reducer could not price is left alone. `2em` needs a basis,
      // and the only basis available under an unpriceable ancestor is the
      // stand-in this engine falls back to — so applying the sheet there would
      // turn a size the engine reports it could not read into a confident
      // multiple of a number the page never states.
      // {@link checkUnresolvableFontSizes} reports it instead, and a heading
      // under it keeps the declaration it inherits.
      const uaFontSize = USER_AGENT_FONT_SIZE[String(node.name || '').toLowerCase()];
      if (uaFontSize !== undefined && computedFontSizePx(values['fontSize']) !== null) {
        values['fontSize'] = normalizeStaticCssValue(
          'fontSize',
          uaFontSize,
          customProps,
          inheritedParentStyle,
          parentFontPx
        );
      }
    }
    const ownFontPx = usedFontSizePx(classPx, values['fontSize'] ?? '', parentFontPx);
    for (const [prop, decl] of specifiedMap) {
      if (prop.startsWith('--') || prop === 'fontSize') continue;
      values[prop] = normalizeStaticCssValue(
        prop,
        decl.value,
        customProps,
        inheritedParentStyle,
        ownFontPx,
        decl.presentation === true
      );
    }
    storeFontRelativeValues(values, specifiedMap, customProps, {
      ownPx: ownFontPx,
      parentPx: parentFontPx,
    });
    const style = makeStaticStyle(values);
    staticDoc.setStyle(node, style);
    for (const child of node.children || []) {
      if (child.type === 'tag') computeNode(child, style, customProps, ownFontPx);
    }
  };

  for (const child of root.children || []) {
    if (child.type === 'tag') computeNode(child);
  }
}

export {
  BORDER_SHORTHAND_RE,
  NAMED_COLORS,
  normalizeColorForCheck,
  buildBorderOverrideMap,
  STATIC_INHERITED_PROPS,
  STATIC_DEFAULT_STYLE,
  STATIC_PROP_MAP,
  STATIC_NAMED_COLORS,
  splitCssList,
  splitCssTokens,
  cssPropToCamel,
  staticColorToCss,
  parseStaticColor,
  extractStaticColor,
  normalizeStaticCssValue,
  expandStaticBoxValues,
  parseStaticBorder,
  parseStaticFont,
  parseStaticTransition,
  parseStaticAnimation,
  expandStaticDeclaration,
  compareStaticPriority,
  staticSpecificity,
  applyStaticDeclaration,
  parseStaticStyleAttribute,
  collectStaticCssRules,
  StaticElement,
  StaticDocument,
  makeStaticStyle,
  buildStaticWindow,
  collectStaticCssText,
  buildStaticStyleMap,
};
