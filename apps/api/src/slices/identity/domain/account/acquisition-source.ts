import { hasCompletedPayment } from '../../../billing/public/has-completed-payment.js';
import { okAsync } from '../../../../lib/result/index.js';
import type { AcquisitionSourceView, SelfReportAction } from '@hushbox/shared';
import type { Database } from '@hushbox/db';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { ResultAsync } from '../../../../lib/result/index.js';
import type { AcquisitionSelfReport, IdentityUsersStore } from '../../ports/index.js';

export interface AcquisitionSourceArgs {
  readonly store: IdentityUsersStore;
  /** Read only through billing's published door, which owns `payments`. */
  readonly db: Database;
  readonly userId: string;
}

/** Nothing to ask an account that carries no acquisition row to answer. */
const NOTHING_DUE: AcquisitionSourceView = { duePrompt: null };

/**
 * Which channel prompt, if any, this account is owed.
 *
 * The predicate lives on the server and only on the server: the client renders
 * whatever this says and records nothing on the device, so a skip on a phone
 * still holds on a laptop. The two moments are ordered — after signup, then
 * again once money has actually moved — and the second is asked even to a
 * person who skipped the first, because someone who has just paid is a
 * different person from someone who has just arrived.
 *
 * A skip recorded at the later context ends the asking; an answer ends it from
 * either.
 */
export function readAcquisitionSource(
  args: AcquisitionSourceArgs
): ResultAsync<AcquisitionSourceView, DomainError> {
  return args.store
    .readAcquisitionSelfReport(args.userId)
    .andThen((report) => duePromptFor(args, report));
}

function duePromptFor(
  args: AcquisitionSourceArgs,
  report: AcquisitionSelfReport | null
): ResultAsync<AcquisitionSourceView, DomainError> {
  if (report?.channel != null) return okAsync(NOTHING_DUE);
  if (report === null) return okAsync(NOTHING_DUE);
  if (report.skipped === null) return okAsync<AcquisitionSourceView>({ duePrompt: 'post_signup' });
  if (report.skipped === 'first_payment') return okAsync(NOTHING_DUE);
  return hasCompletedPayment(args.db, args.userId).map(
    (paid): AcquisitionSourceView => ({ duePrompt: paid ? 'first_payment' : null })
  );
}

/**
 * One of the prompt's two verbs, applied to the account and answered with what
 * is due afterwards — so the caller renders the next state from the same
 * predicate that produced the current one, rather than inferring it.
 *
 * Both verbs converge on replay: an answer is guarded on the channel still
 * being null so the first one stands, and a skip moves forward through the
 * ordered contexts and never back. Neither is an error when it finds nothing
 * to change; an account carrying no acquisition row simply has nothing due.
 */
export function applySelfReport(
  args: AcquisitionSourceArgs,
  action: SelfReportAction,
  now: Date
): ResultAsync<AcquisitionSourceView, DomainError> {
  const applied =
    action.action === 'answer'
      ? args.store
          .recordSelfReportedChannel({
            userId: args.userId,
            channel: action.channel,
            context: action.context,
            at: now,
          })
          .map((): void => undefined)
      : args.store.recordSelfReportSkip({ userId: args.userId, context: action.context });
  return applied.andThen(() => readAcquisitionSource(args));
}
