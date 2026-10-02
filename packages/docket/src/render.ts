import { Marked, Renderer } from 'marked';
import { createCitationAnnotator } from './citations.ts';
import { DEDICATED_MARKER, RECOMMENDED_MARKER } from './parse.ts';
import type { PathIndex } from './citations.ts';
import type {
  Denial,
  Finding,
  FindingState,
  FindingStatus,
  HistoryEntry,
  Kind,
  Progress,
  Question,
  Ruling,
  Severity,
} from './types.ts';

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * What a rendered href is allowed to point at. A finding file is written by
 * agents and the console rendering it holds write routes to that same corpus,
 * so a link a reader follows is a code path into the surface that records
 * rulings: anything outside this list keeps its text and loses its href. A
 * destination naming no scheme at all is relative, and stays.
 */
const FOLLOWABLE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/**
 * A numeric character reference, which the html parser resolves inside an
 * attribute value whether or not the semicolon is there: `&#106avascript:`
 * reaches the DOM as `javascript:`, and so do the hex, capitalised and
 * zero-padded spellings of the same code point.
 */
const NUMERIC_REFERENCE = /&#(?:(\d+)|[xX]([\da-fA-F]+));?/gu;

/**
 * A reference this side did not resolve: a `&#` the numeric pattern could not
 * read, or a named one, whose table is too large to carry here. A named
 * reference missing its semicolon is left alone deliberately — in an attribute
 * the parser only resolves those from a legacy list, none of whose characters
 * is an ascii letter or a colon, so it cannot build a scheme (measured).
 */
const UNRESOLVED_REFERENCE = /&(?:#|[a-z][a-z\d]*;)/iu;

/** Where a scheme must end, if the destination has one at all. */
const SCHEME_END = /[:/?#]/u;
const SCHEME = /^[a-z][a-z\d+.-]*$/iu;

/** The last character the url parser trims from the front of a destination. */
const LAST_TRIMMED = ' ';

const MAX_CODE_POINT = 0x10_ff_ff;
const FIRST_SURROGATE = 0xd8_00;
const LAST_SURROGATE = 0xdf_ff;

function resolveNumericReferences(text: string): string {
  return text.replaceAll(NUMERIC_REFERENCE, (_reference, decimal: string | undefined, hex) => {
    const code =
      decimal === undefined ? Number.parseInt(String(hex), 16) : Number.parseInt(decimal, 10);
    const representable =
      code > 0 && code <= MAX_CODE_POINT && (code < FIRST_SURROGATE || code > LAST_SURROGATE);
    return representable ? String.fromCodePoint(code) : '�';
  });
}

/**
 * The destination as a browser will read it. An href is written into an
 * attribute, so the html parser resolves character references before the url
 * parser ever sees a scheme, and the url parser then drops every tab, newline
 * and carriage return and trims the leading controls and spaces. Testing the
 * destination as it was written tests a string nothing resolves, which is how
 * an encoded `javascript:` walked through this.
 */
function asResolved(href: string): string {
  let rest = resolveNumericReferences(href).replaceAll(/[\t\n\r]/gu, '');
  while (rest !== '' && rest.slice(0, 1) <= LAST_TRIMMED) rest = rest.slice(1);
  return rest;
}

function isFollowable(href: string): boolean {
  const resolved = asResolved(href);
  const end = resolved.search(SCHEME_END);
  const region = end === -1 ? resolved : resolved.slice(0, end);
  // A reference left in the run-up to the scheme could still resolve to one, so
  // the destination is refused rather than read as the relative link it looks
  // like. Past that point nothing can make a scheme, so an ordinary query
  // string keeps its ampersands.
  if (UNRESOLVED_REFERENCE.test(region)) return false;
  if (end === -1 || resolved[end] !== ':' || !SCHEME.test(region)) return true;
  return FOLLOWABLE_SCHEMES.has(`${region.toLowerCase()}:`);
}

// Raw html in a finding body is shown, not run. Audit bodies are prose, code
// fences and tables, so nothing legitimate is lost, and the guarantee is
// structural rather than an argument about who writes the files. This is
// renderer configuration, not a sanitizer: `html` covers both the block token
// and the inline tag token.
const markdown = new Marked({
  gfm: true,
  renderer: {
    html: ({ text }) => escapeHtml(text),
    // A destination that stays is handed back to marked rather than re-emitted
    // here, so marked's own href encoding is the only one there is. The stock
    // renderer needs nothing but the parser it is lent.
    link(token) {
      if (!isFollowable(token.href)) return this.parser.parseInline(token.tokens);
      const stock = new Renderer();
      stock.parser = this.parser;
      return stock.link(token);
    },
    // An `img` src runs the same allowlist as an href. A script url in a src
    // does not execute, but it is outside what a rendered destination is
    // allowed to be, and the src is what reaches an arbitrary host. A refused
    // image keeps its alt text, the way a refused link keeps its own.
    image(token) {
      if (!isFollowable(token.href)) return escapeHtml(token.text);
      const stock = new Renderer();
      stock.parser = this.parser;
      return stock.image(token);
    },
  },
});

/** The inverse of `escapeHtml`, in the reverse order, so `&amp;lt;` survives it. */
function unescapeHtml(text: string): string {
  return text
    .replaceAll('&#39;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&');
}

/**
 * A title reads as one sentence of inline markdown — most often a symbol or a
 * path in a code span — so the console gets both forms: the markup for the
 * surfaces that can render it, and the text for the ones that place a title as
 * text and would otherwise show its own source. The text is taken out of the
 * markup rather than parsed a second way, so the two cannot disagree about what
 * a title says.
 */
function titleOf(title: string): { text: string; html: string } {
  const html = markdown.parseInline(title, { async: false }).trim();
  return { text: unescapeHtml(html.replaceAll(/<[^>]+>/gu, '')), html };
}

/**
 * An `area` is a short phrase the audit writes paths into, so it arrives with
 * the same code spans a title does. It gets the reading only, not the markup:
 * the area rail places it inside `<option>` elements, which carry no markup at
 * all, so a marked-up reading anywhere else would make the rail and the rows
 * name the same area differently. It is also the filter key and the `?area=`
 * value, and two spellings of one area are two buckets.
 */
function areaOf(area: string): string {
  return titleOf(area).text;
}

export interface RenderedOption {
  readonly id: string;
  readonly label: string;
  readonly recommended: boolean;
  /** Whether choosing this option would make the finding dedicated. */
  readonly dedicated: boolean;
  /** The effort-and-risk line as inline markup, or null where there is none. */
  readonly meta: string | null;
  readonly html: string;
}

/**
 * The console's view of a finding. Scalars are camelCase at this boundary; the
 * compound maps keep their frontmatter keys, so a value read here can be
 * written straight back without a second name mapping to get wrong.
 */
export interface FindingJson {
  readonly id: string;
  /** What the title says, for anywhere a title is placed as text. */
  readonly title: string;
  /** The same title as markup, for anywhere that can render it. */
  readonly titleHtml: string;
  readonly severity: Severity;
  readonly kind: Kind;
  readonly status: FindingStatus;
  readonly statusNote: string | null;
  /** What the area says, read the same way a title is, and never marked up. */
  readonly area: string;
  readonly needsRuling: boolean;
  readonly needsOptions: boolean;
  readonly warning: boolean;
  readonly related: readonly string[];
  readonly group: string | null;
  readonly dedicated: boolean;
  readonly state: FindingState;
  readonly ruling: Ruling | null;
  readonly denial: Denial | null;
  readonly history: readonly HistoryEntry[];
  readonly questions: readonly Question[];
  readonly progress: Progress;
  readonly options: readonly RenderedOption[];
  readonly bodyHtml: string;
  readonly searchText: string;
  readonly path: string;
  readonly hash: string;
}

interface RenderContext {
  readonly index: PathIndex;
  /** Repo-relative path of the finding file. */
  readonly path: string;
  readonly hash: string;
}

function toHtml(source: string): string {
  return source.trim() === '' ? '' : markdown.parse(source, { async: false }).trim();
}

/**
 * The recommendation marker is a parse signal, not content: `recommended`
 * already carries it, so leaving it in the meta line makes every consumer
 * render markdown source. The separator it leaves behind goes with it — the
 * corpus writes a middle dot, but the option heading's own separator is a dash
 * and a meta line is free to use either dash — and a meta line that was only
 * the marker is no meta line at all.
 *
 * What comes back is markup: the audit writes effort and risk with the same
 * code spans a title carries, and a surface placing them as text shows the
 * reader the backticks. It is parsed inline, so a meta line stays the single
 * line it is written as.
 */
function metaProse(meta: string | null): string | null {
  if (meta === null) return null;
  const prose = meta
    .replaceAll(RECOMMENDED_MARKER, '')
    .replaceAll(DEDICATED_MARKER, '')
    .replace(/^[\s·•|–—-]+/u, '')
    .trim();
  return prose === '' ? null : markdown.parseInline(prose, { async: false }).trim();
}

function searchTextOf(finding: Finding): string {
  return [
    finding.id,
    finding.title,
    finding.area,
    finding.group ?? '',
    finding.status_note ?? '',
    finding.body,
    finding.ruling?.text ?? '',
    finding.ruling?.note ?? '',
    finding.denial?.reason ?? '',
    ...finding.questions.flatMap((question) => [question.text, question.answer ?? '']),
    ...finding.progress.notes.map((note) => note.text),
  ]
    .filter((part) => part !== '')
    .join('\n');
}

/**
 * Renders one finding for the console. Citations are resolved here rather than
 * in the client because this side is where the repository is, and one annotator
 * spans the whole finding so a bare line number resolves against a path named
 * anywhere earlier in it.
 */
export function renderFinding(finding: Finding, context: RenderContext): FindingJson {
  const annotate = createCitationAnnotator(context.index);
  const title = titleOf(finding.title);

  return {
    id: finding.id,
    title: title.text,
    titleHtml: title.html,
    severity: finding.severity,
    kind: finding.kind,
    status: finding.status,
    statusNote: finding.status_note,
    area: areaOf(finding.area),
    needsRuling: finding.needs_ruling,
    needsOptions: finding.needs_options,
    warning: finding.warning,
    related: finding.related,
    group: finding.group,
    dedicated: finding.dedicated,
    state: finding.state,
    ruling: finding.ruling,
    denial: finding.denial,
    history: finding.history,
    questions: finding.questions,
    progress: finding.progress,
    bodyHtml: annotate(toHtml(finding.explainer)),
    options: finding.options.map((option) => ({
      id: option.id,
      label: option.label,
      recommended: option.recommended,
      dedicated: option.dedicated,
      meta: metaProse(option.meta),
      html: annotate(toHtml(option.body)),
    })),
    searchText: searchTextOf(finding),
    path: context.path,
    hash: context.hash,
  };
}
