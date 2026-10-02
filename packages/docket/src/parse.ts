import {
  DAY_STAMP_PATTERN,
  DENIAL_AUTHORS,
  FINDING_STATES,
  FINDING_STATUSES,
  KINDS,
  NOTE_AUTHORS,
  PROGRESS_STATUSES,
  SEVERITIES,
} from './types.ts';
import { validateFinding } from './validate.ts';
import type {
  Audit,
  Denial,
  Finding,
  FindingIssue,
  FindingIssueCode,
  FindingOption,
  HistoryEntry,
  ParseResult,
  Progress,
  ProgressNote,
  Question,
  Ruling,
} from './types.ts';

type YamlScalar = string | number | boolean | null;
interface YamlMap {
  readonly [key: string]: YamlValue;
}
type YamlValue = YamlScalar | readonly YamlValue[] | YamlMap;

const DELIMITER = '---';
const KEY_VALUE = /^(\w+):(?: (.*))?$/;
const INTEGER = /^-?\d+$/;
const OPTION_HEADING = /^###[ \t]+(.*)$/;
const OPTIONS_HEADING = /^##[ \t]+Options[ \t]*$/;
const OPTION_SEPARATOR = ' — ';
export const RECOMMENDED_MARKER = '**Recommended**';
export const DEDICATED_MARKER = '**Dedicated**';
const HISTORY_KINDS = ['ruling', 'denial'] as const;

class FormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormatError';
  }
}

function issue(code: FindingIssueCode, field: string | null, message: string): FindingIssue {
  return { code, field, message };
}

/**
 * Splits the frontmatter from the body. The body is every byte after the
 * closing delimiter's newline, returned verbatim: no writer may rewrite it.
 */
export function splitFrontmatter(text: string): { yaml: string; body: string } | null {
  const opening = `${DELIMITER}\n`;
  if (!text.startsWith(opening)) return null;
  const closing = `\n${DELIMITER}\n`;
  const end = text.indexOf(closing, opening.length - 1);
  if (end === -1) return null;
  return {
    yaml: text.slice(opening.length, end + 1),
    body: text.slice(end + closing.length),
  };
}

// eslint-disable-next-line sonarjs/function-return-type -- a scalar of this format's subset is a string, integer, boolean or null by definition
function parseScalarToken(token: string): YamlScalar {
  if (token === 'null') return null;
  if (token === 'true') return true;
  if (token === 'false') return false;
  if (INTEGER.test(token)) return Number(token);
  if (!token.startsWith('"')) {
    throw new FormatError(`scalar outside the format's subset: ${token}`);
  }
  try {
    // A JSON document opening with a double quote can only be a string literal.
    return JSON.parse(token) as string;
  } catch {
    throw new FormatError(`not a JSON string: ${token}`);
  }
}

interface ScanState {
  entries: string[];
  current: string;
  depth: number;
  inString: boolean;
  escaped: boolean;
  closedAt: number;
}

function scanInsideString(state: ScanState, character: string): void {
  state.current += character;
  if (state.escaped) state.escaped = false;
  else if (character === '\\') state.escaped = true;
  else if (character === '"') state.inString = false;
}

function scanCharacter(state: ScanState, character: string, index: number): void {
  if (state.inString) {
    scanInsideString(state, character);
    return;
  }
  switch (character) {
    case '"': {
      state.inString = true;
      state.current += character;
      break;
    }
    case '{': {
      state.depth += 1;
      if (state.depth > 1) state.current += character;
      break;
    }
    case '}': {
      state.depth -= 1;
      if (state.depth === 0) state.closedAt = index;
      else state.current += character;
      break;
    }
    case ',': {
      if (state.depth === 1) {
        state.entries.push(state.current);
        state.current = '';
      } else state.current += character;
      break;
    }
    default: {
      state.current += character;
    }
  }
}

function splitFlowEntries(token: string): string[] {
  const state: ScanState = {
    entries: [],
    current: '',
    depth: 0,
    inString: false,
    escaped: false,
    closedAt: -1,
  };
  for (let index = 0; index < token.length && state.closedAt === -1; index += 1) {
    scanCharacter(state, token.charAt(index), index);
  }

  if (state.closedAt === -1) throw new FormatError(`unclosed flow map: ${token}`);
  if (token.slice(state.closedAt + 1).trim() !== '') {
    throw new FormatError(`text trailing a flow map: ${token}`);
  }
  if (state.current.trim() !== '') state.entries.push(state.current);
  return state.entries;
}

function parseFlowMap(token: string): YamlMap {
  const map: Record<string, YamlValue> = {};
  for (const entry of splitFlowEntries(token)) {
    const match = KEY_VALUE.exec(entry.trim());
    const key = match?.[1];
    const value = match?.[2];
    if (key === undefined || value === undefined) {
      throw new FormatError(`not a flow-map entry: ${entry.trim()}`);
    }
    map[key] = parseScalarToken(value.trim());
  }
  return map;
}

interface YamlLine {
  readonly indent: number;
  readonly text: string;
}

interface BlockContext {
  readonly lines: readonly YamlLine[];
  cursor: number;
}

function toLines(yaml: string): YamlLine[] {
  const lines: YamlLine[] = [];
  for (const raw of yaml.split('\n')) {
    if (raw.trim() === '') continue;
    lines.push({ indent: raw.length - raw.trimStart().length, text: raw.trimStart() });
  }
  return lines;
}

function parseSequence(context: BlockContext, indent: number): YamlValue[] {
  const items: YamlValue[] = [];
  for (;;) {
    const line = context.lines[context.cursor];
    if (line?.indent !== indent || !line.text.startsWith('- ')) break;
    const token = line.text.slice(2).trim();
    items.push(token.startsWith('{') ? parseFlowMap(token) : parseScalarToken(token));
    context.cursor += 1;
  }
  return items;
}

// eslint-disable-next-line sonarjs/function-return-type -- a value of this format's subset is a scalar, a sequence or a map by definition
function parseEntryValue(
  context: BlockContext,
  indent: number,
  key: string,
  inline: string | undefined
): YamlValue {
  if (inline !== undefined && inline !== '') {
    return inline === '[]' ? [] : parseScalarToken(inline);
  }
  const next = context.lines[context.cursor];
  if (next?.indent !== indent + 2) {
    throw new FormatError(`key "${key}" has neither a value nor children`);
  }
  return next.text.startsWith('- ')
    ? parseSequence(context, indent + 2)
    : parseMap(context, indent + 2);
}

function parseMap(context: BlockContext, indent: number): YamlMap {
  const map: Record<string, YamlValue> = {};
  for (;;) {
    const line = context.lines[context.cursor];
    if (line?.indent !== indent) break;
    const match = KEY_VALUE.exec(line.text);
    const key = match?.[1];
    const inline = match?.[2];
    if (key === undefined) throw new FormatError(`not a key-value line: ${line.text}`);
    context.cursor += 1;
    map[key] = parseEntryValue(context, indent, key, inline);
  }
  return map;
}

function parseYamlBlock(yaml: string): YamlMap {
  const context: BlockContext = { lines: toLines(yaml), cursor: 0 };
  const map = parseMap(context, 0);
  const leftover = context.lines[context.cursor];
  if (leftover !== undefined) throw new FormatError(`unexpected line: ${leftover.text}`);
  return map;
}

function isYamlMap(value: YamlValue | undefined): value is YamlMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isYamlList(value: YamlValue | undefined): value is readonly YamlValue[] {
  return Array.isArray(value);
}

interface FieldReader {
  string(key: string): string;
  nullableString(key: string): string | null;
  boolean(key: string): boolean;
  integer(key: string): number;
  /** The first value is the fallback, so a bad enum still yields a typed finding. */
  enumOf<T extends string>(key: string, values: readonly [T, ...T[]]): T;
  nullableMap(key: string): YamlMap | null;
  stringList(key: string): string[];
  mapList(key: string): YamlMap[];
}

/**
 * Reads one map's fields, appending an issue per problem rather than stopping
 * at the first, so a malformed file reports everything wrong with it at once.
 */
function createReader(map: YamlMap, issues: FindingIssue[], prefix = ''): FieldReader {
  const path = (key: string): string => `${prefix}${key}`;

  const present = (key: string): boolean => {
    if (key in map) return true;
    issues.push(issue('missing-field', path(key), `${path(key)} is required`));
    return false;
  };

  const wrongType = (key: string, expected: string): void => {
    issues.push(issue('invalid-type', path(key), `${path(key)} is ${expected}`));
  };

  function list(key: string): readonly YamlValue[] {
    if (!present(key)) return [];
    const value = map[key];
    if (isYamlList(value)) return value;
    wrongType(key, 'a list');
    return [];
  }

  return {
    string(key) {
      if (!present(key)) return '';
      const value = map[key];
      if (typeof value === 'string') return value;
      wrongType(key, 'a string');
      return '';
    },
    nullableString(key) {
      if (!present(key)) return null;
      const value = map[key];
      if (typeof value === 'string' || value === null) return value;
      wrongType(key, 'a string or null');
      return null;
    },
    boolean(key) {
      if (!present(key)) return false;
      const value = map[key];
      if (typeof value === 'boolean') return value;
      wrongType(key, 'a boolean');
      return false;
    },
    integer(key) {
      if (!present(key)) return 0;
      const value = map[key];
      if (typeof value === 'number') return value;
      wrongType(key, 'an integer');
      return 0;
    },
    enumOf(key, values) {
      const [fallback] = values;
      if (!present(key)) return fallback;
      const value = map[key];
      if (typeof value !== 'string') {
        wrongType(key, 'a string');
        return fallback;
      }
      const match = values.find((candidate) => candidate === value);
      if (match !== undefined) return match;
      issues.push(issue('invalid-enum', path(key), `${path(key)} is one of ${values.join(', ')}`));
      return fallback;
    },
    nullableMap(key) {
      if (!present(key)) return null;
      const value = map[key];
      if (value === null) return null;
      if (isYamlMap(value)) return value;
      wrongType(key, 'a map');
      return null;
    },
    stringList(key) {
      const items: string[] = [];
      for (const [index, item] of list(key).entries()) {
        if (typeof item === 'string') items.push(item);
        else {
          issues.push(
            issue('invalid-type', `${path(key)}[${String(index)}]`, 'entries are strings')
          );
        }
      }
      return items;
    },
    mapList(key) {
      const items: YamlMap[] = [];
      for (const [index, item] of list(key).entries()) {
        if (isYamlMap(item)) items.push(item);
        else {
          issues.push(issue('invalid-type', `${path(key)}[${String(index)}]`, 'entries are maps'));
        }
      }
      return items;
    },
  };
}

function readRuling(map: YamlMap, issues: FindingIssue[], prefix: string): Ruling {
  const read = createReader(map, issues, prefix);
  return {
    option: read.string('option'),
    text: read.nullableString('text'),
    note: read.nullableString('note'),
    at: read.string('at'),
  };
}

function readDenial(map: YamlMap, issues: FindingIssue[], prefix: string): Denial {
  const read = createReader(map, issues, prefix);
  return {
    by: read.enumOf('by', DENIAL_AUTHORS),
    reason: read.nullableString('reason'),
    at: read.string('at'),
  };
}

function readHistoryEntry(map: YamlMap, issues: FindingIssue[], prefix: string): HistoryEntry {
  const read = createReader(map, issues, prefix);
  const at = read.string('at');
  const superseded_at = read.string('superseded_at');
  const kind = read.enumOf('kind', HISTORY_KINDS);
  if (kind === 'denial') {
    return {
      at,
      kind,
      superseded_at,
      reason: read.nullableString('reason'),
      by: read.enumOf('by', DENIAL_AUTHORS),
    };
  }
  return {
    at,
    kind,
    superseded_at,
    option: read.string('option'),
    text: read.nullableString('text'),
    note: read.nullableString('note'),
  };
}

function readQuestion(map: YamlMap, issues: FindingIssue[], prefix: string): Question {
  const read = createReader(map, issues, prefix);
  return {
    at: read.string('at'),
    text: read.string('text'),
    answer: read.nullableString('answer'),
    answered_at: read.nullableString('answered_at'),
  };
}

function readProgressNote(map: YamlMap, issues: FindingIssue[], prefix: string): ProgressNote {
  const read = createReader(map, issues, prefix);
  return {
    at: read.string('at'),
    by: read.enumOf('by', NOTE_AUTHORS),
    text: read.string('text'),
  };
}

const DEFAULT_PROGRESS: Progress = {
  status: 'not-started',
  updated: null,
  verified: false,
  notes: [],
};

function readProgress(map: YamlMap, issues: FindingIssue[]): Progress {
  const value = map['progress'];
  if (!('progress' in map)) {
    issues.push(issue('missing-field', 'progress', 'progress is required'));
    return DEFAULT_PROGRESS;
  }
  if (!isYamlMap(value)) {
    issues.push(issue('invalid-type', 'progress', 'progress is a map'));
    return DEFAULT_PROGRESS;
  }
  const read = createReader(value, issues, 'progress.');
  return {
    status: read.enumOf('status', PROGRESS_STATUSES),
    updated: read.nullableString('updated'),
    verified: read.boolean('verified'),
    notes: read
      .mapList('notes')
      .map((note, index) => readProgressNote(note, issues, `progress.notes[${String(index)}].`)),
  };
}

function parseOption(heading: string, lines: readonly string[]): FindingOption {
  const separator = heading.indexOf(OPTION_SEPARATOR);
  const id = separator === -1 ? heading.trim() : heading.slice(0, separator).trim();
  const label = separator === -1 ? '' : heading.slice(separator + OPTION_SEPARATOR.length).trim();

  // Leading blanks are dropped first: Prettier inserts one between the heading
  // and the meta line, so a hand-written option and a formatted one must read
  // the same.
  const first = lines.findIndex((line) => line.trim() !== '');
  const content = first === -1 ? [] : lines.slice(first);
  const [firstLine, secondLine] = content;
  if (firstLine === undefined) {
    return { id, label, recommended: false, dedicated: false, meta: null, body: '' };
  }

  // The meta line is the first content line when it stands alone as its own
  // paragraph, which is the shape the audit skeleton writes.
  const standsAlone = secondLine === undefined || secondLine.trim() === '';

  return {
    id,
    label,
    recommended: firstLine.includes(RECOMMENDED_MARKER),
    dedicated: firstLine.includes(DEDICATED_MARKER),
    meta: standsAlone ? firstLine.trim() : null,
    body: content
      .slice(standsAlone ? 1 : 0)
      .join('\n')
      .trim(),
  };
}

function parseOptions(body: string): { explainer: string; options: FindingOption[] } {
  const lines = body.split('\n');
  const start = lines.findLastIndex((line) => OPTIONS_HEADING.test(line));
  if (start === -1) return { explainer: body.trim(), options: [] };

  const options: FindingOption[] = [];
  let heading: string | null = null;
  let collected: string[] = [];

  for (const line of lines.slice(start + 1)) {
    const next = OPTION_HEADING.exec(line)?.[1];
    if (next === undefined) {
      if (heading !== null) collected.push(line);
      continue;
    }
    if (heading !== null) options.push(parseOption(heading, collected));
    heading = next;
    collected = [];
  }
  if (heading !== null) options.push(parseOption(heading, collected));

  return { explainer: lines.slice(0, start).join('\n').trim(), options };
}

function readFrontmatter(
  text: string,
  issues: FindingIssue[]
): { map: YamlMap; body: string } | null {
  const split = splitFrontmatter(text);
  if (split === null) {
    issues.push(
      text.startsWith(`${DELIMITER}\n`)
        ? issue('unterminated-frontmatter', null, 'the frontmatter is never closed')
        : issue('missing-frontmatter', null, 'the file does not open with frontmatter')
    );
    return null;
  }
  try {
    return { map: parseYamlBlock(split.yaml), body: split.body };
  } catch (error) {
    issues.push(issue('malformed-yaml', null, (error as Error).message));
    return null;
  }
}

function toFinding(map: YamlMap, body: string, issues: FindingIssue[]): Finding {
  const read = createReader(map, issues);
  const ruling = read.nullableMap('ruling');
  const denial = read.nullableMap('denial');
  const { explainer, options } = parseOptions(body);

  return {
    id: read.string('id'),
    title: read.string('title'),
    severity: read.enumOf('severity', SEVERITIES),
    kind: read.enumOf('kind', KINDS),
    status: read.enumOf('status', FINDING_STATUSES),
    status_note: read.nullableString('status_note'),
    area: read.string('area'),
    needs_ruling: read.boolean('needs_ruling'),
    needs_options: read.boolean('needs_options'),
    warning: read.boolean('warning'),
    related: read.stringList('related'),
    group: read.nullableString('group'),
    dedicated: read.boolean('dedicated'),
    state: read.enumOf('state', FINDING_STATES),
    ruling: ruling === null ? null : readRuling(ruling, issues, 'ruling.'),
    denial: denial === null ? null : readDenial(denial, issues, 'denial.'),
    history: read
      .mapList('history')
      .map((entry, index) => readHistoryEntry(entry, issues, `history[${String(index)}].`)),
    questions: read
      .mapList('questions')
      .map((entry, index) => readQuestion(entry, issues, `questions[${String(index)}].`)),
    progress: readProgress(map, issues),
    body,
    explainer,
    options,
  };
}

export function parseFinding(text: string, filePath: string): ParseResult<Finding> {
  const fatal: FindingIssue[] = [];
  const read = readFrontmatter(text, fatal);
  if (read === null) return { ok: false, issues: fatal };

  const finding = toFinding(read.map, read.body, fatal);
  if (fatal.length > 0) return { ok: false, issues: fatal };

  const stem = filePath.replace(/^.*\//, '').replace(/\.md$/, '');
  const structural = [...validateFinding(finding, 'structural')];
  if (finding.id !== stem) {
    structural.push(
      issue('id-filename-mismatch', 'id', `id "${finding.id}" is not the stem "${stem}"`)
    );
  }
  return { ok: true, value: finding, issues: structural };
}

export function parseAudit(text: string): ParseResult<Audit> {
  const fatal: FindingIssue[] = [];
  const parsed = readFrontmatter(text, fatal);
  if (parsed === null) return { ok: false, issues: fatal };

  const read = createReader(parsed.map, fatal);
  const audit: Audit = {
    layout_version: read.integer('layout_version'),
    date: read.string('date'),
    title: read.string('title'),
    scope: read.string('scope'),
    body: parsed.body,
  };

  // The header carries the same day rule as every finding stamp. A date that is
  // absent or not a string is already reported by the reader, so the rule only
  // speaks about a value that is there.
  const date = parsed.map['date'];
  if (typeof date === 'string' && !DAY_STAMP_PATTERN.test(date)) {
    fatal.push(issue('non-day-timestamp', 'date', `date "${date}" is not a day (YYYY-MM-DD)`));
  }

  if (fatal.length > 0) return { ok: false, issues: fatal };
  return { ok: true, value: audit, issues: [] };
}
