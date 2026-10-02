import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  createCitationAnnotator,
  indexRepositoryFiles,
  NOT_IN_TREE,
  readCitationText,
} from './citations.ts';
import { renderFinding } from './render.ts';
import { CITATION_ATTRIBUTES } from './types.ts';
import type { CitationText, PathIndex } from './citations.ts';
import type { LoadedFinding } from './store.ts';
import type { FindingState } from './types.ts';

/**
 * Why the console cannot take a reader to the code a citation names.
 *
 * `unresolved-path` is every refusal of a written path: an ending owned by no
 * file or by several, and a path escaping the repository root. The console
 * refuses all of them identically and for the same reason — it will not guess —
 * so splitting them here would mean a second copy of the resolution rules.
 */
export type DeadCitationReason =
  | 'past-end-of-file'
  | 'missing-file'
  | 'relocated'
  | 'unresolved-path'
  | 'bare-without-antecedent'
  | 'invalid-range';

/** Where in a finding a citation was written. */
export type CitationZone = 'explainer' | 'option' | 'title';

export interface DeadCitation {
  readonly findingId: string;
  readonly state: FindingState;
  readonly zone: CitationZone;
  /** The option holding it, null in every other zone. */
  readonly optionId: string | null;
  /** Whether the console renders it as something a reader can activate. */
  readonly clickable: boolean;
  /** The citation exactly as the finding writes it. */
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly reason: DeadCitationReason;
  /** The file the console resolved it to, null where it resolved none. */
  readonly resolvedPath: string | null;
  /** That file's real line count, null unless the range ran past its end. */
  readonly fileLines: number | null;
}

export interface CensusTotals {
  /** Every citation-shaped code span in scope, dead or not. */
  readonly citations: number;
  readonly dead: number;
  /** Findings holding at least one dead citation. */
  readonly findings: number;
}

export interface CitationCensus {
  readonly dead: readonly DeadCitation[];
  /** Every zone, finding titles included: what the reader can see. */
  readonly all: CensusTotals;
  /** Explainer and option bodies: what the console makes clickable. */
  readonly clickable: CensusTotals;
  /** Over every zone; the rows carry `clickable` for a narrower tally. */
  readonly byReason: Readonly<Record<DeadCitationReason, number>>;
}

interface CensusInput {
  /**
   * The working tree the console resolves against — the repository root. A
   * census is a reading of the tree as it stands, so an edit to any cited file
   * can change the answer.
   */
  readonly root: string;
  readonly findings: readonly LoadedFinding[];
  /** Restrict to these states; every state when omitted. */
  readonly states?: readonly FindingState[];
}

/**
 * Every `<code>` span, annotated or not, with the note the annotator puts after
 * a span it refused to serve. The attributes and that note are what say which
 * span is which. Fenced blocks need no special case, because marked ends a
 * block's code text with a newline and the citation shape is anchored.
 */
const SPAN = new RegExp(
  String.raw`<code(\s[^>]*)?>([^<]*)</code>` +
    `(?: <span ${CITATION_ATTRIBUTES.note}="">([^<]*)</span>)?`,
  'g'
);
const SERVED_PATH = new RegExp(`${CITATION_ATTRIBUTES.path}="([^"]*)"`);

/**
 * The lines a file really has. `split('\n')` counts the empty string after a
 * file's final newline as a line, which reads every newline-terminated file as
 * one line longer than it is and so hides a citation ending one past its end.
 */
export function countLines(text: string): number {
  if (text === '') return 0;
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n').length;
}

interface Span {
  readonly text: string;
  readonly citation: CitationText;
  /** The path the console served it as, null where it served nothing. */
  readonly servedPath: string | null;
  /** The note the console shows beside a span it refused to serve, else null. */
  readonly note: string | null;
}

function spansOf(html: string): readonly Span[] {
  const spans: Span[] = [];
  for (const match of html.matchAll(SPAN)) {
    const [, attributes = '', text = '', note] = match;
    const citation = readCitationText(text);
    if (citation === null) continue;
    spans.push({
      text,
      citation,
      servedPath: SERVED_PATH.exec(attributes)?.[1] ?? null,
      note: note ?? null,
    });
  }
  return spans;
}

interface Zone {
  readonly zone: CitationZone;
  readonly optionId: string | null;
  readonly clickable: boolean;
  readonly spans: readonly Span[];
}

/**
 * The console renders a finding's explainer and options through one annotator,
 * so a path named in the explainer is still the antecedent of a bare `:610` in
 * an option. A title is rendered on its own and never annotated at all: it is
 * shown to the reader but is not a control, so it reads against its own text
 * alone and neither gives nor takes an antecedent from the body.
 */
function zonesOf(loaded: LoadedFinding, index: PathIndex): readonly Zone[] {
  const rendered = renderFinding(loaded.finding, {
    index,
    path: loaded.path,
    hash: loaded.hash,
  });
  const annotateTitle = createCitationAnnotator(index);

  return [
    { zone: 'explainer', optionId: null, clickable: true, spans: spansOf(rendered.bodyHtml) },
    ...rendered.options.map((option) => ({
      zone: 'option' as const,
      optionId: option.id,
      clickable: true,
      spans: spansOf(option.html),
    })),
    {
      zone: 'title',
      optionId: null,
      clickable: false,
      spans: spansOf(annotateTitle(rendered.titleHtml)),
    },
  ];
}

interface Reading {
  readonly loaded: LoadedFinding;
  readonly zone: Zone;
  readonly span: Span;
}

function readingsOf(findings: readonly LoadedFinding[], index: PathIndex): readonly Reading[] {
  return findings.flatMap((loaded) =>
    zonesOf(loaded, index).flatMap((zone) => zone.spans.map((span) => ({ loaded, zone, span })))
  );
}

async function lineCounts(
  root: string,
  readings: readonly Reading[]
): Promise<Map<string, number>> {
  const served = new Set(
    readings
      .map((reading) => reading.span.servedPath)
      .filter((servedPath): servedPath is string => servedPath !== null)
  );
  const counts = new Map<string, number>();
  await Promise.all(
    [...served].map(async (relative) => {
      counts.set(relative, countLines(await fs.readFile(path.join(root, relative), 'utf8')));
    })
  );
  return counts;
}

function refusalOf(span: Span): DeadCitationReason {
  if (span.note !== null) return span.note === NOT_IN_TREE ? 'missing-file' : 'relocated';
  if (span.citation.path === '') return 'bare-without-antecedent';
  if (span.citation.start < 1 || span.citation.end < span.citation.start) return 'invalid-range';
  return 'unresolved-path';
}

interface Verdict {
  readonly reason: DeadCitationReason;
  readonly fileLines: number | null;
}

/**
 * `fileLines` is the count of the file the console served the span as, so it is
 * present for exactly the served spans and absent for every refused one.
 */
function verdictFor(span: Span, fileLines: number | undefined): Verdict | null {
  if (fileLines !== undefined) {
    return span.citation.end > fileLines ? { reason: 'past-end-of-file', fileLines } : null;
  }
  return { reason: refusalOf(span), fileLines: null };
}

function deadOf(reading: Reading, lines: ReadonlyMap<string, number>): DeadCitation | null {
  const { span, zone, loaded } = reading;
  const verdict = verdictFor(
    span,
    span.servedPath === null ? undefined : lines.get(span.servedPath)
  );
  if (verdict === null) return null;

  return {
    findingId: loaded.finding.id,
    state: loaded.finding.state,
    zone: zone.zone,
    optionId: zone.optionId,
    clickable: zone.clickable,
    text: span.text,
    start: span.citation.start,
    end: span.citation.end,
    reason: verdict.reason,
    resolvedPath: span.servedPath,
    fileLines: verdict.fileLines,
  };
}

function totalsOf(readings: readonly Reading[], dead: readonly DeadCitation[]): CensusTotals {
  return {
    citations: readings.length,
    dead: dead.length,
    findings: new Set(dead.map((entry) => entry.findingId)).size,
  };
}

function tally(dead: readonly DeadCitation[]): Record<DeadCitationReason, number> {
  const counts: Record<DeadCitationReason, number> = {
    'past-end-of-file': 0,
    'missing-file': 0,
    relocated: 0,
    'unresolved-path': 0,
    'bare-without-antecedent': 0,
    'invalid-range': 0,
  };
  for (const entry of dead) counts[entry.reason] += 1;
  return counts;
}

/**
 * Counts the citations the console cannot take a reader to, over the same
 * resolution the console itself runs: the findings are rendered, and the census
 * reads the markup that rendering leaves behind rather than resolving anything
 * a second way.
 */
export async function censusCitations(input: CensusInput): Promise<CitationCensus> {
  const states = input.states;
  const scoped =
    states === undefined
      ? input.findings
      : input.findings.filter((loaded) => states.includes(loaded.finding.state));

  const index = await indexRepositoryFiles(input.root);
  const readings = readingsOf(scoped, index);
  const lines = await lineCounts(input.root, readings);

  const dead = readings
    .map((reading) => deadOf(reading, lines))
    .filter((entry): entry is DeadCitation => entry !== null);
  const clickable = readings.filter((reading) => reading.zone.clickable);

  return {
    dead,
    all: totalsOf(readings, dead),
    clickable: totalsOf(
      clickable,
      dead.filter((entry) => entry.clickable)
    ),
    byReason: tally(dead),
  };
}
