/**
 * The live-hold readout billing publishes for the conversations slice's group
 * budget display: what each budget scope and the owner's wallet have reserved
 * right now, so the readout subtracts holds the ledger has not seen yet.
 * Read-only — billing stays the single writer of `member_budgets` and
 * `conversation_spending`.
 */
export { holdReadoutAt, readGroupHolds } from '../domain/wallets/spendable.js';
