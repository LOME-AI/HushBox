import { namedFigures } from './panel-scope.js';
import { CEILING_REACHED } from './summed-label.js';

/** One column of an exported panel: its header and how to read it off a row. */
export interface CsvColumn<T> {
  readonly header: string;
  readonly value: (row: T) => string | number | null | undefined;
}

/**
 * Which page of an answer the rows are, where the read behind them pages.
 * Both fields decide the sentence: the file holds the whole answer only where
 * this is the first page and no page follows it.
 */
export interface CsvPage {
  /** The index the read numbered this page with, counting from zero. */
  readonly index: number;
  /** Whether the read had further pages after this one. */
  readonly hasMore: boolean;
}

/** A column a file has not got, under the name it would have carried. */
export interface CsvAbsentColumn {
  readonly header: string;
  /**
   * Why the page had no figure to write under that header, in the words the
   * page itself shows in the figure's place. The file and the screen carry one
   * reason rather than two wordings of it, which would read as two facts.
   */
  readonly reason: string;
}

/**
 * The columns a page decided against, where a file's columns come from what its
 * page could state rather than from a fixed list.
 *
 * The week is part of this rather than left out because the reasons are written
 * for a screen showing one week and speak of it as "this week". A file carrying
 * a row per week would leave that pointing at nothing, which a reader cannot
 * even see is wrong.
 */
export interface CsvAbsentColumns {
  /** The week the page's figures were read for, which their reasons speak of. */
  readonly selectedWeek: string;
  readonly columns: readonly CsvAbsentColumn[];
}

/**
 * What an exported file holds, against what the read behind it answered with
 * and against what its page could have written.
 *
 * Each fact is one the rows cannot show. A file holding one page of a longer
 * answer looks exactly like a file holding the lot; a file whose rows were
 * narrowed to a selection looks exactly like one whose read only ever had those
 * rows — a campaign filtered out leaves no trace in a file; and a figure the
 * page withheld leaves no trace either, because a column that was never written
 * looks like a figure that never existed. So the file states them above its
 * rows.
 *
 * What a file's rows are made of is not among them: that is visible in its
 * columns and differs per panel, so a shared sentence claiming it would be
 * false somewhere — the sources file writes the read's rows under a panel that
 * groups them, and the files built on the marketing read each hold one family
 * of it.
 *
 * The alternative considered was making every export cover its whole window,
 * which would need no page statement. It was rejected for a panel whose read
 * the server pages: that read computes the whole window and returns one page of
 * it, so gathering the rest costs one more run of the same query per page
 * against the reader's capped hourly operation budget, and a gather that failed
 * part way would produce an incomplete file that still had to say so.
 *
 * Every field is required, so an export cannot quietly decline to say one.
 */
export interface CsvExtent {
  /** The page these rows are, or null where the read behind them does not page. */
  readonly page: CsvPage | null;
  /** What a campaign selection did to the rows, or null where nothing narrowed them. */
  readonly campaigns: CsvCampaignNarrowing | null;
  /**
   * The columns the page could have named and did not, or null where this
   * export's columns are fixed and so cannot go missing.
   */
  readonly absentColumns: CsvAbsentColumns | null;
}

/**
 * What a campaign selection did to an export's rows, and what it left alone.
 *
 * The second half exists because a selection need not reach every figure in a
 * file: one counted over every campaign sits in the same rows as the ones the
 * selection narrowed, and the sentence above them would otherwise say of it
 * what is true only of its neighbours. A reader with no screen beside the file
 * cannot tell the two kinds of column apart from the figures.
 */
export interface CsvCampaignNarrowing {
  /** The campaigns the rows were narrowed to. */
  readonly campaigns: readonly string[];
  /**
   * The figures the selection does not reach, under the names their columns
   * carry — empty where it reaches every figure in the file.
   */
  readonly unreachedFigures: readonly string[];
}

/** An export of an unpaged read that no selection narrowed, under fixed columns. */
export const WHOLE_READ: CsvExtent = { page: null, campaigns: null, absentColumns: null };

/**
 * The campaign narrowing an export's rows carry, from the page's selection and
 * the figures in the file that selection does not reach.
 *
 * Selecting none narrows nothing, which is a different fact from selecting
 * every campaign there is, and the file must not state it as one; an unreached
 * figure under no selection is outside nothing, so it is not stated either.
 * Sorted, so two files written under one selection open with one sentence.
 *
 * Both arguments are required, so an export that carries a figure the selection
 * misses cannot quietly decline to say which.
 */
export function campaignNarrowing(
  selected: readonly string[],
  unreachedFigures: readonly string[]
): CsvCampaignNarrowing | null {
  if (selected.length === 0) return null;
  return {
    campaigns: [...selected].toSorted((one, other) => one.localeCompare(other)),
    unreachedFigures,
  };
}

/**
 * Whether pages the reader cannot see exist. A page index above the first has
 * pages before it and a read with more to give has pages after it, so a file
 * sends its reader looking only when one of those holds.
 */
function hasOtherPages(page: CsvPage): boolean {
  return page.index > 0 || page.hasMore;
}

/**
 * Where the rows sit in what the read answered.
 *
 * A page index arrives counting from zero and a reader counts from one, so the
 * translation happens here, where the sentence is written, rather than at each
 * panel handing over a page.
 */
function pagingSentence(page: CsvPage | null): string {
  if (page === null || !hasOtherPages(page)) {
    return 'the read behind this export answered in one page.';
  }
  return `the rows below are page ${String(page.index + 1)} of what the read behind this export answered; its other pages are not in this file.`;
}

/** What a campaign selection took out of the rows, or that none did. */
function narrowingSentence(narrowing: CsvCampaignNarrowing | null): string {
  if (narrowing === null) return 'No campaign selection narrowed these rows.';
  const narrowed = `A campaign selection narrowed these rows to ${narrowing.campaigns.join(', ')} when this file was written; rows for other campaigns are not in this file.`;
  if (narrowing.unreachedFigures.length === 0) return narrowed;
  return `${narrowed} That selection does not reach ${namedFigures(narrowing.unreachedFigures)}, which count every campaign.`;
}

/**
 * What a reader would look for in the columns and not find, each under the
 * reason the page gave for it.
 *
 * Silent where an export's columns are fixed, and silent again where the page
 * could name every figure it has: a file missing nothing has no absence to
 * state.
 */
function absentColumnsSentences(absent: CsvAbsentColumns | null): readonly string[] {
  if (absent === null || absent.columns.length === 0) return [];
  return [
    `The week selected when this file was written began ${absent.selectedWeek}.`,
    ...absent.columns.map((column) => `${column.header} has no column here: ${column.reason}`),
  ];
}

/**
 * The sentence an exported file opens with. Whoever opens the file later has no
 * screen beside it, so the file names itself and says what it holds.
 */
function extentLine(name: string, extent: CsvExtent): string {
  const sentences = [
    pagingSentence(extent.page),
    narrowingSentence(extent.campaigns),
    ...absentColumnsSentences(extent.absentColumns),
  ];
  return `${name}: ${sentences.join(' ')}`;
}

/**
 * The column an export writes a row's ceiling flag under. One definition rather
 * than one per panel: a file spelling the flag its own way reads as a different
 * fact from the same flag in the file beside it, and the export is the copy that
 * outlives the screen it was read from.
 */
export function ceilingReachedColumn<T extends { readonly overflow: boolean }>(): CsvColumn<T> {
  return { header: CEILING_REACHED, value: (row) => String(row.overflow) };
}

/**
 * The same column where a row carries more than one flagged figure, so the
 * header has to say which figure the flag belongs to.
 *
 * A figure whose store keeps no ceiling evidence gets no column at all rather
 * than a column of falses: written into a file that outlives the screen, a
 * false is a claim that the ceiling was not reached, which is not what an
 * absent flag says. A row the figure has no reading for writes an empty field
 * for the same reason, one level finer: an empty field says nothing, where a
 * false would say the ceiling was not reached.
 */
export function figureCeilingReachedColumn<T>(
  figure: string,
  flag: (row: T) => boolean | null
): CsvColumn<T> {
  return {
    header: `${figure}: ${CEILING_REACHED}`,
    value: (row) => {
      const reading = flag(row);
      return reading === null ? null : String(reading);
    },
  };
}

/** Fields needing quotes are the ones whose raw form would end the field or the record. */
const NEEDS_QUOTING = /[",\n\r]/;

function encodeField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (!NEEDS_QUOTING.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

/**
 * One panel's rows as CSV text. Every panel exports through this rather than
 * building its own string: a panel that hand-joined commas would corrupt the
 * first campaign label containing one, and the failure would be silent.
 *
 * The extent sentence is the first line and the header is the second, so the
 * file's table starts one line in; the sentence is left as a single field
 * rather than padded to the table's width, which would dress it as a header
 * row. Both the name and the extent are required: an export that could omit
 * its extent would be indistinguishable from one that covers everything.
 */
export function toCsv<T>({
  name,
  extent,
  columns,
  rows,
}: {
  /** Identifies the export in its own first line, as it does in its file name. */
  readonly name: string;
  readonly extent: CsvExtent;
  readonly columns: readonly CsvColumn<T>[];
  readonly rows: readonly T[];
}): string {
  const lines = [
    encodeField(extentLine(name, extent)),
    columns.map((column) => encodeField(column.header)).join(','),
  ];
  for (const row of rows) {
    lines.push(columns.map((column) => encodeField(column.value(row))).join(','));
  }
  return lines.join('\n');
}
