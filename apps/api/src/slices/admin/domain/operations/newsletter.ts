import { ADMIN_OP_CONTRACTS } from '@hushbox/shared';
import { conflictError, notFoundError, validationError } from '../../../../lib/errors/index.js';
import { err, errAsync, ok, okAsync } from '../../../../lib/result/index.js';
import { cancelIssueWithinTx, createIssueWithinTx } from '../../../newsletter/index.js';
import { newsletterMarkdownSchema } from '../../../notifications/index.js';
import { defineAdminOp } from '../registry.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { SettlementTx } from '../../../../lib/idempotency/index.js';
import type { EnqueueJobResult, JobWakeCapable } from '../../../../lib/jobs/index.js';
import type { ResultAsync } from '../../../../lib/result/index.js';
import type { NewsletterIssueRow } from '../../../newsletter/index.js';
import type { AdminOpsClock } from './user.js';

/**
 * The newsletter issue lifecycle ops — the durable pair `newsletter.schedule`
 * ↔ `newsletter.cancel` plus the ephemeral `newsletter.testSend` — composed
 * from the newsletter slice's published within-tx surface. Schedule commits
 * the issue row and its dispatch job together in the settlement transaction
 * (both roll back in preview); cancel's undo re-schedules an IDENTICAL fresh
 * issue from the snapshot captured at cancel time (inverse snapshot
 * semantics), so undoing a cancel whose scheduledAt has already passed fails
 * schedule's future gate naturally — deliberate, pinned by test.
 */

const scheduleContract = ADMIN_OP_CONTRACTS['newsletter.schedule'];
const cancelContract = ADMIN_OP_CONTRACTS['newsletter.cancel'];
const testSendContract = ADMIN_OP_CONTRACTS['newsletter.testSend'];

/** A body whose links the email writer would refuse is refused here, not at send time. */
const UNSENDABLE_LINK = 'newsletter issue body carries a link an email cannot send';

export interface AdminNewsletterDeps {
  readonly clock: AdminOpsClock;
  /**
   * The acting admin's allowlisted Access email (the Single Auth Path
   * identity) — recorded as the issue's `createdBy` and the test-send
   * recipient. Always engine-request identity, never an input field.
   */
  actorEmail(): string;
  /** Curried over the composition root's job registry (the dispatch registration). */
  readonly newsletterDispatch: {
    enqueueWithinTx(
      tx: JobWakeCapable<SettlementTx>,
      params: { readonly issueId: string; readonly scheduledAt: Date }
    ): Promise<EnqueueJobResult>;
  };
  /** Within-tx issue read for cancel's inverse snapshot (the request's
   * database is serial and refuses a base-db read inside the open settlement
   * transaction at once, so the read must ride `ctx.tx`). */
  readonly newsletterIssueReader: {
    readWithinTx(tx: SettlementTx, issueId: string): Promise<NewsletterIssueRow | null>;
  };
}

/**
 * What the engine hands the newsletter ephemerals once the transaction has
 * committed: the live Resend-backed test sender, and nothing else. It is not
 * reachable from an op body — a send from inside the transaction would
 * survive a preview's rollback as a delivered email.
 */
export interface AdminNewsletterPostDeps {
  /** The rendered-issue test email over the composed EmailSender port. */
  readonly newsletterTestEmail: {
    send(params: {
      readonly subject: string;
      readonly bodyMarkdown: string;
      readonly to: string;
    }): ResultAsync<void, DomainError>;
  };
}

export const newsletterSchedule = defineAdminOp<
  AdminNewsletterDeps,
  (typeof scheduleContract)['input'],
  AdminNewsletterPostDeps
>(scheduleContract, {
  execute: async (ctx, input) => {
    if (!newsletterMarkdownSchema.safeParse(input.bodyMarkdown).success) {
      return err(validationError(UNSENDABLE_LINK));
    }
    const scheduledAt = new Date(input.scheduledAt);
    // Injected clock — op-body modules may not call `Date.now()` (purity lint).
    if (scheduledAt.getTime() <= ctx.deps.clock.now().getTime()) {
      return err(validationError('newsletter issue must be scheduled in the future'));
    }
    const issue = await createIssueWithinTx(ctx.tx, {
      subject: input.subject,
      bodyMarkdown: input.bodyMarkdown,
      scheduledAt,
      createdBy: ctx.deps.actorEmail(),
    });
    await ctx.deps.newsletterDispatch.enqueueWithinTx(ctx.tx, { issueId: issue.id, scheduledAt });
    return ok({
      effects: [
        {
          label: 'newsletter.issue',
          before: null,
          // No issue id here: preview and execute run in separate rolled-back
          // vs committed transactions, so a generated id would break the
          // preview ≡ execute battery. The id rides `target`/`inverseInput`.
          after: {
            subject: issue.subject,
            status: issue.status,
            scheduledAt: issue.scheduledAt.toISOString(),
          },
        },
      ],
      target: { type: 'newsletterIssue', id: issue.id },
      inverseInput: { issueId: issue.id },
    });
  },
});

export const newsletterCancel = defineAdminOp<
  AdminNewsletterDeps,
  (typeof cancelContract)['input'],
  AdminNewsletterPostDeps
>(cancelContract, {
  execute: async (ctx, input) => {
    const outcome = await cancelIssueWithinTx(ctx.tx, input.issueId);
    if (outcome.kind === 'not-found') {
      return err(notFoundError('newsletter issue does not exist'));
    }
    if (outcome.kind === 'illegal-state') {
      return err(conflictError('newsletter issue dispatch has already begun'));
    }
    // The snapshot read happens after the conditional cancel, inside the same
    // transaction snapshot: the row is known to exist and its content columns
    // are immutable, so a missing row here is a defect, not a state.
    const issue = await ctx.deps.newsletterIssueReader.readWithinTx(ctx.tx, input.issueId);
    /* v8 ignore next 3 -- unreachable: the cancel above saw the row in this same transaction snapshot */
    if (issue === null) {
      throw new Error('newsletter.cancel: issue row vanished within its own transaction');
    }
    return ok({
      effects: [
        {
          label: 'newsletter.issue.status',
          before: outcome.kind === 'canceled' ? 'scheduled' : 'canceled',
          after: 'canceled',
        },
      ],
      target: { type: 'newsletterIssue', id: input.issueId },
      inverseInput: {
        subject: issue.subject,
        bodyMarkdown: issue.bodyMarkdown,
        scheduledAt: issue.scheduledAt.toISOString(),
      },
    });
  },
});

export const newsletterTestSend = defineAdminOp<
  AdminNewsletterDeps,
  (typeof testSendContract)['input'],
  AdminNewsletterPostDeps
>(testSendContract, {
  execute: (ctx, input) => {
    if (!newsletterMarkdownSchema.safeParse(input.bodyMarkdown).success) {
      return errAsync(validationError(UNSENDABLE_LINK));
    }
    const to = ctx.deps.actorEmail();
    // Post-commit ephemeral: the op body performs no external call (the send
    // runs only after the audit row commits, never in preview), and a send
    // failure is captured telemetry, never a failed op.
    ctx.registerEphemeral({
      name: 'newsletter.testSend.email',
      run: async (post): Promise<void> => {
        const sent = await post.newsletterTestEmail.send({
          subject: input.subject,
          bodyMarkdown: input.bodyMarkdown,
          to,
        });
        if (sent.isErr()) {
          throw new Error(`newsletter test send failed: ${sent.error.code}`);
        }
      },
    });
    return okAsync({
      effects: [{ label: 'newsletter.testSend', after: { subject: input.subject, to } }],
    });
  },
});
