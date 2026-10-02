/**
 * Every change the CLI makes to a status file, as a pure transform on the
 * model. Each refuses loudly rather than acting on a card or field that is not
 * where the verb expects it, so a silent no-op cannot be reported as applied.
 */

import {
  label,
  serializeCard,
  STATE_GLYPHS,
  type Card,
  type CardState,
  type Chart,
  type Field,
  type StatusFile,
} from './format.js';

/** The canonical fields, in the order they are written. */
const CANONICAL_FIELDS = ['Problem', 'Recommendation', 'Decision', 'Alternatives'] as const;

const CANONICAL_FIELD_NAMES: ReadonlySet<string> = new Set(CANONICAL_FIELDS);

/** The fields a card carries whatever its Problem holds; Alternatives is conditional on the option table. */
const REQUIRED_FIELDS = ['Problem', 'Recommendation', 'Decision'] as const;

const REQUIRED_FIELD_NAMES: ReadonlySet<string> = new Set(REQUIRED_FIELDS);

/** The four things a Problem states, one bullet each; the bold spelling counts too. */
const PROBLEM_LABELS = ['Found', 'Today', 'After', 'Breaks'] as const;

const PROBLEM_LABEL_BULLET = new RegExp(
  String.raw`^-\s+(?:\*\*)?(${PROBLEM_LABELS.join('|')})(?:\*\*)?\b`,
  'u'
);

/**
 * Words that chain a Decision into steps, so the one word "approve" no longer
 * binds to a single act. The semicolon does the same and is banned beside them.
 */
const BANNED_DECISION_WORDS = ['then', 'until', 'at which point'] as const;

const BANNED_DECISION_PATTERNS = BANNED_DECISION_WORDS.map(
  (word) => [word, new RegExp(String.raw`\b${word}\b`, 'iu')] as const
);

/** Fields the verbs own; `edit` refuses them. */
const VERB_OWNED_FIELDS = new Set(['Answer', 'Work', 'Findings']);

/** Parts of the title line, which `edit` sends to the verb that owns them. */
const TITLE_LINE_PARTS = new Set(['title', 'question', 'blocks', 'blocking']);

interface Draft {
  readonly question: string;
  readonly blocks: readonly string[];
  readonly problem: string;
  readonly recommendation: string;
  readonly decision: string;
  /** Absent on a card whose Problem weighs its options in a table. */
  readonly alternatives?: string | undefined;
}

/** The forms that leave the field in place, carrying the text it ends up with. */
type FieldRewrite =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'replace'; readonly old: string; readonly with: string }
  | { readonly kind: 'append'; readonly text: string };

export type FieldEdit = FieldRewrite | { readonly kind: 'remove' };

interface Ruling {
  readonly text?: string | undefined;
  readonly work: string;
}

interface Ruled {
  readonly file: StatusFile;
  readonly ledgerLine: string;
}

/** What a title change names: the question text, the tasks the card blocks, or both. */
export interface TitleChange {
  readonly question?: string | undefined;
  readonly blocks?: readonly string[] | undefined;
}

export type ListFilter = 'open' | 'ready' | 'answered';

const BULLETED_BODY = /^-\s/u;

/**
 * A bulleted body begins on the line after its lead, which is the shape the
 * canonical card is written in and the one a four-bullet Problem round-trips in.
 */
function leadFor(separator: string, text: string): string {
  return BULLETED_BODY.test(text) ? `${separator}\n` : `${separator} `;
}

function prose(name: string, text: string): Field {
  return { name, lead: leadFor(`**${name}** —`, text), text };
}

function inline(name: string, text: string): Field {
  return { name, lead: leadFor(`**${name}:**`, text), text };
}

function nextId(file: StatusFile): number {
  return Math.max(0, ...[...file.open, ...file.answered].map((card) => card.id)) + 1;
}

function requireCanonical(fields: readonly Field[]): void {
  for (const name of REQUIRED_FIELDS) {
    const field = fields.find((candidate) => candidate.name === name);
    if (field === undefined || field.text.trim() === '')
      throw new Error(`the ${name} field is missing or empty`);
  }
}

function fieldText(fields: readonly Field[], name: string): string {
  return fields.find((field) => field.name === name)?.text ?? '';
}

/** What a Problem lacks of its four labels, or null when it carries them all. */
function problemLabelDefect(problem: string): string | null {
  const carried = new Set(
    problem
      .split('\n')
      .map((line) => PROBLEM_LABEL_BULLET.exec(line)?.[1])
      .filter((name) => name !== undefined)
  );
  const missing = PROBLEM_LABELS.filter((name) => !carried.has(name));
  if (missing.length === 0) return null;
  return `the Problem has no ${missing.join(', ')} ${missing.length === 1 ? 'label' : 'labels'}`;
}

/** An option table is a line of the Problem whose trimmed form opens a table row. */
function hasOptionTable(problem: string): boolean {
  return problem.split('\n').some((line) => line.trim().startsWith('|'));
}

/** Presence, not text: a field holding nothing is still a field beside a table, and `edit --remove` takes it out. */
function carriesAlternatives(fields: readonly Field[]): boolean {
  return fields.some((field) => field.name === 'Alternatives');
}

/**
 * Alternatives is conditional on the option table, never merely optional: the
 * table's rows already hold every loser's reason, and where there is no table
 * nothing else records why the other options lost.
 */
function alternativesDefect(fields: readonly Field[]): string | null {
  const table = hasOptionTable(fieldText(fields, 'Problem'));
  const carried = carriesAlternatives(fields);
  if (table && carried)
    return "the Problem's option table already holds every loser's reason, so the card takes no Alternatives field";
  if (!table && !carried)
    return 'the Problem weighs no options in a table, so the card needs an Alternatives field';
  return null;
}

/** The chaining token a Decision holds, or null when it binds to one act. */
function decisionTokenDefect(decision: string): string | null {
  if (decision.includes(';')) return 'the Decision holds a semicolon';
  const banned = BANNED_DECISION_PATTERNS.find(([, pattern]) => pattern.test(decision));
  return banned === undefined ? null : `the Decision holds "${banned[0]}"`;
}

/** The rule governing one field's own text, or null where the shape says nothing about it. */
function fieldDefect(name: string, text: string): string | null {
  if (name === 'Problem') return problemLabelDefect(text);
  if (name === 'Decision') return decisionTokenDefect(text);
  return null;
}

/** Every way a card's fields miss the documented shape, one clause each. */
function shapeDefects(fields: readonly Field[]): string[] {
  return [
    problemLabelDefect(fieldText(fields, 'Problem')),
    decisionTokenDefect(fieldText(fields, 'Decision')),
    alternativesDefect(fields),
  ].filter((defect) => defect !== null);
}

function requireShape(id: number, fields: readonly Field[]): void {
  const defects = shapeDefects(fields);
  if (defects.length > 0) throw new Error(`${label(id)}: ${defects.join('\n')}`);
}

/**
 * A card as a section holds it, every field's lead derived from the body it now
 * carries by {@link withLeadFor}. Every helper that puts a card into a section
 * calls this, so no write path can carry a lead through unexamined.
 */
function written(card: Card): Card {
  return { ...card, fields: card.fields.map((field) => withLeadFor(field)) };
}

function insertOpen(file: StatusFile, card: Card): StatusFile {
  return { ...file, open: [written(card), ...file.open] };
}

/** A run's first status file: the chart and both sections, carrying no cards. */
export function emptyStatus(title: string): StatusFile {
  return {
    title,
    chart: { stamp: 'created', done: '0', inFlight: 'none', blocked: 'none', queued: '0' },
    open: [],
    answered: [],
  };
}

/** A new drafting card at the top of Open, with the next Q-ID. */
export function openCard(file: StatusFile, draft: Draft): { file: StatusFile; id: number } {
  const alternatives = draft.alternatives ?? '';
  const fields: Field[] = [
    prose('Problem', draft.problem),
    prose('Recommendation', draft.recommendation),
    prose('Decision', draft.decision),
    ...(alternatives.trim() === '' ? [] : [prose('Alternatives', alternatives)]),
  ];
  const id = nextId(file);
  requireCanonical(fields);
  requireShape(id, fields);
  const card: Card = {
    id,
    state: 'drafting',
    question: draft.question,
    blocks: draft.blocks,
    preamble: '',
    fields,
  };
  return { file: insertOpen(file, card), id };
}

/** The same, from a card drafted in a file; its own id, state, and verb-owned fields are discarded. */
export function openFromCard(file: StatusFile, drafted: Card): { file: StatusFile; id: number } {
  const fields = drafted.fields.filter((field) => !VERB_OWNED_FIELDS.has(field.name));
  const id = nextId(file);
  requireCanonical(fields);
  requireShape(id, fields);
  const card: Card = { ...drafted, id, state: 'drafting', fields };
  return { file: insertOpen(file, card), id };
}

function findIn(cards: readonly Card[], id: number): Card | undefined {
  return cards.find((card) => card.id === id);
}

function requireOpen(file: StatusFile, id: number): Card {
  const card = findIn(file.open, id);
  if (card === undefined) throw new Error(`${label(id)} is not in Open`);
  return card;
}

function requireAnswered(file: StatusFile, id: number): Card {
  const card = findIn(file.answered, id);
  if (card === undefined) throw new Error(`${label(id)} is not in Answered`);
  return card;
}

function replaceOpen(file: StatusFile, card: Card): StatusFile {
  return {
    ...file,
    open: file.open.map((candidate) => (candidate.id === card.id ? written(card) : candidate)),
  };
}

function replaceAnswered(file: StatusFile, card: Card): StatusFile {
  return {
    ...file,
    answered: file.answered.map((candidate) =>
      candidate.id === card.id ? written(card) : candidate
    ),
  };
}

function moveToAnswered(file: StatusFile, card: Card): StatusFile {
  return {
    ...file,
    open: file.open.filter((candidate) => candidate.id !== card.id),
    answered: [written(card), ...file.answered],
  };
}

function moveToOpen(file: StatusFile, card: Card): StatusFile {
  return {
    ...file,
    open: [written(card), ...file.open],
    answered: file.answered.filter((candidate) => candidate.id !== card.id),
  };
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function applyEdit(field: Field, edit: FieldRewrite): Field {
  switch (edit.kind) {
    case 'text': {
      return { ...field, text: edit.text };
    }
    case 'append': {
      return { ...field, text: `${field.text}\n\n${edit.text}` };
    }
    case 'replace': {
      const count = countOccurrences(field.text, edit.old);
      if (count !== 1)
        throw new Error(
          `"${edit.old}" occurs ${String(count)} times in ${field.name}; it must occur exactly once`
        );
      return { ...field, text: field.text.replace(edit.old, edit.with) };
    }
  }
}

/**
 * A field's lead for the body it now carries. A bulleted body ends up under its
 * lead however it got there, so one collapsed onto its lead line is repaired
 * wherever it is read or written; a lead that already breaks keeps the break it
 * has, blank line included. A prose body keeps the lead it came with unless
 * `bodyBefore` says an edit took it out of bullets, where the break it no
 * longer needs is dropped — only an edit makes that transition, and only the
 * caller holding the body from before it knows.
 */
function withLeadFor(field: Field, bodyBefore = field.text): Field {
  const rederive = BULLETED_BODY.test(field.text)
    ? !field.lead.endsWith('\n')
    : BULLETED_BODY.test(bodyBefore);
  return rederive ? { ...field, lead: leadFor(field.lead.trimEnd(), field.text) } : field;
}

/** One field of one open card, rewritten by one of the three forms or removed outright. */
export function editField(file: StatusFile, id: number, name: string, edit: FieldEdit): StatusFile {
  if (VERB_OWNED_FIELDS.has(name)) {
    throw new Error(`${name} is written by its own verb, never by edit`);
  }
  if (TITLE_LINE_PARTS.has(name.toLowerCase())) {
    throw new Error(`${name} is part of the title line: \`pnpm cards title\` writes it`);
  }
  if (edit.kind === 'remove' && REQUIRED_FIELD_NAMES.has(name)) {
    throw new Error(`${name} is a field every card carries, never removed by edit`);
  }
  const card = requireOpen(file, id);
  const field = card.fields.find((candidate) => candidate.name === name);
  if (field === undefined) throw new Error(`${label(id)} carries no ${name} field`);
  if (edit.kind === 'remove') {
    const remaining = card.fields.filter((candidate) => candidate !== field);
    const stranded = alternativesDefect(remaining);
    // Only a removal that introduces the defect is refused. Refusing every
    // result that carries one would block each unrelated removal on a card
    // already carrying it, and a removal is how such a card is repaired.
    if (stranded !== null && alternativesDefect(card.fields) === null)
      throw new Error(`${label(id)}: ${stranded}`);
    return replaceOpen(file, { ...card, fields: remaining });
  }
  const edited = withLeadFor(applyEdit(field, edit), field.text);
  const defect = fieldDefect(name, edited.text);
  if (defect !== null) throw new Error(`${label(id)}: ${defect}`);
  return replaceOpen(file, {
    ...card,
    fields: card.fields.map((candidate) => (candidate === field ? edited : candidate)),
  });
}

function withoutFindings(card: Card): Card {
  return { ...card, fields: card.fields.filter((field) => field.name !== 'Findings') };
}

function withFindings(card: Card, text: string): Card {
  const without = withoutFindings(card).fields;
  // Anchored on the last canonical field the card carries, never on Alternatives by
  // name: a card whose Problem weighs its options in a table has no Alternatives field.
  const at = without.findLastIndex((field) => CANONICAL_FIELD_NAMES.has(field.name)) + 1;
  const fields = [...without.slice(0, at), prose('Findings', text), ...without.slice(at)];
  return { ...card, fields };
}

/**
 * An open card's question text, the tasks it blocks, or both. The glyph moves
 * through {@link setState} and the Q-ID never moves, so those are the whole of
 * the title line this owns.
 */
export function setTitle(file: StatusFile, id: number, change: TitleChange): StatusFile {
  const card = requireOpen(file, id);
  const { question, blocks } = change;
  if (question === undefined && blocks === undefined) {
    throw new Error(
      `${label(id)}: nothing to change — name a question, the tasks it blocks, or both`
    );
  }
  if (question?.trim() === '') {
    throw new Error(`${label(id)}: the question is empty`);
  }
  return replaceOpen(file, {
    ...card,
    ...(question === undefined ? {} : { question }),
    ...(blocks === undefined ? {} : { blocks }),
  });
}

/**
 * The card's glyph. `findings` files the reviewer's open findings on the card;
 * every other state drops that field, because findings the glyph no longer
 * advertises read as open ones beside a card that has none.
 */
export function setState(
  file: StatusFile,
  id: number,
  state: CardState,
  findings?: string
): StatusFile {
  const card = requireOpen(file, id);
  if (state === 'findings') {
    if (findings === undefined || findings.trim() === '')
      throw new Error("the findings state needs the reviewer's findings text");
    return replaceOpen(file, { ...withFindings(card, findings), state });
  }
  return replaceOpen(file, { ...withoutFindings(card), state });
}

/**
 * The Answer line the human filled that no Work line has yet recorded: the
 * last Answer field, when it is non-empty and nothing follows it but blanks.
 * A reopened card keeps its earlier Answer and Work pair, so "any filled
 * Answer" would read a ruling already acted on as a new one.
 */
export function unrecordedAnswer(card: Card): string | null {
  const last = card.fields.at(-1);
  if (last?.name !== 'Answer') return null;
  const text = last.text.trim();
  return text === '' ? null : text;
}

function answerText(card: Card, given: string | undefined): string {
  if (given !== undefined && given.trim() !== '') return given;
  const inFile = unrecordedAnswer(card);
  if (inFile === null)
    throw new Error(`${label(card.id)} has no answer: pass --text or fill its Answer line`);
  return inFile;
}

/** Move an open card whole to the top of Answered, Answer and Work appended. */
export function answerCard(file: StatusFile, id: number, ruling: Ruling): Ruled {
  const card = requireOpen(file, id);
  const text = answerText(card, ruling.text);
  const kept = card.fields.at(-1)?.name === 'Answer' ? card.fields.slice(0, -1) : card.fields;
  const fields = [...kept, inline('Answer', text), inline('Work', ruling.work)];
  return {
    file: moveToAnswered(file, { ...card, fields }),
    ledgerLine: `- ${label(id)} ruled: "${text}" → Work: ${ruling.work}`,
  };
}

/**
 * A card whose premise turned out false, collapsed to that one line: a withdrawn
 * card was never a decision, so its deliberation is not a record worth keeping.
 */
export function withdrawCard(file: StatusFile, id: number, reason: string): Ruled {
  const card = requireOpen(file, id);
  const fields = [
    prose('Problem', reason),
    inline('Answer', 'withdrawn'),
    inline('Work', 'none — withdrawn'),
  ];
  return {
    file: moveToAnswered(file, { ...card, fields }),
    ledgerLine: `- ${label(id)} withdrawn: "${reason}"`,
  };
}

/** Open cards whose Answer line the human filled in the file. */
export function pendingCards(file: StatusFile): readonly Card[] {
  return file.open.filter((card) => unrecordedAnswer(card) !== null);
}

/** An answered card back to the top of Open, the correction folded into Problem. */
export function reopenCard(file: StatusFile, id: number, correction: string): StatusFile {
  const card = requireAnswered(file, id);
  const fields = card.fields.map((field) =>
    field.name === 'Problem'
      ? { ...field, text: `${field.text}\n\nCorrection — ${correction}` }
      : field
  );
  return moveToOpen(file, { ...card, fields });
}

/** A later ruling on an answered card, appended after the first; the earlier lines stay. */
export function supersedeCard(
  file: StatusFile,
  id: number,
  ruling: { readonly text: string; readonly work: string }
): Ruled {
  const card = requireAnswered(file, id);
  const text = `${ruling.text} (supersedes the answer above)`;
  const fields = [...card.fields, inline('Answer', text), inline('Work', ruling.work)];
  return {
    file: replaceAnswered(file, { ...card, fields }),
    ledgerLine: `- ${label(id)} ruled again, supersedes: "${ruling.text}" → Work: ${ruling.work}`,
  };
}

/** A card withdrawn on a false premise carries one field deliberately, so the field checks pass it by. */
function isWithdrawn(card: Card): boolean {
  return card.fields.some((field) => field.name === 'Answer' && field.text.trim() === 'withdrawn');
}

/** The defects of one card in its section, one line each. */
function cardProblems(card: Card, section: 'Open' | 'Answered'): string[] {
  const unruled =
    section === 'Answered'
      ? ['Answer', 'Work']
          .filter(
            (name) => !card.fields.some((field) => field.name === name && field.text.trim() !== '')
          )
          .map((name) => `${label(card.id)} (Answered) has no ${name} line`)
      : [];
  if (isWithdrawn(card)) return unruled;
  const missing = REQUIRED_FIELDS.filter(
    (name) => !card.fields.some((field) => field.name === name)
  ).map((name) => `${label(card.id)} (${section}) has no ${name} field`);
  const defects = shapeDefects(card.fields).map(
    (defect) => `${label(card.id)} (${section}): ${defect}`
  );
  return [...missing, ...defects, ...unruled];
}

/** Every shape defect in a file, one line each; empty means canonical. */
export function checkStatus(file: StatusFile): string[] {
  const seen = new Set<number>();
  const duplicates: string[] = [];
  for (const card of [...file.open, ...file.answered]) {
    if (seen.has(card.id)) duplicates.push(`${label(card.id)} appears twice`);
    seen.add(card.id);
  }
  return [
    ...duplicates,
    ...file.open.flatMap((card) => cardProblems(card, 'Open')),
    ...file.answered.flatMap((card) => cardProblems(card, 'Answered')),
  ];
}

/** The card's title line as `list` prints it. */
export function titleLine(card: Card): string {
  const glyph = card.state === null ? '' : `${STATE_GLYPHS[card.state]} `;
  const tag =
    card.blocks.length === 0 ? '[blocks nothing]' : `[blocking ${card.blocks.join(', ')}]`;
  return `${glyph}${label(card.id)} — ${card.question} ${tag}`;
}

/** One line per card for the filter. */
export function listLines(file: StatusFile, filter: ListFilter): string[] {
  switch (filter) {
    case 'open': {
      return file.open.map((card) => titleLine(card));
    }
    case 'ready': {
      return file.open
        .filter((card) => card.state === 'ready' || card.state === 'findings')
        .map((card) => titleLine(card));
    }
    case 'answered': {
      return file.answered.map(
        (card) =>
          `${titleLine(card)} → ${card.fields.findLast((field) => field.name === 'Answer')?.text ?? ''}`
      );
    }
  }
}

/** A card as written, or one of its fields. */
export function showCard(file: StatusFile, id: number, fieldName?: string): string {
  const card = findIn(file.open, id) ?? findIn(file.answered, id);
  if (card === undefined) throw new Error(`${label(id)} is not in this file`);
  if (fieldName === undefined) return serializeCard(card);
  const field = card.fields.find((candidate) => candidate.name === fieldName);
  if (field === undefined) throw new Error(`${label(id)} carries no ${fieldName} field`);
  return field.text;
}

/** The chart's task cells and stamp; the ❓ cell derives at serialization. */
export function setChart(file: StatusFile, chart: Chart, idle = false): StatusFile {
  return { ...file, chart: idle ? { ...chart, stamp: `idle — ${chart.stamp}` } : chart };
}
