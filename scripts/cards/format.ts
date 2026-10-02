/**
 * The `status.md` grammar: parse to a model and serialize back, byte-stable on
 * a canonical file. Field bodies are opaque text from a bold field name to the
 * next field or heading, so tables, fences and diagrams pass through untouched.
 */

export type CardState = 'drafting' | 'review' | 'ready' | 'findings';

export const STATE_GLYPHS: Readonly<Record<CardState, string>> = {
  drafting: '📝',
  review: '🔍',
  ready: '✅',
  findings: '⚠️',
};

/** A card's label as it is typed and printed. */
export function label(id: number): string {
  return `Q${String(id)}`;
}

export interface Field {
  readonly name: string;
  /** Everything before the body — name, separator, and any break — kept so a file round-trips. */
  readonly lead: string;
  readonly text: string;
}

export interface Card {
  readonly id: number;
  readonly state: CardState | null;
  readonly question: string;
  readonly blocks: readonly string[];
  /** Prose between the heading and the first field; empty on a canonical card. */
  readonly preamble: string;
  readonly fields: readonly Field[];
}

export interface Chart {
  readonly stamp: string;
  readonly done: string;
  readonly inFlight: string;
  readonly blocked: string;
  readonly queued: string;
}

export interface StatusFile {
  readonly title: string;
  readonly chart: Chart;
  readonly open: readonly Card[];
  readonly answered: readonly Card[];
}

const CHART_HEADER = '| ✅ done | 🔧 in-flight | ⏸ blocked | ⬜ queued | ❓ open |';
const CHART_RULE = '| --- | --- | --- | --- | --- |';
const OPEN_HEADING = '## Open';
const ANSWERED_HEADING = '## Answered';

const CARD_HEADING = /^## (?:(\S+) )?Q(\d+) — (.+?)(?: \[(blocking (.+)|blocks nothing)\])?$/u;
const FIELD_LEAD = /^(\*\*([A-Za-z]+)(?::\*\*|\*\* —) ?)(.*)$/u;
const BLOCKS_SEPARATOR = /,\s*/u;

function glyphToState(glyph: string | undefined): CardState | null {
  if (glyph === undefined) return null;
  const entry = Object.entries(STATE_GLYPHS).find(([, value]) => value === glyph);
  if (entry === undefined) throw new Error(`unknown card glyph: ${glyph}`);
  return entry[0] as CardState;
}

function blankEdges(lines: readonly string[]): { start: number; end: number } {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.trim() === '') start += 1;
  while (end > start && lines[end - 1]?.trim() === '') end -= 1;
  return { start, end };
}

function trimBlankEdges(lines: readonly string[]): string {
  const { start, end } = blankEdges(lines);
  return lines.slice(start, end).join('\n');
}

function parseFields(lines: readonly string[]): { preamble: string; fields: Field[] } {
  const fields: Field[] = [];
  const preamble: string[] = [];
  let current: { name: string; lead: string; body: string[] } | null = null;
  const close = (): void => {
    if (current === null) return;
    const { body } = current;
    const { start, end } = blankEdges(body);
    const text = body.slice(start, end).join('\n');
    // An all-blank body keeps a bare lead: those blank lines are the separators between
    // fields, which serialization writes back itself.
    const skipped = text === '' ? [] : body.slice(0, start);
    const lead = current.lead + skipped.map((line) => `${line}\n`).join('');
    fields.push({ name: current.name, lead, text });
  };
  for (const line of lines) {
    const match = FIELD_LEAD.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      close();
      /* v8 ignore next -- the trailing group is `(.*)`, which always participates */
      current = { name: match[2], lead: match[1], body: [match[3] ?? ''] };
    } else if (current === null) {
      preamble.push(line);
    } else {
      current.body.push(line);
    }
  }
  close();
  return { preamble: trimBlankEdges(preamble), fields };
}

function parseCardBlock(heading: string, body: readonly string[]): Card {
  const match = CARD_HEADING.exec(heading);
  if (match === null) throw new Error(`unreadable card heading: ${heading}`);
  const [, glyph, id, question, tag, blocking] = match;
  const blocks =
    tag === undefined || blocking === undefined ? [] : blocking.split(BLOCKS_SEPARATOR);
  return {
    id: Number(id),
    state: glyphToState(glyph),
    /* v8 ignore next -- the question group is required by the pattern that matched */
    question: question ?? '',
    blocks,
    ...parseFields(body),
  };
}

/** Split lines at every `## ` heading into [heading, body] pairs; the prefix before the first heading comes first. */
function splitHeadings(lines: readonly string[]): {
  prefix: string[];
  blocks: [string, string[]][];
} {
  const prefix: string[] = [];
  const blocks: [string, string[]][] = [];
  let current: [string, string[]] | null = null;
  for (const line of lines) {
    if (line.startsWith('## ')) {
      current = [line, []];
      blocks.push(current);
    } else if (current === null) prefix.push(line);
    else current[1].push(line);
  }
  return { prefix, blocks };
}

function parseChart(prefix: readonly string[]): { title: string; chart: Chart } {
  const titleLine = prefix.find((line) => line.startsWith('# '));
  if (titleLine === undefined) throw new Error('missing `# Status — <run>` title');
  const stampLine = prefix.find((line) => line.startsWith('📊 '));
  if (stampLine === undefined) throw new Error('missing the `📊 <stamp>` chart line');
  const row = prefix.find(
    (line) => line.startsWith('| ') && line !== CHART_HEADER && !line.startsWith('| ---')
  );
  if (row === undefined) throw new Error('missing the chart row');
  const cells = row.split('|').map((cell) => cell.trim());
  const [, done, inFlight, blocked, queued] = cells;
  if (
    done === undefined ||
    inFlight === undefined ||
    blocked === undefined ||
    queued === undefined
  ) {
    throw new Error(`chart row needs five cells: ${row}`);
  }
  return {
    title: titleLine.replace(/^# Status — /u, ''),
    chart: { stamp: stampLine.slice('📊 '.length), done, inFlight, blocked, queued },
  };
}

/** Parse a whole `status.md`. Throws on any shape it cannot read. */
export function parseStatus(text: string): StatusFile {
  const { prefix, blocks } = splitHeadings(text.split('\n'));
  const { title, chart } = parseChart(prefix);
  const openAt = blocks.findIndex(([heading]) => heading === OPEN_HEADING);
  const answeredAt = blocks.findIndex(([heading]) => heading === ANSWERED_HEADING);
  if (openAt === -1) throw new Error(`missing \`${OPEN_HEADING}\` section`);
  if (answeredAt === -1 || answeredAt < openAt)
    throw new Error(`missing \`${ANSWERED_HEADING}\` section after Open`);
  for (const [heading, body] of blocks.filter(
    (_, index) => index === openAt || index === answeredAt
  )) {
    const stray = trimBlankEdges(body);
    if (stray !== '' && stray !== 'None.')
      throw new Error(`text under ${heading} outside any card`);
  }
  return {
    title,
    chart,
    open: cardsOf(blocks, openAt + 1, answeredAt),
    answered: cardsOf(blocks, answeredAt + 1, blocks.length),
  };
}

function cardsOf(
  blocks: readonly (readonly [string, string[]])[],
  from: number,
  to: number
): Card[] {
  return blocks.slice(from, to).map(([heading, body]) => parseCardBlock(heading, body));
}

/** Parse text holding exactly one card, as `open --from` reads it. */
export function parseCard(text: string): Card {
  const { prefix, blocks } = splitHeadings(text.split('\n'));
  if (prefix.some((line) => line.trim() !== '')) throw new Error('text before the card heading');
  const [only] = blocks;
  if (only === undefined || blocks.length !== 1) throw new Error('expected exactly one card');
  return parseCardBlock(only[0], only[1]);
}

function isCounted(card: Card): boolean {
  return card.state === 'ready' || card.state === 'findings';
}

/** The ❓ cell: ready and findings cards, and how many of those block a task. */
function openCell(open: readonly Card[]): string {
  const counted = open.filter((card) => isCounted(card));
  const blocking = counted.filter((card) => card.blocks.length > 0).length;
  return `${String(counted.length)} (${String(blocking)} blocking)`;
}

export function serializeCard(card: Card): string {
  const glyph = card.state === null ? '' : `${STATE_GLYPHS[card.state]} `;
  const tag =
    card.blocks.length === 0 ? '[blocks nothing]' : `[blocking ${card.blocks.join(', ')}]`;
  const fields = card.fields.map((field) => `${field.lead}${field.text}`);
  const preamble = card.preamble === '' ? [] : [card.preamble];
  return [`## ${glyph}${label(card.id)} — ${card.question} ${tag}`, ...preamble, ...fields].join(
    '\n\n'
  );
}

/** The canonical file text for a model. */
export function serializeStatus(file: StatusFile): string {
  const { chart } = file;
  const row = `| ${chart.done} | ${chart.inFlight} | ${chart.blocked} | ${chart.queued} | ${openCell(file.open)} |`;
  return `${[
    `# Status — ${file.title}`,
    `📊 ${chart.stamp}`,
    [CHART_HEADER, CHART_RULE, row].join('\n'),
    OPEN_HEADING,
    ...file.open.map((card) => serializeCard(card)),
    ANSWERED_HEADING,
    ...file.answered.map((card) => serializeCard(card)),
  ].join('\n\n')}\n`;
}
