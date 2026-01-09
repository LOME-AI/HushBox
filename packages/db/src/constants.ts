/** Daily free allowance in cents ($0.05 = 5 cents) */
export const FREE_ALLOWANCE_CENTS = 5;

/** Maximum messages per day for guest users */
export const GUEST_MESSAGE_LIMIT = 5;

/** Welcome credit for new users in cents ($0.20 = 20 cents) */
export const WELCOME_CREDIT_CENTS = 20;

/** Welcome credit as decimal string for numeric column (derived from WELCOME_CREDIT_CENTS) */
export const WELCOME_CREDIT_BALANCE = (WELCOME_CREDIT_CENTS / 100).toFixed(8);
