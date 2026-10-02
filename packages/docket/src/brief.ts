import { accountAndReplies, outstandingQuestions } from './types.ts';
import type { Finding, FindingOption, ProgressNote, Question } from './types.ts';

const ID_WIDTH = 10;
const STATE_WIDTH = 16;
const SEVERITY_WIDTH = 10;
const AREA_WIDTH = 14;

/**
 * The separator is part of the column, not part of the padding: a value at or
 * past the column width still gets one space, so a long `area` cannot run into
 * the title. Values shorter than the column pad exactly as before.
 */
function pad(value: string, width: number): string {
  return value.padEnd(width - 1, ' ') + ' ';
}

/** One finding on one line, for `--list`. */
export function formatFindingLine(finding: Finding): string {
  const state =
    finding.progress.status === 'not-started'
      ? finding.state
      : `${finding.state}/${finding.progress.status}`;
  return [
    pad(finding.id, ID_WIDTH),
    pad(state, STATE_WIDTH),
    pad(finding.severity, SEVERITY_WIDTH),
    pad(finding.area, AREA_WIDTH),
    finding.title,
  ].join('');
}

/**
 * What the contest brief puts on the ruled option's heading. Sits between the
 * id and the label, where it cannot be read as part of either.
 */
const RULED_MARK = ' [ruled]';

/**
 * Dedication is stated rather than left to the marker's own bytes: the marker
 * reaches an option's meta line as literal markdown, and an agent reading past
 * it is exactly how the disposition goes unnoticed.
 */
const DEDICATED_FINDING_LINE =
  'Dedicated: this finding takes a session of its own, not an ordinary task.';
const DEDICATED_OPTION_LINE = 'Choosing this option makes the finding dedicated.';

function optionLines(option: FindingOption, mark: string): string[] {
  return [
    `Option ${option.id}:${mark} ${option.label}`,
    ...(option.dedicated ? [DEDICATED_OPTION_LINE] : []),
    ...(option.meta === null ? [] : [option.meta]),
    ...(option.body === '' ? [] : [option.body]),
    '',
  ];
}

function decisionLines(finding: Finding): string[] {
  if (finding.ruling !== null) {
    return [
      `Ruling: option ${finding.ruling.option}, at ${finding.ruling.at}`,
      ...(finding.ruling.text === null ? [] : [finding.ruling.text]),
      ...(finding.ruling.note === null ? [] : [`Note: ${finding.ruling.note}`]),
      'The ruling text outranks the option prose.',
    ];
  }
  if (finding.denial !== null) {
    return [
      `Denied by ${finding.denial.by}, at ${finding.denial.at}`,
      ...(finding.denial.reason === null ? [] : [finding.denial.reason]),
    ];
  }
  return ['Ruling: none yet'];
}

/**
 * One question, labelled by whether it has been answered. The index is the
 * question's position in the finding's own array, which is what a write
 * addresses, so it is printed even where nothing here is writable.
 */
function askedLines(question: Question, index: number): string[] {
  if (question.answer === null) {
    return [`Unanswered question ${String(index)}: ${question.text}`];
  }
  const stamp = question.answered_at === null ? '' : `, at ${question.answered_at}`;
  return [
    `Answered question ${String(index)}: ${question.text}`,
    `Answer${stamp}: ${question.answer}`,
  ];
}

/**
 * Every question the finding carries, answered or not, in the order it records
 * them. An answered question is evidence the next agent needs and the only
 * place a human's answer is written down, so leaving it out forces that agent
 * to re-ask or to guess; the order is the finding's own, because a question
 * asked after an answer reads as a follow-up only where it was recorded.
 */
function questionLines(finding: Finding): string[] {
  if (finding.questions.length === 0) return [];
  return [...finding.questions.flatMap((question, index) => askedLines(question, index)), ''];
}

/**
 * The whole note thread, in the order it was recorded. The brief is the only
 * history an agent picking a finding up is handed, so a note left out is a
 * reason that agent never sees: an answered block without the block, a fix
 * without the reasoning the ruling was carried out on.
 *
 * Each note is labelled by its role, never by recency or position. `Note` is an
 * account — what an agent had to say — and `Reply` is a note answering an
 * account already on record, so `Reply` on a thread no agent ever wrote to
 * would claim an exchange with nothing behind it, and those notes are labelled
 * `Note` instead.
 */
function noteLines(notes: readonly ProgressNote[]): string[] {
  if (notes.length === 0) return [];
  const { account, replies } = accountAndReplies(notes);
  // The helper resolves the latest exchange only. The notes ahead of it are the
  // exchange that one supersedes, and take their labels from the same rule.
  const earlier = notes.slice(0, notes.length - account.length - replies.length);
  const replyLabel = account.length === 0 ? 'Note' : 'Reply';
  return [
    ...noteLines(earlier),
    ...account.map((note) => `Note (${note.by}): ${note.text}`),
    ...replies.map((note) => `${replyLabel} (${note.by}): ${note.text}`),
  ];
}

function progressLines(finding: Finding): string[] {
  return [
    `Progress: ${finding.progress.status}${finding.progress.verified ? ', verified' : ''}`,
    ...noteLines(finding.progress.notes),
    '',
  ];
}

/**
 * The two fields that say which findings belong together. The brief is the only
 * surface that carries them to an agent, so an omitted line means the finding
 * declares nothing — never that the brief dropped it.
 */
function groupingLines(finding: Finding): string[] {
  return [
    ...(finding.group === null ? [] : [`Group: ${finding.group}`]),
    ...(finding.related.length === 0 ? [] : [`Related: ${finding.related.join(', ')}`]),
  ];
}

function briefBody(finding: Finding, options: readonly string[]): string {
  return [
    `${finding.id}  ${finding.severity}  ${finding.status}  ${finding.area}`,
    finding.title,
    ...groupingLines(finding),
    ...(finding.dedicated ? [DEDICATED_FINDING_LINE] : []),
    '',
    ...decisionLines(finding),
    '',
    ...questionLines(finding),
    ...progressLines(finding),
    finding.explainer,
    '',
    ...options,
  ].join('\n');
}

/**
 * What an implementation agent reads before it starts. The decision comes
 * first, because the ruling is what it has to carry out and the body is the
 * evidence behind it; a ruled finding shows only the option that was chosen.
 */
export function formatBrief(finding: Finding): string {
  const chosen =
    finding.ruling === null
      ? finding.options
      : finding.options.filter((option) => option.id === finding.ruling?.option);

  return briefBody(
    finding,
    chosen.flatMap((option) => optionLines(option, ''))
  );
}

/**
 * The same brief for the opposite reader. An agent carrying a ruling out should
 * not be reading the roads not taken, so `formatBrief` hides them; an agent
 * arguing that another option was better needs exactly those, so this one shows
 * every option and marks the one that was chosen. Two entry points rather than
 * a mode, because which reader is asking is the whole distinction.
 */
export function formatContestBrief(finding: Finding): string {
  return briefBody(
    finding,
    finding.options.flatMap((option) =>
      optionLines(option, option.id === finding.ruling?.option ? RULED_MARK : '')
    )
  );
}

/** What the questions brief needs: the console's finding and the file's both satisfy it. */
interface QuestionsBriefFinding {
  readonly id: string;
  readonly title: string;
  readonly questions: readonly Question[];
}

const QUESTIONS_PREAMBLE = [
  'Questions from the audit console, one document for every finding still waiting on an answer.',
  'Answer each one by running the command printed under it from the repository root.',
  'Replace <answer> with your answer; leave the id and the index exactly as printed.',
];

function questionsSection(finding: QuestionsBriefFinding): string {
  const asked = outstandingQuestions(finding).map(
    (question) =>
      `${question.text}\npnpm docket --answer ${finding.id} "<answer>" --index ${String(question.index)}`
  );
  return [`## ${finding.title}`, `Finding ${finding.id}`, '', asked.join('\n\n')].join('\n');
}

/**
 * Every outstanding question across an audit, as one document to hand an
 * implementation agent. The reader on the other end has none of this console's
 * context, so each group is headed by the title of the finding it is about and
 * every question carries the command that answers that one: the index is the
 * question's position in its own finding, which is what the write routes by.
 */
export function formatQuestionsBrief(findings: readonly QuestionsBriefFinding[]): string | null {
  const sections = findings
    .filter((finding) => outstandingQuestions(finding).length > 0)
    .map((finding) => questionsSection(finding));

  return sections.length === 0 ? null : [QUESTIONS_PREAMBLE.join('\n'), ...sections].join('\n\n');
}
