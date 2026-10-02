export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const KINDS = ['defect', 'decision'] as const;
export type Kind = (typeof KINDS)[number];

export const FINDING_STATUSES = ['live', 'latent', 'unclear'] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export const FINDING_STATES = ['open', 'ruled', 'denied'] as const;
export type FindingState = (typeof FINDING_STATES)[number];

export const PROGRESS_STATUSES = ['not-started', 'in-progress', 'blocked', 'done'] as const;
export type ProgressStatus = (typeof PROGRESS_STATUSES)[number];

export const DENIAL_AUTHORS = ['human', 'audit'] as const;
export type DenialAuthor = (typeof DENIAL_AUTHORS)[number];

export const NOTE_AUTHORS = ['human', 'agent'] as const;
export type NoteAuthor = (typeof NOTE_AUTHORS)[number];

/**
 * The attributes a resolved citation is marked with. The renderer writes them
 * and the console's source peek reads them, and a divergence would break the
 * peek silently rather than loudly, so both sides take the names from here.
 *
 * They live in this module, not in `citations.ts`, because the reading side
 * runs in a browser and this is the only entry point free of `node:fs`.
 */
export const CITATION_ATTRIBUTES = {
  path: 'data-citation-path',
  start: 'data-citation-start',
  end: 'data-citation-end',
  /**
   * The other half of the same contract: a citation the console will not serve
   * carries `dead` in place of the three above, and the sentence saying why
   * follows it under `note`. The console styles both and gives a tab stop to
   * neither — there is nothing to activate, and the sentence is already in the
   * reading order.
   */
  dead: 'data-citation-dead',
  note: 'data-citation-note',
} as const;

/**
 * What a citation reads as, which is both the name the renderer gives the
 * control and the text activating it puts on the clipboard. One declaration for
 * the same reason the attribute names have one: an announced name that differs
 * from what is copied is a lie no test on either side would catch.
 */
export function citationLabel(citation: {
  readonly path: string;
  readonly start: number;
  readonly end: number;
}): string {
  const range = citation.start === citation.end ? '' : `-${String(citation.end)}`;
  return `${citation.path}:${String(citation.start)}${range}`;
}

/**
 * Every timestamp the finding format holds is a day, never an instant. The
 * pattern and the producer live together here, and the minting sites and the
 * validator both read them: a second expression of the rule is one a write
 * minted by one path and rejected by the other.
 *
 * They live in this module, not beside the validator, because the console
 * bundles this entry point and it is the only one free of `node:fs`.
 */
export const DAY_STAMP_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The UTC day an instant falls on. */
export function dayStamp(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

export interface Ruling {
  readonly option: string;
  readonly text: string | null;
  readonly note: string | null;
  readonly at: string;
}

export interface Denial {
  readonly by: DenialAuthor;
  readonly reason: string | null;
  readonly at: string;
}

export interface RulingHistoryEntry {
  readonly at: string;
  readonly kind: 'ruling';
  readonly superseded_at: string;
  readonly option: string;
  readonly text: string | null;
  readonly note: string | null;
}

export interface DenialHistoryEntry {
  readonly at: string;
  readonly kind: 'denial';
  readonly superseded_at: string;
  readonly reason: string | null;
  readonly by: DenialAuthor;
}

/**
 * One chronological array rather than one per kind: a superseded ruling and a
 * cleared denial are both what the finding used to be, and the console renders
 * them as a single list.
 */
export type HistoryEntry = RulingHistoryEntry | DenialHistoryEntry;

/** One thing the human asked an implementation agent about a finding. */
export interface Question {
  readonly at: string;
  readonly text: string;
  readonly answer: string | null;
  readonly answered_at: string | null;
}

interface OutstandingQuestion {
  /** Position in the finding's own `questions` array, which is what a write addresses. */
  readonly index: number;
  readonly text: string;
}

/** A shape carrying questions: both the file's finding and the console's view of one. */
interface Questioned {
  readonly questions: readonly Question[];
}

/** The questions nobody has answered, each paired with the index that answers it. */
export function outstandingQuestions(finding: Questioned): readonly OutstandingQuestion[] {
  return finding.questions
    .map((question, index) => ({ index, text: question.text, answer: question.answer }))
    .filter((entry) => entry.answer === null)
    .map((entry) => ({ index: entry.index, text: entry.text }));
}

/**
 * Whether a finding still owes an answer, which is what puts it in the questions
 * section. Derived on every read rather than stored: more questions than answers
 * is the same set as a question carrying no answer, and a stored flag beside the
 * array it describes is a flag that can come to disagree with it.
 */
export function hasOutstandingQuestion(finding: Questioned): boolean {
  return finding.questions.some((question) => question.answer === null);
}

export interface ProgressNote {
  readonly at: string;
  readonly by: NoteAuthor;
  readonly text: string;
}

/**
 * A note thread read as an exchange: what the agent last had to say, and what
 * has been said back to it since.
 */
interface AccountAndReplies {
  /**
   * The trailing run of agent notes — the agent's own last word, which on a
   * blocked finding is why the work stopped. Notes before that run are the
   * exchange it supersedes and belong to neither half.
   */
  readonly account: readonly ProgressNote[];
  /** Every note written after the account, which is what answers it. */
  readonly replies: readonly ProgressNote[];
}

/**
 * The one place the account/replies boundary is decided, because the console and
 * the brief both label it and a second implementation would let them label the
 * same note differently.
 *
 * The rule is self-correcting rather than stateful: an agent that speaks again
 * makes its new run the account, so nothing has to be reset when a block is
 * answered and then re-raised. A thread no agent ever wrote to is all replies —
 * there is no account to attribute them to, and dropping them would hide notes
 * that exist.
 */
export function accountAndReplies(notes: readonly ProgressNote[]): AccountAndReplies {
  const accountEnd = notes.findLastIndex((note) => note.by === 'agent') + 1;
  const accountStart = notes.slice(0, accountEnd).findLastIndex((note) => note.by !== 'agent') + 1;
  return {
    account: notes.slice(accountStart, accountEnd),
    replies: notes.slice(accountEnd),
  };
}

export interface Progress {
  readonly status: ProgressStatus;
  readonly updated: string | null;
  readonly verified: boolean;
  readonly notes: readonly ProgressNote[];
}

export interface FindingOption {
  readonly id: string;
  readonly label: string;
  readonly recommended: boolean;
  /** Whether choosing this option would make the finding dedicated. */
  readonly dedicated: boolean;
  readonly meta: string | null;
  readonly body: string;
}

export interface Finding {
  readonly id: string;
  readonly title: string;
  readonly severity: Severity;
  readonly kind: Kind;
  readonly status: FindingStatus;
  readonly status_note: string | null;
  readonly area: string;
  readonly needs_ruling: boolean;
  readonly needs_options: boolean;
  readonly warning: boolean;
  readonly related: readonly string[];
  readonly group: string | null;
  /**
   * Whether the fix is too large for one task or needs a design session before
   * code. A disposition, not progress: it says who takes the work, never how
   * far along it is, so it moves neither `state` nor the ruling.
   */
  readonly dedicated: boolean;
  readonly state: FindingState;
  readonly ruling: Ruling | null;
  readonly denial: Denial | null;
  readonly history: readonly HistoryEntry[];
  readonly questions: readonly Question[];
  readonly progress: Progress;
  /** Every byte after the closing frontmatter delimiter. No program rewrites it. */
  readonly body: string;
  /** The part of `body` before its last `## Options` heading. */
  readonly explainer: string;
  readonly options: readonly FindingOption[];
}

/**
 * The audit header, which is parse-only: no code path emits this file, so the
 * body and every field above it are the audit agent's and the human's alone.
 */
export interface Audit {
  readonly layout_version: number;
  readonly date: string;
  readonly title: string;
  readonly scope: string;
  readonly body: string;
}

export const FINDING_ISSUE_CODES = [
  'missing-frontmatter',
  'unterminated-frontmatter',
  'malformed-yaml',
  'missing-field',
  'invalid-type',
  'invalid-enum',
  'id-filename-mismatch',
  'unsanitized-id',
  'invalid-option-id',
  'duplicate-option-id',
  'ruling-without-ruled-state',
  'ruled-state-without-ruling',
  'denial-without-denied-state',
  'denied-state-without-denial',
  'blocked-without-ruling',
  'non-day-timestamp',
  'emission-option-count',
  'emission-state',
  'emission-needs-options',
  'emission-recommended-count',
] as const;
export type FindingIssueCode = (typeof FINDING_ISSUE_CODES)[number];

export interface FindingIssue {
  readonly code: FindingIssueCode;
  /** The frontmatter path the issue is about, e.g. `progress.status`, or null. */
  readonly field: string | null;
  readonly message: string;
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T; readonly issues: readonly FindingIssue[] }
  | { readonly ok: false; readonly issues: readonly FindingIssue[] };

/**
 * `structural` is checked on every parse. `emission` binds the audit agent
 * writing a fresh audit and is never rechecked: a human can reopen a finding
 * that shipped `needs_ruling: false`, leaving it `open` with one option
 * forever, and that is not a defect to fix.
 */
export const VALIDATION_MODES = ['structural', 'emission'] as const;
export type ValidationMode = (typeof VALIDATION_MODES)[number];
