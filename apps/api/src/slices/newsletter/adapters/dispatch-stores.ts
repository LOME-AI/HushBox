import { and, asc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import { newsletterDeliveries, newsletterIssues, newsletterSubscribers } from '@hushbox/db';
import type { Database } from '@hushbox/db';
import type {
  DeliveryPage,
  DeliveryTarget,
  DispatchIssueClaim,
  NewsletterDispatchStore,
} from '../ports/dispatch-store.js';

/**
 * Drizzle implementation of the dispatch store. Single-writer: this slice
 * owns `newsletter_issues` and `newsletter_deliveries`; the WHERE clause (or
 * the unique constraint) is the state check, never check-then-act.
 */
export function createNewsletterDispatchStores(db: Database): NewsletterDispatchStore {
  return {
    async claimIssue(issueId: string, topic: string): Promise<DispatchIssueClaim> {
      return db.transaction(async (tx): Promise<DispatchIssueClaim> => {
        const claimed = await tx
          .update(newsletterIssues)
          .set({ status: 'sending' })
          .where(
            and(
              eq(newsletterIssues.id, issueId),
              eq(newsletterIssues.status, 'scheduled'),
              lte(newsletterIssues.scheduledAt, sql`now()`)
            )
          )
          .returning({
            subject: newsletterIssues.subject,
            bodyMarkdown: newsletterIssues.bodyMarkdown,
            scheduledAt: newsletterIssues.scheduledAt,
          });
        const row = claimed[0];
        if (row !== undefined) {
          // The winner freezes the recipient set atomically with its claim:
          // rows exist iff the sending transition committed, so no later
          // attempt (yield resume or lease-reclaim) ever adds one. One
          // INSERT … SELECT rather than a read plus chunked writes: the list
          // never crosses the wire, and the issue row's lock is held for a
          // single statement whatever the list's size. Unnamed columns take
          // their schema defaults, so the id and timestamp are not restated
          // here.
          await tx.execute(sql`
            insert into ${newsletterDeliveries} (
              ${sql.identifier(newsletterDeliveries.issueId.name)},
              ${sql.identifier(newsletterDeliveries.subscriberId.name)},
              ${sql.identifier(newsletterDeliveries.status.name)}
            )
            select ${issueId}::uuid, ${newsletterSubscribers.id}, 'claimed'
            from ${newsletterSubscribers}
            where ${newsletterSubscribers.status} = 'subscribed'
              and ${newsletterSubscribers.topic} = ${topic}
          `);
          return { kind: 'claimed', ...row };
        }

        const current = await tx
          .select({
            status: newsletterIssues.status,
            subject: newsletterIssues.subject,
            bodyMarkdown: newsletterIssues.bodyMarkdown,
            scheduledAt: newsletterIssues.scheduledAt,
          })
          .from(newsletterIssues)
          .where(eq(newsletterIssues.id, issueId));
        const issue = current[0];
        if (issue === undefined) return { kind: 'missing' };
        switch (issue.status) {
          case 'canceled': {
            return { kind: 'canceled' };
          }
          case 'sent': {
            return { kind: 'sent' };
          }
          case 'sending': {
            // The lease-reclaimed retry of the run that already claimed (and
            // froze) it; the delivery rows are the composition of record.
            return {
              kind: 'claimed',
              subject: issue.subject,
              bodyMarkdown: issue.bodyMarkdown,
              scheduledAt: issue.scheduledAt,
            };
          }
          case 'scheduled': {
            return { kind: 'not-due' };
          }
        }
      });
    },

    async loadTargets(issueId: string, page: DeliveryPage): Promise<DeliveryTarget[]> {
      return db
        .select({
          deliveryId: newsletterDeliveries.id,
          subscriberId: newsletterDeliveries.subscriberId,
          status: newsletterDeliveries.status,
          email: newsletterSubscribers.email,
          unsubscribeToken: newsletterSubscribers.unsubscribeToken,
        })
        .from(newsletterDeliveries)
        .innerJoin(
          newsletterSubscribers,
          eq(newsletterDeliveries.subscriberId, newsletterSubscribers.id)
        )
        .where(
          page.after === null
            ? eq(newsletterDeliveries.issueId, issueId)
            : and(
                eq(newsletterDeliveries.issueId, issueId),
                gt(newsletterDeliveries.subscriberId, page.after)
              )
        )
        .orderBy(asc(newsletterDeliveries.subscriberId))
        .limit(page.limit);
    },

    async markDeliveries(
      deliveryIds: readonly string[],
      status: 'sent' | 'failed',
      resendIdByDeliveryId?: ReadonlyMap<string, string>
    ): Promise<void> {
      if (deliveryIds.length === 0) return;
      // One statement for the batch: the per-recipient provider ids ride a
      // CASE over the same id list the WHERE selects, so the round trips do
      // not grow with the batch.
      const resendEmailId =
        resendIdByDeliveryId === undefined
          ? null
          : sql`case ${sql.join(
              deliveryIds.map(
                (deliveryId) =>
                  sql`when ${newsletterDeliveries.id} = ${deliveryId} then ${
                    /* v8 ignore next -- the map is built from the whole batch, so this only narrows `get`'s optional return */
                    resendIdByDeliveryId.get(deliveryId) ?? null
                  }`
              ),
              sql` `
            )} end`;
      // `sent` is monotone-terminal — the mail provably went out — while
      // `failed` only records that one attempt did not deliver and a later one
      // may still turn it into `sent`. So the only forbidden transition is
      // `sent → failed`, and the `failed` write carries the predicate that
      // refuses it. A `claimed`-only guard would be wrong in the other
      // direction: a retry re-sends the page it failed on, whose rows are
      // already `failed`. Zero rows matched is the benign already-done case —
      // a live executor recorded `sent` first — so nothing here inspects the
      // count.
      const guard =
        status === 'failed'
          ? and(
              inArray(newsletterDeliveries.id, [...deliveryIds]),
              eq(newsletterDeliveries.status, 'claimed')
            )
          : inArray(newsletterDeliveries.id, [...deliveryIds]);
      await db.update(newsletterDeliveries).set({ status, resendEmailId }).where(guard);
    },

    async hasMultipleSubscriberTopics(): Promise<boolean> {
      // Subscribed rows only — an audience is what an issue can reach, and a
      // suppressed or unsubscribed row on another topic receives nothing.
      // The limit caps what is returned, not what is read: `distinct` is a
      // filter over an ordered scan, so one topic emits one row and the scan
      // runs to the end of the list. Costed as a whole-list read, which is
      // why the caller asks once per issue.
      const topics = await db
        .selectDistinct({ topic: newsletterSubscribers.topic })
        .from(newsletterSubscribers)
        .where(eq(newsletterSubscribers.status, 'subscribed'))
        .limit(2);
      return topics.length > 1;
    },

    async completeIssue(issueId: string, now: Date): Promise<void> {
      const counts = await db
        .select({
          total: sql<number>`count(*)::int`,
          sent: sql<number>`count(*) FILTER (WHERE ${newsletterDeliveries.status} = 'sent')::int`,
          failed: sql<number>`count(*) FILTER (WHERE ${newsletterDeliveries.status} = 'failed')::int`,
        })
        .from(newsletterDeliveries)
        .where(eq(newsletterDeliveries.issueId, issueId));
      /* v8 ignore next -- a count(*) aggregate always returns exactly one row */
      const tally = counts[0] ?? { total: 0, sent: 0, failed: 0 };
      await db
        .update(newsletterIssues)
        .set({
          status: 'sent',
          sentAt: now,
          recipientCount: tally.total,
          sentCount: tally.sent,
          failedCount: tally.failed,
        })
        .where(and(eq(newsletterIssues.id, issueId), eq(newsletterIssues.status, 'sending')));
    },
  };
}
