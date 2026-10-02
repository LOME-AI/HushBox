/**
 * Billing's completed-payment existence read, published as its own entry
 * point. Identity's channel prompt asks whether an account has ever paid, and
 * the `payments` table stays billing's alone: the question crosses the slice
 * boundary, the query does not.
 */
export { hasCompletedPayment } from '../adapters/completed-payment.js';
