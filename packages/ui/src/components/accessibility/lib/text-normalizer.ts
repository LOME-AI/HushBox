/**
 * normalizeForSpeech — strips markdown so a text-to-speech engine doesn't
 * read formatting markers literally ("asterisk asterisk bold asterisk
 * asterisk"). Called by `SentenceChunker` on each emitted sentence, so
 * streaming use is handled by the chunker's own buffer-and-emit pattern.
 */

const LINK_PATTERN = /(?<!!)\[([^\]]*)\]\(([^)]*)\)/g;
const IMAGE_PATTERN = /!\[([^\]]*)\]\(([^)]*)\)/g;
const HTML_TAG_PATTERN = /<[^>\n]+>/g;
const URL_PATTERN = /https?:\/\/[^\s)]+/g;
const FENCE_PATTERN = /```[\s\S]*?```/g;
const BOLD_ITALIC_AST = /\*\*\*([^*\n]+?)\*\*\*/g;
const BOLD_AST = /\*\*([^*\n]+?)\*\*/g;
const BOLD_UNDER = /__([^_\n]+?)__/g;
const STRIKE = /~~([^~\n]+?)~~/g;
const INLINE_CODE = /`([^`\n]+?)`/g;
// Italic single * — non-word boundary outside (or whitespace/punctuation), non-whitespace inside.
const ITALIC_AST_INNER = String.raw`[^*\s](?:[^*\n]*?[^*\s])?`;
const ITALIC_AST = new RegExp(
  String.raw`(^|[\s,;:!?])\*(${ITALIC_AST_INNER})\*(?=$|[\s,;.:!?])`,
  'g'
);
// Italic single _ — must not be between alphanumerics (snake_case rule).
const ITALIC_UNDER = /(^|\W)_([^_\n]+?)_(?=$|\W)/g;
const HORIZONTAL_RULE = /^[ \t]*(-{3,}|\*{3,}|_{3,})[ \t]*$/;
const HEADING = /^[ \t]*(#+)[ \t]+(.*)$/;
const BLOCKQUOTE = /^[ \t]*>[ \t]?(.*)$/;
const NUMBERED_LIST = /^[ \t]*\d+\.[ \t]+(.*)$/;
const BULLET_LIST = /^[ \t]*[-*+][ \t]+(.*)$/;
const TABLE_SEPARATOR_CELL = String.raw`[ \t]*:?-{2,}:?[ \t]*`;
const TABLE_SEPARATOR = new RegExp(
  String.raw`^[ \t]*\|?${TABLE_SEPARATOR_CELL}(\|${TABLE_SEPARATOR_CELL})+\|?[ \t]*$`
);
const TABLE_ROW = /^[ \t]*\|.*\|[ \t]*$/;

function stripInlineMarkers(text: string): string {
  let result = text;
  result = result.replaceAll(IMAGE_PATTERN, '$1');
  result = result.replaceAll(LINK_PATTERN, '$1');
  result = result.replaceAll(HTML_TAG_PATTERN, '');
  result = result.replaceAll(URL_PATTERN, 'link');
  result = result.replaceAll(BOLD_ITALIC_AST, '$1');
  result = result.replaceAll(BOLD_AST, '$1');
  result = result.replaceAll(BOLD_UNDER, '$1');
  result = result.replaceAll(STRIKE, '$1');
  result = result.replaceAll(INLINE_CODE, '$1');
  result = result.replaceAll(ITALIC_AST, '$1$2');
  result = result.replaceAll(ITALIC_UNDER, '$1$2');
  return result;
}

const LINE_RULES: readonly ((line: string) => string | null | undefined)[] = [
  (line) => (HORIZONTAL_RULE.test(line) ? null : undefined),
  (line) => HEADING.exec(line)?.[2],
  (line) => {
    const inner = BLOCKQUOTE.exec(line)?.[1];
    return inner === undefined ? undefined : (processLine(inner) ?? '');
  },
  (line) => NUMBERED_LIST.exec(line)?.[1],
  (line) => BULLET_LIST.exec(line)?.[1],
  (line) => (TABLE_SEPARATOR.test(line) ? null : undefined),
  (line) => (TABLE_ROW.test(line) ? extractTableRow(line) : undefined),
];

function extractTableRow(line: string): string {
  const cells = line
    .split('|')
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0);
  return cells.length === 0 ? '' : cells.join(', ');
}

function processLine(line: string): string | null {
  for (const rule of LINE_RULES) {
    const result = rule(line);
    if (result === undefined) continue;
    return result === null ? null : stripInlineMarkers(result);
  }
  return stripInlineMarkers(line);
}

function collapseInlineWhitespace(line: string): string {
  return line
    .replaceAll(/[ \t]+/g, ' ')
    .replaceAll(/^ | $/g, (m) => (line.length === m.length ? '' : m));
}

export function normalizeForSpeech(text: string): string {
  const withoutFences = text.replaceAll(FENCE_PATTERN, '');
  const lines = withoutFences.split('\n');
  const processed: string[] = [];
  for (const line of lines) {
    const result = processLine(line);
    if (result === null) continue;
    processed.push(collapseInlineWhitespace(result));
  }
  return processed.join('\n');
}
