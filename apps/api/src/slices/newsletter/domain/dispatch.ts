import { z } from 'zod';
import { NEWSLETTER_DEFAULT_TOPIC } from '@hushbox/shared';
import { chunkedWork, enqueueWithinTx } from '../../../lib/jobs/index.js';
import { renderIssueEmail } from './issue-email.js';
import type { DbWriter } from '../../../lib/idempotency/transaction.js';
import type {
  ChunkResult,
  ChunkedJobRegistration,
  EnqueueJobResult,
  JobRegistry,
  JobWakeCapable,
} from '../../../lib/jobs/index.js';
import type { BatchEmailSender } from '../../notifications/index.js';
import type { DeliveryTarget, NewsletterDispatchStore } from '../ports/index.js';
import type { IssueEmailUrls } from './issue-email.js';

export const NEWSLETTER_DISPATCH_JOB_TYPE = 'newsletter.dispatch.v1';

/**
 * Only transient provider failures consume the budget (a failed batch send);
 * every terminal issue state maps to `ok`. Sibling precedent:
 * `media.reclaimUser.v1`.
 */
const NEWSLETTER_DISPATCH_MAX_FAILURES = 8;

/**
 * How many times a claim landing before the issue is due may checkpoint. A
 * checkpoint costs no retry and re-pends immediately, so an issue rescheduled
 * genuinely far ahead would otherwise checkpoint forever with nothing to
 * dead-letter it; past this count the attempt fails and the ordinary failure
 * budget carries it to `dead`.
 */
export const NEWSLETTER_DISPATCH_MAX_NOT_DUE_YIELDS = 3;

/** Resend's `/emails/batch` hard cap — also the default dispatch batch size. */
const DEFAULT_BATCH_SIZE = 100;

/**
 * The yield checkpoint. `cursor` is the frozen list's keyset position and the
 * only thing that names a page: it selects the recipients AND builds their
 * send's idempotency key, so the two cannot come apart. A second field
 * counting attempts could — a checkpoint written before this one existed
 * still parses, and would then pair a stale counter with the head page. The
 * executor replaces the payload with the checkpoint, so completed batches are
 * skipped by construction on the next claim (and re-verified by the
 * delivery-row fence regardless).
 */
export const newsletterDispatchPayloadSchema = z.object({
  issueId: z.uuid(),
  cursor: z.uuid().nullable().default(null),
  notDueYields: z.number().int().min(0).default(0),
});

type DispatchPayload = z.infer<typeof newsletterDispatchPayloadSchema>;

/** The frozen list's keyset position; `null` is its head. */
type DispatchCursor = DispatchPayload['cursor'];

type DispatchChunk = ChunkResult<DispatchPayload, DispatchCursor>;

interface NewsletterDispatchSendDeps {
  readonly sender: BatchEmailSender;
  readonly urls: IssueEmailUrls;
}

interface NewsletterDispatchDeps {
  readonly store: NewsletterDispatchStore;
  /** Resolved inside the handler so a config fault is an isolated row failure. */
  readonly resolveSend: () => NewsletterDispatchSendDeps;
  /** The list this dispatch serves; the launch topic unless bound otherwise. */
  readonly topic?: string | undefined;
  /** Test seam, only narrowing-down; never above the provider cap. */
  readonly batchSize?: number | undefined;
}

/**
 * The admin scheduling op's enqueue, atomic with its issue insert: the jobs
 * row lands in the caller's transaction, first attempted at `scheduledAt`,
 * deduped so one issue can never carry two active dispatch rows.
 */
export function enqueueIssueDispatch(
  tx: JobWakeCapable<DbWriter>,
  registry: JobRegistry,
  params: { readonly issueId: string; readonly scheduledAt: Date }
): Promise<EnqueueJobResult> {
  return enqueueWithinTx(tx, registry, {
    type: NEWSLETTER_DISPATCH_JOB_TYPE,
    payload: { issueId: params.issueId },
    dedupeKey: `newsletter.dispatch:${params.issueId}`,
    scheduledAt: params.scheduledAt,
  });
}

function terminalChunkFor(claim: 'missing' | 'canceled' | 'sent'): DispatchChunk {
  switch (claim) {
    case 'missing': {
      return { kind: 'dead', error: 'dispatch issue does not exist' };
    }
    case 'canceled': {
      return { kind: 'ok', result: 'canceled' };
    }
    case 'sent': {
      return { kind: 'ok', result: 'already-sent' };
    }
  }
}

/**
 * An early claim is a rescheduling, not a fault: the dispatcher makes a job
 * eligible on the database's clock and the due check reads that same clock,
 * so the two agree, and what is left is an issue whose `scheduledAt` moved.
 * Checkpointing rather than failing keeps the retry budget for real send
 * failures — bounded, because a checkpoint does not spend one.
 */
function notDueChunkFor(payload: DispatchPayload): DispatchChunk {
  if (payload.notDueYields >= NEWSLETTER_DISPATCH_MAX_NOT_DUE_YIELDS) {
    return { kind: 'fail', error: 'dispatch issue is still not due' };
  }
  return { kind: 'defer', payload: { ...payload, notDueYields: payload.notDueYields + 1 } };
}

/**
 * `newsletter.dispatch.v1` — sends one issue to every subscribed recipient.
 *
 * Idempotency is layered, `natural` class:
 * - the issue's atomic `scheduled → sending` claim admits exactly one live run
 *   (lease-reclaimed retries re-enter through the `sending` branch);
 * - each recipient's delivery row (`UNIQUE(issueId, subscriberId)`, inserted
 *   `claimed` before any send) is the per-recipient fence — rows already
 *   `sent` are never re-marked, and a batch whose rows are all finished is
 *   skipped without a provider call;
 * - each batch's send carries the deterministic
 *   `newsletter:{issueId}:{page position}` Idempotency-Key — derived from the
 *   same cursor that selected the page, so a page and its key are one fact
 *   rather than two that must agree — and a retry re-sends the FULL batch
 *   under that same key:
 *   the provider replays the original accepted request (delivering at most
 *   once per recipient) and returns the original index-matched ids, which is
 *   what lets the retry finish `claimed`-but-unsent rows safely.
 *
 * Exactly-once delivery of a replayed batch therefore rests on the provider
 * honoring that key, and nothing local verifies it: the tests pin the key's
 * determinism and the composition it names, while the one path that would
 * prove the guarantee — the provider accepted a batch and the delivery
 * marking then failed — is only reachable through a real send. Trusting a
 * true external seam's own contract rather than re-verifying it here is the
 * deliberate choice.
 *
 * Batch composition is frozen at claim time: the winning `scheduled →
 * sending` transition inserts every delivery row in its own transaction, and
 * no later attempt inserts any — batches are keyset pages over those rows
 * (ordered by subscriberId), immutable for the issue's lifetime, so a cursor
 * names the same recipients on every replay. A subscriber
 * who joins mid-dispatch is simply not in this issue; one who unsubscribes
 * keeps their row (they were subscribed at the freeze).
 *
 * Batches send sequentially (the provider's 5 req/s budget), and the page
 * cursor is the framework chunk loop's: it runs pages while the execution
 * budget holds and checkpoints the cursor when it does not, so long lists
 * consume no failure budget.
 *
 * An issue carries no topic of its own, so the recipients it reaches are the
 * ones this job's binding selects. That holds while exactly one list has
 * subscribers; the handler asserts that on the attempt that freezes the
 * audience, and dead-letters once a second topic carries any.
 */
export function createNewsletterDispatchJobRegistration(
  deps: NewsletterDispatchDeps
): ChunkedJobRegistration<typeof newsletterDispatchPayloadSchema> {
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > DEFAULT_BATCH_SIZE) {
    throw new Error(
      `newsletter dispatch: batchSize must be an integer between 1 and ${String(DEFAULT_BATCH_SIZE)}`
    );
  }
  const topic = deps.topic ?? NEWSLETTER_DEFAULT_TOPIC;

  async function sendBatch(
    send: NewsletterDispatchSendDeps,
    params: {
      readonly issue: {
        readonly subject: string;
        readonly bodyMarkdown: string;
        readonly scheduledAt: Date;
      };
      readonly issueId: string;
      readonly cursor: string | null;
      readonly batch: readonly DeliveryTarget[];
    }
  ): Promise<DispatchChunk | null> {
    const { issue, issueId, cursor, batch } = params;
    const unfinished = batch.filter((target) => target.status !== 'sent');
    if (unfinished.length === 0) return null;

    // The FULL batch replays under the fixed key (see the registration doc);
    // only unfinished rows are (re-)marked from the index-matched response.
    const messages = batch.map((target) => {
      const rendered = renderIssueEmail({
        subject: issue.subject,
        bodyMarkdown: issue.bodyMarkdown,
        unsubscribeToken: target.unsubscribeToken,
        urls: send.urls,
        // The scheduled date, never the clock: a retry replays this batch under the
        // same provider key, so its bodies must not change across a year boundary.
        sentAt: issue.scheduledAt,
      });
      return { to: target.email, ...rendered };
    });
    const sent = await send.sender.sendBatch(messages, {
      idempotencyKey: `newsletter:${issueId}:${cursor ?? 'head'}`,
    });
    if (sent.isErr()) {
      await deps.store.markDeliveries(
        unfinished
          .filter((target) => target.status === 'claimed')
          .map((target) => target.deliveryId),
        'failed'
      );
      return { kind: 'fail', error: `newsletter batch send failed: ${sent.error.code}` };
    }
    const resendIdByDeliveryId = new Map(
      batch.map((target, index): readonly [string, string] => {
        // The adapters reject a response whose id count mismatches the batch,
        /* v8 ignore next -- so the `?? ''` arm only narrows the indexed type */
        const resendId = sent.value.ids[index] ?? '';
        return [target.deliveryId, resendId];
      })
    );
    await deps.store.markDeliveries(
      unfinished.map((target) => target.deliveryId),
      'sent',
      resendIdByDeliveryId
    );
    return null;
  }

  return {
    kind: 'chunked',
    type: NEWSLETTER_DISPATCH_JOB_TYPE,
    schema: newsletterDispatchPayloadSchema,
    maxExecutionSeconds: 300,
    maxFailures: NEWSLETTER_DISPATCH_MAX_FAILURES,
    idempotency: 'natural',
    shard: 'bulk',
    chunked: chunkedWork<DispatchPayload, DispatchCursor>({
      readCursor: (payload) => payload.cursor,
      withCursor: (payload, cursor) => ({ ...payload, cursor }),
      runChunk: async ({ payload, cursor }): Promise<DispatchChunk> => {
        const { issueId } = payload;
        // Ahead of the claim: a config fault must fail the row without moving
        // the issue `scheduled → sending`, which only a live sender may do.
        const send = deps.resolveSend();
        // A second list means this issue's recipients were decided by wiring,
        // and sending it anyway would mail the wrong people. Asked only of the
        // chunk that has no page yet — the one that freezes the audience.
        // Asking per page would be destructive as well as costly: after the
        // freeze the answer cannot change who receives this issue, so a topic
        // appearing then strands a half-sent issue instead of preventing one,
        // and every ask reads the whole subscribed list.
        if (cursor === null && (await deps.store.hasMultipleSubscriberTopics())) {
          return { kind: 'dead', error: 'newsletter subscribers span more than one topic' };
        }
        const claim = await deps.store.claimIssue(issueId, topic);
        if (claim.kind === 'not-due') {
          return notDueChunkFor(payload);
        }
        if (claim.kind !== 'claimed') {
          return terminalChunkFor(claim.kind);
        }

        const batch = await deps.store.loadTargets(issueId, { after: cursor, limit: batchSize });
        const last = batch.at(-1);
        if (last === undefined) {
          await deps.store.completeIssue(issueId, new Date());
          return { kind: 'ok', result: 'sent' };
        }
        const failure = await sendBatch(send, {
          issue: claim,
          issueId,
          cursor,
          batch,
        });
        if (failure !== null) return failure;

        // A short page is the end of the list. A full one may not be, so the
        // next page reads from this batch's last recipient and finds nothing
        // if it was.
        if (batch.length < batchSize) {
          await deps.store.completeIssue(issueId, new Date());
          return { kind: 'ok', result: 'sent' };
        }
        return { kind: 'advance', cursor: last.subscriberId };
      },
    }),
  };
}
