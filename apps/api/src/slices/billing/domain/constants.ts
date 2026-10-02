import {
  FREE_ALLOWANCE_CENTS_VALUE,
  NANO_USD_PER_CENT,
  WELCOME_CREDIT_CENTS,
} from '@hushbox/shared';

/**
 * K — the cost-circuit multiplier: once a run's observed spend exceeds
 * `hold × K`, the engine starts no further node, level or loop iteration for it;
 * spend already in flight runs to its end. The check runs against the whole
 * hold, so it must sit above what an ordinary run legitimately reaches. Two
 * inputs set that: a dense-script prompt reaches about 2.1× its reserved input
 * at the reserved 3 characters per token, and a long-context tier doubles a
 * rate, so a dense-script run that crosses a tier reaches about 4.2× its hold.
 * 5 clears that.
 */
export const COST_CIRCUIT_MULTIPLIER = 5n;

/** One-time signup credit, granted as promo ledger legs at provisioning. */
export const WELCOME_CREDIT_NANO_USD = BigInt(WELCOME_CREDIT_CENTS) * NANO_USD_PER_CENT;

/** Free-tier daily allowance cap, tracked as period-keyed spending rows. */
export const DAILY_ALLOWANCE_NANO_USD = BigInt(FREE_ALLOWANCE_CENTS_VALUE) * NANO_USD_PER_CENT;

/**
 * Added to the run deadline to size a hold's TTL: the hold must outlive the
 * run it admits (settlement releases it early; expiry is the recovery path,
 * never the primary mechanism).
 */
export const HOLD_TTL_MARGIN_SECONDS = 60;

/**
 * Redis balance-snapshot TTL — the staleness bound: a miss forces a Postgres
 * re-read, so a stale snapshot can never outlive this window.
 */
export const SNAPSHOT_TTL_SECONDS = 30;

/**
 * The daily trial-spend cap: a single cumulative ceiling ($50) on aggregate
 * free-trial provider spend per UTC day. Trial runs never touch a wallet, so
 * this is the only bound on how much unpaid provider spend we absorb in a day.
 * It is tracked as one period-keyed Redis counter (`trial:global:spend:<day>`)
 * fed by each run's ACTUAL provider cost at settlement; admission reads and
 * compares it (no reservation), so a Sybil flood is refused once the day's
 * real spend reaches the cap. A tunable abuse-mitigation figure, not a
 * correctness constant.
 */
export const TRIAL_DAILY_SPEND_CAP_NANO_USD = 50_000_000_000n;
