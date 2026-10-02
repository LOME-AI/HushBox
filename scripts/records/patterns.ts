/**
 * The record patterns, read from the marked block of the repository's root
 * `.gitignore` so the paths the main repository ignores and the paths the
 * overlay tracks are one list, written once.
 */

const BEGIN_MARKER = '# BEGIN records overlay';
const END_MARKER = '# END records overlay';

/** The overlay's own git directory, ignored by the block but never a record. */
const OVERLAY_PATTERN = '/.records.git/';

/** A line git reads as a rule: neither blank nor a comment. */
function isRule(line: string): boolean {
  return line.trim() !== '' && !line.startsWith('#');
}

interface Bounds {
  readonly begin: number;
  readonly end: number;
}

/** The indices of the block's two marker lines. */
function bounds(lines: readonly string[]): Bounds {
  const begin = lines.findIndex((line) => line.startsWith(BEGIN_MARKER));
  if (begin === -1) throw new Error(`.gitignore has no "${BEGIN_MARKER}" block`);
  const length = lines.slice(begin).findIndex((line) => line.startsWith(END_MARKER));
  if (length === -1) throw new Error(`.gitignore's records block has no "${END_MARKER}" line`);
  return { begin, end: begin + length };
}

/** The patterns naming the record roots. */
export function recordPatterns(gitignore: string): string[] {
  const lines = gitignore.split(/\r?\n/u);
  const { begin, end } = bounds(lines);
  return lines.slice(begin + 1, end).filter((line) => isRule(line) && line !== OVERLAY_PATTERN);
}

/** The file with the block's lines, markers included, removed and every other byte kept. */
export function withoutRecordsBlock(gitignore: string): string {
  const lines = gitignore.split(/(?<=\n)/u);
  const { begin, end } = bounds(lines);
  return [...lines.slice(0, begin), ...lines.slice(end + 1)].join('');
}
