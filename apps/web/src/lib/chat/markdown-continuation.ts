/**
 * Markdown continuity across a block that interrupts assistant text, such as a
 * search row. The row sits where the search happened, which can be inside a
 * code block, a table or a numbered list, and each side then renders as its own
 * markdown document. This closes the block the text before the row left open
 * and reopens it at the start of the text after, for rendering only: the raw
 * text is never altered, so nothing sent back to a model changes.
 */

export interface ContinuedText {
  readonly before: string;
  readonly after: string;
}

interface OpenFence {
  readonly marker: string;
  readonly openingLine: string;
}

interface OpenTable {
  readonly header: string;
  readonly delimiter: string;
}

interface OpenList {
  readonly delimiter: string;
  readonly start: number;
  readonly count: number;
  /** A blank line followed the list's last line, so unindented text would end it. */
  readonly afterBlank: boolean;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const TABLE_DELIMITER_CELL = /^[ \t]*:?-+:?[ \t]*$/;
const TABLE_ROW_START = /^ {0,3}\|/;
const ORDERED_ITEM = /^( {0,3})(\d{1,9})([.)])(?=[ \t]|$)/;
const OTHER_BLOCK_START = /^ {0,3}([-*+>#|]|`{3}|~{3})/;

function linesOf(text: string): string[] {
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
}

/** A capture group the pattern always fills, so the fallback never applies. */
function group(match: RegExpExecArray, index: number): string {
  /* v8 ignore next -- every group read here is outside any optional part of its pattern, so it always participates */
  return match[index] ?? '';
}

function withoutOneLeadingNewline(text: string): string {
  return text.startsWith('\n') ? text.slice(1) : text;
}

function fenceOpening(line: string): OpenFence | undefined {
  const opening = FENCE_OPEN.exec(line);
  if (opening === null) return undefined;
  const marker = group(opening, 1);
  // A backtick fence's info string cannot hold a backtick.
  if (marker.startsWith('`') && group(opening, 2).includes('`')) return undefined;
  return { marker, openingLine: line.trimStart() };
}

function closesFence(line: string, open: OpenFence): boolean {
  const closing = FENCE_CLOSE.exec(line);
  if (closing === null) return false;
  const marker = group(closing, 1);
  return marker.startsWith(open.marker.charAt(0)) && marker.length >= open.marker.length;
}

function openFenceAtEnd(text: string): OpenFence | undefined {
  let open: OpenFence | undefined;
  for (const line of text.split('\n')) {
    if (open === undefined) open = fenceOpening(line);
    else if (closesFence(line, open)) open = undefined;
  }
  return open;
}

/** A table's delimiter row: pipe-separated cells of dashes, each optionally colon-aligned. */
function isTableDelimiterRow(line: string): boolean {
  if (!line.includes('|') || line.startsWith('    ')) return false;
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
  return cells.every((cell) => TABLE_DELIMITER_CELL.test(cell));
}

/**
 * The table the text ends inside: a header row and a delimiter row in the
 * text's last block. Every later line of that block is a row of the same table,
 * since a table runs until a blank line.
 */
function openTableAtEnd(text: string): OpenTable | undefined {
  const lines = linesOf(text);
  const block = lines.slice(lines.findLastIndex((line) => line.trim() === '') + 1);
  let header: string | undefined;
  for (const line of block) {
    if (header?.includes('|') && isTableDelimiterRow(line)) return { header, delimiter: line };
    header = line;
  }
  return undefined;
}

function isIndented(line: string): boolean {
  return line.startsWith(' ') || line.startsWith('\t');
}

function withItem(list: OpenList | undefined, item: RegExpExecArray): OpenList {
  const delimiter = group(item, 3);
  if (list?.delimiter === delimiter) return { ...list, count: list.count + 1, afterBlank: false };
  return { delimiter, start: Number(group(item, 2)), count: 1, afterBlank: false };
}

/** The list still open after one more line, following CommonMark's continuation rules. */
function afterLine(list: OpenList | undefined, line: string): OpenList | undefined {
  const item = ORDERED_ITEM.exec(line);
  if (item !== null) return withItem(list, item);
  if (list === undefined) return undefined;
  if (line.trim() === '') return { ...list, afterBlank: true };
  if (isIndented(line)) return { ...list, afterBlank: false };
  // Unindented text continues an item lazily unless a blank line or another block came first.
  return list.afterBlank || OTHER_BLOCK_START.test(line) ? undefined : list;
}

/** The ordered list the text ends inside, if any. */
function openListAtEnd(text: string): OpenList | undefined {
  let list: OpenList | undefined;
  for (const line of linesOf(text)) list = afterLine(list, line);
  return list;
}

function resumedList(after: string, list: OpenList): string | undefined {
  const trimmed = after.replace(/^\n+/, '');
  const item = ORDERED_ITEM.exec(trimmed);
  if (item === null || group(item, 3) !== list.delimiter) return undefined;
  const next = String(list.start + list.count);
  return `${group(item, 1)}${next}${list.delimiter}${trimmed.slice(item[0].length)}`;
}

/**
 * The two texts either side of an interrupting block, rewritten so a code
 * fence, a table or a numbered list the first leaves open reads as one block
 * across the interruption. Text that leaves nothing open comes back unchanged.
 */
export function markdownContinuation(before: string, after: string): ContinuedText {
  const fence = openFenceAtEnd(before);
  if (fence !== undefined) {
    const close = fence.marker.charAt(0).repeat(fence.marker.length);
    return {
      before: `${before}${before.endsWith('\n') ? '' : '\n'}${close}`,
      after: `${fence.openingLine}\n${withoutOneLeadingNewline(after)}`,
    };
  }
  const table = openTableAtEnd(before);
  const afterRow = withoutOneLeadingNewline(after);
  if (table !== undefined && TABLE_ROW_START.test(afterRow)) {
    return { before, after: `${table.header}\n${table.delimiter}\n${afterRow}` };
  }
  const list = openListAtEnd(before);
  const resumed = list === undefined ? undefined : resumedList(after, list);
  if (resumed !== undefined) return { before, after: resumed };
  return { before, after };
}
