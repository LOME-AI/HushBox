/** One recipient's delivery row joined with its send address and token. */
export interface DeliveryTarget {
  readonly deliveryId: string;
  readonly subscriberId: string;
  readonly status: 'claimed' | 'sent' | 'failed';
  readonly email: string;
  readonly unsubscribeToken: string;
}

/** One keyset page of a frozen recipient list, `after` exclusive. */
export interface DeliveryPage {
  readonly after: string | null;
  readonly limit: number;
}

/** The atomic issue-claim disposition the dispatch handler branches on. */
export type DispatchIssueClaim =
  | {
      readonly kind: 'claimed';
      readonly subject: string;
      readonly bodyMarkdown: string;
      /** The send date every recipient's email states, whichever attempt renders it. */
      readonly scheduledAt: Date;
    }
  | { readonly kind: 'canceled' }
  | { readonly kind: 'sent' }
  | { readonly kind: 'not-due' }
  | { readonly kind: 'missing' };

/**
 * The dispatch job's single-writer store over `newsletter_issues` +
 * `newsletter_deliveries`. Every mutation is an atomic conditional statement;
 * infra failures throw (the job attempt fails and retries).
 */
export interface NewsletterDispatchStore {
  /**
   * `scheduled → sending` when due, and — in the SAME transaction — the
   * recipient freeze: the winning claim inserts one `claimed` delivery row
   * per then-subscribed recipient, so composition is immutable for the
   * issue's lifetime (a subscriber who joins mid-dispatch is simply not in
   * this issue). On 0 rows the actual state is read and classified; a row
   * already `sending` reports `claimed` too — the lease-reclaimed retry of
   * the run that owns it — and inserts nothing.
   *
   * Due-ness is measured against the database's own clock, the one the
   * dispatcher used to make the job eligible; a worker clock would be a
   * second, disagreeing reading of the same moment.
   */
  claimIssue(issueId: string, topic: string): Promise<DispatchIssueClaim>;

  /**
   * One page of the issue's delivery rows in subscriber-id order, starting
   * after `page.after`. Keyset rather than offset: the frozen list never
   * shifts, and the page is served by the leading columns of
   * `UNIQUE(issueId, subscriberId)`, so an attempt's read cost is its own
   * batch rather than the whole list.
   */
  loadTargets(issueId: string, page: DeliveryPage): Promise<DeliveryTarget[]>;

  /** One statement for the whole batch, whatever its size. */
  markDeliveries(
    deliveryIds: readonly string[],
    status: 'sent' | 'failed',
    resendIdByDeliveryId?: ReadonlyMap<string, string>
  ): Promise<void>;

  /**
   * Whether more than one topic carries subscribed rows. An issue does not
   * record the list it was written for, so which subscribers receive it is
   * decided by this job's binding; that is safe only while one audience
   * exists, and this is what says so.
   *
   * The answer costs a pass over the subscribed rows however few topics they
   * span: the cap of two is on what comes back, not on what is scanned, since
   * a single topic never yields a second row to stop at.
   */
  hasMultipleSubscriberTopics(): Promise<boolean>;

  /** `sending → sent` with counts aggregated from the delivery rows. */
  completeIssue(issueId: string, now: Date): Promise<void>;
}
