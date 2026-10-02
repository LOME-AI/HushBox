/**
 * The focus-refetch policy for the served funding families — the spendable
 * snapshot and the hold-aware conversation budgets — and nowhere else. The
 * client's global default leaves focus refetching off, so it is declared per
 * family rather than raised to the client: greying, catalogs and transcripts
 * have no reason to re-read on every tab return.
 *
 * `'always'` rather than `true`: `true` refetches only a query the client
 * already considers stale, so it guarantees nothing about what a returning
 * viewer sees — it defers to whatever stale time is configured. `'always'`
 * guarantees the read, which is what makes a released hold visible on return
 * rather than after a timer BILLING §Notices & Refusals 9 does not permit it
 * to outlive. Window focus is the only freshness signal such a surface has:
 * with no conversation socket, no run frame ever reaches it.
 */
export const REFETCH_FUNDING_ON_FOCUS = 'always' as const;
