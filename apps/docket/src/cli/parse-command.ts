import { FINDING_STATES, PROGRESS_STATUSES, SEVERITIES } from '@hushbox/docket/types';
import { SECTIONS } from '../components/shell/logic/sections';
import type { SectionId } from '../components/shell/logic/sections';
import type { FindingState, ProgressStatus, Severity } from '@hushbox/docket/types';

/**
 * The queues, derived rather than listed: a whole-audit section reads every
 * finding the filters admit, so its predicate answers a different question and
 * naming it here would return the wrong set under a filter's name.
 */
const QUEUE_SECTIONS: readonly SectionId[] = SECTIONS.filter((section) => !section.wholeAudit).map(
  (section) => section.id
);

export interface ConsoleCommand {
  readonly kind: 'console';
}

/** Which findings an action reads. Shared so `--list` and `--census` scope alike. */
export interface FindingFilters {
  readonly id: string | null;
  readonly state: FindingState | null;
  /** One of the console's queues, read through that queue's own predicate. */
  readonly section: SectionId | null;
  readonly area: string | null;
  readonly severity: Severity | null;
  readonly progress: ProgressStatus | null;
}

export interface ListCommand extends FindingFilters {
  readonly kind: 'list';
  readonly audit: string | null;
  readonly brief: boolean;
  readonly contest: boolean;
}

export interface CensusCommand extends FindingFilters {
  readonly kind: 'census';
  readonly audit: string | null;
}

export interface QuestionsCommand extends FindingFilters {
  readonly kind: 'questions';
  readonly audit: string | null;
}

export interface SetCommand {
  readonly kind: 'set';
  readonly audit: string | null;
  readonly id: string;
  readonly field: string;
  readonly value: string;
}

export interface NoteCommand {
  readonly kind: 'note';
  readonly audit: string | null;
  readonly id: string;
  readonly text: string;
}

export interface AnswerCommand {
  readonly kind: 'answer';
  readonly audit: string | null;
  readonly id: string;
  readonly text: string;
  readonly index: number | null;
}

/**
 * What every action taken on a human's behalf carries. The mandate is their own
 * words: the write lands as the human writer, so the text is the only record of
 * what they actually decided.
 */
interface MandatedCommand {
  readonly audit: string | null;
  readonly id: string;
  readonly mandate: string;
}

/**
 * A dedication decision riding the write that took it, so the finding is never
 * decided and unmarked in between. Absent is not false: the store reads a patch
 * by its keys, so a write naming the field is fenced on it and would refuse a
 * decision that raced a mark nobody was arguing about.
 */
interface DedicationRider {
  readonly dedicated?: boolean;
}

export interface RuleCommand extends MandatedCommand, DedicationRider {
  readonly kind: 'rule';
  /** The id of the option the ruling picks, as the finding names it. */
  readonly option: string;
  /**
   * What was decided, which outranks the chosen option's own prose and is the
   * only way to record a decision none of the options carries. Absent when the
   * option is the whole of it; the mandate is a different channel, saying whose
   * decision it was rather than what it was.
   */
  readonly text?: string;
}

export interface DenyCommand extends MandatedCommand {
  readonly kind: 'deny';
}

export interface AskCommand extends MandatedCommand {
  readonly kind: 'ask';
  readonly text: string;
}

export interface WithdrawCommand extends MandatedCommand {
  readonly kind: 'withdraw';
  /** The question's position in the finding, which is how the store names one. */
  readonly index: number;
}

export interface DedicateCommand extends MandatedCommand {
  readonly kind: 'dedicate';
  readonly dedicated: boolean;
}

export interface VerifyCommand extends MandatedCommand {
  readonly kind: 'verify';
  readonly verified: boolean;
}

export interface ReopenCommand extends MandatedCommand {
  readonly kind: 'reopen';
}

/**
 * Where the work has got to, moved by the reader rather than reported by the
 * agent. `--set progress.status=` writes the same field as the agent's own
 * report; this is the other writer, saying where they are putting the work.
 */
export interface MoveCommand extends MandatedCommand {
  readonly kind: 'move';
  readonly status: ProgressStatus;
}

/** The mandate is the whole of a remark, as it is for an unblocking. */
export interface RemarkCommand extends MandatedCommand {
  readonly kind: 'remark';
}

/** The mandate is the answer the work stopped for, so it is also the note. */
export interface UnblockCommand extends MandatedCommand, DedicationRider {
  readonly kind: 'unblock';
}

export interface ValidateCommand {
  readonly kind: 'validate';
  readonly audit: string | null;
}

export interface HelpCommand {
  readonly kind: 'help';
}

export type Command =
  | ConsoleCommand
  | ListCommand
  | CensusCommand
  | QuestionsCommand
  | SetCommand
  | NoteCommand
  | AnswerCommand
  | RuleCommand
  | DenyCommand
  | ReopenCommand
  | UnblockCommand
  | AskCommand
  | WithdrawCommand
  | DedicateCommand
  | VerifyCommand
  | MoveCommand
  | RemarkCommand
  | ValidateCommand
  | HelpCommand;

export type ActionKind = Exclude<Command['kind'], 'console'>;

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

/** Every action, in the order `--help` prints them. */
export const KIND_BY_ACTION = {
  '--list': 'list',
  '--census': 'census',
  '--questions': 'questions',
  '--set': 'set',
  '--note': 'note',
  '--answer': 'answer',
  '--rule': 'rule',
  '--deny': 'deny',
  '--reopen': 'reopen',
  '--unblock': 'unblock',
  '--ask': 'ask',
  '--withdraw': 'withdraw',
  '--dedicate': 'dedicate',
  '--verify': 'verify',
  // Not `--progress`, which is the listing filter and would read
  // `--list --progress=blocked` as two actions; the store's own words for what
  // this does are that the agent reports where it got to and the human moves it
  // on. Not `--status` either: that is the finding's own human-owned field.
  '--move': 'move',
  '--remark': 'remark',
  '--validate': 'validate',
  '--help': 'help',
} as const satisfies Record<string, ActionKind>;

const KIND_BY_FLAG = new Map<string, ActionKind>(Object.entries(KIND_BY_ACTION));

/** Flags carrying no value; everything else known takes one. */
const BARE_FLAGS = new Set(['--brief', '--contest', ...Object.keys(KIND_BY_ACTION)]);
/**
 * The flags whose value is open, and how that value reads. The placeholder is
 * stated here rather than at the render, so a value with a shape worth knowing —
 * a dated audit name, a whole number — says so wherever it is printed.
 */
export const OPEN_VALUES = {
  '--audit': '<name>',
  '--id': '<ID>',
  '--area': '<path>',
  '--index': '<n>',
  '--mandate': '"<text>"',
  '--text': '"<what was decided>"',
} as const;

/**
 * What a value is for, where "needs a value" leaves the reader with nothing to
 * act on. One statement per flag, so a value that is missing and a value that is
 * blank are refused in the same words.
 */
const REQUIRED = {
  '--mandate':
    "--mandate needs the human's own words: a mandated action records their decision on the finding, and an agent has none of its own to write there",
} as const;

/** The same words for a flag left out and a flag left blank. */
const PURPOSE_BY_FLAG = new Map<string, string>(Object.entries(REQUIRED));

/**
 * The flags an action cannot run without, kept above with what each is for so
 * one cannot be required without saying why. Which actions they bind is read off
 * `ALLOWED_FLAGS`, so an action takes the requirement on by taking the flag on
 * and there is no second list of who is required to carry what.
 */
export const REQUIRED_FLAGS: readonly string[] = Object.keys(REQUIRED);

/**
 * The flags whose value is a closed set, and the set. One statement: the parser
 * refuses by it and `--help` prints it, so what a flag accepts and what the CLI
 * says it accepts cannot come apart.
 */
export const ENUM_FLAGS = {
  '--state': FINDING_STATES,
  '--section': QUEUE_SECTIONS,
  '--severity': SEVERITIES,
  '--progress': PROGRESS_STATUSES,
  '--dedicated': ['true', 'false'],
} as const;

/** Every flag taking a value, which is exactly the two sets above. */
const VALUE_FLAGS = new Set<string>([...Object.keys(ENUM_FLAGS), ...Object.keys(OPEN_VALUES)]);

const FILTER_FLAGS = [
  '--id',
  '--state',
  '--section',
  '--area',
  '--severity',
  '--progress',
] as const;

/**
 * Pairs that say the same thing twice, where disagreeing is meaningless: a
 * section is a state's queue read through the console's own predicate, and a
 * contest is the brief with the options the brief leaves out.
 */
export const EXCLUSIVE: readonly (readonly [string, string])[] = [
  ['--section', '--state'],
  ['--brief', '--contest'],
];

export const ALLOWED_FLAGS: Record<ActionKind, readonly string[]> = {
  list: ['--list', '--audit', '--brief', '--contest', ...FILTER_FLAGS],
  census: ['--census', '--audit', ...FILTER_FLAGS],
  questions: ['--questions', '--audit', ...FILTER_FLAGS],
  set: ['--set', '--audit'],
  note: ['--note', '--audit'],
  answer: ['--answer', '--audit', '--index'],
  rule: ['--rule', '--audit', '--mandate', '--text', '--dedicated'],
  deny: ['--deny', '--audit', '--mandate'],
  reopen: ['--reopen', '--audit', '--mandate'],
  unblock: ['--unblock', '--audit', '--mandate', '--dedicated'],
  ask: ['--ask', '--audit', '--mandate'],
  withdraw: ['--withdraw', '--audit', '--mandate'],
  dedicate: ['--dedicate', '--audit', '--mandate'],
  verify: ['--verify', '--audit', '--mandate'],
  move: ['--move', '--audit', '--mandate'],
  remark: ['--remark', '--audit', '--mandate'],
  validate: ['--validate', '--audit'],
  help: ['--help'],
};

/**
 * What an action takes after its own flag, written as its usage line reads it.
 * One statement: `--help` prints it and the usage errors below are composed from
 * it, so the shape the CLI publishes is the shape it enforces.
 */
export const ARGUMENTS: Record<ActionKind, { readonly count: number; readonly shape: string }> = {
  list: { count: 0, shape: '' },
  census: { count: 0, shape: '' },
  questions: { count: 0, shape: '' },
  set: { count: 2, shape: '<ID> field=value' },
  note: { count: 2, shape: '<ID> "<text>"' },
  answer: { count: 2, shape: '<ID> "<text>"' },
  rule: { count: 2, shape: '<ID> <option>' },
  deny: { count: 1, shape: '<ID>' },
  reopen: { count: 1, shape: '<ID>' },
  unblock: { count: 1, shape: '<ID>' },
  ask: { count: 2, shape: '<ID> "<question>"' },
  withdraw: { count: 2, shape: '<ID> <n>' },
  dedicate: { count: 2, shape: '<ID> true|false' },
  verify: { count: 2, shape: '<ID> true|false' },
  move: { count: 2, shape: `<ID> ${PROGRESS_STATUSES.join('|')}` },
  remark: { count: 1, shape: '<ID>' },
  validate: { count: 0, shape: '' },
  help: { count: 0, shape: '' },
};

function misuse(kind: ActionKind): CliUsageError {
  const { count, shape } = ARGUMENTS[kind];
  return new CliUsageError(
    count === 0 ? `--${kind} takes no arguments` : `--${kind} needs ${shape}`
  );
}

interface Draft {
  readonly values: Map<string, string>;
  readonly used: Set<string>;
  readonly positionals: string[];
}

function readFlag(token: string): { flag: string; inline: string | null } {
  const equals = token.indexOf('=');
  return equals === -1
    ? { flag: token, inline: null }
    : { flag: token.slice(0, equals), inline: token.slice(equals + 1) };
}

function needsValue(flag: string): CliUsageError {
  return new CliUsageError(PURPOSE_BY_FLAG.get(flag) ?? `${flag} needs a value`);
}

function readValue(flag: string, inline: string | null, rest: string[]): string {
  const value = inline ?? rest.shift() ?? '';
  if (value === '') throw needsValue(flag);
  return value;
}

/**
 * An unknown flag is collected rather than rejected here, so the refusal comes
 * from the chosen action's own flag set and reads as "does not apply to
 * --list". That also keeps the console's flags out of this file: with no action
 * flag present the whole argv goes to the launcher, which is the one authority
 * on what `--port` and `--idle` mean.
 */
function tokenize(argv: readonly string[]): Draft {
  const rest = [...argv];
  const draft: Draft = { values: new Map(), used: new Set(), positionals: [] };

  for (let token = rest.shift(); token !== undefined; token = rest.shift()) {
    if (!token.startsWith('--')) {
      draft.positionals.push(token);
      continue;
    }

    const { flag, inline } = readFlag(token);
    draft.used.add(flag);

    if (BARE_FLAGS.has(flag)) {
      if (inline !== null) throw new CliUsageError(`${flag} takes no value`);
    } else if (VALUE_FLAGS.has(flag)) {
      draft.values.set(flag, readValue(flag, inline, rest));
    }
  }

  return draft;
}

function actionKind(argv: readonly string[]): ActionKind | null {
  const kinds = [...new Set(argv.map((token) => readFlag(token).flag))]
    .map((flag) => KIND_BY_FLAG.get(flag))
    .filter((kind) => kind !== undefined);

  if (kinds.length > 1) {
    const named = kinds.map((kind) => '--' + kind).join(' and ');
    throw new CliUsageError(`use one action at a time, not ${named}`);
  }
  return kinds[0] ?? null;
}

function checkFlags(kind: ActionKind, used: Set<string>): void {
  const allowed = ALLOWED_FLAGS[kind];
  for (const flag of used) {
    if (!allowed.includes(flag)) {
      throw new CliUsageError(`${flag} does not apply to --${kind}`);
    }
  }
}

function checkExclusive(used: Set<string>): void {
  for (const [one, other] of EXCLUSIVE) {
    if (used.has(one) && used.has(other)) {
      throw new CliUsageError(`${one} and ${other} say the same thing; use one of them`);
    }
  }
}

function noArguments(kind: ActionKind, positionals: readonly string[]): void {
  if (positionals.length > 0) throw misuse(kind);
}

function oneArgument(kind: ActionKind, positionals: readonly string[]): string {
  const [id] = positionals;
  if (id === undefined || positionals.length > 1) throw misuse(kind);
  return id;
}

function twoArguments(kind: ActionKind, positionals: readonly string[]): [string, string] {
  const [id, text] = positionals;
  if (id === undefined || text === undefined || positionals.length > 2) {
    throw misuse(kind);
  }
  return [id, text];
}

function oneOf<TValue extends string>(
  flag: string,
  raw: string | undefined,
  values: readonly TValue[]
): TValue | null {
  if (raw === undefined) return null;
  const match = values.find((value) => value === raw);
  if (match === undefined) {
    throw new CliUsageError(`${flag} must be one of ${values.join(', ')}`);
  }
  return match;
}

function wholeNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new CliUsageError(`--index needs a whole number, got "${raw}"`);
  }
  return value;
}

/**
 * A closed set an argument stands in, refused in the shape the action publishes
 * rather than in a sentence of its own: the shape already names both values, and
 * a second wording of them could disagree with it.
 */
function yesOrNo(kind: ActionKind, raw: string): boolean {
  if (raw !== 'true' && raw !== 'false') throw misuse(kind);
  return raw === 'true';
}

/**
 * A closed set an argument stands in, taken from the set itself so what the
 * action accepts and what its shape publishes cannot come apart, and refused in
 * that shape rather than in a sentence of its own.
 */
function fromSet<TValue extends string>(
  kind: ActionKind,
  raw: string,
  values: readonly TValue[]
): TValue {
  const match = values.find((value) => value === raw);
  if (match === undefined) throw misuse(kind);
  return match;
}

/**
 * A positional the finding will carry as prose, held to what the flags carrying
 * prose are held to: trimmed, and blank refused in the shape the action
 * publishes rather than in a sentence of its own.
 */
function freeText(kind: ActionKind, raw: string): string {
  const text = raw.trim();
  if (text === '') throw misuse(kind);
  return text;
}

function position(kind: ActionKind, raw: string): number {
  if (!/^\d+$/u.test(raw)) throw misuse(kind);
  return Number(raw);
}

/**
 * An empty value is refused rather than passed through: no field this writes
 * takes an empty string, and the store reads a patch by its keys, so
 * `progress=` would name no field at all and be reported as a write that
 * happened.
 */
function assignment(raw: string): { field: string; value: string } {
  const equals = raw.indexOf('=');
  if (equals < 1)
    throw new CliUsageError('--set needs field=value, for example progress.status=done');
  const value = raw.slice(equals + 1);
  if (value === '')
    throw new CliUsageError('--set needs a value, for example progress.status=done');
  return { field: raw.slice(0, equals), value };
}

/**
 * A flag the action cannot run without, refused in the words that say what it is
 * for rather than that it is absent. Whitespace is no answer either: the text is
 * written to the finding, and a blank one would record a decision nobody made.
 */
function requiredValue(flag: string, purpose: string, draft: Draft): string {
  const value = (draft.values.get(flag) ?? '').trim();
  if (value === '') throw new CliUsageError(purpose);
  return value;
}

/**
 * A flag the action runs with or without. It is left out of the command rather
 * than carried as an empty value, so what the writer did not say stays unsaid.
 * Blank is refused in the words an empty value is refused in: the text is
 * written to the finding, and whitespace would record a decision nobody made.
 */
function rulingText(draft: Draft): { readonly text?: string } {
  const raw = draft.values.get('--text');
  if (raw === undefined) return {};
  const text = raw.trim();
  if (text === '') throw needsValue('--text');
  return { text };
}

/** Left out of the command when the flag was, for the reason the rider states. */
function dedication(draft: Draft): DedicationRider {
  const raw = oneOf('--dedicated', draft.values.get('--dedicated'), ENUM_FLAGS['--dedicated']);
  return raw === null ? {} : { dedicated: raw === 'true' };
}

/** Read from the two tables, so no action carries its own idea of what it needs. */
function checkRequired(kind: ActionKind, draft: Draft): void {
  for (const [flag, purpose] of Object.entries(REQUIRED)) {
    if (ALLOWED_FLAGS[kind].includes(flag)) requiredValue(flag, purpose, draft);
  }
}

function filters(draft: Draft): FindingFilters {
  return {
    id: draft.values.get('--id') ?? null,
    state: oneOf('--state', draft.values.get('--state'), ENUM_FLAGS['--state']),
    section: oneOf('--section', draft.values.get('--section'), ENUM_FLAGS['--section']),
    area: draft.values.get('--area') ?? null,
    severity: oneOf('--severity', draft.values.get('--severity'), ENUM_FLAGS['--severity']),
    progress: oneOf('--progress', draft.values.get('--progress'), ENUM_FLAGS['--progress']),
  };
}

function auditOf(draft: Draft): string | null {
  return draft.values.get('--audit') ?? null;
}

/** The actions that read, which are the ones taking no argument of their own. */
type ReadingKind =
  | ListCommand['kind']
  | CensusCommand['kind']
  | QuestionsCommand['kind']
  | ValidateCommand['kind']
  | HelpCommand['kind'];

/** The writes an agent makes on its own account. */
type AgentWriteKind = SetCommand['kind'] | NoteCommand['kind'] | AnswerCommand['kind'];

/** The actions taken on a human's behalf, read off the commands that carry one. */
type MandatedKind = Extract<Command, { mandate: string }>['kind'];

function buildReading(kind: ReadingKind, draft: Draft): Command {
  noArguments(kind, draft.positionals);
  if (kind === 'help') return { kind };

  const audit = auditOf(draft);
  if (kind === 'validate') return { kind, audit };
  if (kind === 'list') {
    return {
      kind,
      audit,
      brief: draft.used.has('--brief'),
      contest: draft.used.has('--contest'),
      ...filters(draft),
    };
  }
  return { kind, audit, ...filters(draft) };
}

function buildAgentWrite(kind: AgentWriteKind, draft: Draft): Command {
  const audit = auditOf(draft);
  const [id, text] = twoArguments(kind, draft.positionals);
  if (kind === 'set') return { kind, audit, id, ...assignment(text) };
  if (kind === 'note') return { kind, audit, id, text };
  return { kind, audit, id, text, index: wholeNumber(draft.values.get('--index')) };
}

function buildMandated(kind: MandatedKind, draft: Draft): Command {
  const audit = auditOf(draft);
  const mandate = requiredValue('--mandate', REQUIRED['--mandate'], draft);
  if (kind === 'deny' || kind === 'reopen' || kind === 'remark') {
    return { kind, audit, id: oneArgument(kind, draft.positionals), mandate };
  }
  if (kind === 'unblock') {
    const id = oneArgument(kind, draft.positionals);
    return { kind, audit, id, mandate, ...dedication(draft) };
  }

  const [id, text] = twoArguments(kind, draft.positionals);
  if (kind === 'rule') {
    const option = freeText(kind, text);
    return { kind, audit, id, option, mandate, ...rulingText(draft), ...dedication(draft) };
  }
  if (kind === 'ask') return { kind, audit, id, text: freeText(kind, text), mandate };
  if (kind === 'withdraw') return { kind, audit, id, index: position(kind, text), mandate };
  if (kind === 'dedicate') return { kind, audit, id, dedicated: yesOrNo(kind, text), mandate };
  if (kind === 'move') {
    return { kind, audit, id, status: fromSet(kind, text, PROGRESS_STATUSES), mandate };
  }
  return { kind, audit, id, verified: yesOrNo(kind, text), mandate };
}

/**
 * The three families, taken in turn so what is left over is the mandated set:
 * an action added to the union without a home here fails to compile rather than
 * falling through to a builder that would read it as something else.
 */
function build(kind: ActionKind, draft: Draft): Command {
  if (kind === 'set' || kind === 'note' || kind === 'answer') return buildAgentWrite(kind, draft);
  if (
    kind === 'list' ||
    kind === 'census' ||
    kind === 'questions' ||
    kind === 'validate' ||
    kind === 'help'
  ) {
    return buildReading(kind, draft);
  }
  return buildMandated(kind, draft);
}

/**
 * The whole command line, read once. No action flag means the console, and the
 * argv is passed on untouched rather than re-interpreted here.
 */
export function parseCommand(argv: readonly string[]): Command {
  const kind = actionKind(argv);
  if (kind === null) return { kind: 'console' };

  const draft = tokenize(argv);
  checkFlags(kind, draft.used);
  checkExclusive(draft.used);
  checkRequired(kind, draft);
  return build(kind, draft);
}
