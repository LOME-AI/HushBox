import { GENERIC_FONTS, TAILWIND_TEXT_SIZE_PX } from '../../shared/constants.mjs';
import { reduceFontSizePx, reduceLengthPx } from '../../shared/length.mjs';
import { darkGlowVerdict, monotonousSpacingSnippet } from '../../shared/source-verdicts.mjs';
import { isNeutralColor } from '../../shared/color.mjs';
import { checkSourceDesignSystem } from '../../design-system.mjs';
import { SCOPE_DOCUMENT, reportableOnSource, stripHtmlToText } from '../../shared/page.mjs';
import { applyInlineIgnores } from '../../shared/inline-ignores.mjs';
import { ENGINE_REGEX, finding, stampEngine } from '../../findings.mjs';
import { filterByProviders } from '../../registry/antipatterns.mjs';
import { HEADING_TAGS } from '../../rules/checks.mjs';

// ---------------------------------------------------------------------------
// Regex fallback (non-HTML files: CSS, JSX, TSX, etc.)
// ---------------------------------------------------------------------------


/**
 * A completed regex match as the matchers read it. The groups are declared as
 * present because each matcher's own pattern is what decides they are: the
 * matcher and the regex beside it are written as one unit.
 * @typedef {{ readonly 0: string, readonly 1: string, readonly 2: string, readonly 3: string, readonly 4: string, readonly index?: number }} Match
 */

/** The utility classes the size table holds, as one pattern. Derived from the
 *  table rather than written out, so a class added to it cannot be priced by
 *  the type scale and missed by the line the finding points at. */
const TAILWIND_TEXT_SIZE_CLASS = new RegExp(
  `(?<!:)\\b(?:${Object.keys(TAILWIND_TEXT_SIZE_PX).join('|')})\\b`
);

/** One matcher over a single source line.
 * @typedef {{ id: string, regex: RegExp, test: (m: Match, line: string) => boolean, fmt: (m: Match, line: string) => string }} RegexMatcher
 */

/** One analyzer over a whole file's text. Every one of them reaches a verdict
 *  about the page as a whole, so every one declares that scope.
 * @typedef {(content: string, filePath: string) => ScopedFinding[]} RegexAnalyzer
 */

// The parent font size `em` and `%` are measured against. This engine has no
// cascade to read one from, so the number is a stand-in, and neither reader
// here lets it reach an answer. The report discards it: a length reduces or
// does not at every basis — the basis only scales a number the reducibility
// question throws away — so the stand-in cannot change which declarations are
// reported. The type scale keeps it: a reduction that consumed the basis is a
// size no rendering of the page shows, so it is priced into no scale at all.
const RELATIVE_SIZE_BASIS_PX = 16;

/** @param {string} line */
const hasRounded = (line) => /\brounded(?:-\w+)?\b/.test(line);
/** @param {string} line */
const hasBorderRadius = (line) => /border-radius/i.test(line);
/** @param {string} line */
const isSafeElement = (line) => /<(?:blockquote|nav[\s>]|pre[\s>]|code[\s>]|a\s|input[\s>]|span[\s>])/i.test(line);

/**
 * The text one element's own tag states, for a utility class the source writes
 * inside that tag.
 *
 * A reader with no document can attribute a class to exactly one element: the
 * one whose tag the class is written in. Two utilities sharing nothing but a
 * source line belong to no element the source names, and reading them as one
 * element's is a fact about where the line breaks fell rather than about the
 * page — reflow the same markup and the answer moves, where a browser's does
 * not. The element reading in `rules/checks.mjs` asks the same question of a
 * resolved class list, which is what makes the two answers one answer.
 *
 * Where the match sits inside no tag the source names no element to narrow to —
 * a stylesheet, or a call that builds a class list — and the reach is the text
 * as given, which is the only reading available there.
 *
 * @param {Match} m
 * @param {string} text
 * @returns {string}
 */
function statedElementText(m, text) {
  const token = m[0];
  // The match index is into one line; a block context is several lines joined,
  // so the index is verified against the text before it is trusted.
  const at = m.index !== undefined && text.startsWith(token, m.index)
    ? m.index
    : text.indexOf(token);
  if (at < 0) return text;
  const open = text.lastIndexOf('<', at);
  if (open < 0) return text;
  const close = text.indexOf('>', open);
  // The tag closed before the match, so the match is between tags rather than
  // inside one — text content, which names no element either.
  if (close !== -1 && close < at) return text;
  return text.slice(open, close === -1 ? text.length : close + 1);
}

/** A background utility in a colour rather than a neutral. Not global, so the
 *  two readers below share one pattern without sharing a `lastIndex`. */
const COLOURED_BG_CLASS =
  /\bbg-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d+\b/;

/** The far stop of a gradient whose near stop is purple, violet or indigo. */
const GRADIENT_TO_CLASS = /\bto-(?:purple|violet|indigo|blue|cyan|pink|fuchsia)-\d+\b/;

/** Heading scale as a class states it, matching the element reading's own gate. */
const HEADING_SCALE_CLASS = /\btext-(?:[2-9]xl)\b/;

/**
 * The extensions a source's own text is markup a reader sees, rather than the
 * program text of a file that happens to write markup out.
 *
 * This is not the page gate and does not ask its question. {@link
 * reportableOnSource} reads the characters and asks whether they are a page;
 * this reads the file's type and asks whether its text is copy at all — and the
 * two answers come apart on exactly the population that made it worth keeping.
 * Measured over this repository: 53 `.ts`, `.tsx` and `.css` sources write a
 * whole page into a string or a template literal and are page-shaped by the
 * characters alone, and reading their text as copy reports the em-dashes in
 * their code comments and the ordinals in a debug script — 16 rows, all of them
 * wrong.
 */
const RENDERED_TEXT_EXTENSIONS = new Set(['.html', '.htm', '.astro', '.vue', '.svelte']);

/** @param {string | null | undefined} filePath */
function extFromFilePath(filePath) {
  return filePath ? (filePath.match(/\.\w+$/)?.[0] || '').toLowerCase() : '';
}

/**
 * Whether a source's text is the page's own, so a rule may read it as one.
 * A source with no extension is read as its own text: that is stdin, which is
 * handed to this engine as the page a caller piped in.
 *
 * @param {string} filePath
 */
function statesRenderedText(filePath) {
  const ext = extFromFilePath(filePath);
  return !ext || RENDERED_TEXT_EXTENSIONS.has(ext);
}

/**
 * A verdict about the page as a whole, marked as one so the page gate can hold
 * it back from a source of component shape. Declared beside each claim rather
 * than listed anywhere, which is what lets a verdict added here reach the gate
 * without a second place to remember.
 *
 * @param {import('../../findings.mjs').Finding} reached
 * @returns {ScopedFinding}
 */
function pageVerdict(reached) {
  return { ...reached, scope: SCOPE_DOCUMENT };
}

/**
 * A finding carrying the scope its verdict declared. The scope is read by the
 * page gate and dropped before the finding is reported, so it reaches no
 * consumer of the findings stream.
 * @typedef {import('../../findings.mjs').Finding & { scope?: string }} ScopedFinding
 */

/**
 * One page verdict as the report takes it: what the analyzer reached, less the
 * scope the gate has already spent.
 *
 * @param {ScopedFinding} gated
 * @returns {import('../../findings.mjs').Finding}
 */
function withoutScope({ scope: _scope, ...rest }) {
  return rest;
}

/** @param {string} str */
function isNeutralBorderColor(str) {
  const m = str.match(/solid\s+((?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\([^)]*\)|#[0-9a-f]{3,8}\b|[a-z]+)/i);
  if (!m) return false;
  const c = /** @type {string} */ (m[1]).toLowerCase();
  if (['gray', 'grey', 'silver', 'white', 'black', 'transparent', 'currentcolor'].includes(c)) return true;
  if (/^(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(/i.test(c)) return isNeutralColor(c);
  const hex = c.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/);
  if (hex) {
    const [, h1, h2, h3] = /** @type {readonly [string, string, string, string]} */ (
      /** @type {unknown} */ (hex)
    );
    const [r, g, b] = [parseInt(h1, 16), parseInt(h2, 16), parseInt(h3, 16)];
    return (Math.max(r, g, b) - Math.min(r, g, b)) < 30;
  }
  const shex = c.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
  if (shex) {
    const [, s1, s2, s3] = /** @type {readonly [string, string, string, string]} */ (
      /** @type {unknown} */ (shex)
    );
    const [r, g, b] = [parseInt(s1 + s1, 16), parseInt(s2 + s2, 16), parseInt(s3 + s3, 16)];
    return (Math.max(r, g, b) - Math.min(r, g, b)) < 30;
  }
  return false;
}

/** Whether a transition names a property whose animation costs a re-layout.
 *  A longhand answers through its shorthand's own word — `padding-top` carries
 *  `padding` and a word boundary — so this is the question and
 *  {@link LAYOUT_PROPERTY_NAMED} is the answer. */
const LAYOUT_PROPERTY_MENTIONED = /\b(?:(?:max|min)-)?(?:width|height)\b|\bpadding\b|\bmargin\b/;

/** Every layout property a transition names, as the finding lists them back. */
const LAYOUT_PROPERTY_NAMED =
  /\b(?:(?:max|min)-)?(?:width|height)\b|\bpadding(?:-(?:top|right|bottom|left))?\b|\bmargin(?:-(?:top|right|bottom|left))?\b/gi;

/**
 * The `layout-transition` matcher over one declaration that states a transition.
 *
 * `transition` and `transition-property` say the same thing about the same
 * page and are read the same way, so the reading is written once and each
 * declaration names itself — a second copy would be one rule whose two
 * spellings could drift into disagreeing about one line.
 *
 * @param {string} declaration
 * @returns {RegexMatcher}
 */
function layoutTransitionMatcher(declaration) {
  return {
    id: 'layout-transition',
    regex: new RegExp(`${declaration}\\s*:\\s*([^;{}]+)`, 'gi'),
    test: (m) => {
      const value = m[1].toLowerCase();
      if (/\ball\b/.test(value)) return false;
      return LAYOUT_PROPERTY_MENTIONED.test(value);
    },
    fmt: (m) => {
      const named = m[1].match(LAYOUT_PROPERTY_NAMED);
      return `${declaration}: ${named ? named.join(', ') : m[1].trim()}`;
    },
  };
}

/** @type {readonly RegexMatcher[]} */
const REGEX_MATCHERS = [
  // --- Side-tab ---
  { id: 'side-tab', regex: /\bborder-[lrse]-(\d+)\b/g,
    test: (m, line) => { const n = +m[1]; return hasRounded(line) ? n >= 2 : n >= 4; },
    fmt: (m) => m[0] },
  { id: 'side-tab', regex: /border-(?:left|right)\s*:\s*(\d+)px\s+solid[^;]*/gi,
    test: (m, line) => { if (isSafeElement(line)) return false; if (isNeutralBorderColor(m[0])) return false; const n = +m[1]; return hasBorderRadius(line) ? n >= 2 : n >= 3; },
    fmt: (m) => m[0].replace(/\s*;?\s*$/, '') },
  { id: 'side-tab', regex: /border-(?:left|right)-width\s*:\s*(\d+)px/gi,
    test: (m, line) => !isSafeElement(line) && +m[1] >= 3,
    fmt: (m) => m[0] },
  { id: 'side-tab', regex: /border-inline-(?:start|end)\s*:\s*(\d+)px\s+solid/gi,
    test: (m, line) => !isSafeElement(line) && +m[1] >= 3,
    fmt: (m) => m[0] },
  { id: 'side-tab', regex: /border-inline-(?:start|end)-width\s*:\s*(\d+)px/gi,
    test: (m, line) => !isSafeElement(line) && +m[1] >= 3,
    fmt: (m) => m[0] },
  { id: 'side-tab', regex: /border(?:Left|Right)\s*[:=]\s*["'`](\d+)px\s+solid/g,
    test: (m) => +m[1] >= 3,
    fmt: (m) => m[0] },
  // --- Border accent on rounded ---
  { id: 'border-accent-on-rounded', regex: /\bborder-[tb]-(\d+)\b/g,
    test: (m, line) => hasRounded(line) && +m[1] >= 1,
    fmt: (m) => m[0] },
  { id: 'border-accent-on-rounded', regex: /border-(?:top|bottom)\s*:\s*(\d+)px\s+solid/gi,
    test: (m, line) => +m[1] >= 3 && hasBorderRadius(line),
    fmt: (m) => m[0] },
  // --- Overused font ---
  { id: 'overused-font', regex: /font-family\s*:\s*['"]?(Inter|Roboto|Open Sans|Lato|Montserrat|Arial|Helvetica|Fraunces|Geist Sans|Geist Mono|Geist|Mona Sans|Plus Jakarta Sans|Space Grotesk|Recoleta|Instrument Sans|Instrument Serif)\b/gi,
    test: () => true,
    fmt: (m) => m[0] },
  { id: 'overused-font', regex: /fonts\.googleapis\.com\/css2?\?family=(Inter|Roboto|Open\+Sans|Lato|Montserrat|Fraunces|Plus\+Jakarta\+Sans|Space\+Grotesk|Instrument\+Sans|Instrument\+Serif|Mona\+Sans|Geist)\b/gi,
    test: () => true,
    fmt: (m) => `Google Fonts: ${m[1].replace(/\+/g, ' ')}` },
  // --- Gradient text ---
  { id: 'gradient-text', regex: /background-clip\s*:\s*text|-webkit-background-clip\s*:\s*text/gi,
    test: (_m, line) => /gradient/i.test(line),
    fmt: () => 'background-clip: text + gradient' },
  // --- Gradient text (Tailwind) ---
  { id: 'gradient-text', regex: /\bbg-clip-text\b/g,
    test: (_m, line) => /\bbg-gradient-to-/i.test(line),
    fmt: () => 'bg-clip-text + bg-gradient' },
  // --- Gradient text (JSX inline style) ---
  // JSX style objects use camelCase keys and quoted values:
  // `WebkitBackgroundClip: 'text'` / `backgroundClip: 'text'`. The CSS-syntax
  // matcher above only catches the hyphenated form, so it misses .tsx/.jsx.
  { id: 'gradient-text', regex: /\b(?:Webkit)?[Bb]ackgroundClip\s*:\s*(['"`])text\1/g,
    test: (_m, line) => /gradient/i.test(line),
    fmt: () => 'backgroundClip: text + gradient' },
  // --- Tailwind gray on colored bg ---
  // The three utility readers below ask which element carries the classes, not
  // which line does: {@link statedElementText} is where that question is
  // answered, and answering it is what makes these the same verdicts the
  // element reading in `rules/checks.mjs` reaches.
  { id: 'gray-on-color', regex: /\btext-(?:gray|slate|zinc|neutral|stone)-(\d+)\b/g,
    test: (m, line) => COLOURED_BG_CLASS.test(statedElementText(m, line)),
    fmt: (m, line) => { const bg = statedElementText(m, line).match(COLOURED_BG_CLASS); return `${m[0]} on ${bg?.[0] || '?'}`; } },
  // --- Tailwind AI palette ---
  { id: 'ai-color-palette', regex: /\btext-(?:purple|violet|indigo)-(\d+)\b/g,
    test: (m, line) => { const el = statedElementText(m, line); return HEADING_SCALE_CLASS.test(el) || /^<h[1-3][\s>]/i.test(el); },
    fmt: (m) => `${m[0]} on heading` },
  { id: 'ai-color-palette', regex: /\bfrom-(?:purple|violet|indigo)-(\d+)\b/g,
    test: (m, line) => GRADIENT_TO_CLASS.test(statedElementText(m, line)),
    fmt: (m) => `${m[0]} gradient` },
  // --- Bounce/elastic easing ---
  { id: 'bounce-easing', regex: /\banimate-bounce\b/g,
    test: () => true,
    fmt: () => 'animate-bounce (Tailwind)' },
  { id: 'bounce-easing', regex: /animation(?:-name)?\s*:\s*([^;{}]*(?:bounce|elastic|wobble|jiggle|spring)[^;{}]*)/gi,
    test: () => true,
    fmt: (m) => {
      const token = m[1]
        .split(/[,\s]+/)
        .find((part) => /bounce|elastic|wobble|jiggle|spring/i.test(part));
      return `animation: ${token || m[1].trim()}`;
    } },
  { id: 'bounce-easing', regex: /cubic-bezier\(\s*([\d.-]+)\s*,\s*([\d.-]+)\s*,\s*([\d.-]+)\s*,\s*([\d.-]+)\s*\)/g,
    test: (m) => {
      const y1 = parseFloat(m[2]), y2 = parseFloat(m[4]);
      return y1 < -0.1 || y1 > 1.1 || y2 < -0.1 || y2 > 1.1;
    },
    fmt: (m) => `cubic-bezier(${m[1]}, ${m[2]}, ${m[3]}, ${m[4]})` },
  // --- Layout property transition ---
  layoutTransitionMatcher('transition'),
  layoutTransitionMatcher('transition-property'),
  // --- Broken image: src="" or src="#" or src=" " ---
  { id: 'broken-image', regex: /<img\b[^>]*?\bsrc\s*=\s*(?:""|''|"\s+"|'\s+'|"#"|'#')/gi,
    test: () => true,
    fmt: (m) => m[0].slice(0, 100) },
  // --- Broken image: <img> with no src attribute at all ---
  { id: 'broken-image', regex: /<img\b(?:(?!\bsrc\s*=)[^>])*>/gi,
    test: (m) => !/\bsrc\s*=/i.test(m[0]),
    fmt: (m) => m[0].slice(0, 100) },
];

/** @type {readonly RegexAnalyzer[]} */
const REGEX_ANALYZERS = [
  // Single font
  (content, filePath) => {
    const fontFamilyRe = /font-family\s*:\s*([^;}]+)/gi;
    const fonts = new Set();
    let m;
    while ((m = fontFamilyRe.exec(content)) !== null) {
      for (const f of /** @type {string} */ (m[1])
        .split(',')
        .map((family) => family.trim().replace(/^['"]|['"]$/g, '').toLowerCase())) {
        if (f && !GENERIC_FONTS.has(f)) fonts.add(f);
      }
    }
    const gfRe = /fonts\.googleapis\.com\/css2?\?family=([^&"'\s]+)/gi;
    while ((m = gfRe.exec(content)) !== null) {
      for (const f of /** @type {string} */ (m[1])
        .split('|')
        .map((family) => /** @type {string} */ (family.split(':')[0]).replace(/\+/g, ' ').toLowerCase())) {
        fonts.add(f);
      }
    }
    if (fonts.size !== 1 || content.split('\n').length < 20) return [];
    const name = /** @type {string} */ ([...fonts][0]);
    const lines = content.split('\n');
    let line = 1;
    for (let i = 0; i < lines.length; i++) {
      if (/** @type {string} */ (lines[i]).toLowerCase().includes(name)) {
        line = i + 1;
        break;
      }
    }
    return [pageVerdict(finding('single-font', filePath, `only font used is ${name}`, line))];
  },
  // Flat type hierarchy.
  //
  // This analyzer reads declarations, so a size behind a custom property
  // (`font-size: var(--display)`) contributes nothing and a page whose scale is
  // built from custom properties can be reported flat here while it renders a
  // steep hierarchy. That is a false positive, it is known, and it stays: the
  // static-HTML engine resolves custom properties against a real cascade and is
  // the engine to trust wherever both have read the same page. Closing the gap
  // here would mean a second cascade inside this engine — a copy of logic whose
  // correctness depends on matching the first, which the repository's
  // one-implementation rule forbids, and unsound besides, since a custom
  // property routinely lives in a file this engine never sees.
  //
  // The browser's own default stylesheet is the other size this engine cannot
  // read, and it is read differently: a heading takes a MULTIPLE of the size the
  // element above it renders at — an `h1` twice, an `h6` two thirds — and this
  // engine has no document to name that element in. A heading is the top of the
  // scale on most pages, so a range computed without one is a floor rather than
  // the page's range, and a page cannot be called flat on a floor. It declines
  // instead. The static-HTML engine models the sheet against a resolved cascade
  // and reaches the same answer by pricing the heading; this is the only route
  // to that answer open to a reader with no document, and pricing the heading
  // here against the stand-in basis would state a size no rendering shows —
  // which is the thing every other reading in this engine refuses to do.
  (content, filePath) => {
    if (!sizesEveryHeading(content)) return [];
    const sizes = new Set();
    const declarations = fontSizeDeclarations(content, extFromFilePath(filePath));
    // The pricing half of the walk, which keeps what the report discards. A
    // reduction that consumed the stand-in basis — an `em`, a percentage, or a
    // `clamp()` whose minimum is one — is a size no rendering of this page
    // shows, so it enters no scale rather than entering one at an invented
    // number. A `clamp()` reaches this already priced at its minimum endpoint,
    // the size at the narrowest viewport, by the same reducer the static-HTML
    // engine's cascade uses: reading both endpoints instead spans a range no
    // single rendering shows, and a page flat at every width reads as steep.
    for (const declaration of declarations) {
      const { px, basisDependent } = reduceDeclaration(declaration);
      if (px === null || basisDependent) continue;
      if (px > 0 && px < 200) sizes.add(Math.round(px * 10) / 10);
    }
    // A variant prefix is not priced: `md:text-3xl` applies above a breakpoint, and
    // a size the page never shows alongside the others is not a step beside them.
    // `:` is a non-word character, so word boundaries alone would match inside the
    // prefix — which is why the lookbehind, and not `\b`, is what declines it. This
    // is the reading the static-HTML engine's class lookup already takes.
    for (const [cls, px] of Object.entries(TAILWIND_TEXT_SIZE_PX)) {
      if (new RegExp(`(?<!:)\\b${cls}\\b`).test(content)) sizes.add(px);
    }
    if (sizes.size < 3) return [];
    const sorted = [...sizes].sort((a, b) => a - b);
    const ratio =
      /** @type {number} */ (sorted[sorted.length - 1]) / /** @type {number} */ (sorted[0]);
    if (ratio >= 2.0) return [];
    // Where the page first states a size: the first declaration, or the first
    // utility class, whichever the source wrote first. Both come from the lists
    // the sizes above were priced from, so the line a reader is sent to cannot
    // name something this rule did not read.
    const lines = content.split('\n');
    let line =
      declarations.length > 0 ? /** @type {FontSizeDeclaration} */ (declarations[0]).line : 0;
    for (let i = 0; i < lines.length && (line === 0 || i + 1 < line); i++) {
      if (TAILWIND_TEXT_SIZE_CLASS.test(/** @type {string} */ (lines[i]))) {
        line = i + 1;
        break;
      }
    }
    if (line === 0) line = 1;
    return [
      pageVerdict(
        finding(
          'flat-type-hierarchy',
          filePath,
          `Sizes: ${sorted.map(s => s + 'px').join(', ')} (ratio ${ratio.toFixed(1)}:1)`,
          line
        )
      ),
    ];
  },
  // Monotonous spacing (regex)
  (content, filePath) => {
    const snippet = monotonousSpacingSnippet(content);
    return snippet === null ? [] : [pageVerdict(finding('monotonous-spacing', filePath, snippet))];
  },
  // Em-dash overuse: an AI-cadence heuristic, not the absolute rule. HushBox's
  // "no long dashes in user-facing copy" rule lives in DESIGN.md and is enforced
  // on rendered copy by the design-review subagent. This static pass only flags
  // overuse (5+ em-dashes or "--") that reads as machine cadence.
  (content, filePath) => {
    const text = stripHtmlToText(content);
    let count = 0;
    const re = /[—]|--(?=\S)/g;
    while (re.exec(text) !== null) count++;
    if (count < 5) return [];
    return [pageVerdict(finding('em-dash-overuse', filePath, `${count} em-dashes in body text`))];
  },
  // Marketing buzzwords: SaaS phrase list
  (content, filePath) => {
    const text = stripHtmlToText(content);
    const lower = text.toLowerCase();
    const BUZZWORDS = [
      'streamline your', 'empower your', 'supercharge your',
      'unleash your', 'unleash the power', 'leverage the power',
      'built for the modern', 'trusted by leading', 'trusted by the world',
      'best-in-class', 'industry-leading', 'world-class', 'enterprise-grade',
      'next-generation', 'cutting-edge', 'transform your business',
      'revolutionize', 'game-changer', 'game changing',
      'mission-critical', 'best of breed', 'future-proof', 'future proof',
      'seamless experience', 'seamlessly integrate',
      'drive engagement', 'drive growth', 'drive results',
      'harness the power',
    ];
    let count = 0;
    let firstSample = '';
    for (const phrase of BUZZWORDS) {
      let from = 0;
      while (true) {
        const idx = lower.indexOf(phrase, from);
        if (idx === -1) break;
        count++;
        if (!firstSample) {
          firstSample = text.slice(Math.max(0, idx - 12), Math.min(text.length, idx + phrase.length + 12)).trim();
        }
        from = idx + phrase.length;
      }
    }
    if (count === 0) return [];
    return [
      pageVerdict(
        finding(
          'marketing-buzzword',
          filePath,
          `${count} buzzword phrase${count === 1 ? '' : 's'}: "${firstSample}"`
        )
      ),
    ];
  },
  // Numbered section markers (01 / 02 / 03 ...)
  (content, filePath) => {
    const text = stripHtmlToText(content);
    const re = /\b(0[1-9]|1[0-2])\b/g;
    const seen = new Set();
    let m;
    while ((m = re.exec(text)) !== null) seen.add(m[1]);
    if (seen.size < 3) return [];
    const sorted = [...seen].sort();
    let sequential = 0;
    for (let i = 1; i < sorted.length; i++) {
      if (parseInt(sorted[i], 10) === parseInt(sorted[i - 1], 10) + 1) sequential++;
    }
    if (sequential < 2) return [];
    return [
      pageVerdict(
        finding('numbered-section-markers', filePath, `Sequence: ${sorted.slice(0, 6).join(', ')}`)
      ),
    ];
  },
  // Aphoristic cadence: manufactured-contrast + short-rebuttal
  (content, filePath) => {
    const text = stripHtmlToText(content);
    const NOT_A_RE = /\bNot an? [a-z][^.!?]{1,40}[.!]\s+[A-Z][^.!?]{1,60}[.!]/g;
    const SHORT_REBUTTAL_RE = /\b[A-Z][^.!?]{4,80}[.!]\s+(No|Just)\s+[a-z][^.!?]{2,60}[.!]/g;
    let count = 0;
    let firstSample = '';
    let m;
    NOT_A_RE.lastIndex = 0;
    while ((m = NOT_A_RE.exec(text)) !== null) {
      count++;
      if (!firstSample) firstSample = m[0].trim().slice(0, 80);
    }
    SHORT_REBUTTAL_RE.lastIndex = 0;
    while ((m = SHORT_REBUTTAL_RE.exec(text)) !== null) {
      count++;
      if (!firstSample) firstSample = m[0].trim().slice(0, 80);
    }
    if (count < 3) return [];
    return [
      pageVerdict(
        finding(
          'aphoristic-cadence',
          filePath,
          `${count} aphoristic constructions: "${firstSample}"`
        )
      ),
    ];
  },
  // Dark glow (page-level: dark bg + colored box-shadow with blur)
  (content, filePath) => {
    const verdict = darkGlowVerdict(content);
    if (verdict === null) return [];
    const line = content.substring(0, verdict.index).split('\n').length;
    return [pageVerdict(finding('dark-glow', filePath, verdict.snippet, line))];
  },
];

// ---------------------------------------------------------------------------
// Style block extraction (Vue/Svelte <style> blocks)
// ---------------------------------------------------------------------------

/**
 * @param {string} content
 * @param {string} ext
 * @returns {{ content: string, startLine: number }[]}
 */
function extractStyleBlocks(content, ext) {
  ext = ext.toLowerCase();
  if (ext !== '.vue' && ext !== '.svelte') return [];
  /** @type {{ content: string, startLine: number }[]} */
  const blocks = [];
  const re = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(content)) !== null) {
    const before = content.substring(0, m.index);
    const startLine = before.split('\n').length + 1;
    blocks.push({ content: /** @type {string} */ (m[1]), startLine });
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// CSS-in-JS extraction (styled-components, emotion)
// ---------------------------------------------------------------------------

const CSS_IN_JS_EXTENSIONS = new Set(['.js', '.ts', '.jsx', '.tsx']);

/**
 * @param {string} content
 * @param {string} ext
 * @returns {{ content: string, startLine: number }[]}
 */
function extractCSSinJS(content, ext) {
  ext = ext.toLowerCase();
  if (!CSS_IN_JS_EXTENSIONS.has(ext)) return [];
  /** @type {{ content: string, startLine: number }[]} */
  const blocks = [];
  const re = /(?:styled(?:\.\w+|\([^)]+\))|css)\s*`([\s\S]*?)`/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const before = content.substring(0, m.index);
    const startLine = before.split('\n').length;
    blocks.push({ content: /** @type {string} */ (m[1]), startLine });
  }
  return blocks;
}

/**
 * @param {readonly string[]} lines
 * @param {string} filePath
 * @param {number} [lineOffset]
 * @param {boolean | null} [blockContext]
 * @returns {import('../../findings.mjs').Finding[]}
 */
function runRegexMatchers(lines, filePath, lineOffset = 0, blockContext = null) {
  /** @type {import('../../findings.mjs').Finding[]} */
  const findings = [];
  for (const matcher of REGEX_MATCHERS) {
    for (let i = 0; i < lines.length; i++) {
      const line = /** @type {string} */ (lines[i]);
      matcher.regex.lastIndex = 0;
      /** @type {RegExpExecArray | null} */
      let m;
      while ((m = matcher.regex.exec(line)) !== null) {
        // For extracted blocks, use nearby lines as context for multi-line CSS patterns
        const context = blockContext
          ? lines.slice(Math.max(0, i - 3), Math.min(lines.length, i + 4)).join(' ')
          : line;
        const match = /** @type {Match} */ (/** @type {unknown} */ (m));
        if (matcher.test(match, context)) {
          findings.push(
            finding(matcher.id, filePath, matcher.fmt(match, context), i + 1 + lineOffset)
          );
        }
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Font size this engine cannot price
// ---------------------------------------------------------------------------

// This engine has no cascade, so it reports the declaration it read rather than
// the size the page renders — a weaker finding than the static-HTML engine's,
// and the strongest one available without a document. Whether a length reduces
// at all is `shared/length.mjs`'s decision for both engines: a length one
// priced and the other reported would be a divergence between them.
//
// It reads whole content rather than a line, because a CSS declaration ends at
// its semicolon and may break anywhere before it: a matcher in
// {@link REGEX_MATCHERS} sees one line at a time, so a value written under its
// property was invisible to it while a `clamp()` split over lines was read down
// to its opening paren and reported as a size naming no value.

/** The characters that end a declaration's value. A line ending does not. */
const VALUE_TERMINATORS = new Set([';', '{', '}', '"', "'"]);

// How far past the colon a value is read. It is what keeps the pass linear in
// file length: unbounded, a file of unterminated `font-size:` occurrences would
// scan to its end once per occurrence, and every scan this pass makes — for a
// terminator and for an interpolation's closing brace alike — therefore stops
// here. Reaching it is the engine reporting a value it could not finish
// reading, which is this rule, so the finding carries what was read up to it.
const VALUE_SCAN_LIMIT = 200;

/**
 * The characters that open a name, keyed by the source type whose grammars
 * introduce them.
 *
 * An entry is the union over the grammars that type can carry: a `.less` file
 * is CSS and Less, a `.tsx` file is JavaScript and — inside a template literal
 * — CSS, and a single-file component carries all four. The pattern below takes
 * the union of every entry, so a sigil filed under one type rather than another
 * changes nothing the engine does. The table's job is totality over the types
 * this engine reads, not dispatch between them, and its floor is asserted where
 * those types are: a twelfth source type reds rather than joining the population
 * with a class that never learned its grammar.
 *
 * That floor does NOT cover a new sigil inside a grammar already here. Nothing
 * publishes a grammar's sigil set the way the walker publishes its extension
 * set, so that half is a standing gap and this paragraph is the whole of its
 * guard. A sigil of more than one character reaches the class through its last:
 * `--` through `-`, `@@` through `@`.
 */
const NAME_SIGILS_BY_SOURCE_TYPE = Object.freeze({
  // A CSS custom property is `--name`.
  '.css': '-',
  // Sass writes `$name`, over CSS.
  '.scss': '-$',
  '.sass': '-$',
  // Less writes `@name` and `@@name`, and `$name` for a property accessor.
  '.less': '-$@',
  // JavaScript opens an identifier with `$` and a private class field with `#`;
  // CSS rides along in a template literal.
  '.js': '-$#',
  '.jsx': '-$#',
  '.ts': '-$#',
  '.tsx': '-$#',
  // A single-file component holds a script and a style block, and the style
  // block names its own preprocessor.
  '.vue': '-$@#',
  '.svelte': '-$@#',
  '.astro': '-$@#',
});

/** The sigils of {@link NAME_SIGILS_BY_SOURCE_TYPE} as a character class body:
 *  deduplicated, and escaped where a class would read one as syntax. */
const NAME_SIGIL_CLASS = [...new Set(Object.values(NAME_SIGILS_BY_SOURCE_TYPE).join(''))]
  .join('')
  .replace(/[\\\]^-]/g, (character) => `\\${character}`);

/** What a name is written out of: the sigils above, the characters a CSS ident
 *  and a JavaScript identifier share, and every code point outside ASCII. */
const NAME_CHARACTERS = `\\w${NAME_SIGIL_CLASS}\\u0080-\\uffff`;

/**
 * Where a font size declaration starts, in every spelling this engine reads.
 *
 * Three, and what differs is how the property is spelled and delimited: a
 * stylesheet's `font-size:`, the `font-size=` presentation attribute markup
 * carries, and a style object's `fontSize:`. All three state the same property,
 * so a size this engine cannot price is the same finding whichever wrote it.
 *
 * The lookbehind declines a name that merely ends in the property's spelling —
 * `--heading-font-size`, `headingFontSize`, `$font-size`, `@font-size`,
 * `#fontSize` — whose size is reported at the declaration that uses it rather
 * than twice. Its character class is {@link NAME_CHARACTERS}, derived from the
 * grammars the engine's own source types are written in rather than enumerated
 * from the shapes anyone has met. What the derivation enumerates is the
 * constructs that BIND a value, because a binding is what the exclusion's
 * reason is about: its size is written once, at the use. CSS binds through the
 * ident and the custom property, Sass through the variable, Less through the
 * variable and the property accessor, JavaScript through the identifier and the
 * private class field. No other construct in these grammars binds a value under
 * a name.
 *
 * A name that binds nothing is deliberately outside the class. A selector
 * (`#font-size`, `.font-size`, `%font-size`), a pseudo-class, an attribute
 * name, a namespace prefix and an at-keyword each name something and none of
 * them holds a size reported anywhere else, so the exclusion's reason does not
 * reach them; what they do produce is a value {@link isFontSizeValue} refuses,
 * not a name it should have declined. `#` is in the class for the private field
 * and covers the id selector incidentally. An escape (`\66`) encodes a
 * character inside a name rather than opening one, and one standing against the
 * property's spelling encodes a different character, so the text matched there
 * is not the property's name at all.
 *
 * The non-ASCII range is exact for a CSS name — CSS Syntax counts every code
 * point outside ASCII as an ident code point — and a deliberate superset for a
 * JavaScript one, whose identifiers take only some of them. The excess is a
 * non-identifier character standing against the property's spelling with no
 * separator, which no valid source writes.
 *
 * `fontSize=` is absent by decision, not by omission: its left side is an
 * identifier, so `el.style.fontSize = v` and `const fontSize = v` are one
 * shape, and separating them needs a parse this engine does not have. A
 * Tailwind arbitrary value (`text-[4vw]`) is absent because no rule in the
 * detector reads one: a page whose only sizes are `text-[16px]`, `text-[17px]`
 * and `text-[18px]` is silent on both engines. The `font:` shorthand is absent
 * for an unrelated reason, and NOT because nothing reads it — the static-HTML
 * engine's cascade parses the shorthand's size and prices it into the type
 * scale. It is absent because this engine reads a declaration's value run
 * whole while the shorthand's size is one positional component of that run, so
 * admitting the spelling reports every shorthand: `font: 18px/1.2 serif`,
 * whose size prices cleanly, and `font: menu`, which carries no size at all.
 */
const FONT_SIZE_DECLARATION = new RegExp(
  `(?<![${NAME_CHARACTERS}])(font-size\\s*[:=]|fontSize\\s*:)`,
  'gi'
);

/** The quotes a value can open with, in every spelling that writes one. */
const VALUE_QUOTES = new Set(['"', "'", '`']);

/** A token that is a value rather than an expression: it begins with a digit,
 *  after an optional sign or decimal point. */
const NUMERIC_VALUE = /^[+-]?\.?\d[\w.%+-]*/;

/**
 * How a match's value is written, or null where the match is no declaration.
 *
 * A stylesheet's `font-size:` holds a CSS value run; the presentation attribute
 * and the style object hold a value their own language's way. A camelCase
 * spelling that is not exactly `fontSize` is neither: a JavaScript property
 * name is case-sensitive, so `fontsize:` is a key in some map rather than a
 * declaration, while the CSS property and the HTML attribute are ASCII
 * case-insensitive and `FONT-SIZE:` is the same declaration as `font-size:`.
 * Measured on this repository's built bundles, where an attribute-name map
 * carries both spellings a line apart.
 *
 * @param {string} spelled
 * @returns {'stylesheet' | 'off-stylesheet' | null}
 */
function valueSpelling(spelled) {
  if (spelled.includes('-')) return spelled.endsWith(':') ? 'stylesheet' : 'off-stylesheet';
  return spelled.startsWith('fontSize') ? 'off-stylesheet' : null;
}

/**
 * The first `}` at or after `from` and before `bound`, or -1 where the bound is
 * reached first. Searching the whole of `content` instead would make this pass
 * quadratic on a file of unclosed interpolations — the bound is a bound on
 * every scan, not only on the value's length.
 *
 * @param {string} content
 * @param {number} from
 * @param {number} bound
 * @returns {number}
 */
function closingBraceBefore(content, from, bound) {
  for (let i = from; i < bound; i++) {
    if (content[i] === '}') return i;
  }
  return -1;
}

/**
 * What a reader took, and whether it reached the end of it — the one fact about
 * a read that its text alone cannot say. {@link isFontSizeValue} asks it only of
 * a read opening with a name, that being the read a cut can change the shape of:
 * a word the bound sliced is a word the engine never saw the end of, while a
 * value opening with a digit or a sigil is a value however far the bound let it
 * run.
 * @typedef {{ value: string, complete: boolean }} ValueRead
 */

/**
 * The value of the declaration starting at `from`, read no further than
 * `bound`. A `${…}` closing inside the bound is taken whole, because the value
 * ends at the rule's brace everywhere else and cutting at the interpolation's
 * brace names nothing; one that does not close inside the bound is read to the
 * bound like any other value the scan could not finish.
 *
 * @param {string} content
 * @param {number} from
 * @returns {ValueRead}
 */
function declarationValue(content, from) {
  const limit = from + VALUE_SCAN_LIMIT;
  const bound = Math.min(content.length, limit);
  let value = '';
  let i = from;
  while (i < bound) {
    const char = /** @type {string} */ (content[i]);
    if (VALUE_TERMINATORS.has(char)) return { value, complete: true };
    if (char === '$' && content[i + 1] === '{') {
      const close = closingBraceBefore(content, i + 2, bound);
      if (close === -1) return { value: value + content.slice(i, bound), complete: bound < limit };
      value += content.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    value += char;
    i += 1;
  }
  return { value, complete: bound < limit };
}

/**
 * The value of a font size written outside a stylesheet declaration, read no
 * further than `bound`, or null where nothing in that position is a value.
 *
 * A style object's property and a markup attribute hold an expression where a
 * stylesheet holds a value run, so the value is what a quote holds or a token
 * beginning with a digit. An identifier, a call or a type annotation in that
 * position is not a size the engine could read, and naming one would report the
 * source's own symbols as a font size.
 *
 * Only the quoted read can hand {@link isFontSizeValue} a word, so only its
 * completeness can change an answer; a token beginning with a digit opens no
 * name and is a value whatever the bound did to it. Both arms report the fact
 * anyway, because it is a fact about the read rather than about who consults
 * it.
 *
 * What the literal rule cannot decline is a quoted string that IS length-shaped
 * in a field that is not a style: a preferences field named `fontSize` holding
 * `'4vw'` is reported. That is the same false positive the custom-property
 * reading above carries and it stays for the same reason — a value the engine
 * cannot price is what this rule says, and separating a style object from a
 * data object needs a parse this engine does not have. A quoted word that names
 * no size at all is a different case and {@link isFontSizeValue} declines it.
 *
 * @param {string} content
 * @param {number} from
 * @returns {ValueRead | null}
 */
function offStylesheetValue(content, from) {
  const limit = from + VALUE_SCAN_LIMIT;
  const bound = Math.min(content.length, limit);
  let i = from;
  while (i < bound && /\s/.test(/** @type {string} */ (content[i]))) i += 1;
  if (i >= bound) return null;
  const quote = /** @type {string} */ (content[i]);
  if (VALUE_QUOTES.has(quote)) {
    const close = content.indexOf(quote, i + 1);
    return close === -1 || close >= bound
      ? { value: content.slice(i + 1, bound), complete: bound < limit }
      : { value: content.slice(i + 1, close), complete: true };
  }
  const numeric = NUMERIC_VALUE.exec(content.slice(i, bound));
  if (numeric === null) return null;
  const token = /** @type {string} */ (numeric[0]);
  return { value: token, complete: i + token.length < bound || bound < limit };
}

/** The values `font-size` takes that are not lengths: its two size keyword
 *  families, the one keyword naming the font a math context sets, and the
 *  keywords every property takes. */
const FONT_SIZE_KEYWORDS = new Set([
  'xx-small',
  'x-small',
  'small',
  'medium',
  'large',
  'x-large',
  'xx-large',
  'xxx-large',
  'larger',
  'smaller',
  'math',
  'inherit',
  'initial',
  'revert',
  'revert-layer',
  'unset',
]);

/** A value opening with a name: a CSS identifier, or the colon chain a
 *  pseudo-element leaves standing in the same position, carrying the
 *  `.`-separated members a namespace or an object exposes. A leading `-` opens
 *  an identifier only where a letter follows it, which is what keeps `-2vw` a
 *  number rather than a name; a member opens with the same sigils a name does,
 *  so `colors.$size` is one token here exactly as `map.get` is. */
const VALUE_LEADING_NAME = new RegExp(`^:*-?[a-zA-Z_][\\w-]*(?:\\.[${NAME_SIGIL_CLASS}]?[\\w-]+)*`);

/** A variable a namespace exposes: the `.` the namespace is reached through,
 *  then a sigil {@link NAME_SIGILS_BY_SOURCE_TYPE} opens a name with. Sass
 *  writes `colors.$size`. A member that is a function is admitted by the call
 *  standing after it instead. */
const NAMESPACED_VARIABLE = new RegExp(`\\.[${NAME_SIGIL_CLASS}]`);

/** The `-vendor-` an implementation writes in front of an identifier. It names
 *  the implementation rather than the value, so a prefixed keyword is the same
 *  member of the property's value set the bare spelling is. */
const VENDOR_PREFIX = /^-[a-z]+-/;

/**
 * Whether what a reader took is a value this property could hold.
 *
 * The property's spelling stands in selector position too, and a pseudo-class
 * puts a colon after it exactly where a declaration's colon goes — so
 * `.font-size:hover`, `%font-size::before` and `ns|font-size:first-child` were
 * each read as a declaration and reported a pseudo-class name as a size. The
 * answer belongs here rather than in the name class {@link
 * FONT_SIZE_DECLARATION} declines: a selector binds no value, so the reason
 * that class exists does not reach one.
 *
 * The question is whether the value is length-SHAPED, never whether it reduces.
 * Reporting a size it cannot reduce is this rule's entire purpose, so a
 * viewport unit, a `calc()` over custom properties and an undeclared `var()`
 * are its subject matter and every one of them is a value. What is not is a
 * name the property's grammar does not admit: a font size is a length, a
 * percentage, a function, an interpolation, a member a namespace exposes, or
 * one of {@link FONT_SIZE_KEYWORDS}, and a bare word outside that set names
 * something else.
 *
 * A number and a sigil open a value and nothing else in these grammars, so only
 * a value opening with a name reaches a decision at all, and what ends that name
 * decides it. A `(` makes it a call, whatever spells the callee — `calc(`,
 * `-webkit-calc(` and `map.get(` alike. A `.` reaching a member under a sigil
 * makes it a variable a namespace exposes, `colors.$size`. Under neither, the
 * name stood alone as a word, and a word is judged against {@link
 * FONT_SIZE_KEYWORDS} with any vendor prefix taken off it, because a prefix
 * names an implementation rather than a value: `-webkit-xxx-large` is the
 * absolute size `xxx-large` is, and no vendor-prefixed pseudo-class strips to a
 * keyword.
 *
 * A read the scan's bound cut short stands outside the question once the value
 * is known to open with a name: the engine did not see the whole word, and
 * reporting what it could not finish reading is this rule's own answer for that
 * case.
 *
 * Two shapes sit outside deliberately.
 *
 * A qualified name reaching a member under no sigil and no call — `hover.active`,
 * `theme.size` — is refused. No grammar this engine reads writes one as a value:
 * Sass reaches a module member as `ns.$var` or `ns.fn(…)`, Less has no member
 * syntax, and a JavaScript property access reaches a stylesheet only inside an
 * interpolation, which opens with its own sigil. What does write that shape is a
 * selector, a pseudo-class chained with a class.
 *
 * A FUNCTIONAL pseudo-class is reported. `.font-size:not(.hero)` leaves a name
 * followed by an argument list, which is the shape of every CSS function. The
 * separation available at this layer is the character the read ENDED at, since a
 * declaration's value ends at `;` or `}` while a selector's ends at `{` — and
 * that one silences a real Sass length, `rem-calc(#{$x})`, whose value ends at
 * the interpolation's own brace. So the false positive stands rather than a size
 * going quiet.
 *
 * @param {ValueRead} read
 * @returns {boolean}
 */
function isFontSizeValue(read) {
  const name = VALUE_LEADING_NAME.exec(read.value);
  if (name === null) return true;
  if (!read.complete) return true;
  const token = /** @type {string} */ (name[0]);
  if (read.value[token.length] === '(') return true;
  if (NAMESPACED_VARIABLE.test(token)) return true;
  return FONT_SIZE_KEYWORDS.has(token.toLowerCase().replace(VENDOR_PREFIX, ''));
}

/** The source types whose grammar is JavaScript's, and whose string and
 *  regular-expression literals therefore hold text rather than CSS. A
 *  single-file component (`.vue`, `.svelte`, `.astro`) is not one: markup,
 *  script and style sit in one file under three grammars, and reading the whole
 *  of it as JavaScript would mislex the other two. */
const JS_SOURCE_EXTENSIONS = new Set([
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
]);

/** The characters a regular-expression literal can open after. Each is a place
 *  an expression begins, where a `/` cannot be division. `<` and `>` are
 *  deliberately absent: they open and close a JSX tag, and admitting them would
 *  read `</span>` as a literal opening. */
const REGEX_OPENS_AFTER = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '^', '~',
]);

/** The keywords a regular-expression literal can open after, for the positions
 *  a word rather than a punctuator ends. */
const REGEX_OPENS_AFTER_KEYWORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'do', 'else', 'yield',
  'await', 'case',
]);

/** @param {string} content @param {number} end */
function endsWithRegexKeyword(content, end) {
  let i = end;
  while (i > 0 && /[A-Za-z]/.test(/** @type {string} */ (content[i - 1]))) i -= 1;
  return REGEX_OPENS_AFTER_KEYWORD.has(content.slice(i, end));
}

/**
 * Every span of a JavaScript source that holds text rather than code: its
 * quoted strings and its regular-expression literals.
 *
 * A template literal is not one, and the read walks INTO it rather than over
 * it: a template is where a JavaScript source writes CSS — a styled
 * component's rule set, an email template's `<style>` block — so its text is
 * read as a stylesheet. What the read must not do inside one is treat the
 * template's own text as code, or an apostrophe in a sentence would open a
 * string; only the `${…}` an interpolation opens returns it to code. Comments
 * are walked the same way and mark nothing, so a `/` inside one opens no
 * literal.
 *
 * @param {string} content
 * @returns {[number, number][]} half-open [start, end) spans, in reading order
 */
function textLiteralSpans(content) {
  /** @type {[number, number][]} */
  const spans = [];
  /** Where the read is: template text, or the code that encloses or interrupts
   *  it. A frame opened by an interpolation counts the braces inside it, so the
   *  `}` that ends the interpolation is told from the ones a block uses.
   *  @type {{ template: boolean, braces: number, interpolation: boolean }[]} */
  const frames = [{ template: false, braces: 0, interpolation: false }];
  /** The last character that can decide whether a `/` opens a literal. */
  let previous = '';
  let i = 0;
  while (i < content.length) {
    const frame = /** @type {{ template: boolean, braces: number, interpolation: boolean }} */ (
      frames[frames.length - 1]
    );
    const char = /** @type {string} */ (content[i]);
    if (frame.template) {
      if (char === '\\') { i += 2; continue; }
      if (char === '`') { frames.pop(); previous = '`'; i += 1; continue; }
      if (char === '$' && content[i + 1] === '{') {
        frames.push({ template: false, braces: 0, interpolation: true });
        previous = '{';
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (char === '/' && content[i + 1] === '/') {
      const end = content.indexOf('\n', i);
      i = end === -1 ? content.length : end;
      continue;
    }
    if (char === '/' && content[i + 1] === '*') {
      const end = content.indexOf('*/', i + 2);
      i = end === -1 ? content.length : end + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      const start = i;
      i += 1;
      while (i < content.length && content[i] !== char && content[i] !== '\n') {
        i += content[i] === '\\' ? 2 : 1;
      }
      i = Math.min(i + 1, content.length);
      spans.push([start, i]);
      previous = char;
      continue;
    }
    if (char === '`') {
      frames.push({ template: true, braces: 0, interpolation: false });
      previous = '`';
      i += 1;
      continue;
    }
    if (char === '{') { frame.braces += 1; previous = '{'; i += 1; continue; }
    if (char === '}') {
      if (frame.braces > 0) frame.braces -= 1;
      else if (frame.interpolation) { frames.pop(); previous = '}'; i += 1; continue; }
      previous = '}';
      i += 1;
      continue;
    }
    if (
      char === '/' &&
      (previous === '' || REGEX_OPENS_AFTER.has(previous) || endsWithRegexKeyword(content, i))
    ) {
      const start = i;
      i += 1;
      let inClass = false;
      while (i < content.length && content[i] !== '\n') {
        const inner = /** @type {string} */ (content[i]);
        if (inner === '\\') { i += 2; continue; }
        if (inner === '[') inClass = true;
        else if (inner === ']') inClass = false;
        else if (inner === '/' && !inClass) break;
        i += 1;
      }
      // A read that reached no closing `/` on its own line is not a literal:
      // JavaScript writes none across a line break, so what stood there was
      // division, or markup this reader has no grammar for.
      if (content[i] !== '/') { previous = '/'; i = start + 1; continue; }
      i += 1;
      spans.push([start, i]);
      previous = '/';
      continue;
    }
    if (!/\s/.test(char)) previous = char;
    i += 1;
  }
  return spans;
}

/**
 * Whether `index` falls inside one of `spans`.
 * @param {readonly [number, number][]} spans
 * @param {number} index
 */
function insideSpan(spans, index) {
  for (const [start, end] of spans) {
    if (index >= start && index < end) return true;
    if (start > index) break;
  }
  return false;
}

/** A comment, in the one spelling every stylesheet dialect writes. */
const CSS_COMMENT = /\/\*[\s\S]*?\*\//g;

/** A selector whose subject is the root element: the tag, or the pseudo-class
 *  that matches it, carrying any number of its own qualifiers and no combinator
 *  — so `html`, `:root` and `html.a11y-font-scale-88` are members and
 *  `html.a11y-font-scale-88 input` is not. */
const ROOT_SUBJECT_SELECTOR = /^(?:html|:root)(?:[.#:[][^\s>+~,]*)*$/i;

/** The opening tag of a `<style>` element, whose end is where the stylesheet
 *  inside it begins. */
const STYLE_ELEMENT_OPEN = /<style\b[^>]*>/gi;

/**
 * Where the selector of the rule opened at `open` can begin: the nearest
 * position before it that nothing on the selector's side can precede.
 *
 * Two kinds of position qualify. A character that closed the construct in front
 * of the selector — a previous rule's `}`, an enclosing at-rule's `{`, a
 * previous declaration's `;` — and the opening delimiter of the container the
 * stylesheet is written in, because a stylesheet is not always a whole file: a
 * `<style>` element's opening tag and a template literal's backtick each have
 * markup or JavaScript in front of them, which a read that passed them would
 * take for the selector. The start of the source qualifies when nothing else
 * does.
 *
 * @param {string} content
 * @param {number} open index of the `{` that opens the rule
 */
function selectorStart(content, open) {
  let start = 0;
  for (const boundary of ['}', '{', ';', '`']) {
    const at = content.lastIndexOf(boundary, open - 1);
    if (at + 1 > start) start = at + 1;
  }
  STYLE_ELEMENT_OPEN.lastIndex = 0;
  /** @type {RegExpExecArray | null} */
  let tag;
  while ((tag = STYLE_ELEMENT_OPEN.exec(content)) !== null) {
    const end = tag.index + tag[0].length;
    if (end > open) break;
    if (end > start) start = end;
  }
  return start;
}

/**
 * Whether the rule holding the declaration at `index` states the root element.
 *
 * Read backwards from the declaration to the `{` that opens its rule, and back
 * again to where its selector can begin ({@link selectorStart}). What stands
 * between is the selector, less the comments a stylesheet writes in the same
 * place, and every comma-separated part of it has to be the root, because a
 * rule states one size for all of its subjects.
 *
 * @param {string} content
 * @param {number} index
 */
function statesRootElement(content, index) {
  const open = content.lastIndexOf('{', index);
  if (open === -1) return false;
  const start = selectorStart(content, open);
  const selector = content.slice(start, open).replace(CSS_COMMENT, ' ').trim();
  if (!selector) return false;
  return selector
    .split(',')
    .every((part) => ROOT_SUBJECT_SELECTOR.test(part.trim()));
}

/**
 * A heading element as a source writes it: the tag it is written under, and the
 * attributes standing on it. Built from {@link HEADING_TAGS} so the tags this
 * asks about and the tags the rest of the detector calls headings are one set.
 */
const HEADING_ELEMENT = new RegExp(`<(${[...HEADING_TAGS].join('|')})\\b([^>]*)>`, 'gi');

/**
 * An attribute that puts a size on the element carrying it. A `font-size` in a
 * `style` attribute states one outright; any class at all is enough, because
 * this engine prices utility classes off the source as a whole and has no
 * document to attribute one to an element in — so a classed heading is a
 * heading it cannot rule out having been sized.
 */
const SIZES_ITS_OWN_ELEMENT =
  /\bstyle\s*=\s*(['"])[^'"]*font-size[^'"]*\1|\bclass(?:Name)?\s*=/i;

/** One heading tag as a selector names it: the tag standing as a subject or a
 *  qualifier of one, and not the head of a longer name. */
const HEADING_TAG_IN_SELECTOR = new Map(
  [...HEADING_TAGS].map((tag) => [tag, new RegExp(`(?:^|[\\s>+~,(])${tag}(?![\\w-])`, 'i')])
);

/**
 * Every selector a stylesheet in this source states a font size under.
 *
 * Read the way {@link statesRootElement} reads one — back from the declaration
 * to the `{` that opens its rule, and back again to where the selector can
 * begin — so the two readings cannot disagree about where a selector starts.
 *
 * @param {string} content
 * @returns {string[]}
 */
function fontSizeSelectors(content) {
  /** @type {string[]} */
  const selectors = [];
  FONT_SIZE_DECLARATION.lastIndex = 0;
  /** @type {RegExpExecArray | null} */
  let m;
  while ((m = FONT_SIZE_DECLARATION.exec(content)) !== null) {
    if (valueSpelling(/** @type {string} */ (m[1])) !== 'stylesheet') continue;
    const open = content.lastIndexOf('{', m.index);
    if (open === -1) continue;
    selectors.push(content.slice(selectorStart(content, open), open).replace(CSS_COMMENT, ' '));
  }
  return selectors;
}

/**
 * Whether every heading this source states is a heading it also sizes.
 *
 * A heading the page sizes nowhere takes its size from the browser's own
 * default stylesheet, which states it as a multiple of the size the element
 * above it renders at. This engine has no document to name that element in, so
 * such a heading is a size it cannot read — and a heading is the top of the
 * type scale on most pages, which is why the answer is this question rather
 * than a smaller one about whether the scale is complete.
 *
 * @param {string} content
 */
function sizesEveryHeading(content) {
  /** @type {Set<string> | null} */
  let sizedByStylesheet = null;
  HEADING_ELEMENT.lastIndex = 0;
  /** @type {RegExpExecArray | null} */
  let element;
  while ((element = HEADING_ELEMENT.exec(content)) !== null) {
    if (SIZES_ITS_OWN_ELEMENT.test(/** @type {string} */ (element[2]))) continue;
    if (sizedByStylesheet === null) {
      const selectors = fontSizeSelectors(content);
      sizedByStylesheet = new Set(
        [...HEADING_TAG_IN_SELECTOR].filter(([, names]) => selectors.some((one) => names.test(one)))
          .map(([tag]) => tag)
      );
    }
    if (!sizedByStylesheet.has(/** @type {string} */ (element[1]).toLowerCase())) return false;
  }
  return true;
}

/**
 * One font size declaration this engine read: the line it starts on, the value
 * it carries, and whether a stylesheet wrote it. The line is counted in the
 * walk and nowhere else, so every rule built on the walk sends a reader to the
 * same place.
 * @typedef {{ line: number, value: string, stylesheet: boolean, rootScoped: boolean }} FontSizeDeclaration
 */

/**
 * Every font size declaration in a source, in reading order.
 *
 * One walk, because the two rules built on it — the report of a size this
 * engine could not price and the type scale it prices — are the two halves of
 * one reading, exactly as the static-HTML engine's own walk is. A walk per rule
 * would let the halves disagree about which declarations a source even holds.
 *
 * @param {string} content
 * @param {string} [ext] the source's extension, which decides whether a match
 *   standing in a string or a regular-expression literal is a declaration
 * @returns {FontSizeDeclaration[]}
 */
function fontSizeDeclarations(content, ext = '') {
  /** @type {FontSizeDeclaration[]} */
  const declarations = [];
  const literals = JS_SOURCE_EXTENSIONS.has(ext) ? textLiteralSpans(content) : [];
  let line = 1;
  let counted = 0;
  FONT_SIZE_DECLARATION.lastIndex = 0;
  /** @type {RegExpExecArray | null} */
  let m;
  while ((m = FONT_SIZE_DECLARATION.exec(content)) !== null) {
    if (insideSpan(literals, m.index)) continue;
    const spelling = valueSpelling(/** @type {string} */ (m[1]));
    const stylesheet = spelling === 'stylesheet';
    const raw =
      spelling === null
        ? null
        : stylesheet
          ? declarationValue(content, FONT_SIZE_DECLARATION.lastIndex)
          : offStylesheetValue(content, FONT_SIZE_DECLARATION.lastIndex);
    while (counted < m.index) {
      if (content[counted] === '\n') line += 1;
      counted += 1;
    }
    if (raw === null) continue;
    const value = raw.value.trim().replace(/\s+/g, ' ');
    if (!value) continue;
    if (!isFontSizeValue({ value, complete: raw.complete })) continue;
    declarations.push({
      line,
      value,
      stylesheet,
      rootScoped: stylesheet && statesRootElement(content, m.index),
    });
  }
  return declarations;
}

/**
 * A declaration reduced to pixels, by the reading its own spelling takes: a
 * stylesheet's value is a CSS length, and the other two spellings sit where a
 * bare number is priced as one.
 *
 * @param {FontSizeDeclaration} declaration
 * @returns {import('../../shared/length.mjs').Reduction}
 */
function reduceDeclaration(declaration) {
  const reduction = declaration.stylesheet
    ? reduceLengthPx(declaration.value, RELATIVE_SIZE_BASIS_PX)
    : reduceFontSizePx(declaration.value, RELATIVE_SIZE_BASIS_PX);
  // On the root element the basis is not a stand-in for a parent size this
  // engine could not look up: the root has no parent, so a font-relative size on
  // it resolves against the initial value a browser starts from, which is the
  // number the basis already holds. The reduction is the size the page renders,
  // so it is not basis-dependent and the rules that decline one may keep it.
  return declaration.rootScoped && reduction.px !== null
    ? { px: reduction.px, basisDependent: false }
    : reduction;
}

/**
 * Every font-size declaration in a source that this engine cannot price.
 *
 * The report half of the walk, and it asks the pricing half's own question:
 * whether a number came out that a rendering of this page would show. A value
 * the reducer refused outright is one that did not, and so is one it reached
 * only by spending the stand-in basis — an `em`, a percentage, a `clamp()`
 * whose minimum is either — because that basis stands in for a parent size this
 * engine has no document to look up. Both leave the type scale, so both are
 * reported: a size that enters neither rule is a size the page says nothing at
 * all about, which is the fabricated number one step quieter.
 *
 * The static-HTML engine prices those same values instead, its cascade having a
 * parent to price them against. The divergence is the shape of the two engines
 * rather than a gap in this one, and both sides of it are driven on one page in
 * `detector/length-resolution.test.mjs`.
 *
 * @param {string} content
 * @param {string} filePath
 * @returns {import('../../findings.mjs').Finding[]}
 */
function findUnresolvableFontSizes(content, filePath) {
  /** @type {import('../../findings.mjs').Finding[]} */
  const findings = [];
  for (const declaration of fontSizeDeclarations(content, extFromFilePath(filePath))) {
    const { px, basisDependent } = reduceDeclaration(declaration);
    if (px !== null && !basisDependent) continue;
    findings.push(
      finding(
        'unresolvable-font-size',
        filePath,
        `font-size: ${declaration.value}`,
        declaration.line
      )
    );
  }
  return findings;
}

/** Page-level analyzers that scan rendered text content (em-dash use,
 *  buzzword phrases, numbered section markers, aphoristic cadence).
 *  These are detector-agnostic — they work on any HTML/text source
 *  and don't need a parsed DOM. Exported so detectHtml can call them
 *  for `.html` files (which otherwise skip the regex engine). */
const TEXT_CONTENT_ANALYZER_IDS = [
  'em-dash-overuse',
  'marketing-buzzword',
  'numbered-section-markers',
  'aphoristic-cadence',
];

/**
 * @param {string} content
 * @param {string} filePath
 * @returns {import('../../findings.mjs').Finding[]}
 */
function runTextContentAnalyzers(content, filePath) {
  if (!statesRenderedText(filePath)) return [];
  // The text-content analyzers follow the page analyzers in REGEX_ANALYZERS.
  /** @type {ScopedFinding[]} */
  const reached = [];
  for (let i = 0; i < TEXT_CONTENT_ANALYZER_IDS.length; i++) {
    const analyzer = /** @type {RegexAnalyzer} */ (REGEX_ANALYZERS[3 + i]);
    reached.push(...analyzer(content, filePath));
  }
  return reportableOnSource(content, reached).map(withoutScope);
}

/**
 * @param {string} content
 * @param {string} filePath
 * @param {{ designSystem?: import('../../design-system.mjs').DesignSystem, providers?: readonly string[], inlineIgnores?: boolean }} [options]
 * @returns {import('../../findings.mjs').Finding[]}
 */
function detectText(content, filePath, options = {}) {
  /** @type {import('../../findings.mjs').Finding[]} */
  const findings = [];
  const lines = content.split('\n');
  const ext = extFromFilePath(filePath);

  // Run regex matchers on the full file content (catches Tailwind classes, inline styles)
  // Enable block context for CSS files where related properties span multiple lines
  const cssLike = new Set(['.css', '.scss', '.sass', '.less']);
  findings.push(...runRegexMatchers(lines, filePath, 0, cssLike.has(ext) || null));
  findings.push(...findUnresolvableFontSizes(content, filePath));

  // Extract and scan <style> blocks from Vue/Svelte SFCs
  const styleBlocks = extractStyleBlocks(content, ext);
  for (const block of styleBlocks) {
    const blockLines = block.content.split('\n');
    findings.push(...runRegexMatchers(blockLines, filePath, block.startLine - 1, true));
  }

  // Extract and scan CSS-in-JS template literals
  const cssJsBlocks = extractCSSinJS(content, ext);
  for (const block of cssJsBlocks) {
    const blockLines = block.content.split('\n');
    findings.push(...runRegexMatchers(blockLines, filePath, block.startLine - 1, true));
  }

  if (options?.designSystem) {
    findings.push(...checkSourceDesignSystem(content, filePath, { designSystem: options.designSystem }));
  }

  // Deduplicate findings (same antipattern + similar snippet, within 2 lines)
  /** @type {import('../../findings.mjs').Finding[]} */
  const deduped = [];
  for (const f of findings) {
    const isDupe = deduped.some(d =>
      d.antipattern === f.antipattern &&
      d.snippet === f.snippet &&
      Math.abs(d.line - f.line) <= 2
    );
    if (!isDupe) deduped.push(f);
  }

  // Every page-level verdict this engine reaches, held to the source shapes that
  // can carry one by the page gate alone: each verdict declares its own scope,
  // and nothing here decides for it.
  if (statesRenderedText(filePath)) {
    /** @type {ScopedFinding[]} */
    const reached = [];
    for (const analyzer of REGEX_ANALYZERS) {
      reached.push(...analyzer(content, filePath));
    }
    deduped.push(...reportableOnSource(content, reached).map(withoutScope));
  }

  const byProvider = filterByProviders(deduped, options?.providers);
  // Inline `impeccable-disable*` waivers travel with the file; honor them unless
  // explicitly bypassed (`--no-config` / `--no-inline-ignores`).
  const reported = options?.inlineIgnores === false ? byProvider : applyInlineIgnores(byProvider, content);
  return stampEngine(reported, ENGINE_REGEX);
}

export {
  NAME_SIGILS_BY_SOURCE_TYPE,
  REGEX_MATCHERS,
  REGEX_ANALYZERS,
  TEXT_CONTENT_ANALYZER_IDS,
  extractStyleBlocks,
  extractCSSinJS,
  runRegexMatchers,
  runTextContentAnalyzers,
  detectText,
};
