/**
 * One argument grammar for every `scripts/` entry point that owns its argv.
 *
 * Shared rather than restated per script because of what a parser that ignores
 * what it does not recognise costs: the reading that drops `--help` and runs
 * the pipeline anyway also drops a misspelt real flag and runs something other
 * than what the operator asked for. On a command that ends processes or
 * recreates infrastructure, that is the whole hazard — the help text is the
 * cheap half.
 *
 * A script that forwards the argv it does not consume to another tool is not a
 * caller of this: there an unrecognised token belongs to the wrapped tool's own
 * parser, and refusing it here would break the wrapper's contract.
 */

import { messageChain, type runMain } from './run-main.ts';

/** How a flag carries its value, and therefore what the parse yields for it. */
export type FlagKind = 'boolean' | 'value' | 'list';

export interface FlagSpec {
  /** The flag as it is typed, leading dashes included. */
  readonly flag: string;
  readonly kind: FlagKind;
  /** One line for the usage listing. */
  readonly summary: string;
  /** Stands for the value in the usage listing; `value` and `list` flags only. */
  readonly placeholder?: string;
}

/** What a command does with bare arguments — those carrying no leading dash. */
export type PositionalSpec =
  | { readonly kind: 'none' }
  | { readonly kind: 'many'; readonly placeholder: string; readonly summary: string };

export interface CommandSpec {
  /** How the command is invoked, as a developer types it. */
  readonly command: string;
  readonly summary: string;
  readonly flags: readonly FlagSpec[];
  readonly positionals: PositionalSpec;
  /**
   * Declared by a command whose whole run reads and reports: it changes
   * nothing, starts nothing that outlives it, and reaches nothing outside this
   * checkout. It is what licenses a check to EXECUTE the entry point rather
   * than only inspect its grammar.
   *
   * Absent means the command can act, and absent is the default on purpose: a
   * command that ends processes or recreates infrastructure is safe to execute
   * only while its wiring holds, so a check that executed everything would
   * carry out the act on the day the wiring broke. A new command joins the
   * executed set by saying it cannot act, never by being forgotten.
   */
  readonly effect?: 'reports';
}

type ValueOfKind<K> = K extends 'boolean'
  ? boolean
  : K extends 'list'
    ? readonly string[]
    : string | undefined;

/** The parse of one spec, keyed by the spec's own flag spellings. */
export type FlagValues<S extends CommandSpec> = {
  readonly [F in S['flags'][number] as F['flag']]: ValueOfKind<F['kind']>;
};

/**
 * A parse read without one spec's literal keys, for a dispatch that holds many
 * specs at once and cannot name the one it is acting on at the type level.
 */
export type FlagRecord = Readonly<Record<string, boolean | string | readonly string[] | undefined>>;

/**
 * The two shapes a parse can take. Not exported: nothing outside this module
 * names it, and every caller reads it through {@link parseCommandLine}.
 */
type CommandLine<S extends CommandSpec> =
  | { readonly kind: 'help'; readonly usage: string }
  | {
      readonly kind: 'run';
      readonly flags: FlagValues<S>;
      readonly positionals: readonly string[];
    };

/**
 * The two spellings of a help request, recognised for every spec so that no
 * command can be written without one.
 */
const HELP_FLAGS: readonly string[] = ['--help', '-h'];

const HELP_SUMMARY = 'Print this message and exit, doing nothing else.';

/**
 * Whether a line asks for usage. Separate from the parse so a caller whose
 * refusal path is not an exception can answer the request without going
 * through one.
 */
export function isHelpRequest(argv: readonly string[]): boolean {
  return argv.some((token) => HELP_FLAGS.includes(token));
}

function flagLabel(spec: FlagSpec): string {
  return spec.placeholder === undefined ? spec.flag : `${spec.flag} ${spec.placeholder}`;
}

function listing(rows: readonly (readonly [string, string])[]): string[] {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, summary]) => `  ${label.padEnd(width)}  ${summary}`);
}

/** The usage text `--help` prints, derived from the spec rather than restated. */
export function formatUsage(spec: CommandSpec): string {
  const positionals = spec.positionals;
  const bare = positionals.kind === 'none' ? '' : ` [${positionals.placeholder}...]`;
  const options = listing([
    ...spec.flags.map((flag): readonly [string, string] => [flagLabel(flag), flag.summary]),
    [HELP_FLAGS.join(', '), HELP_SUMMARY],
  ]);
  const arguments_ =
    positionals.kind === 'none'
      ? []
      : ['', 'Arguments:', ...listing([[positionals.placeholder, positionals.summary]])];
  return [
    `Usage: ${spec.command} [options]${bare}`,
    '',
    spec.summary,
    '',
    'Options:',
    ...options,
    ...arguments_,
  ].join('\n');
}

function refuse(spec: CommandSpec, detail: string): never {
  throw new Error(
    `${spec.command}: ${detail}\n\n${formatUsage(spec)}\n\nRun \`${spec.command} --help\` for this message.`
  );
}

/** The flag a token names, and the value written into the same token, if any. */
function splitToken(token: string): { readonly name: string; readonly inline: string | undefined } {
  const equals = token.indexOf('=');
  return equals === -1
    ? { name: token, inline: undefined }
    : { name: token.slice(0, equals), inline: token.slice(equals + 1) };
}

/** What one token contributed, and how far the reader moved past it. */
interface Collected {
  readonly consumed: number;
}

/**
 * Where a parse accumulates, one entry per flag kind so the reader stays a
 * dispatch rather than a nest of conditionals.
 */
interface Accumulator {
  readonly booleans: Set<string>;
  readonly values: Map<string, string>;
  readonly lists: Map<string, string[]>;
  readonly positionals: string[];
}

/**
 * The value slot of a token that carried none. A slot holding another flag is
 * refused rather than consumed: taking it would swallow the flag as a value and
 * silently drop what the operator asked for, which is the defect this module
 * exists to close.
 */
function consumeValue(
  spec: CommandSpec,
  flag: FlagSpec,
  argv: readonly string[],
  index: number
): string {
  const next = argv[index];
  if (next === undefined || next.startsWith('-')) {
    refuse(spec, `\`${flag.flag}\` needs a value, and none followed it.`);
  }
  return next;
}

interface FlagToken {
  readonly flag: FlagSpec;
  readonly inline: string | undefined;
  readonly index: number;
}

function collectFlag(
  spec: CommandSpec,
  token: FlagToken,
  argv: readonly string[],
  into: Accumulator
): Collected {
  const { flag, inline, index } = token;
  if (flag.kind === 'boolean') {
    if (inline !== undefined) refuse(spec, `\`${flag.flag}\` takes no value.`);
    into.booleans.add(flag.flag);
    return { consumed: 1 };
  }
  const value = inline ?? consumeValue(spec, flag, argv, index + 1);
  if (flag.kind === 'list')
    into.lists.set(flag.flag, [...(into.lists.get(flag.flag) ?? []), value]);
  else into.values.set(flag.flag, value);
  return { consumed: inline === undefined ? 2 : 1 };
}

function collectToken(
  spec: CommandSpec,
  argv: readonly string[],
  index: number,
  into: Accumulator
): Collected {
  const token = argv[index] ?? '';
  if (!token.startsWith('-')) {
    if (spec.positionals.kind === 'none') {
      refuse(spec, `\`${token}\` is not an argument this takes.`);
    }
    into.positionals.push(token);
    return { consumed: 1 };
  }
  const { name, inline } = splitToken(token);
  const flag = spec.flags.find((candidate) => candidate.flag === name);
  if (flag === undefined) refuse(spec, `\`${name}\` is not a flag this recognises.`);
  return collectFlag(spec, { flag, inline, index }, argv, into);
}

function flagsFrom(spec: CommandSpec, collected: Accumulator): FlagRecord {
  const flags: Record<string, boolean | string | readonly string[] | undefined> = {};
  for (const flag of spec.flags) {
    if (flag.kind === 'boolean') flags[flag.flag] = collected.booleans.has(flag.flag);
    else if (flag.kind === 'list') flags[flag.flag] = collected.lists.get(flag.flag) ?? [];
    else flags[flag.flag] = collected.values.get(flag.flag);
  }
  return flags;
}

/**
 * Parse `argv` against `spec`, or refuse.
 *
 * Refusal is a thrown `Error` whose message names the offending argument and
 * carries the usage text; `runMain` prints it and exits non-zero. A help
 * request wins over everything else in the line, including an argument that
 * would otherwise be refused — someone who does not know the grammar is exactly
 * who is typing it.
 */
export function parseCommandLine<const S extends CommandSpec>(
  spec: S,
  argv: readonly string[]
): CommandLine<S> {
  if (isHelpRequest(argv)) {
    return { kind: 'help', usage: formatUsage(spec) };
  }

  const collected: Accumulator = {
    booleans: new Set<string>(),
    values: new Map<string, string>(),
    lists: new Map<string, string[]>(),
    positionals: [],
  };
  for (let index = 0; index < argv.length; ) {
    index += collectToken(spec, argv, index, collected).consumed;
  }

  // Asserted into the spec's mapped type: the record above and that type are
  // the same shape read twice, once by the loop and once by the compiler, and
  // no narrower construction expresses that.
  return {
    kind: 'run',
    flags: flagsFrom(spec, collected) as FlagValues<S>,
    positionals: collected.positionals,
  };
}

/** What an entry point acts on once the line is known to run. */
export interface Invocation<S extends CommandSpec> {
  readonly flags: FlagValues<S>;
  readonly positionals: readonly string[];
}

/**
 * The parse an entry point acts on, or `null` when the line asked for usage —
 * which this wrote out. A `null` means the entry point executes nothing and
 * exits zero; anything the spec does not name has already thrown by then.
 */
export function readCommandLine<const S extends CommandSpec>(
  spec: S,
  argv: readonly string[],
  write: (text: string) => void = (text) => {
    process.stdout.write(text);
  }
): Invocation<S> | null {
  const parsed = parseCommandLine(spec, argv);
  if (parsed.kind === 'help') {
    write(`${parsed.usage}\n`);
    return null;
  }
  return { flags: parsed.flags, positionals: parsed.positionals };
}

/**
 * The parse for an entry point that must not exit on success: one that leaves a
 * server listening, or writes to a stream `process.exit` would truncate.
 *
 * Answers a help request and a refusal exactly as an entry running under
 * {@link runMain} does — usage on standard output, the refusal on standard
 * error and a failing exit code — and returns `null` for both, so the caller's
 * one test is whether there is anything to run.
 */
export function readCommandLineOrRefuse<const S extends CommandSpec>(
  spec: S,
  argv: readonly string[]
): Invocation<S> | null {
  try {
    return readCommandLine(spec, argv);
  } catch (error: unknown) {
    process.stderr.write(`${messageChain(error)}\n`);
    process.exitCode = 1;
    return null;
  }
}
