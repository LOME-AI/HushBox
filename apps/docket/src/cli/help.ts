import { LAUNCH_BARE_FLAG, LAUNCH_VALUE_FLAGS } from '../server/launch-options';
import {
  ALLOWED_FLAGS,
  ARGUMENTS,
  ENUM_FLAGS,
  EXCLUSIVE,
  KIND_BY_ACTION,
  OPEN_VALUES,
  REQUIRED_FLAGS,
} from './parse-command';
import { SETTABLE_FIELDS } from './write';
import type { ActionKind } from './parse-command';

const WIDTH = 96;
const INDENT = '      ';

const VALUES_BY_FLAG = new Map<string, readonly string[]>(Object.entries(ENUM_FLAGS));

/**
 * Two authorities, unioned only to look a flag up: the actions' placeholders are
 * the parser's, the console's are the launcher's, and neither is restated here.
 */
const PLACEHOLDERS = new Map<string, string>([
  ...LAUNCH_VALUE_FLAGS,
  ...Object.entries(OPEN_VALUES),
]);

/**
 * The queue semantics, which no constant carries: a predicate is code, and what
 * separates one queue from the state it is named after can only be said. Every
 * sentence here is a claim about the code that answers these flags, and is
 * checked against that code, so it is the one part of this output a reader has
 * to maintain.
 */
const QUEUES = [
  'Queues',
  "  --section reads a queue through the console's own predicate, which is why it is not --state.",
  '  --section=ruled is the work queue and leaves out a finding whose progress.status is blocked;',
  '  --section=progress is every ruled finding, blocked ones kept. --section=open leaves out a',
  '  finding with an unanswered question, and --section=questions is any finding carrying one,',
  '  whatever its state. --brief hides the options that were not ruled; --contest shows them all',
  '  and marks the one that was.',
  '  A dedicated finding is one too large for a single task, or owed a design session before any',
  '  code. It leaves the queues an ordinary task picks work up from and is listed by',
  '  --section=dedicated, the inventory those sessions are planned from. Only intake skips it: a',
  '  listing given no --section leaves it out, a named section answers through its own predicate',
  '  so it holds one exactly when that predicate does, and --questions reads Questions by name,',
  '  because answering a question is not taking the work on. Ask for it by section or name it',
  '  with --id; a write named by --id is never skipped.',
  '  --list answers what a section holds; --census reports citation health and prints no line for',
  '  a finding whose citations are all live, so it is never a count of what a section holds.',
].join('\n');

function flagSpec(flag: string): string {
  const values = VALUES_BY_FLAG.get(flag);
  if (values !== undefined) return `${flag}=${values.join('|')}`;
  const placeholder = PLACEHOLDERS.get(flag);
  return placeholder === undefined ? flag : `${flag}=${placeholder}`;
}

/** Filled greedily, so an action with many flags reads as a paragraph. */
function fill(specs: readonly string[]): string[] {
  const lines: string[] = [];
  for (const spec of specs) {
    const last = lines.at(-1);
    if (last !== undefined && `${last}  ${spec}`.length <= WIDTH) {
      lines[lines.length - 1] = `${last}  ${spec}`;
    } else {
      lines.push(INDENT + spec);
    }
  }
  return lines;
}

/** The `field` in `--set`'s usage line is the one argument with a closed set behind it. */
function fields(kind: ActionKind): string[] {
  if (kind !== 'set') return [];
  return [`${INDENT}field must be one of ${SETTABLE_FIELDS.join(', ')}`];
}

/**
 * A flag the action cannot run without reads as part of the invocation rather
 * than as one more thing on offer, so it goes on the usage line and comes off
 * the list below it. Which flags those are is the parser's, not stated here.
 */
function required(kind: ActionKind): string[] {
  return ALLOWED_FLAGS[kind].filter((allowed) => REQUIRED_FLAGS.includes(allowed));
}

function actionBlock(flag: string, kind: ActionKind): string {
  const carried = new Set([flag, ...required(kind)]);
  const specs = ALLOWED_FLAGS[kind]
    .filter((allowed) => !carried.has(allowed))
    .map((allowed) => flagSpec(allowed));
  const usage = [flag, ARGUMENTS[kind].shape, ...required(kind).map((must) => flagSpec(must))]
    .filter((part) => part !== '')
    .join(' ');
  return [`  pnpm docket ${usage}`, ...fill(specs), ...fields(kind)].join('\n');
}

/**
 * The single statement of this CLI. Everything but the queue prose is read out
 * of the parser's own constants, so a flag, an action or a closed set the parser
 * gains appears here without anyone remembering to write it down.
 */
export function formatHelp(): string {
  return [
    [
      'Usage',
      '  pnpm docket                                     start the console',
      ...fill([...LAUNCH_VALUE_FLAGS.keys(), LAUNCH_BARE_FLAG].map((flag) => flagSpec(flag))),
    ].join('\n'),
    'Actions',
    ...Object.entries(KIND_BY_ACTION).map(([flag, kind]) => actionBlock(flag, kind)),
    ['Never together', ...EXCLUSIVE.map(([one, other]) => `  ${one} and ${other}`)].join('\n'),
    QUEUES,
  ].join('\n\n');
}
