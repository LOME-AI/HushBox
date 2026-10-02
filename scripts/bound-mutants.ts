/**
 * The bound enumeration behind this repository's gate sweeps: every construct in
 * a source file that decides where a boundary falls, derived from the file and
 * moved one step in each direction. It is derived rather than written beside the
 * code because a hand-written list can only hold the shapes its author thought
 * of, which is the failure a sweep exists to escape.
 *
 * Comments and string contents are masked before extraction, and the masking is
 * the part that carries the accuracy: a hyphen inside a quoted word is not a
 * character-class range, and a digit inside prose is not a bound. Regular
 * expressions are the deliberate exception — a regex literal is code, and both
 * its class ranges and its quantifier bounds are boundaries.
 *
 * Regions a coverage pragma excludes from measurement are walked like any other.
 * A pragma says what is measured, never what runs, and a CLI entry point's
 * argv-borne values live behind exactly such a pragma.
 *
 * Two shapes sit outside the enumeration and neither is an oversight: a
 * non-integer literal, because the step between two of them is a choice the
 * source does not state, and a radix-prefixed literal, because its digits are
 * not a decimal bound.
 */
import { promises as fs } from 'node:fs';
import { isMainModule } from './lib/cli/is-main.js';
import { runMain } from './lib/cli/run-main.js';

export type BoundKind =
  | 'numeric-literal'
  | 'array-index'
  | 'comparison-strictness'
  | 'class-range-endpoint'
  | 'quantifier-bound'
  | 'position-predicate';

export interface BoundMutant {
  readonly kind: BoundKind;
  /** Index into the unmasked source where `original` begins. */
  readonly offset: number;
  /** 1-based, so a listing is navigable. */
  readonly line: number;
  readonly original: string;
  readonly replacement: string;
}

type MutantDraft = Omit<BoundMutant, 'line'>;

interface RegexSpan {
  readonly start: number;
  readonly end: number;
  readonly bodyStart: number;
  readonly bodyEnd: number;
}

interface Scan {
  readonly masked: string;
  readonly spans: RegexSpan[];
}

// A lone backslash: `String.raw` cannot carry one, since the escape still ends the template.
const BACKSLASH = '\\';

/** Characters after which a slash opens a regular expression rather than divides. */
const REGEX_PRECEDERS = new Set('=(,:[!&|?{};+-*%^~<>');

/** Keywords after which the same holds, where the preceding character is a letter. */
const REGEX_KEYWORDS = new Set([
  'return',
  'typeof',
  'case',
  'in',
  'of',
  'do',
  'else',
  'yield',
  'await',
]);

function lastCodeIndex(masked: string): number {
  let index = masked.length - 1;
  while (index >= 0 && /\s/.test(masked.charAt(index))) index--;
  return index;
}

function precedingWord(masked: string, end: number): string {
  let start = end;
  while (start >= 0 && /[\w$]/.test(masked.charAt(start))) start--;
  return masked.slice(start + 1, end + 1);
}

function startsRegex(masked: string): boolean {
  const index = lastCodeIndex(masked);
  if (index < 0) return true;
  const character = masked.charAt(index);
  if (REGEX_PRECEDERS.has(character)) return true;
  if (!/[A-Za-z_$]/.test(character)) return false;
  return REGEX_KEYWORDS.has(precedingWord(masked, index));
}

/**
 * Where the body of the regex literal opening at `start` ends, or null when the
 * slash opens nothing. The class state is what makes the walk correct: a slash
 * inside `[...]` is a literal slash, and a scan that stopped there would hand
 * the rest of the expression back as code.
 */
function regexBodyEnd(source: string, start: number): number | null {
  let index = start + 1;
  let inClass = false;
  while (index < source.length) {
    const character = source.charAt(index);
    if (character === BACKSLASH) index += 2;
    else if (character === '\n') return null;
    else {
      if (inClass) inClass = character !== ']';
      else if (character === '[') inClass = true;
      else if (character === '/') return index;
      index++;
    }
  }
  return null;
}

function regexSpanAt(source: string, start: number): RegexSpan | null {
  const bodyEnd = regexBodyEnd(source, start);
  if (bodyEnd === null) return null;
  let index = bodyEnd + 1;
  while (index < source.length && /[a-z]/.test(source.charAt(index))) index++;
  return { start, end: index, bodyStart: start + 1, bodyEnd };
}

interface Cursor {
  readonly source: string;
  out: string;
  readonly spans: RegexSpan[];
  index: number;
}

function blank(cursor: Cursor, count: number): void {
  for (let step = 0; step < count && cursor.index < cursor.source.length; step++, cursor.index++) {
    cursor.out += cursor.source.charAt(cursor.index) === '\n' ? '\n' : ' ';
  }
}

function keep(cursor: Cursor, count: number): void {
  const end = Math.min(cursor.index + count, cursor.source.length);
  cursor.out += cursor.source.slice(cursor.index, end);
  cursor.index = end;
}

function skipComment(cursor: Cursor): boolean {
  const opener = cursor.source.slice(cursor.index, cursor.index + 2);
  if (opener === '//') {
    const newline = cursor.source.indexOf('\n', cursor.index);
    blank(cursor, (newline === -1 ? cursor.source.length : newline) - cursor.index);
    return true;
  }
  if (opener !== '/*') return false;
  const close = cursor.source.indexOf('*/', cursor.index + 2);
  blank(cursor, (close === -1 ? cursor.source.length : close + 2) - cursor.index);
  return true;
}

function skipString(cursor: Cursor): boolean {
  const quote = cursor.source.charAt(cursor.index);
  if (quote !== "'" && quote !== '"') return false;
  keep(cursor, 1);
  while (cursor.index < cursor.source.length) {
    const character = cursor.source.charAt(cursor.index);
    if (character === quote || character === '\n') break;
    blank(cursor, character === BACKSLASH ? 2 : 1);
  }
  if (cursor.source.charAt(cursor.index) === quote) keep(cursor, 1);
  return true;
}

function skipRegex(cursor: Cursor): boolean {
  if (cursor.source.charAt(cursor.index) !== '/' || !startsRegex(cursor.out)) return false;
  const span = regexSpanAt(cursor.source, cursor.index);
  if (span === null) return false;
  cursor.spans.push(span);
  keep(cursor, span.end - span.start);
  return true;
}

const braceDelta = (character: string): number => {
  if (character === '{') return 1;
  return character === '}' ? -1 : 0;
};

const closesInterpolation = (cursor: Cursor, nested: boolean, depth: number): boolean =>
  nested && depth === 0 && cursor.source.charAt(cursor.index) === '}';

/**
 * A template literal's text is blanked while the code inside its `${}` holes is
 * scanned as code: an interpolation is where a bound routinely sits, and
 * blanking the whole template would drop it.
 */
function scanTemplate(cursor: Cursor): void {
  keep(cursor, 1);
  while (cursor.index < cursor.source.length) {
    const character = cursor.source.charAt(cursor.index);
    if (character === '`') {
      keep(cursor, 1);
      return;
    }
    if (character === BACKSLASH) blank(cursor, 2);
    else if (character === '$' && cursor.source.charAt(cursor.index + 1) === '{') {
      keep(cursor, 2);
      scanCode(cursor, true);
    } else blank(cursor, 1);
  }
}

/** Nested means the scan stops at the brace closing the interpolation it opened in. */
function scanCode(cursor: Cursor, nested: boolean): void {
  let depth = 0;
  while (cursor.index < cursor.source.length) {
    if (closesInterpolation(cursor, nested, depth)) {
      keep(cursor, 1);
      return;
    }
    if (skipComment(cursor) || skipString(cursor) || skipRegex(cursor)) continue;
    if (cursor.source.charAt(cursor.index) === '`') scanTemplate(cursor);
    else {
      depth += braceDelta(cursor.source.charAt(cursor.index));
      keep(cursor, 1);
    }
  }
}

/**
 * The source with everything that is not code blanked to spaces, at the same
 * offsets and over the same lines, plus the regex literals found on the way.
 */
function scanSource(source: string): Scan {
  const cursor: Cursor = { source, out: '', spans: [], index: 0 };
  scanCode(cursor, false);
  return { masked: cursor.out, spans: cursor.spans };
}

export function maskNonCode(source: string): string {
  return scanSource(source).masked;
}

const insideSpan = (spans: readonly RegexSpan[], offset: number): boolean =>
  spans.some((span) => offset >= span.start && offset < span.end);

const NUMBER = /(?<![\w$.])\d[\d_]*(?![\w$.])/g;
const COMPARISON = /(?<=\s)(?:<=|>=|<|>)(?=\s)/g;
const PREDICATE = /\.(?:startsWith|includes|endsWith)\(/g;

/** Widest first: the rungs a position predicate can be moved between. */
const PREDICATE_LADDER = ['.startsWith(', '.includes(', '.endsWith('];

/** Inclusive becomes exclusive and back: the boundary moves by one either way. */
const flipStrictness = (operator: string): string =>
  operator.endsWith('=') ? operator.slice(0, 1) : `${operator}=`;

function numericDrafts(masked: string, spans: readonly RegexSpan[]): MutantDraft[] {
  const drafts: MutantDraft[] = [];
  for (const match of masked.matchAll(NUMBER)) {
    const offset = match.index;
    const original = match[0];
    const value = Number(original.replaceAll('_', ''));
    if (insideSpan(spans, offset) || !Number.isSafeInteger(value)) continue;
    const kind =
      masked.charAt(offset - 1) === '[' && masked.charAt(offset + original.length) === ']'
        ? 'array-index'
        : 'numeric-literal';
    drafts.push(
      { kind, offset, original, replacement: String(value - 1) },
      { kind, offset, original, replacement: String(value + 1) }
    );
  }
  return drafts;
}

function comparisonDrafts(masked: string, spans: readonly RegexSpan[]): MutantDraft[] {
  const drafts: MutantDraft[] = [];
  for (const match of masked.matchAll(COMPARISON)) {
    if (insideSpan(spans, match.index)) continue;
    drafts.push({
      kind: 'comparison-strictness',
      offset: match.index,
      original: match[0],
      replacement: flipStrictness(match[0]),
    });
  }
  return drafts;
}

function predicateDrafts(masked: string, spans: readonly RegexSpan[]): MutantDraft[] {
  const drafts: MutantDraft[] = [];
  for (const match of masked.matchAll(PREDICATE)) {
    if (insideSpan(spans, match.index)) continue;
    for (const rung of PREDICATE_LADDER) {
      if (rung !== match[0]) {
        drafts.push({
          kind: 'position-predicate',
          offset: match.index,
          original: match[0],
          replacement: rung,
        });
      }
    }
  }
  return drafts;
}

interface ClassToken {
  readonly offset: number;
  readonly text: string;
}

/** Total by construction: an absent code point becomes NaN rather than a branch. */
const codePointOf = (text: string, at: number): number => Number(text.codePointAt(at));

/**
 * The code point a class token stands for, or null when it stands for a set
 * rather than a character: `\s` has no neighbour to step to, while `\-` does.
 */
function endpointCodePoint(token: string): number | null {
  if (token.length === 1) return codePointOf(token, 0);
  return /[A-Za-z]/.test(token.charAt(1)) ? null : codePointOf(token, 1);
}

const CLASS_SPECIALS = String.raw`\]^-[`;

function renderEndpoint(codePoint: number): string {
  const character = String.fromCodePoint(codePoint);
  if (codePoint < 0x20 || codePoint > 0x7e) {
    return `${BACKSLASH}u${codePoint.toString(16).padStart(4, '0')}`;
  }
  return CLASS_SPECIALS.includes(character) ? `${BACKSLASH}${character}` : character;
}

/** Takes a one-or-zero element slice, so an absent neighbour needs no optional access. */
const endpointDrafts = (tokens: readonly ClassToken[]): MutantDraft[] =>
  tokens.flatMap((token) => {
    const codePoint = endpointCodePoint(token.text);
    if (codePoint === null) return [];
    return [codePoint - 1, codePoint + 1].map((moved) => ({
      kind: 'class-range-endpoint' as const,
      offset: token.offset,
      original: token.text,
      replacement: renderEndpoint(moved),
    }));
  });

/** A hyphen is a range only with a token on each side; at either end it is literal. */
function rangeDrafts(tokens: readonly ClassToken[]): MutantDraft[] {
  const drafts: MutantDraft[] = [];
  for (const [index, token] of tokens.entries()) {
    if (token.text !== '-' || index === 0 || index + 1 === tokens.length) continue;
    drafts.push(
      ...endpointDrafts(tokens.slice(index - 1, index)),
      ...endpointDrafts(tokens.slice(index + 1, index + 2))
    );
  }
  return drafts;
}

/** The tokens of each `[...]` group in a regex body, group by group. */
function classGroups(source: string, span: RegexSpan): ClassToken[][] {
  const groups: ClassToken[][] = [];
  let tokens: ClassToken[] | null = null;
  let index = span.bodyStart;
  while (index < span.bodyEnd) {
    const character = source.charAt(index);
    const width = character === BACKSLASH ? 2 : 1;
    if (tokens === null) tokens = character === '[' ? [] : null;
    else if (character === ']') {
      groups.push(tokens);
      tokens = null;
    } else tokens.push({ offset: index, text: source.slice(index, index + width) });
    index += width;
  }
  return groups;
}

const QUANTIFIER = /^\{\d+(?:,\d*)?\}/;

function boundDrafts(offset: number, original: string): MutantDraft[] {
  const value = Number(original);
  const moved = value > 0 ? [value - 1, value + 1] : [value + 1];
  return moved.map((next) => ({
    kind: 'quantifier-bound' as const,
    offset,
    original,
    replacement: String(next),
  }));
}

/** `{n}`, `{n,}` and `{n,m}` alike: each number present is a bound of its own. */
function quantifierDrafts(offset: number, text: string): MutantDraft[] {
  const drafts: MutantDraft[] = [];
  let at = offset + 1;
  for (const part of text.slice(1, -1).split(',')) {
    if (part !== '') drafts.push(...boundDrafts(at, part));
    at += part.length + 1;
  }
  return drafts;
}

function quantifierAt(
  source: string,
  span: RegexSpan,
  index: number,
  inClass: boolean
): string | null {
  if (inClass || source.charAt(index) !== '{') return null;
  const match = QUANTIFIER.exec(source.slice(index, span.bodyEnd));
  return match === null ? null : match[0];
}

const nextClassState = (inClass: boolean, character: string): boolean =>
  inClass ? character !== ']' : character === '[';

/** Braces are quantifiers only outside a character class, where they are literal. */
function quantifierSites(source: string, span: RegexSpan): MutantDraft[] {
  const drafts: MutantDraft[] = [];
  let inClass = false;
  let index = span.bodyStart;
  while (index < span.bodyEnd) {
    const character = source.charAt(index);
    if (character === BACKSLASH) {
      index += 2;
      continue;
    }
    const text = quantifierAt(source, span, index, inClass);
    if (text === null) {
      inClass = nextClassState(inClass, character);
      index++;
      continue;
    }
    drafts.push(...quantifierDrafts(index, text));
    index += text.length;
  }
  return drafts;
}

const lineAt = (source: string, offset: number): number =>
  source.slice(0, offset).split('\n').length;

export function enumerateBoundMutants(source: string): BoundMutant[] {
  const { masked, spans } = scanSource(source);
  const drafts = [
    ...numericDrafts(masked, spans),
    ...comparisonDrafts(masked, spans),
    ...predicateDrafts(masked, spans),
    ...spans.flatMap((span) => [
      ...classGroups(source, span).flatMap((tokens) => rangeDrafts(tokens)),
      ...quantifierSites(source, span),
    ]),
  ];
  return drafts
    .map((draft) => ({ ...draft, line: lineAt(source, draft.offset) }))
    .toSorted((left, right) => left.offset - right.offset);
}

export function applyBoundMutant(source: string, mutant: BoundMutant): string {
  return (
    source.slice(0, mutant.offset) +
    mutant.replacement +
    source.slice(mutant.offset + mutant.original.length)
  );
}

export function formatBoundMutants(path: string, mutants: readonly BoundMutant[]): string {
  if (mutants.length === 0) return `${path}: no bound-bearing construct`;
  return mutants
    .map(
      (mutant) =>
        `${path}:${String(mutant.line)} ${mutant.kind} ${mutant.original} -> ${mutant.replacement}`
    )
    .join('\n');
}

/* v8 ignore start -- CLI entry point, exercised through the sweep runner */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    const paths = process.argv.slice(2);
    if (paths.length === 0) throw new Error('Usage: bound-mutants.ts <file>...');
    for (const path of paths) {
      console.log(formatBoundMutants(path, enumerateBoundMutants(await fs.readFile(path, 'utf8'))));
    }
    return 0;
  });
}
/* v8 ignore stop */
