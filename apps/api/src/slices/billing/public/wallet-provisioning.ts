/**
 * Billing's wallet provisioning, published as its own entry point for
 * identity's registration transaction. Billing remains the single writer of
 * `wallets` and `ledger_entries`: the caller supplies the settlement
 * transaction and billing's stores, and every write still happens in billing's
 * own code.
 */
export { provisionWalletsWithinTx } from '../domain/wallets/wallets.js';
