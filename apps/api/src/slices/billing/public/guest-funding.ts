/**
 * The payer's funding snapshot as a link guest reads it. A guest holds no
 * session, so the guest-reachable door lives on the conversations slice's
 * route; the snapshot itself is produced here, over billing's rows, in the
 * shape `/billing/spendable` returns — a second door, never a second
 * derivation.
 */
export { readGuestFundingSnapshot, serializeFundingSnapshot } from '../domain/wallets/spendable.js';
