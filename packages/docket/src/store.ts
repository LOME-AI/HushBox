import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicWrite } from './atomic-write.ts';
import { LockUnavailableError, withLockFile } from './lock.ts';
import { parseAudit, parseFinding } from './parse.ts';
import { serializeFinding } from './serialize.ts';
import { validateFinding } from './validate.ts';
import type {
  Audit,
  Denial,
  Finding,
  FindingIssue,
  FindingState,
  FindingStatus,
  HistoryEntry,
  ProgressNote,
  ProgressStatus,
  Question,
  Ruling,
  Severity,
} from './types.ts';

const AUDIT_FILE = 'audit.md';
const FINDINGS_DIRECTORY = 'findings';
const DATED_NAME = /^\d{4}-\d{2}-\d{2}$/;

export type Writer = 'audit' | 'human' | 'agent';

/**
 * The agent's row of the table below, published because the CLI's `--help` has to
 * state what an implementation agent may write and this is where that is decided.
 * Narrow on purpose: the other rows stay private, so the barrel carries the one
 * fact a caller outside this package needs rather than the whole table.
 */
export const AGENT_OWNED_FIELDS: readonly string[] = [
  'dedicated',
  'questions.answers',
  'progress.status',
  'progress.updated',
  'progress.notes',
];

/**
 * Which writers may write each field — the table `docs/audits/CLAUDE.md` states
 * as its **Written by** column. What it guarantees is non-interference rather
 * than disjointness: a write naming a field its writer does not own is refused,
 * and one that passes is merged into the copy re-read inside the lock, so it
 * touches only the fields it named. A field with two writers is where that
 * guarantee does its work, not a hole in it — a note is a list both writers add
 * to, and what a write adds is computed from that re-read copy, while a
 * replacement of the scalar `progress.status` names the version it was decided
 * on. Which of the two writes when is ordered by intent: an agent reports where
 * it got to, and the human moves it on — unblocking a contested ruling is the
 * human's act, and attributing it to the agent would misname who decided. An
 * answer is the agent's alone: the human asks, so a human-written answer would
 * record one writer's words under the other's name.
 */
const OWNED_FIELDS: Record<Writer, readonly string[]> = {
  audit: [
    'id',
    'title',
    'severity',
    'kind',
    'status',
    'status_note',
    'area',
    'needs_ruling',
    'needs_options',
    'warning',
    'related',
    'group',
    'dedicated',
    'state',
    'ruling',
    'denial',
    'history',
  ],
  human: [
    'severity',
    'status',
    'area',
    'needs_options',
    'dedicated',
    'state',
    'ruling',
    'denial',
    'history',
    'questions',
    'progress.status',
    'progress.verified',
    'progress.notes',
  ],
  agent: AGENT_OWNED_FIELDS,
};

export interface QuestionAnswer {
  readonly index: number;
  readonly answer: string;
  readonly answered_at: string;
}

export interface ProgressPatch {
  readonly status?: ProgressStatus;
  readonly updated?: string | null;
  readonly verified?: boolean;
  readonly notes?: readonly ProgressNote[];
}

export interface FindingPatch {
  readonly title?: string;
  readonly severity?: Severity;
  readonly status?: FindingStatus;
  readonly status_note?: string | null;
  readonly area?: string;
  readonly needs_options?: boolean;
  readonly warning?: boolean;
  readonly related?: readonly string[];
  readonly group?: string | null;
  readonly dedicated?: boolean;
  readonly state?: FindingState;
  readonly ruling?: Ruling | null;
  readonly denial?: Denial | null;
  readonly history?: readonly HistoryEntry[];
  readonly questions?: readonly Question[];
  /** Answers by question index, the one part of `questions` an agent may write. */
  readonly answers?: readonly QuestionAnswer[];
  readonly progress?: ProgressPatch;
}

export const WRITE_ERROR_CODES = [
  'not-owned',
  'conflict',
  'unreadable',
  'invalid',
  'invalid-transition',
  'unknown-question',
  'locked',
] as const;
export type WriteErrorCode = (typeof WRITE_ERROR_CODES)[number];

export interface WriteError {
  readonly code: WriteErrorCode;
  readonly message: string;
  readonly fields?: readonly string[];
  readonly issues?: readonly FindingIssue[];
}

export interface Write {
  readonly writer: Writer;
  readonly patch: FindingPatch;
}

type Failable<TValue> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly error: WriteError };

export type TransitionOutcome = Failable<Write>;

/** Runs against the finding as it is on disk, never against the caller's copy. */
export type Transition = (finding: Finding) => TransitionOutcome;

export interface WriteResult {
  readonly finding: Finding;
  readonly text: string;
  readonly hash: string;
  /** The bytes this write replaced, which is what an undo puts back. */
  readonly previousText: string;
  readonly fieldHash: string;
}

export type WriteOutcome = Failable<WriteResult>;

export interface LoadedFinding {
  readonly finding: Finding;
  readonly path: string;
  readonly text: string;
  readonly hash: string;
}

export interface ValidationEntry {
  readonly id: string;
  readonly path: string;
  readonly issues: readonly FindingIssue[];
}

interface LoadedAudit {
  readonly dir: string;
  readonly name: string;
  readonly audit: Audit;
  readonly auditPath: string;
  readonly auditText: string;
  readonly findings: readonly LoadedFinding[];
  readonly validation: readonly ValidationEntry[];
  /** Every audit in the root, newest first, for the console's switcher. */
  readonly audits: readonly string[];
}

function error(code: WriteErrorCode, message: string, extra: Partial<WriteError> = {}): WriteError {
  return { code, message, ...extra };
}

function hashOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function readDirectoryNames(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function hasAuditFile(dir: string): Promise<boolean> {
  try {
    await fs.access(path.join(dir, AUDIT_FILE));
    return true;
  } catch {
    return false;
  }
}

/**
 * Dated names sort lexically, so newest-first is a plain reverse sort. Only a
 * dated directory holding an `audit.md` qualifies, and the console admits an
 * audit name off the wire by membership here alone, so loosening this filter
 * widens that allowlist. An undated directory holding an `audit.md` is
 * reachable only through a pin.
 */
export async function listAuditNames(auditsRoot: string): Promise<string[]> {
  const names = await readDirectoryNames(auditsRoot);
  const dated = names.filter((name) => DATED_NAME.test(name));
  const present = await Promise.all(
    dated.map(async (name) => ((await hasAuditFile(path.join(auditsRoot, name))) ? name : null))
  );
  return present
    .filter((name): name is string => name !== null)
    .toSorted((a, b) => b.localeCompare(a));
}

export async function resolveAuditDir(auditsRoot: string, pin?: string): Promise<string> {
  if (pin !== undefined) {
    const pinned = path.join(auditsRoot, pin);
    if (await hasAuditFile(pinned)) return pinned;
    throw new Error(`no audit "${pin}" under ${auditsRoot}`);
  }

  const [newest] = await listAuditNames(auditsRoot);
  if (newest === undefined) {
    throw new Error(`no audit directory under ${auditsRoot}: expected <YYYY-MM-DD>/${AUDIT_FILE}`);
  }
  return path.join(auditsRoot, newest);
}

async function readFindingFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir);
    return entries.filter((name) => name.endsWith('.md')).toSorted((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

async function loadFinding(
  filePath: string
): Promise<{ loaded: LoadedFinding | null; validation: ValidationEntry | null }> {
  const text = await fs.readFile(filePath, 'utf8');
  const parsed = parseFinding(text, filePath);
  const id = path.basename(filePath, '.md');
  const validation =
    parsed.issues.length > 0 ? { id, path: filePath, issues: parsed.issues } : null;

  if (!parsed.ok)
    return { loaded: null, validation: { id, path: filePath, issues: parsed.issues } };
  return {
    loaded: { finding: parsed.value, path: filePath, text, hash: hashOf(text) },
    validation,
  };
}

/**
 * Loads one audit whole. A file that fails to parse lands in `validation` and
 * the rest still load, because one broken finding must not hide the others.
 */
export async function loadAudit(auditsRoot: string, pin?: string): Promise<LoadedAudit> {
  const dir = await resolveAuditDir(auditsRoot, pin);
  const auditPath = path.join(dir, AUDIT_FILE);
  const auditText = await fs.readFile(auditPath, 'utf8');
  const audit = parseAudit(auditText);
  if (!audit.ok) {
    const reasons = audit.issues.map((issue) => issue.message).join('; ');
    throw new Error(`${auditPath} is not readable as an audit header: ${reasons}`);
  }

  const findingsDir = path.join(dir, FINDINGS_DIRECTORY);
  const names = await readFindingFiles(findingsDir);
  const results = await Promise.all(
    names.map(async (name) => loadFinding(path.join(findingsDir, name)))
  );

  return {
    dir,
    name: path.basename(dir),
    audit: audit.value,
    auditPath,
    auditText,
    findings: results
      .map((result) => result.loaded)
      .filter((entry): entry is LoadedFinding => entry !== null),
    validation: results
      .map((result) => result.validation)
      .filter((entry): entry is ValidationEntry => entry !== null),
    audits: await listAuditNames(auditsRoot),
  };
}

function patchPaths(patch: FindingPatch): string[] {
  const paths: string[] = [];
  for (const key of Object.keys(patch)) {
    if (key === 'progress' || key === 'answers') continue;
    paths.push(key);
  }
  if (patch.answers !== undefined) paths.push('questions.answers');
  if (patch.progress !== undefined) {
    paths.push(...Object.keys(patch.progress).map((key) => `progress.${key}`));
  }
  return paths;
}

function isKeyOf<T extends object>(source: T, field: string): field is Extract<keyof T, string> {
  return field in source;
}

/** A record's value at a runtime-named field, `undefined` where it carries no such field. */
function fieldOf<T extends object>(
  source: T,
  field: string
): T[Extract<keyof T, string>] | undefined {
  return isKeyOf(source, field) ? source[field] : undefined;
}

function valueAt(finding: Finding, field: string): unknown {
  if (field === 'questions.answers') {
    return finding.questions.map((question) => [question.answer, question.answered_at]);
  }
  if (field.startsWith('progress.')) {
    return fieldOf(finding.progress, field.slice('progress.'.length));
  }
  return fieldOf(finding, field);
}

/**
 * A hash of just the fields a write names. Scoping it this way is what makes
 * the common case conflict-free: two writers touching different fields have
 * independent hashes, so only a genuine same-field race is rejected.
 */
export function fieldHash(finding: Finding, fields: Iterable<string>): string {
  const sorted = [...fields].toSorted((a, b) => a.localeCompare(b));
  const payload = sorted.map((field) => [field, valueAt(finding, field)]);
  return hashOf(JSON.stringify(payload));
}

/**
 * The hash a caller passes as `expect`: the fields *this* write will name,
 * valued as the caller last saw them. Computed through the same transition, so
 * the caller cannot guess the field set wrong and turn a stale-read check into
 * a spurious conflict.
 */
export function expectedHash(finding: Finding, transition: Transition): string | null {
  const outcome = transition(finding);
  return outcome.ok ? fieldHash(finding, patchPaths(outcome.value.patch)) : null;
}

function applyAnswers(
  questions: readonly Question[],
  answers: readonly QuestionAnswer[]
): Question[] {
  const byIndex = new Map(answers.map((answer) => [answer.index, answer]));
  return questions.map((question, index) => {
    const answer = byIndex.get(index);
    if (answer === undefined) return question;
    return { ...question, answer: answer.answer, answered_at: answer.answered_at };
  });
}

function mergePatch(finding: Finding, patch: FindingPatch): Finding {
  const { answers, progress, ...fields } = patch;
  const merged: Finding = { ...finding, ...fields };
  return {
    ...merged,
    questions: answers === undefined ? merged.questions : applyAnswers(merged.questions, answers),
    progress: progress === undefined ? merged.progress : { ...merged.progress, ...progress },
  };
}

// One writer per file at a time. The queue covers this process; the lock file
// covers the others, and both are load-bearing: the console's dev server and
// the agent CLI are separate processes writing the same finding, and the
// field-scoped merge does not save them, because each re-emits the whole
// frontmatter from its own read.
const writeQueues = new Map<string, Promise<unknown>>();

async function takeTurn<T>(
  previous: Promise<unknown> | undefined,
  run: () => Promise<T>
): Promise<T> {
  if (previous !== undefined) await previous;
  return run();
}

async function settled(turn: Promise<unknown>): Promise<void> {
  try {
    await turn;
  } catch {
    // The turn's outcome belongs to its caller; the queue only needs the turn
    // to be over, and a failed write must not stall the writer behind it.
  }
}

function withFileLock<TValue>(
  filePath: string,
  run: () => Promise<Failable<TValue>>
): Promise<Failable<TValue>> {
  const turn = takeTurn<Failable<TValue>>(writeQueues.get(filePath), async () => {
    try {
      return await withLockFile(`${filePath}.lock`, run);
    } catch (error_) {
      if (error_ instanceof LockUnavailableError) {
        return { ok: false, error: error('locked', error_.message) };
      }
      // The lock sits beside the file it guards, so a lock path that cannot be
      // created means the directory is gone: the same unreadable the write
      // itself would have reported.
      if ((error_ as NodeJS.ErrnoException).code !== 'ENOENT') throw error_;
      return { ok: false, error: error('unreadable', `cannot write ${filePath}`) };
    }
  });
  writeQueues.set(filePath, settled(turn));
  return turn;
}

export function patchWrite(writer: Writer, patch: FindingPatch): Transition {
  return () => ({ ok: true, value: { writer, patch } });
}

/**
 * Applies one write. The file is re-read inside the lock and the transition
 * runs against those bytes, so a caller's stale copy can neither decide the
 * write nor be written back; the body comes from the same read, which is what
 * makes "no program writes the body" structural rather than a convention.
 */
export async function applyWrite(
  filePath: string,
  transition: Transition,
  options: { readonly expect?: string } = {}
): Promise<WriteOutcome> {
  return withFileLock(filePath, async () => {
    let text: string;
    try {
      text = await fs.readFile(filePath, 'utf8');
    } catch {
      return { ok: false, error: error('unreadable', `${filePath} cannot be read`) };
    }

    const parsed = parseFinding(text, filePath);
    if (!parsed.ok) {
      return {
        ok: false,
        error: error('unreadable', `${filePath} is not a finding`, { issues: parsed.issues }),
      };
    }

    const outcome = transition(parsed.value);
    if (!outcome.ok) return { ok: false, error: outcome.error };

    const { writer, patch } = outcome.value;
    const fields = patchPaths(patch);
    const owned = OWNED_FIELDS[writer];
    const unowned = fields.filter((field) => !owned.includes(field));
    if (unowned.length > 0) {
      return {
        ok: false,
        error: error('not-owned', `the ${writer} writer does not own ${unowned.join(', ')}`, {
          fields: unowned,
        }),
      };
    }

    if (options.expect !== undefined && options.expect !== fieldHash(parsed.value, fields)) {
      return {
        ok: false,
        error: error('conflict', `${fields.join(', ')} changed since it was read`, { fields }),
      };
    }

    const merged = mergePatch(parsed.value, patch);
    const [broken, ...rest] = validateFinding(merged, 'structural');
    if (broken !== undefined) {
      return {
        ok: false,
        error: error('invalid', `the write would break ${broken.code}`, {
          issues: [broken, ...rest],
        }),
      };
    }

    const next = serializeFinding(merged, text);
    await atomicWrite(filePath, next);
    return {
      ok: true,
      value: {
        finding: merged,
        text: next,
        hash: hashOf(next),
        previousText: text,
        fieldHash: fieldHash(merged, fields),
      },
    };
  });
}

/**
 * Puts one write's previous frontmatter back. The body still comes from disk,
 * so an undo cannot resurrect body bytes either.
 *
 * `writtenHash` is the whole file as the write left it, and undo is the one
 * write here fenced that way. Every other write hashes only the fields it names,
 * which is what lets a human ruling and an agent's note land in the same second.
 * An undo has no field set to scope to: it restores the entire frontmatter, so
 * whatever moved since is precisely what the restore would discard. Whole-file
 * matches undo's blast radius rather than contradicting the field-scoped fence.
 */
export async function undoWrite(
  filePath: string,
  previousText: string,
  writtenHash: string
): Promise<WriteOutcome> {
  return withFileLock(filePath, async () => {
    const previous = parseFinding(previousText, filePath);
    if (!previous.ok) {
      return {
        ok: false,
        error: error('unreadable', 'the previous bytes are not a finding', {
          issues: previous.issues,
        }),
      };
    }

    let text: string;
    try {
      text = await fs.readFile(filePath, 'utf8');
    } catch {
      return { ok: false, error: error('unreadable', `${filePath} cannot be read`) };
    }
    if (!parseFinding(text, filePath).ok) {
      return { ok: false, error: error('unreadable', `${filePath} cannot be read`) };
    }

    // The comparison belongs inside the lock, against the bytes about to be
    // replaced: deciding it from a copy read earlier would be the check-then-act
    // race this fence exists to close.
    if (hashOf(text) !== writtenHash) {
      return {
        ok: false,
        error: error('conflict', 'the finding changed after the write being undone'),
      };
    }

    const next = serializeFinding(previous.value, text);
    await atomicWrite(filePath, next);
    return {
      ok: true,
      value: {
        finding: previous.value,
        text: next,
        hash: hashOf(next),
        previousText: text,
        fieldHash: '',
      },
    };
  });
}

function archived(finding: Finding, at: string): HistoryEntry[] {
  if (finding.ruling !== null) {
    return [
      {
        at: finding.ruling.at,
        kind: 'ruling',
        superseded_at: at,
        option: finding.ruling.option,
        text: finding.ruling.text,
        note: finding.ruling.note,
      },
    ];
  }
  if (finding.denial !== null) {
    return [
      {
        at: finding.denial.at,
        kind: 'denial',
        superseded_at: at,
        reason: finding.denial.reason,
        by: finding.denial.by,
      },
    ];
  }
  return [];
}

/**
 * Everything a decision clears is archived, never dropped: a superseded ruling
 * and a cleared denial are both what the finding used to be.
 *
 * Progress is reset rather than archived, because it was recorded against the
 * decision being replaced: work standing at `blocked` or `done` against a ruling
 * that no longer exists is a claim about a decision nobody made. The notes are
 * the record and survive; `progress.updated` survives because it is the agent's
 * stamp and a human-attributed patch naming it is refused as `not-owned`. The
 * reset is emitted only when there is something to reset, so a first ruling on
 * untouched progress keeps its fence off the progress fields.
 */
function clearing(finding: Finding, at: string): FindingPatch {
  const entries = archived(finding, at);
  const stale = finding.progress.status !== 'not-started' || finding.progress.verified;
  return {
    ...(finding.ruling === null ? {} : { ruling: null }),
    ...(finding.denial === null ? {} : { denial: null }),
    ...(entries.length === 0 ? {} : { history: [...finding.history, ...entries] }),
    ...(stale ? { progress: { status: 'not-started', verified: false } } : {}),
  };
}

export function ruleFinding(
  input: { readonly option: string; readonly text: string | null; readonly note: string | null },
  at: string
): Transition {
  // A ruling settles the finding, not the questions on it: an unanswered
  // question is a separate fact and survives the ruling untouched.
  return (finding) => ({
    ok: true,
    value: {
      writer: 'human',
      patch: {
        ...clearing(finding, at),
        state: 'ruled',
        ruling: { option: input.option, text: input.text, note: input.note, at },
      },
    },
  });
}

export function denyFinding(input: { readonly reason: string | null }, at: string): Transition {
  return (finding) => {
    if (finding.state === 'denied') {
      return { ok: false, error: error('invalid-transition', 'the finding is already denied') };
    }
    return {
      ok: true,
      value: {
        writer: 'human',
        patch: {
          ...clearing(finding, at),
          state: 'denied',
          denial: { by: 'human', reason: input.reason, at },
        },
      },
    };
  };
}

export function reopenFinding(at: string): Transition {
  return (finding) => {
    if (finding.state !== 'ruled' && finding.state !== 'denied') {
      return { ok: false, error: error('invalid-transition', 'only a decided finding reopens') };
    }
    return {
      ok: true,
      value: {
        writer: 'human',
        patch: {
          ...clearing(finding, at),
          state: 'open',
          // A finding reopened with nothing to choose from goes back to the
          // audit for option minting; option count lives in the body, which no
          // program may write.
          ...(finding.options.length === 0 ? { needs_options: true } : {}),
        },
      },
    };
  };
}

/**
 * Answering the block is the human's act, so the answer lands as a human note
 * and the status moves with it in one write: an answer that left the finding
 * blocked would be an answer nobody could act on. The status returns to
 * `not-started` because no agent is on the finding — anything further along
 * would claim work that is not happening — and the ruling stands, because the
 * block was raised against it rather than about it.
 *
 * The patch names `progress.status` and `progress.notes` and so is fenced on
 * both. A note that landed after the reader's screen was drawn is a different
 * question than the one being answered here, and refusing is the right answer.
 */
export function unblockFinding(input: { readonly note: string }, at: string): Transition {
  return (finding) => {
    if (finding.state !== 'ruled' || finding.progress.status !== 'blocked') {
      return {
        ok: false,
        error: error('invalid-transition', 'only a ruled finding blocked on an answer unblocks'),
      };
    }
    return {
      ok: true,
      value: {
        writer: 'human',
        patch: {
          progress: {
            status: 'not-started',
            notes: [...finding.progress.notes, { at, by: 'human', text: input.note }],
          },
        },
      },
    };
  };
}

/**
 * A question is an outbox entry, not a state: it asks an implementation agent
 * for something the finding's decision does not wait on, so a ruled finding
 * takes one and stays ruled. Where the finding is shown is derived from whether
 * an answer is outstanding, never from a state this could set.
 */
export function askQuestion(
  input: { readonly text: string },
  at: string,
  writer: Writer
): Transition {
  return (finding) => ({
    ok: true,
    value: {
      writer,
      patch: {
        questions: [
          ...finding.questions,
          { at, text: input.text, answer: null, answered_at: null },
        ],
      },
    },
  });
}

export function answerQuestion(
  input: { readonly index: number; readonly text: string },
  at: string,
  writer: Writer
): Transition {
  return (finding) => {
    const question = finding.questions[input.index];
    if (question?.answer !== null) {
      return {
        ok: false,
        error: error('unknown-question', `no unanswered question at index ${String(input.index)}`),
      };
    }
    return {
      ok: true,
      value: {
        writer,
        patch: { answers: [{ index: input.index, answer: input.text, answered_at: at }] },
      },
    };
  };
}

export function withdrawQuestion(input: { readonly index: number }): Transition {
  return (finding) => {
    if (finding.questions[input.index] === undefined) {
      return {
        ok: false,
        error: error('unknown-question', `no question at index ${String(input.index)}`),
      };
    }
    return {
      ok: true,
      value: {
        writer: 'human',
        patch: {
          questions: finding.questions.filter((_question, index) => index !== input.index),
        },
      },
    };
  };
}

export function updateProgress(
  input: {
    readonly status?: ProgressStatus;
    readonly note?: string;
    readonly verified?: boolean;
  },
  at: string,
  writer: 'human' | 'agent'
): Transition {
  return (finding) => {
    const progress: {
      status?: ProgressStatus;
      updated?: string;
      verified?: boolean;
      notes?: readonly ProgressNote[];
    } = {};
    if (input.status !== undefined) progress.status = input.status;
    if (input.verified !== undefined) progress.verified = input.verified;
    if (input.note !== undefined) {
      progress.notes = [...finding.progress.notes, { at, by: writer, text: input.note }];
    }
    // `progress.updated` records the implementation agent's last report, so a
    // human note or verification does not move it.
    if (writer === 'agent') progress.updated = at;

    return { ok: true, value: { writer, patch: { progress } } };
  };
}
