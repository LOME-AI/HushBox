/**
 * `pnpm cards`: the orchestrator's and the card-reviewer's whole surface over a
 * run's `status.md`. Every verb takes `--run`, reads the file into the model,
 * applies one operation, and writes it back under the lock — so the file is
 * always in the canonical shape and nobody re-emits it by hand.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  readCommandLine,
  type CommandSpec,
  type FlagRecord,
  type FlagSpec,
} from '../lib/cli/command-line.js';
import { isMainModule } from '../lib/cli/is-main.js';
import { runMain } from '../lib/cli/run-main.js';
import { label, parseCard, serializeStatus, type CardState, type StatusFile } from './format.js';
import {
  answerCard,
  checkStatus,
  editField,
  emptyStatus,
  listLines,
  openCard,
  openFromCard,
  pendingCards,
  reopenCard,
  setChart,
  setState,
  setTitle,
  showCard,
  supersedeCard,
  titleLine,
  unrecordedAnswer,
  withdrawCard,
  type FieldEdit,
  type ListFilter,
  type TitleChange,
} from './operations.js';
import { appendLedger, createStatus, loadStatus, saveStatus, withStatusLock } from './store.js';

const RUN: FlagSpec = {
  flag: '--run',
  kind: 'value',
  summary: 'The run directory holding status.md.',
  placeholder: '<dir>',
};

const TEXT_HINT =
  'A literal, or @<path> to read a file; a value opening with a dash needs --flag=value.';

function text(flag: string, summary: string): FlagSpec {
  return { flag, kind: 'value', summary: `${summary} ${TEXT_HINT}`, placeholder: '<text>' };
}

const ID_POSITIONAL = {
  kind: 'many',
  placeholder: '<Q-ID>',
  summary: 'The card, as Q7 or 7.',
} as const;

const SUBCOMMANDS = {
  create: {
    command: 'pnpm cards create',
    summary: "The run's status.md, with the chart and no cards; refuses a run that has one.",
    flags: [RUN, text('--title', "The file's title; the run directory's name when omitted.")],
    positionals: { kind: 'none' },
  },
  open: {
    command: 'pnpm cards open',
    summary: 'Open a drafting card at the top of Open and print its Q-ID.',
    flags: [
      RUN,
      text('--title', 'The question, with its concrete nouns.'),
      {
        flag: '--blocks',
        kind: 'list',
        summary: 'A task the card blocks; repeatable.',
        placeholder: '<task>',
      },
      text('--problem', 'The Problem field.'),
      text('--recommendation', 'The Recommendation field.'),
      text('--decision', 'The Decision field.'),
      text('--alternatives', 'The Alternatives field.'),
      {
        flag: '--from',
        kind: 'value',
        summary: 'A file holding one drafted card instead of the field flags.',
        placeholder: '<path>',
      },
    ],
    positionals: { kind: 'none' },
  },
  list: {
    command: 'pnpm cards list',
    summary:
      'One line per open card; --ready for the cards the human answers, --answered for the record.',
    flags: [
      RUN,
      { flag: '--ready', kind: 'boolean', summary: 'Only ✅ and ⚠️ cards.' },
      {
        flag: '--answered',
        kind: 'boolean',
        summary: 'The Answered section, each with its answer.',
      },
    ],
    positionals: { kind: 'none' },
    effect: 'reports',
  },
  show: {
    command: 'pnpm cards show',
    summary: 'Print one card as written, or one of its fields.',
    flags: [
      RUN,
      { flag: '--field', kind: 'value', summary: 'Print only this field.', placeholder: '<name>' },
      {
        flag: '--blind',
        kind: 'boolean',
        summary: 'The title line and the Problem only, so a reviewer can form its own view first.',
      },
    ],
    positionals: ID_POSITIONAL,
    effect: 'reports',
  },
  edit: {
    command: 'pnpm cards edit',
    summary:
      'Change one field of one open card: --text replaces it, --replace/--with swaps one exact string, --append adds a paragraph, --remove deletes it.',
    flags: [
      RUN,
      {
        flag: '--field',
        kind: 'value',
        summary: 'Problem, Recommendation, Decision, or Alternatives.',
        placeholder: '<name>',
      },
      text('--text', 'The whole new field.'),
      text('--replace', 'An exact string occurring once in the field.'),
      text('--with', 'Its replacement.'),
      text('--append', 'A paragraph to add at the end.'),
      {
        flag: '--remove',
        kind: 'boolean',
        summary:
          'Delete the field; refused unless the card carries it, edit writes it, and the card still holds its shape without it.',
      },
    ],
    positionals: ID_POSITIONAL,
  },
  title: {
    command: 'pnpm cards title',
    summary:
      "Reframe an open card's question or set which tasks it blocks; its glyph and Q-ID stay.",
    flags: [
      RUN,
      text('--text', 'The question, with its concrete nouns.'),
      {
        flag: '--blocks',
        kind: 'list',
        summary: 'A task the card blocks, replacing the whole tag; repeatable.',
        placeholder: '<task>',
      },
      { flag: '--unblock', kind: 'boolean', summary: 'Clear the blocking tag.' },
    ],
    positionals: ID_POSITIONAL,
  },
  state: {
    command: 'pnpm cards state',
    summary:
      "Set a card's glyph: review, ready, or findings (which files --text under the card's last canonical field).",
    flags: [RUN, text('--text', "The reviewer's open findings; findings only.")],
    positionals: {
      kind: 'many',
      placeholder: '<Q-ID> <state>',
      summary: 'The card and one of: review, ready, findings.',
    },
  },
  answer: {
    command: 'pnpm cards answer',
    summary:
      'Record the ruling and move the card whole to Answered; the ruling also lands on ledger.md.',
    flags: [
      RUN,
      text('--text', 'The answer verbatim; omitted, the Answer line the human wrote in the file.'),
      text('--work', 'Where the work landed.'),
    ],
    positionals: ID_POSITIONAL,
  },
  pending: {
    command: 'pnpm cards pending',
    summary: 'Open cards whose Answer line the human has filled in the file.',
    flags: [RUN],
    positionals: { kind: 'none' },
    effect: 'reports',
  },
  reopen: {
    command: 'pnpm cards reopen',
    summary: 'Move an answered card back to Open with a correction folded into its Problem.',
    flags: [RUN, text('--correction', 'What was false and what is true instead.')],
    positionals: ID_POSITIONAL,
  },
  supersede: {
    command: 'pnpm cards supersede',
    summary: 'A later ruling on an answered card, appended beneath the first.',
    flags: [
      RUN,
      text('--text', 'The new answer verbatim.'),
      text('--work', 'Where the new work landed.'),
    ],
    positionals: ID_POSITIONAL,
  },
  withdraw: {
    command: 'pnpm cards withdraw',
    summary:
      'Collapse a card whose premise turned out false to that one line and move it to Answered; the reason also lands on ledger.md.',
    flags: [RUN, text('--reason', 'What turned out false.')],
    positionals: ID_POSITIONAL,
  },
  check: {
    command: 'pnpm cards check',
    summary: "Validate the file's shape; prints ok or fails naming each defect.",
    flags: [RUN],
    positionals: { kind: 'none' },
    effect: 'reports',
  },
  chart: {
    command: 'pnpm cards chart',
    summary:
      'The progress chart: set writes the task cells and stamp, idle marks the stamp idle, show prints the block. The ❓ cell is derived.',
    flags: [
      RUN,
      {
        flag: '--stamp',
        kind: 'value',
        summary: 'The trigger, or for idle what every blocked unit waits on.',
        placeholder: '<text>',
      },
      { flag: '--done', kind: 'value', summary: 'Count of clean tasks.', placeholder: '<n>' },
      {
        flag: '--in-flight',
        kind: 'value',
        summary: 'Units dispatched, ×N for fix cycles.',
        placeholder: '<units>',
      },
      {
        flag: '--blocked',
        kind: 'value',
        summary: 'Units and what each waits on.',
        placeholder: '<units>',
      },
      {
        flag: '--queued',
        kind: 'value',
        summary: 'Count of tasks not yet ready.',
        placeholder: '<n>',
      },
    ],
    positionals: {
      kind: 'many',
      placeholder: '<set|idle|show>',
      summary: 'What to do with the chart.',
    },
  },
} as const satisfies Record<string, CommandSpec>;

export const SUBCOMMAND_LINES: Readonly<Record<string, CommandSpec>> = SUBCOMMANDS;

export const COMMAND_LINE = {
  command: 'pnpm cards',
  summary: `The status.md cards of one run. Commands: ${Object.keys(SUBCOMMANDS).join(', ')}.`,
  flags: [],
  positionals: {
    kind: 'many',
    placeholder: '<command>',
    summary: `One of: ${Object.keys(SUBCOMMANDS).join(', ')}. Each takes its own --help.`,
  },
} as const satisfies CommandSpec;

type Verb = keyof typeof SUBCOMMANDS;

type Log = (line: string) => void;

function isVerb(word: string | undefined): word is Verb {
  return word !== undefined && word in SUBCOMMANDS;
}

function optional(flags: FlagRecord, name: string): string | undefined {
  const value = flags[name];
  if (typeof value !== 'string') return undefined;
  return value.startsWith('@')
    ? readFileSync(path.resolve(value.slice(1)), 'utf8').replace(/\n$/u, '')
    : value;
}

function required(flags: FlagRecord, name: string): string {
  const value = optional(flags, name);
  if (value === undefined || value === '') throw new Error(`Missing required flag: ${name}`);
  return value;
}

/** A `list` flag's values. Every flag this reads is declared `list`, so the parse yields an array. */
function listedValues(flags: FlagRecord, name: string): readonly string[] {
  const value = flags[name];
  /* v8 ignore next -- the empty arm answers a shape no declared grammar produces */
  return typeof value === 'object' ? value : [];
}

function parseId(token: string | undefined): number {
  const match = /^Q?(\d+)$/u.exec(token ?? '');
  if (match === null) throw new Error(`expected a Q-ID such as Q7, got ${token ?? 'nothing'}`);
  return Number(match[1]);
}

const STATES: readonly CardState[] = ['review', 'ready', 'findings'];

function parseState(token: string | undefined): CardState {
  const state = STATES.find((candidate) => candidate === token);
  if (state === undefined)
    throw new Error(`expected one of ${STATES.join(', ')}, got ${token ?? 'nothing'}`);
  return state;
}

function editFrom(flags: FlagRecord): FieldEdit {
  const forms: FieldEdit[] = [];
  const whole = optional(flags, '--text');
  const old = optional(flags, '--replace');
  const append = optional(flags, '--append');
  if (whole !== undefined) forms.push({ kind: 'text', text: whole });
  if (old !== undefined) forms.push({ kind: 'replace', old, with: required(flags, '--with') });
  if (append !== undefined) forms.push({ kind: 'append', text: append });
  if (flags['--remove'] === true) forms.push({ kind: 'remove' });
  const [form] = forms;
  if (form === undefined || forms.length !== 1)
    throw new Error('edit takes exactly one of --text, --replace/--with, --append, --remove');
  return form;
}

function draftFrom(flags: FlagRecord): (file: StatusFile) => { file: StatusFile; id: number } {
  const from = optional(flags, '--from');
  if (from !== undefined) {
    const drafted = parseCard(readFileSync(path.resolve(from), 'utf8'));
    return (file) => openFromCard(file, drafted);
  }
  const draft = {
    question: required(flags, '--title'),
    blocks: listedValues(flags, '--blocks'),
    problem: required(flags, '--problem'),
    recommendation: required(flags, '--recommendation'),
    decision: required(flags, '--decision'),
    alternatives: optional(flags, '--alternatives'),
  };
  return (file) => openCard(file, draft);
}

/** The title change a line asks for, or a refusal naming the flags that carry one. */
function titleChange(flags: FlagRecord): TitleChange {
  const named = listedValues(flags, '--blocks');
  const unblock = flags['--unblock'] === true;
  if (named.length > 0 && unblock) {
    throw new Error('--blocks and --unblock name opposite tags; pass one of them');
  }
  const question = optional(flags, '--text');
  // `named` is empty whenever `unblock` holds, which the guard above is what makes true.
  const blocks = named.length > 0 || unblock ? named : undefined;
  if (question === undefined && blocks === undefined) {
    throw new Error('title takes --text, --blocks, or --unblock');
  }
  return { question, blocks };
}

/**
 * A card as a reviewer may first see it: the heading line and the Problem, so
 * the view it forms is its own. The Recommendation is what withholding this
 * way is for, and the heading is the serialized card's first line.
 */
function blindCard(file: StatusFile, id: number): string {
  const [heading = ''] = showCard(file, id).split('\n');
  return `${heading}\n\n${showCard(file, id, 'Problem')}`;
}

function listFilter(flags: FlagRecord): ListFilter {
  if (flags['--ready'] === true) return 'ready';
  if (flags['--answered'] === true) return 'answered';
  return 'open';
}

async function chart(
  runDir: string,
  flags: FlagRecord,
  word: string | undefined,
  log: Log
): Promise<void> {
  const file = await loadStatus(runDir);
  switch (word) {
    case 'show': {
      log(`📊 ${file.chart.stamp}`);
      log(serializeStatus(file).split('\n\n')[2] ?? '');
      return;
    }
    case 'set': {
      const cells = {
        stamp: required(flags, '--stamp'),
        done: required(flags, '--done'),
        inFlight: required(flags, '--in-flight'),
        blocked: required(flags, '--blocked'),
        queued: required(flags, '--queued'),
      };
      await saveStatus(runDir, setChart(file, cells));
      return;
    }
    case 'idle': {
      await saveStatus(
        runDir,
        setChart(file, { ...file.chart, stamp: required(flags, '--stamp') }, true)
      );
      return;
    }
    default: {
      throw new Error(`chart takes set, idle, or show, got ${word ?? 'nothing'}`);
    }
  }
}

async function mutate(runDir: string, change: (file: StatusFile) => StatusFile): Promise<void> {
  await saveStatus(runDir, change(await loadStatus(runDir)));
}

async function rule(
  runDir: string,
  change: (file: StatusFile) => { file: StatusFile; ledgerLine: string }
): Promise<void> {
  const { file, ledgerLine } = change(await loadStatus(runDir));
  await saveStatus(runDir, file);
  await appendLedger(runDir, ledgerLine);
}

interface Invocation {
  readonly runDir: string;
  readonly flags: FlagRecord;
  readonly positionals: readonly string[];
  readonly log: Log;
}

type Handler = (invocation: Invocation) => Promise<void>;

/** One handler per verb, keyed so a verb the grammar gains without one fails to compile. */
const HANDLERS: Readonly<Record<Verb, Handler>> = {
  async create({ runDir, flags }) {
    const given = optional(flags, '--title');
    await createStatus(
      runDir,
      emptyStatus(given === undefined || given === '' ? path.basename(runDir) : given)
    );
  },
  async open({ runDir, flags, log }) {
    const open = draftFrom(flags);
    let id = 0;
    await mutate(runDir, (file) => {
      const opened = open(file);
      id = opened.id;
      return opened.file;
    });
    log(label(id));
  },
  async list({ runDir, flags, log }) {
    for (const line of listLines(await loadStatus(runDir), listFilter(flags))) log(line);
  },
  async show({ runDir, flags, positionals, log }) {
    const field = optional(flags, '--field');
    const blind = flags['--blind'] === true;
    if (blind && field !== undefined) throw new Error('show takes --blind or --field, not both');
    const file = await loadStatus(runDir);
    const id = parseId(positionals[0]);
    log(blind ? blindCard(file, id) : showCard(file, id, field));
  },
  async edit({ runDir, flags, positionals }) {
    const edit = editFrom(flags);
    await mutate(runDir, (file) =>
      editField(file, parseId(positionals[0]), required(flags, '--field'), edit)
    );
  },
  async title({ runDir, flags, positionals }) {
    const change = titleChange(flags);
    await mutate(runDir, (file) => setTitle(file, parseId(positionals[0]), change));
  },
  async state({ runDir, flags, positionals }) {
    await mutate(runDir, (file) =>
      setState(file, parseId(positionals[0]), parseState(positionals[1]), optional(flags, '--text'))
    );
  },
  async answer({ runDir, flags, positionals }) {
    await rule(runDir, (file) =>
      answerCard(file, parseId(positionals[0]), {
        text: optional(flags, '--text'),
        work: required(flags, '--work'),
      })
    );
  },
  async pending({ runDir, log }) {
    for (const card of pendingCards(await loadStatus(runDir)))
      log(`${titleLine(card)} → ${unrecordedAnswer(card) ?? ''}`);
  },
  async reopen({ runDir, flags, positionals }) {
    await mutate(runDir, (file) =>
      reopenCard(file, parseId(positionals[0]), required(flags, '--correction'))
    );
  },
  async supersede({ runDir, flags, positionals }) {
    await rule(runDir, (file) =>
      supersedeCard(file, parseId(positionals[0]), {
        text: required(flags, '--text'),
        work: required(flags, '--work'),
      })
    );
  },
  async withdraw({ runDir, flags, positionals }) {
    await rule(runDir, (file) =>
      withdrawCard(file, parseId(positionals[0]), required(flags, '--reason'))
    );
  },
  async check({ runDir, log }) {
    const problems = checkStatus(await loadStatus(runDir));
    if (problems.length > 0) throw new Error(problems.join('\n'));
    log('ok');
  },
  chart({ runDir, flags, positionals, log }) {
    return chart(runDir, flags, positionals[0], log);
  },
};

/** One invocation. Prints through `log`; throws on any refusal. */
export async function main(argv: readonly string[], log: Log): Promise<void> {
  const [word, ...rest] = argv;
  const usage = (line: string): void => {
    log(line.replace(/\n$/u, ''));
  };
  if (!isVerb(word)) {
    if (readCommandLine(COMMAND_LINE, argv, usage) === null) return;
    throw new Error(word === undefined ? 'Missing command' : `Unknown command: ${word}`);
  }
  const parsed = readCommandLine(SUBCOMMANDS[word] as CommandSpec, rest, usage);
  if (parsed === null) return;
  const runDir = optional(parsed.flags, '--run');
  if (runDir === undefined) throw new Error('Missing required flag: --run');
  const invocation: Invocation = {
    runDir: path.resolve(runDir),
    flags: parsed.flags,
    positionals: parsed.positionals,
    log,
  };
  const act = (): Promise<void> => HANDLERS[word](invocation);
  const reads = SUBCOMMAND_LINES[word]?.effect === 'reports';
  await (reads ? act() : withStatusLock(invocation.runDir, act));
}

/* v8 ignore start -- CLI entry point; the verbs are driven through main() */
if (isMainModule(import.meta.url)) {
  await runMain(() =>
    main(process.argv.slice(2), (line) => {
      process.stdout.write(`${line}\n`);
    })
  );
}
/* v8 ignore stop */
