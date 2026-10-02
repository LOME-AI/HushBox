/**
 * Billing's balance read, published as its own entry point. Identity's
 * account deletion compares the purchased balance against the forfeit the
 * request acknowledged; the wallets stay billing's alone, read by billing's
 * own code.
 */
export { readBalance } from '../domain/wallets/balance.js';
