/** Daily free allowance in cents ($0.05 = 5 cents) - numeric value for calculations */
export const FREE_ALLOWANCE_CENTS_VALUE = 5;

/** Free allowance as decimal string for numeric column (5 cents with 8 decimal precision) */
export const FREE_ALLOWANCE_CENTS = FREE_ALLOWANCE_CENTS_VALUE.toFixed(8);

/** Maximum messages per day for guest users */
export const GUEST_MESSAGE_LIMIT = 5;

/** Welcome credit for new users in cents ($0.20 = 20 cents) */
export const WELCOME_CREDIT_CENTS = 20;

/** Welcome credit as decimal string for numeric column (derived from WELCOME_CREDIT_CENTS) */
export const WELCOME_CREDIT_BALANCE = (WELCOME_CREDIT_CENTS / 100).toFixed(8);
