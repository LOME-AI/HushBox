/**
 * The billing-portal handoff token mint. It writes identity's Redis key and is
 * paired with the redemption half on identity's `POST /auth/token-login`, so it
 * lives here; the billing slice owns only the HTTP surface that exposes it.
 */
export { issueBillingLoginToken } from '../domain/account/billing-portal.js';
