import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CITATION_ATTRIBUTES, citationLabel } from './types.ts';

export interface PathIndex {
  readonly paths: ReadonlySet<string>;
  /** Every repo-relative path sharing a basename; a basename with two owners resolves to nothing. */
  readonly byBasename: ReadonlyMap<string, readonly string[]>;
  /** Top-level directory names, which is what tells a repo-rooted citation from a shorthand. */
  readonly roots: ReadonlySet<string>;
}

interface Citation {
  readonly path: string;
  readonly start: number;
  readonly end: number;
}

/** Directories a citation never points into, skipped so the walk stays cheap. */
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.turbo',
  '.wrangler',
  'build',
  'coverage',
  'dist',
  'node_modules',
]);

// Code spans only. Fenced blocks are `<pre><code`, and their content is sample
// code rather than evidence, so they are cut out before any span is considered.
const CODE_SPAN = /<code>([^<]*)<\/code>/g;
const FENCED_BLOCK = /<pre\b[\s\S]*?<\/pre>/g;
// `$` is in the path charset because the router names its route files for the
// parameters they bind — `share.c.$conversationId.tsx` — so leaving it out makes
// every route file in the repository permanently uncitable.
const CITATION = /^([A-Za-z0-9$._/-]*):(\d+)(?:-(\d+))?(?:,[\d,-]+)?$/;

/** What a code span spells, before any of it is resolved against the tree. */
export interface CitationText {
  /** As written, so empty for a bare `:610`. */
  readonly path: string;
  readonly start: number;
  readonly end: number;
}

/**
 * The citation a code span's text spells, or null where the text is prose. A
 * trailing `,20-25` is part of the shape but not of the range: only the first
 * range is ever served, so only the first range is read.
 */
export function readCitationText(text: string): CitationText | null {
  const match = CITATION.exec(text);
  if (match === null) return null;

  const [, cited = '', rawStart = '', rawEnd] = match;
  const start = Number(rawStart);
  return { path: cited, start, end: rawEnd === undefined ? start : Number(rawEnd) };
}

export function buildPathIndex(files: Iterable<string>): PathIndex {
  const paths = new Set<string>();
  const byBasename = new Map<string, string[]>();
  const roots = new Set<string>();
  for (const file of files) {
    paths.add(file);
    const base = path.posix.basename(file);
    const owners = byBasename.get(base);
    if (owners === undefined) byBasename.set(base, [file]);
    else owners.push(file);
    const [top = ''] = file.split('/');
    if (top !== file) roots.add(top);
  }
  return { paths, byBasename, roots };
}

async function walk(root: string, relative: string, found: string[]): Promise<void> {
  const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
  for (const entry of entries) {
    const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) await walk(root, child, found);
    } else if (entry.isFile()) found.push(child);
  }
}

export async function indexRepositoryFiles(root: string): Promise<PathIndex> {
  const found: string[] = [];
  await walk(root, '', found);
  return buildPathIndex(found);
}

function isContained(candidate: string): boolean {
  if (candidate.startsWith('/')) return false;
  const normalized = path.posix.normalize(candidate);
  return normalized !== '..' && !normalized.startsWith('../');
}

/**
 * What the console is willing to say about one cited path: serve it, name the
 * file that took its place, or say nothing at all.
 */
type PathVerdict =
  | { readonly kind: 'cite'; readonly path: string }
  | { readonly kind: 'relocated'; readonly to: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'refused' };

const MISSING = { kind: 'missing' } as const;

const REFUSED = { kind: 'refused' } as const;

/**
 * Whether a file is the one an ending names: a path ends at a segment boundary
 * or not at all, so `src/mylib/init-script.ts` is not what `lib/init-script.ts`
 * points at. Both rules below ask it of the same candidates, and it lives here
 * rather than in each because a second copy can be weakened on its own.
 */
function endsAtSegment(owner: string, ending: string): boolean {
  return owner === ending || owner.endsWith(`/${ending}`);
}

/**
 * The files that survive a cited path, matched on the deepest ending of it any
 * file has: a path that lost or gained a directory somewhere in its middle
 * still finds itself, and the ending is what keeps the answer specific, where a
 * basename like `routes.ts` is shared by every slice in the repository.
 */
function survivorsOf(raw: string, index: PathIndex): readonly string[] {
  const owners = index.byBasename.get(path.posix.basename(raw)) ?? [];
  const segments = raw.split('/');
  for (let cut = 0; cut < segments.length; cut += 1) {
    const ending = segments.slice(cut).join('/');
    const matches = owners.filter((owner) => endsAtSegment(owner, ending));
    if (matches.length > 0) return matches;
  }
  return [];
}

/**
 * What an empty location means, of which only the first answer is a deletion:
 * nothing of that shape anywhere is gone and is said to be gone, never served,
 * because a citation the console cannot open has to stop looking like one that
 * it can; exactly one survivor is a move, said as a note rather than as a peek,
 * because a file that moved has usually also changed and its old line numbers
 * cannot be trusted against its new text; several survivors are a question the
 * console cannot answer, so it says nothing at all.
 */
function verdictForEmptyLocation(raw: string, index: PathIndex): PathVerdict {
  const [only, ...rest] = survivorsOf(raw, index);
  if (only === undefined) return MISSING;
  return rest.length === 0 ? { kind: 'relocated', to: only } : REFUSED;
}

/**
 * A shorthand claims no location, only an ending, so it resolves to the single
 * file that ends with it and to nothing otherwise: annotating an unresolved
 * citation makes the peek report a deletion that never happened, and the reader
 * has no way to tell that claim from a true one.
 */
function verdictForEnding(raw: string, index: PathIndex): PathVerdict {
  const owners = index.byBasename.get(path.posix.basename(raw)) ?? [];
  const [only, ...rest] = owners.filter((owner) => endsAtSegment(owner, raw));
  return only !== undefined && rest.length === 0 ? { kind: 'cite', path: only } : REFUSED;
}

/**
 * A citation either starts at the repository root, and is then a claim about a
 * location the console can check, or is a shorthand ending of a path that does.
 */
function resolvePath(raw: string, index: PathIndex, lastPath: string | null): PathVerdict {
  if (raw === '') return lastPath === null ? REFUSED : { kind: 'cite', path: lastPath };
  if (!isContained(raw)) return REFUSED;

  const [top = ''] = raw.split('/');
  if (top === raw || !index.roots.has(top)) return verdictForEnding(raw, index);
  return index.paths.has(raw) ? { kind: 'cite', path: raw } : verdictForEmptyLocation(raw, index);
}

/**
 * What one code span is. `prose` and `refused` both stay plain text and differ
 * only in what they leave behind: a span that never was a citation cannot break
 * the chain a bare `:610` reads from, and a citation the console would not
 * resolve has to break it, or the bare line after it silently attaches to some
 * earlier path and reads as a resolution of the one refused.
 */
type SpanVerdict =
  | { readonly kind: 'citation'; readonly citation: Citation }
  | { readonly kind: 'relocated'; readonly to: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'refused' }
  | { readonly kind: 'prose' };

/**
 * The whole span has to be the citation: a span mixing prose with a reference
 * would need the annotation to wrap part of its text, and no finding writes one.
 */
function readSpan(text: string, index: PathIndex, lastPath: string | null): SpanVerdict {
  const cited = readCitationText(text);
  if (cited === null) return { kind: 'prose' };
  if (cited.start < 1 || cited.end < cited.start) return REFUSED;

  const verdict = resolvePath(cited.path, index, lastPath);
  if (verdict.kind !== 'cite') return verdict;
  return { kind: 'citation', citation: { path: verdict.path, start: cited.start, end: cited.end } };
}

/**
 * Activating a citation writes to the clipboard, so it is marked up as the
 * control it is: without the role a screen reader announces a code span and
 * gives no reason to press anything. The name carries the resolved path, which
 * a bare `:610` does not show but does copy. Neither the path charset nor the
 * line numbers can produce a quote, so the attribute needs no escaping.
 */
function annotateSpan(text: string, citation: Citation): string {
  const attributes = [
    `${CITATION_ATTRIBUTES.path}="${citation.path}"`,
    `${CITATION_ATTRIBUTES.start}="${String(citation.start)}"`,
    `${CITATION_ATTRIBUTES.end}="${String(citation.end)}"`,
    'role="button"',
    `aria-label="Copy ${citationLabel(citation)}"`,
  ].join(' ');
  return `<code ${attributes}>${text}</code>`;
}

/** A relocated span extends this note; a missing one carries it alone. */
export const NOT_IN_TREE = 'This path is not in the working tree.';

/**
 * A citation the console will not serve: marked as dead where a served one
 * carries the peek attributes, and followed by the sentence saying why.
 *
 * The sentence is a text node rather than a `title`, because a `title` reaches
 * a pointer and nothing else. The dead span is deliberately not a tab stop and
 * carries no role: there is nothing to activate, and putting the reason in the
 * reading order is what makes it reach a screen reader and a keyboard reader
 * without one.
 */
function notedSpan(text: string, note: string): string {
  return `<code ${CITATION_ATTRIBUTES.dead}="">${text}</code> <span ${CITATION_ATTRIBUTES.note}="">${note}</span>`;
}

/**
 * A cited path with no file at it and nothing of its shape anywhere. Serving it
 * is what this refuses: a served span is visually indistinguishable from one
 * whose file is there, so the reader learns it is dead only by interacting with
 * it, and activating it copies a pointer that resolves to nothing.
 */
function missingSpan(text: string): string {
  return notedSpan(text, NOT_IN_TREE);
}

/**
 * The one file a moved citation could mean, said as a note rather than as a
 * peek. Unlike a cited path, this one comes off the filesystem rather than
 * through the citation pattern, so nothing upstream bounds its characters to
 * ones html text can hold.
 */
function relocatedSpan(text: string, to: string): string {
  const named = to.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return notedSpan(text, `${NOT_IN_TREE} The only file matching its ending is ${named}.`);
}

function annotateSegment(
  html: string,
  index: PathIndex,
  state: { lastPath: string | null }
): string {
  return html.replaceAll(CODE_SPAN, (span, text: string) => {
    const verdict = readSpan(text, index, state.lastPath);
    if (verdict.kind === 'citation') {
      state.lastPath = verdict.citation.path;
      return annotateSpan(text, verdict.citation);
    }
    if (verdict.kind === 'prose') return span;
    state.lastPath = null;
    if (verdict.kind === 'relocated') return relocatedSpan(text, verdict.to);
    return verdict.kind === 'missing' ? missingSpan(text) : span;
  });
}

/**
 * An annotator carrying its resolution state across calls, because a bare
 * `:610` means the last path named earlier in the *same finding* and a finding
 * renders as several html fragments.
 */
export function createCitationAnnotator(index: PathIndex): (html: string) => string {
  const state = { lastPath: null as string | null };

  return (html) => {
    const blocks = [...html.matchAll(FENCED_BLOCK)];
    let cursor = 0;
    let out = '';
    for (const block of blocks) {
      out += annotateSegment(html.slice(cursor, block.index), index, state);
      out += block[0];
      cursor = block.index + block[0].length;
    }
    return out + annotateSegment(html.slice(cursor), index, state);
  };
}
