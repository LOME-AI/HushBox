import { FRONTMATTER_KEY_ORDER } from './frontmatter-order.ts';
import { splitFrontmatter } from './parse.ts';
import type { FrontmatterKey } from './frontmatter-order.ts';
import type { Denial, Finding, HistoryEntry, Progress, Question, Ruling } from './types.ts';

type Scalar = string | number | boolean | null;

const DELIMITER = '---';

const LINE_SEPARATOR = '\u2028';
const PARAGRAPH_SEPARATOR = '\u2029';

function scalar(value: Scalar): string {
  if (value === null) return 'null';
  if (typeof value !== 'string') return String(value);
  // JSON permits U+2028 and U+2029 raw, so `JSON.stringify` leaves them, but
  // they are JS line terminators: emitted raw they would split one key across
  // two physical lines, and the parser reads one key per line. Both escapes are
  // valid JSON, so `JSON.parse` restores the original characters.
  return JSON.stringify(value)
    .replaceAll(LINE_SEPARATOR, String.raw`\u2028`)
    .replaceAll(PARAGRAPH_SEPARATOR, String.raw`\u2029`);
}

function flowMap(entries: readonly (readonly [string, Scalar])[]): string {
  const inner = entries.map(([key, value]) => `${key}: ${scalar(value)}`).join(', ');
  return `{ ${inner} }`;
}

function blockLines(key: string, items: readonly string[], indent: string, empty = '[]'): string[] {
  if (items.length === 0) return [`${indent}${key}: ${empty}`];
  return [`${indent}${key}:`, ...items.map((item) => `${indent}  - ${item}`)];
}

function mapLines(
  key: string,
  entries: readonly (readonly [string, Scalar])[] | null,
  indent: string
): string[] {
  if (entries === null) return [`${indent}${key}: null`];
  return [
    `${indent}${key}:`,
    ...entries.map(([entryKey, value]) => `${indent}  ${entryKey}: ${scalar(value)}`),
  ];
}

function rulingEntries(ruling: Ruling): (readonly [string, Scalar])[] {
  return [
    ['option', ruling.option],
    ['text', ruling.text],
    ['note', ruling.note],
    ['at', ruling.at],
  ];
}

function denialEntries(denial: Denial): (readonly [string, Scalar])[] {
  return [
    ['by', denial.by],
    ['reason', denial.reason],
    ['at', denial.at],
  ];
}

function historyEntries(entry: HistoryEntry): (readonly [string, Scalar])[] {
  const head: (readonly [string, Scalar])[] = [
    ['at', entry.at],
    ['kind', entry.kind],
    ['superseded_at', entry.superseded_at],
  ];
  if (entry.kind === 'denial') {
    return [...head, ['reason', entry.reason], ['by', entry.by]];
  }
  return [...head, ['option', entry.option], ['text', entry.text], ['note', entry.note]];
}

function questionEntries(question: Question): (readonly [string, Scalar])[] {
  return [
    ['at', question.at],
    ['text', question.text],
    ['answer', question.answer],
    ['answered_at', question.answered_at],
  ];
}

function progressLines(progress: Progress): string[] {
  return [
    'progress:',
    `  status: ${scalar(progress.status)}`,
    `  updated: ${scalar(progress.updated)}`,
    `  verified: ${scalar(progress.verified)}`,
    ...blockLines(
      'notes',
      progress.notes.map((note) =>
        flowMap([
          ['at', note.at],
          ['by', note.by],
          ['text', note.text],
        ])
      ),
      '  '
    ),
  ];
}

/**
 * One emitter per key. The record is keyed by the declared order's own member
 * type, so a key added to the order without an emitter, or an emitter for a key
 * the order does not carry, is a compile error rather than a silent omission.
 */
const KEY_EMITTERS: Record<FrontmatterKey, (finding: Finding) => string[]> = {
  id: (finding) => [`id: ${scalar(finding.id)}`],
  title: (finding) => [`title: ${scalar(finding.title)}`],
  severity: (finding) => [`severity: ${scalar(finding.severity)}`],
  kind: (finding) => [`kind: ${scalar(finding.kind)}`],
  status: (finding) => [`status: ${scalar(finding.status)}`],
  status_note: (finding) => [`status_note: ${scalar(finding.status_note)}`],
  area: (finding) => [`area: ${scalar(finding.area)}`],
  needs_ruling: (finding) => [`needs_ruling: ${scalar(finding.needs_ruling)}`],
  needs_options: (finding) => [`needs_options: ${scalar(finding.needs_options)}`],
  warning: (finding) => [`warning: ${scalar(finding.warning)}`],
  related: (finding) =>
    blockLines(
      'related',
      finding.related.map((id) => scalar(id)),
      ''
    ),
  group: (finding) => [`group: ${scalar(finding.group)}`],
  dedicated: (finding) => [`dedicated: ${scalar(finding.dedicated)}`],
  state: (finding) => [`state: ${scalar(finding.state)}`],
  ruling: (finding) =>
    mapLines('ruling', finding.ruling === null ? null : rulingEntries(finding.ruling), ''),
  denial: (finding) =>
    mapLines('denial', finding.denial === null ? null : denialEntries(finding.denial), ''),
  history: (finding) =>
    blockLines(
      'history',
      finding.history.map((entry) => flowMap(historyEntries(entry))),
      ''
    ),
  questions: (finding) =>
    blockLines(
      'questions',
      finding.questions.map((question) => flowMap(questionEntries(question))),
      ''
    ),
  progress: (finding) => progressLines(finding.progress),
};

function frontmatterLines(finding: Finding): string[] {
  return FRONTMATTER_KEY_ORDER.flatMap((key) => KEY_EMITTERS[key](finding));
}

/**
 * Rewrites the frontmatter and returns the file's bytes. The body comes from
 * `originalText`, never from `finding`: no program writes a finding's body, and
 * sourcing it from the file is what makes that structural rather than a
 * convention. Text carrying no frontmatter is taken as the body whole, which is
 * how a finding file is first created.
 */
export function serializeFinding(finding: Finding, originalText: string): string {
  const body = splitFrontmatter(originalText)?.body ?? originalText;
  const lines = frontmatterLines(finding).join('\n');
  return `${DELIMITER}\n${lines}\n${DELIMITER}\n${body}`;
}
