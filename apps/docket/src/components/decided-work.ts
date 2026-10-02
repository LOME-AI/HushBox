import { STATUS_LABELS } from './panes/progress/board-order.ts';
import type { FindingJson } from '@hushbox/docket';

/**
 * Whether the finding already carries a decision. This is what every route to
 * discarding one asks first, so re-ruling it, denying it and reopening it agree
 * about when the reader is taking a decision back rather than making one.
 */
export function isDecided(finding: FindingJson): boolean {
  return finding.ruling !== null || finding.denial !== null;
}

/**
 * Whether the implementation of a ruling has stopped. An agent that cannot carry
 * a ruling out records it here, and the console answers by taking the finding
 * out of the handoff and putting it back in front of the reader. Shared so the
 * queue that collects these and the card that explains one cannot disagree about
 * which findings are stuck.
 *
 * The state is part of the question rather than assumed: progress is only work
 * against a ruling, so an undecided finding carrying the status is a stale field
 * from a decision that has since been taken back.
 *
 * Typed on the two fields it reads rather than on the console's render shape,
 * so the store's own finding — which carries no `titleHtml` and cannot be given
 * one outside a browser — is answerable too.
 */
export function isBlocked(finding: Pick<FindingJson, 'state' | 'progress'>): boolean {
  return finding.state === 'ruled' && finding.progress.status === 'blocked';
}

/**
 * Whether anyone has acted on a finding's decision yet. This is what makes
 * discarding that decision worth stopping the reader over: the decision itself
 * is archived either way, but the work done against it is somebody's time.
 * Shared so the two ways to discard a ruling, reopening it and re-ruling it,
 * cannot disagree about when to ask.
 */
export function hasProgressWork(finding: FindingJson): boolean {
  const { progress } = finding;
  return progress.notes.length > 0 || progress.verified || progress.status !== 'not-started';
}

/**
 * Whether taking a decision would put this finding's recorded progress back to
 * its defaults. The store's `clearing()` resets the status and the verification
 * and keeps the notes, and resets nothing at all where both are already at their
 * defaults, so notes on their own are not something a decision costs.
 *
 * Deliberately a second expression of the store's own condition rather than a
 * shared one: this side decides whether to warn the reader, the store decides
 * what to write, and the packages the store lives in cannot import a console
 * helper. Drift shows up as a warning about nothing, never as a wrong write.
 */
export function decisionResetsProgress(finding: FindingJson): boolean {
  const { progress } = finding;
  return progress.status !== 'not-started' || progress.verified;
}

/**
 * What discarding a decision does to the work recorded against it. Every route
 * to discarding one runs through the same `clearing()` reset, so a correction to
 * this sentence must reach all of them at once: two copies would leave one
 * dialog making a promise the code had stopped keeping.
 */
export const PROGRESS_RESET_CONSEQUENCE =
  'The notes are kept. The status and verification return to their defaults.';

function noteClause(count: number): string {
  if (count === 0) return 'no progress notes';
  return `${String(count)} progress note${count === 1 ? '' : 's'}`;
}

/**
 * What the work actually is, in one sentence. Naming only the note count says
 * "0 progress notes" whenever the work is a status or a verification, which
 * tells the reader nothing is at stake in the one sentence whose job is saying
 * something is. `--set progress.status=` is a first-class way to record work,
 * so that state is ordinary rather than a corner.
 */
export function describeProgressWork(finding: FindingJson): string {
  const { progress } = finding;
  const notes = noteClause(progress.notes.length);
  const kinds = [
    ...(progress.status === 'not-started' ? [] : [`marked ${STATUS_LABELS[progress.status]}`]),
    ...(progress.verified ? ['verified'] : []),
  ];

  if (kinds.length === 0) {
    return `${notes} ${progress.notes.length === 1 ? 'is' : 'are'} recorded against it.`;
  }
  return `It is ${kinds.join(' and ')}, with ${notes}.`;
}
