import {
  AGENT_OWNED_FIELDS,
  answerQuestion,
  applyWrite,
  expectedHash,
  loadAudit,
  patchWrite,
  updateProgress,
} from '@hushbox/docket';
import { PROGRESS_STATUSES } from '@hushbox/docket/types';
import { FINDING_ACTIONS } from '../finding-actions';
import { ACTION_TRANSITIONS } from '../server/action-transitions';
import { auditsRoot, timestamp } from './deps';
import type { FindingAction } from '../finding-actions';
import type { CliDeps } from './deps';
import type { AnswerCommand, Command, NoteCommand, SetCommand } from './parse-command';
import type {
  Finding,
  FindingPatch,
  ProgressPatch,
  Transition,
  WriteOutcome,
} from '@hushbox/docket';

/** Every action a human decides and an implementation agent relays. */
type MandatedCommand = Extract<Command, { readonly mandate: string }>;

type WriteCommand = SetCommand | NoteCommand | AnswerCommand | MandatedCommand;

/** How many times a write is offered to a held file before it gives up. */
const LOCK_ATTEMPTS = 3;
const LOCK_RETRY_MS = 500;

/**
 * The agent-owned fields `--set` refuses, each with what it says instead.
 * `progress.notes` and `questions.answers` are lists a raw string would corrupt,
 * and each has a command of its own. `progress.updated` records when the agent
 * last reported and the store stamps it whenever the agent reports progress —
 * a status or a note, never an answer — so a hand-set value would be the agent
 * restating its own last report. Refusing here leaves the store's ownership and
 * its stamp alone: the stamp travels in the same patch the ownership check
 * reads, so no owned set can tell one from the other.
 *
 * `answers` is the patch key the store reads for `questions.answers`, so both
 * spellings reach the same field and both have to be named here. The store
 * checks ownership by key and then merges, so a string arriving under this one
 * would pass ownership and break inside the merge rather than be refused.
 */
const REDIRECTS: Record<string, string> = {
  'progress.notes': 'use --note to append a progress note',
  'questions.answers': 'use --answer to answer a question',
  answers: 'use --answer to answer a question',
  'progress.updated': 'it is stamped automatically whenever you report progress',
};

/**
 * What `--set` writes: the store's agent-owned fields less the ones redirected
 * above. Subtracted rather than listed, so a field the ownership table gains or
 * loses reaches `--help` without anyone editing a second copy of the table.
 */
export const SETTABLE_FIELDS: readonly string[] = AGENT_OWNED_FIELDS.filter(
  (field) => !Object.hasOwn(REDIRECTS, field)
);

interface Plan {
  readonly transition: Transition;
  /**
   * Whether this write replaces a value rather than adding an entry to one. Only
   * a replacement can lose another writer's work, so only a replacement names
   * the version it was decided on. A note and an answer are both composed from
   * the file re-read inside the lock, so they cannot lose an entry — and naming
   * a version on them would refuse the writers they are meant to allow, because
   * a finding's notes and its answers are each hashed as one value.
   */
  readonly replaces: boolean;
  /**
   * What to report once the write lands, or null for one that cannot land. A
   * field this CLI does not write is handed to the store for its refusal and
   * nothing else: every such field is either refused above or owned by another
   * writer, so there is no landing to confirm.
   */
  readonly confirm: ((finding: Finding) => string) | null;
}

/**
 * A field this CLI does not write itself is still handed to the store, so the
 * refusal comes from the one ownership table rather than a copy of it here. The
 * value's type is irrelevant: ownership is decided from the patch's keys,
 * before any value is read.
 */
function probePatch(field: string, value: string): FindingPatch {
  if (field.startsWith('progress.')) {
    const key = field.slice('progress.'.length);
    return { progress: { [key]: value } as ProgressPatch };
  }
  return { [field]: value } as FindingPatch;
}

/**
 * Read from the finding the write returned rather than from what was asked for,
 * so the two directions cannot be confirmed in the same words. Shared by the
 * agent's own `--set dedicated=` and the human's `--dedicate`, which write the
 * same field under different writers.
 */
function dedication(finding: Finding): string {
  return `docket: ${finding.id} is ${finding.dedicated ? 'now dedicated' : 'no longer dedicated'}`;
}

/** Shared by the agent's own `--set progress.status=` and the human's `--move`. */
function statusMove(finding: Finding): string {
  return `docket: ${finding.id} progress.status is now "${finding.progress.status}"`;
}

/** Shared by the agent's own `--note` and the human's `--remark`. */
function noteAdded(finding: Finding): string {
  return `docket: ${finding.id} progress note added (${String(
    finding.progress.notes.length
  )} in all)`;
}

function planSet(command: SetCommand, deps: CliDeps): Plan | null {
  const redirect = REDIRECTS[command.field];
  if (redirect !== undefined) {
    deps.err(`docket: ${command.field} is not written this way, ${redirect}`);
    return null;
  }

  if (command.field === 'progress.status') {
    const status = PROGRESS_STATUSES.find((value) => value === command.value);
    if (status === undefined) {
      deps.err(`docket: progress.status must be one of ${PROGRESS_STATUSES.join(', ')}`);
      return null;
    }
    return {
      transition: updateProgress({ status }, timestamp(deps), 'agent'),
      replaces: true,
      confirm: statusMove,
    };
  }

  if (command.field === 'dedicated') {
    if (command.value !== 'true' && command.value !== 'false') {
      deps.err('docket: dedicated must be true or false');
      return null;
    }
    return {
      transition: patchWrite('agent', { dedicated: command.value === 'true' }),
      replaces: true,
      confirm: dedication,
    };
  }

  return {
    transition: patchWrite('agent', probePatch(command.field, command.value)),
    replaces: true,
    confirm: null,
  };
}

function planNote(command: NoteCommand, deps: CliDeps): Plan {
  return {
    transition: updateProgress({ note: command.text }, timestamp(deps), 'agent'),
    replaces: false,
    confirm: noteAdded,
  };
}

function planAnswer(command: AnswerCommand, finding: Finding, deps: CliDeps): Plan | null {
  const index =
    command.index ?? finding.questions.findIndex((question) => question.answer === null);
  if (index === -1) {
    deps.err(`docket: ${finding.id} has no unanswered question`);
    return null;
  }
  return {
    transition: answerQuestion({ index, text: command.text }, timestamp(deps), 'agent'),
    replaces: false,
    confirm: (written) =>
      `docket: ${written.id} question ${String(index)} answered, ${String(
        written.questions.filter((question) => question.answer === null).length
      )} still open`,
  };
}

/**
 * The human's words as the finding records them. The write itself lands as the
 * human writer, because the human is who decided; the sentence records that an
 * agent did the typing, which the writer alone cannot say.
 */
function relayed(mandate: string): string {
  return `${mandate} — relayed from the human by the implementation agent`;
}

/**
 * Carries the mandate on the write that needs it, in the same patch: a second
 * write would leave the finding decided with nothing saying whose decision it
 * was, and would fence separately.
 *
 * The notes are read from the patch where the write it rides already composed
 * them, and from the finding only where it did not. Reading the finding alone
 * would drop the note the write itself appended — which is what an unblocking
 * and a progress report both do.
 */
export function alsoNoting(transition: Transition, text: string, at: string): Transition {
  return (finding) => {
    const outcome = transition(finding);
    if (!outcome.ok) return outcome;
    const { writer, patch } = outcome.value;
    const notes = [
      ...(patch.progress?.notes ?? finding.progress.notes),
      { at, by: 'human' as const, text },
    ];
    return {
      ok: true,
      value: { writer, patch: { ...patch, progress: { ...patch.progress, notes } } },
    };
  };
}

/**
 * The fence policy, read off the declaration the console reads it from rather
 * than restated: an action that changes what it overwrites changes it for both
 * surfaces at once.
 */
function replacing(action: FindingAction, body: object): boolean {
  const policy = FINDING_ACTIONS[action].replaces;
  return typeof policy === 'function' ? policy(body) : policy;
}

/**
 * The mark only where the command carries one. A patch is fenced on the fields
 * it names, so naming the mark on a decision that says nothing about it would
 * refuse a decision that merely raced a mark nobody was arguing about.
 */
function marking(command: { readonly dedicated?: boolean }): { readonly dedicated?: boolean } {
  return command.dedicated === undefined ? {} : { dedicated: command.dedicated };
}

/**
 * Every action a human mandates: the ones the console declares, less
 * `progress`, which reaches the CLI as the three writes it carries — a verdict,
 * a status move and a note — because the agent writes two of those fields on
 * its own account too and the writer is what separates them. Derived from the
 * declaration rather than listed, so a console action added later has no CLI
 * story and does not compile until someone decides one.
 */
type MandatedAction = Exclude<FindingAction, 'progress'> | 'verify' | 'move' | 'remark';

type CommandOf<TKind extends MandatedAction> = Extract<MandatedCommand, { kind: TKind }>;

type MandatedPlans = {
  readonly [TKind in MandatedAction]: (command: CommandOf<TKind>, at: string) => Plan;
};

const MANDATED_PLANS = {
  rule: (command, at) => ({
    transition: ACTION_TRANSITIONS.rule(
      {
        option: command.option,
        text: command.text ?? null,
        note: relayed(command.mandate),
        ...marking(command),
      },
      at
    ),
    replaces: replacing('rule', command),
    confirm: (finding) => `docket: ${finding.id} is ruled "${command.option}"`,
  }),
  dedicate: (command, at) => ({
    transition: alsoNoting(
      ACTION_TRANSITIONS.dedicate({ dedicated: command.dedicated }, at),
      relayed(command.mandate),
      at
    ),
    replaces: replacing('dedicate', command),
    confirm: dedication,
  }),
  deny: (command, at) => ({
    transition: ACTION_TRANSITIONS.deny({ reason: relayed(command.mandate) }, at),
    replaces: replacing('deny', command),
    confirm: (finding) => `docket: ${finding.id} is denied`,
  }),
  reopen: (command, at) => ({
    transition: alsoNoting(ACTION_TRANSITIONS.reopen({}, at), relayed(command.mandate), at),
    replaces: replacing('reopen', command),
    confirm: (finding) => `docket: ${finding.id} is open again`,
  }),
  ask: (command, at) => ({
    transition: alsoNoting(
      ACTION_TRANSITIONS.ask({ text: command.text }, at),
      relayed(command.mandate),
      at
    ),
    replaces: replacing('ask', command),
    confirm: (finding) =>
      `docket: ${finding.id} asked, ${String(
        finding.questions.filter((question) => question.answer === null).length
      )} unanswered`,
  }),
  withdraw: (command, at) => ({
    transition: alsoNoting(
      ACTION_TRANSITIONS.withdraw({ index: command.index }, at),
      relayed(command.mandate),
      at
    ),
    replaces: replacing('withdraw', command),
    confirm: (finding) =>
      `docket: ${finding.id} question ${String(command.index)} withdrawn, ${String(
        finding.questions.length
      )} left`,
  }),
  // The answer the work stopped for is the mandate itself, so the action's own
  // note carries it and a wrapper would only write the same sentence twice.
  unblock: (command, at) => ({
    transition: ACTION_TRANSITIONS.unblock(
      { note: relayed(command.mandate), ...marking(command) },
      at
    ),
    replaces: replacing('unblock', command),
    confirm: (finding) =>
      `docket: ${finding.id} is unblocked, progress.status is now "${finding.progress.status}"`,
  }),
  // The verdict half of the progress action, which takes a note beside the
  // verdict, so the mandate needs no wrapper here either.
  verify: (command, at) => ({
    transition: ACTION_TRANSITIONS.progress(
      { verified: command.verified, note: relayed(command.mandate) },
      at
    ),
    replaces: replacing('progress', { verified: command.verified }),
    confirm: (finding) =>
      `docket: ${finding.id} progress is ${
        finding.progress.verified ? 'verified' : 'no longer verified'
      }`,
  }),
  // The status half of the same action, moved by the reader rather than
  // reported by the agent: the agent's own `--set progress.status=` writes this
  // field as the agent, which leaves its last-reported stamp where a reader
  // moving the work has no business putting it.
  move: (command, at) => {
    const input = { status: command.status, note: relayed(command.mandate) };
    return {
      transition: ACTION_TRANSITIONS.progress(input, at),
      replaces: replacing('progress', input),
      confirm: statusMove,
    };
  },
  // The note half, where the mandate is the whole of what is being said, as it
  // is for an unblocking.
  remark: (command, at) => {
    const input = { note: relayed(command.mandate) };
    return {
      transition: ACTION_TRANSITIONS.progress(input, at),
      replaces: replacing('progress', input),
      confirm: noteAdded,
    };
  },
} satisfies MandatedPlans;

/**
 * Applies the entry the command names. The kind travels as its own argument so
 * that one type parameter keeps the entry and the command correlated: indexing
 * the table with a union-typed kind leaves the compiler comparing every entry
 * against every command, which no argument satisfies.
 */
function planMandated<TKind extends MandatedAction>(
  kind: TKind,
  command: CommandOf<TKind>,
  at: string
): Plan {
  const plans: MandatedPlans = MANDATED_PLANS;
  return plans[kind](command, at);
}

function plan(command: WriteCommand, finding: Finding, deps: CliDeps): Plan | null {
  if (command.kind === 'set') return planSet(command, deps);
  if (command.kind === 'note') return planNote(command, deps);
  if (command.kind === 'answer') return planAnswer(command, finding, deps);
  return planMandated(command.kind, command, timestamp(deps));
}

async function pause(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

interface Offer {
  readonly filePath: string;
  readonly transition: Transition;
  /**
   * The named fields valued as this process last saw them. Null leaves the write
   * unguarded: either it adds an entry, which cannot lose anything, or the
   * transition already fails against the read copy, in which case there is
   * nothing to guard and the store reports the real refusal instead of a
   * conflict standing in for it.
   */
  readonly expect: string | null;
  readonly attempts: number;
}

/**
 * `locked` is a refusal, not a failure: another writer holds the file for the
 * few milliseconds a write takes, so the answer is to try again rather than to
 * report the write as impossible.
 *
 * Every attempt carries the same `expect`, so a holder who changed the very
 * fields this write names is reported as a conflict on the retry rather than
 * overwritten by it.
 */
async function applyWithRetry(offer: Offer, deps: CliDeps): Promise<WriteOutcome> {
  const { filePath, transition, attempts } = offer;
  const guard = offer.expect === null ? {} : { expect: offer.expect };

  for (let attempt = 1; ; attempt += 1) {
    const outcome = await applyWrite(filePath, transition, guard);
    if (outcome.ok || outcome.error.code !== 'locked' || attempt >= attempts) return outcome;
    deps.err(
      `docket: another writer holds the file, retrying (${String(attempt + 1)} of ${String(attempts)})`
    );
    await pause(LOCK_RETRY_MS);
  }
}

interface WriteOptions {
  /** Lowered by the lock tests so a permanently held file is not waited on three times. */
  readonly lockAttempts?: number;
}

export async function runWrite(
  command: WriteCommand,
  deps: CliDeps,
  options: WriteOptions = {}
): Promise<number> {
  const loaded = await loadAudit(auditsRoot(deps), command.audit ?? undefined);
  const entry = loaded.findings.find((candidate) => candidate.finding.id === command.id);
  if (entry === undefined) {
    deps.err(`docket: no finding "${command.id}" in ${loaded.name}`);
    return 1;
  }

  const planned = plan(command, entry.finding, deps);
  if (planned === null) return 1;

  const outcome = await applyWithRetry(
    {
      filePath: entry.path,
      transition: planned.transition,
      expect: planned.replaces ? expectedHash(entry.finding, planned.transition) : null,
      attempts: options.lockAttempts ?? LOCK_ATTEMPTS,
    },
    deps
  );
  if (!outcome.ok) {
    deps.err(`docket: ${command.id} refused (${outcome.error.code}): ${outcome.error.message}`);
    if (outcome.error.code === 'conflict') {
      deps.err(`docket: read ${command.id} again before writing; nothing was written`);
    }
    return 1;
  }

  if (planned.confirm !== null) deps.out(planned.confirm(outcome.value.finding));
  return 0;
}
