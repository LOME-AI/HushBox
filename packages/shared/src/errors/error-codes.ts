import { z } from 'zod';
import { noticeText } from '../affordability/notices.ts';
import { rateLimitedMessage } from './error-messages.ts';
import type { NoticeReason } from '../affordability/notices.ts';
import type { UserFacingMessage } from './error-messages.ts';

/**
 * The closed error-code set: every condition a user-facing message is keyed
 * off. Codes map to copy through `friendlyErrorMessage()`, and for the ones a
 * route returns the wire contract is `{ code, details? }` — never a message
 * field.
 *
 * Membership is by minting site, not by transport: a code belongs here if some
 * error path must name it, whether a route raises it or the browser is the only
 * party that can observe the condition (the client-minted entries say so where
 * they sit). One registry rather than two is what keeps every error path on a
 * single code→copy home instead of a hardcoded string.
 *
 * The base codes mirror the `DomainError` taxonomy one-to-one
 * (`DOMAIN_ERROR_CODE_TO_WIRE_CODE` below); defects — exceptions reaching a
 * route — surface as INTERNAL with a 500.
 */
export const ERROR_CODES = {
  VALIDATION: 'VALIDATION',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  TIMEOUT: 'TIMEOUT',
  UNAVAILABLE: 'UNAVAILABLE',
  // The rate limiter's own unreachable counter, told apart from every other
  // 503. A refusal carrying it is produced BEFORE the handler runs, so it
  // proves the request it answers changed nothing; UNAVAILABLE cannot say that,
  // because a handler raises it after work it may already have done — the card
  // processor adapter answers one after an approved charge. A client money
  // guard reads exactly that difference.
  //
  // It is deliberately narrower than "the limiter failed": a limiter layer
  // counted INSIDE a handler answers the generic code, because by then
  // something may have been attempted. Same outage, two codes, and the
  // asymmetry is the distinction rather than a gap in it.
  RATE_LIMIT_UNAVAILABLE: 'RATE_LIMIT_UNAVAILABLE',
  INTERNAL: 'INTERNAL',
  CONCURRENT_RUN: 'CONCURRENT_RUN',
  INSUFFICIENT_ADMISSION: 'INSUFFICIENT_ADMISSION',
  RUN_CAPACITY_REACHED: 'RUN_CAPACITY_REACHED',
  DAILY_ALLOWANCE_EXHAUSTED: 'DAILY_ALLOWANCE_EXHAUSTED',
  // Named for the allocation rather than the budget, because
  // GROUP_BUDGET_EXHAUSTED already exists for the unallocated-guest denial and
  // carries guest-specific copy that is false for a member whose allocation ran
  // out. Two codes, one letter apart in meaning, would be a trap.
  GROUP_ALLOCATION_EXHAUSTED: 'GROUP_ALLOCATION_EXHAUSTED',
  ADMISSION_UNAVAILABLE: 'ADMISSION_UNAVAILABLE',
  ZDR_REFUSED: 'ZDR_REFUSED',
  UNSUPPORTED_MODALITY: 'UNSUPPORTED_MODALITY',
  UNSUPPORTED_RESOLUTION: 'UNSUPPORTED_RESOLUTION',
  UNSUPPORTED_DURATION: 'UNSUPPORTED_DURATION',
  CONTENT_POLICY: 'CONTENT_POLICY',
  CONTEXT_LENGTH_EXCEEDED: 'CONTEXT_LENGTH_EXCEEDED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  NO_REASONING_ENDPOINTS: 'NO_REASONING_ENDPOINTS',
  // A call the gateway refused because no endpoint meets its routing limits.
  // A price refusal and a zero-retention miss are indistinguishable there, so
  // one code names both rather than guessing which one bound.
  NO_ELIGIBLE_ENDPOINT: 'NO_ELIGIBLE_ENDPOINT',
  CLASSIFIER_UNAVAILABLE: 'CLASSIFIER_UNAVAILABLE',
  // The workflow engine's two run failures that are NOT a provider outage: a
  // model answered with a value failing its declared port schema, and a
  // definition produced a collection wider than its compiled fan-out cap. Both
  // fell through to UNAVAILABLE, which told the user to retry against a
  // provider that was fine and hid the actual fault.
  MODEL_OUTPUT_INVALID: 'MODEL_OUTPUT_INVALID',
  WORKFLOW_DEFINITION_INVALID: 'WORKFLOW_DEFINITION_INVALID',
  VERSION_MISMATCH: 'VERSION_MISMATCH',
  BUILD_NOT_FOUND: 'BUILD_NOT_FOUND',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  CSRF_REJECTED: 'CSRF_REJECTED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
  IDEMPOTENCY_BODY_MISMATCH: 'IDEMPOTENCY_BODY_MISMATCH',
  REQUEST_IN_PROGRESS: 'REQUEST_IN_PROGRESS',
  // A card deposit refused because an earlier one of the same user's is still
  // unresolved. Distinct from REQUEST_IN_PROGRESS, which answers a replay of
  // the very request being made: this one answers a NEW request, whose charge
  // was never sent, and the two need different copy for that reason.
  PAYMENT_IN_FLIGHT: 'PAYMENT_IN_FLIGHT',
  // An operator supplied a provider transaction id that another `payments`
  // row already holds. Minted only on the admin plane, where attaching the id
  // read off the provider dashboard is the repair path for a row whose capture
  // the verify job could not confirm. Distinct from CONFLICT because the
  // operator's next move follows from it: the dashboard entry names a payment
  // that is already recorded, so the row in front of them is not the one to
  // repair.
  PAYMENT_TRANSACTION_ID_TAKEN: 'PAYMENT_TRANSACTION_ID_TAKEN',
  AUTH_FAILED: 'AUTH_FAILED',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  USERNAME_TAKEN: 'USERNAME_TAKEN',
  NO_PENDING_LOGIN: 'NO_PENDING_LOGIN',
  NO_PENDING_REGISTRATION: 'NO_PENDING_REGISTRATION',
  INVALID_TOTP_CODE: 'INVALID_TOTP_CODE',
  TOTP_CODE_REQUIRED: 'TOTP_CODE_REQUIRED',
  TOTP_ALREADY_ENABLED: 'TOTP_ALREADY_ENABLED',
  TOTP_NOT_ENABLED: 'TOTP_NOT_ENABLED',
  // The stored second factor is sealed under a TOTP key this deployment does
  // not hold: an operator condition, never a wrong code. Cleared reversibly by
  // an admin operation.
  TOTP_SECRET_STRANDED: 'TOTP_SECRET_STRANDED',
  // The OPAQUE key-encryption key changed between a credential flow's init and
  // finish rounds; the material pinned at init cannot be written. Restart.
  OPAQUE_KEK_ROTATED: 'OPAQUE_KEK_ROTATED',
  // A credential rotation's compare-and-swap found the stored registration
  // record already replaced (a racing password change or recovery reset).
  CREDENTIAL_CONFLICT: 'CREDENTIAL_CONFLICT',
  NO_PENDING_2FA_SETUP: 'NO_PENDING_2FA_SETUP',
  NO_PENDING_STEP_UP: 'NO_PENDING_STEP_UP',
  NO_PENDING_RECOVERY: 'NO_PENDING_RECOVERY',
  INVALID_CONFIRMATION_PHRASE: 'INVALID_CONFIRMATION_PHRASE',
  // An account deletion refused because the purchased balance exceeds the
  // forfeit the request acknowledged; `details.purchasedBalanceNanoUsd` names it.
  DELETE_ACCOUNT_FORFEIT_UNACKNOWLEDGED: 'DELETE_ACCOUNT_FORFEIT_UNACKNOWLEDGED',
  INVALID_VERIFICATION_TOKEN: 'INVALID_VERIFICATION_TOKEN',
  LOGIN_TOKEN_INVALID: 'LOGIN_TOKEN_INVALID',
  TOO_MANY_ATTEMPTS: 'TOO_MANY_ATTEMPTS',
  STALE_EPOCH: 'STALE_EPOCH',
  WRAP_SET_MISMATCH: 'WRAP_SET_MISMATCH',
  MEMBER_LIMIT_REACHED: 'MEMBER_LIMIT_REACHED',
  ALREADY_MEMBER: 'ALREADY_MEMBER',
  ROTATION_PENDING: 'ROTATION_PENDING',
  EPOCH_KEYS_RESTORING: 'EPOCH_KEYS_RESTORING',
  CANNOT_REMOVE_OWNER: 'CANNOT_REMOVE_OWNER',
  CANNOT_REMOVE_SELF: 'CANNOT_REMOVE_SELF',
  CANNOT_CHANGE_OWN_PRIVILEGE: 'CANNOT_CHANGE_OWN_PRIVILEGE',
  PRIVILEGE_INSUFFICIENT: 'PRIVILEGE_INSUFFICIENT',
  FORK_LIMIT_REACHED: 'FORK_LIMIT_REACHED',
  FORK_NAME_TAKEN: 'FORK_NAME_TAKEN',
  FORK_TIP_CONFLICT: 'FORK_TIP_CONFLICT',
  REGENERATION_BLOCKED_BY_OTHER_USER: 'REGENERATION_BLOCKED_BY_OTHER_USER',
  FORK_ID_REQUIRED: 'FORK_ID_REQUIRED',
  AUTHENTICATED_ON_TRIAL: 'AUTHENTICATED_ON_TRIAL',
  TRIAL_LIMIT_REACHED: 'TRIAL_LIMIT_REACHED',
  TRIAL_CAPACITY_REACHED: 'TRIAL_CAPACITY_REACHED',
  FEATURE_REQUIRES_AUTH: 'FEATURE_REQUIRES_AUTH',
  TRIAL_MESSAGE_TOO_EXPENSIVE: 'TRIAL_MESSAGE_TOO_EXPENSIVE',
  PREMIUM_REQUIRES_ACCOUNT: 'PREMIUM_REQUIRES_ACCOUNT',
  MEDIA_TRIAL_BLOCKED: 'MEDIA_TRIAL_BLOCKED',
  MODEL_TIER_LOCKED: 'MODEL_TIER_LOCKED',
  GROUP_BUDGET_EXHAUSTED: 'GROUP_BUDGET_EXHAUSTED',
  BUDGET_BELOW_SPENT: 'BUDGET_BELOW_SPENT',
  MODEL_DISABLED: 'MODEL_DISABLED',
  FEEDBACK_SUBMIT_FAILED: 'FEEDBACK_SUBMIT_FAILED',
  FEEDBACK_DUPLICATE: 'FEEDBACK_DUPLICATE',
  NEWSLETTER_CONFIRM_INVALID: 'NEWSLETTER_CONFIRM_INVALID',
  NEWSLETTER_UNSUBSCRIBE_INVALID: 'NEWSLETTER_UNSUBSCRIBE_INVALID',
  // Client-minted codes for the OPAQUE auth flows and the account/security
  // modals. These never appear on the wire — they are surfaced only from the
  // web client's own catch/guard branches — but they live in the same
  // exhaustive registry so every client error path maps through one code→copy
  // home rather than a hardcoded string.
  LOGIN_FAILED: 'LOGIN_FAILED',
  REGISTRATION_FAILED: 'REGISTRATION_FAILED',
  ENCRYPTION_NOT_SETUP: 'ENCRYPTION_NOT_SETUP',
  CREDENTIAL_UPDATE_FAILED: 'CREDENTIAL_UPDATE_FAILED',
  CREDENTIAL_UPDATED_KEY_NOT_SAVED: 'CREDENTIAL_UPDATED_KEY_NOT_SAVED',
  ACCOUNT_KEY_NOT_AVAILABLE: 'ACCOUNT_KEY_NOT_AVAILABLE',
  DISABLE_2FA_INIT_FAILED: 'DISABLE_2FA_INIT_FAILED',
  TWO_FACTOR_VERIFICATION_FAILED: 'TWO_FACTOR_VERIFICATION_FAILED',
  SIGN_IN_COMPLETION_FAILED: 'SIGN_IN_COMPLETION_FAILED',
  TWO_FACTOR_SETUP_FAILED: 'TWO_FACTOR_SETUP_FAILED',
  EMAIL_VERIFICATION_FAILED: 'EMAIL_VERIFICATION_FAILED',
  CUSTOM_INSTRUCTIONS_SAVE_FAILED: 'CUSTOM_INSTRUCTIONS_SAVE_FAILED',
  CREDENTIAL_VERIFICATION_FAILED: 'CREDENTIAL_VERIFICATION_FAILED',
  RECOVERY_MATERIAL_SAVE_FAILED: 'RECOVERY_MATERIAL_SAVE_FAILED',
  RECOVERY_PHRASE_GENERATION_FAILED: 'RECOVERY_PHRASE_GENERATION_FAILED',
  // Client-oriented UI-state codes carrying preserved account/media copy.
  // Three surface only from the web client's own guard/catch branches (media
  // load failure, account-deletion password + expired session) and never on
  // the wire. DELETE_ACCOUNT_LOCKED is the exception: the delete-account
  // step-up lock also emits it on the wire as a 403 (identity/routes.ts).
  STORAGE_READ_FAILED: 'STORAGE_READ_FAILED',
  // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- error code constant, not a credential
  INCORRECT_PASSWORD: 'INCORRECT_PASSWORD',
  DELETE_ACCOUNT_LOCKED: 'DELETE_ACCOUNT_LOCKED',
  NO_PENDING_DELETE_ACCOUNT: 'NO_PENDING_DELETE_ACCOUNT',
  // Client-minted chat run failures. The client is the only party that can
  // observe either: a branch whose stream ends with an error finish reason,
  // and a run whose transport never carried it (socket unreachable, socket
  // closed mid-run, or the client's own deadline firing).
  STREAM_ERROR: 'STREAM_ERROR',
  CHAT_STREAM_FAILED: 'CHAT_STREAM_FAILED',
  // Client-minted card-payment and invitation failures. Every one is a
  // condition only the browser observes: the Helcim.js tokenizer refusing or
  // returning an incomplete result, its script never loading, the inline
  // `failed`/`expired` charge status the payments route returns in a 200 body,
  // and an accept-invitation request the sidebar row must report on itself.
  PAYMENT_TOKENIZATION_FAILED: 'PAYMENT_TOKENIZATION_FAILED',
  PAYMENT_CARD_DETAILS_MISSING: 'PAYMENT_CARD_DETAILS_MISSING',
  PAYMENT_DECLINED: 'PAYMENT_DECLINED',
  PAYMENT_EXPIRED: 'PAYMENT_EXPIRED',
  PAYMENT_FORM_LOAD_FAILED: 'PAYMENT_FORM_LOAD_FAILED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  INVITE_ACCEPT_FAILED: 'INVITE_ACCEPT_FAILED',
} as const satisfies Record<string, string>;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

const ERROR_CODE_VALUES = Object.values(ERROR_CODES) as [ErrorCode, ...ErrorCode[]];

/** Zod schema for the closed code set (wire validation). */
export const errorCodeSchema = z.enum(ERROR_CODE_VALUES);

/**
 * The one map from a wire code to the notice condition it describes. A code
 * absent here describes no condition the pre-send money vocabulary words.
 */
const NOTICE_REASON_BY_CODE = {
  CONCURRENT_RUN: 'run_already_in_progress',
  INSUFFICIENT_ADMISSION: 'send_cannot_start',
  RUN_CAPACITY_REACHED: 'funds_held_by_run',
  DAILY_ALLOWANCE_EXHAUSTED: 'free_allowance_exhausted',
  GROUP_ALLOCATION_EXHAUSTED: 'group_owner_funds_unavailable',
  ADMISSION_UNAVAILABLE: 'send_check_unavailable',
  CONTEXT_LENGTH_EXCEEDED: 'prompt_too_long',
  TRIAL_MESSAGE_TOO_EXPENSIVE: 'trial_message_cap_exceeded',
  PREMIUM_REQUIRES_ACCOUNT: 'premium_requires_account',
  MODEL_TIER_LOCKED: 'premium_requires_credit',
  GROUP_BUDGET_EXHAUSTED: 'guest_no_group_budget',
} as const satisfies Partial<Record<ErrorCode, NoticeReason>>;

type NoticeBackedCode = keyof typeof NOTICE_REASON_BY_CODE;

/** The notice condition a wire code describes, or `undefined` when it describes none. */
export function noticeReasonForCode(code: ErrorCode): NoticeReason | undefined {
  const reasons: Partial<Record<ErrorCode, NoticeReason>> = NOTICE_REASON_BY_CODE;
  return reasons[code];
}

function noticeMessageFor(code: NoticeBackedCode): string {
  return noticeText(NOTICE_REASON_BY_CODE[code]);
}

/**
 * Compile-exhaustive code→user-message map: the `satisfies
 * Record<ErrorCode, string>` clause makes adding a code without a message
 * a type error.
 *
 * Where a wire refusal describes a condition the pre-send money vocabulary also
 * describes, the sentence is read from that vocabulary rather than re-typed
 * here — §Notices 1 and 2 make one condition's wording single-homed, and a
 * literal copy at this end is exactly the second phrasing they forbid.
 *
 * A code is not automatically a condition. Admission's refusals used to share
 * one code and therefore one sentence, which told a payer whose runs were merely
 * in flight that their balance was short — a payment action for a caller whom
 * paying cannot help. Each now carries its own code and reads its own
 * condition's wording, split by whose action can remedy it: the payer
 * (INSUFFICIENT_ADMISSION, RUN_CAPACITY_REACHED), the payer tomorrow
 * (DAILY_ALLOWANCE_EXHAUSTED), or the conversation owner
 * (GROUP_ALLOCATION_EXHAUSTED).
 *
 * `INSUFFICIENT_ADMISSION` keeps the condition-neutral wording because it still
 * has two producers whose conditions it cannot tell apart. The admission balance
 * gate compares spendable funds MINUS funds reserved by runs in flight, so an
 * empty balance and a live reservation arrive indistinguishable; and the Smart
 * Model build answers it when no candidate fits the payer's EFFECTIVE funding,
 * which is the owner's headroom for a group turn and the remaining daily
 * allowance for a free-tier sender. Retargeting the wording at any one of those
 * would put that one's action on all of them.
 */
export const ERROR_MESSAGES = {
  VALIDATION: 'Invalid input. Please check your data and try again.',
  UNAUTHORIZED: 'You are not logged in. Please log in and try again.',
  FORBIDDEN: "You don't have permission to do this.",
  NOT_FOUND: "The item you're looking for doesn't exist.",
  CONFLICT: 'This action conflicts with the current state. Please refresh and try again.',
  RATE_LIMITED: rateLimitedMessage(),
  TIMEOUT: 'The operation took too long and was stopped. Please try again.',
  UNAVAILABLE: 'This service is temporarily unavailable. Please try again later.',
  RATE_LIMIT_UNAVAILABLE:
    "We couldn't check your request limits, so your request wasn't submitted. Please try again.",
  INTERNAL: 'Something went wrong. Please try again later.',
  CONCURRENT_RUN: noticeMessageFor('CONCURRENT_RUN'),
  INSUFFICIENT_ADMISSION: noticeMessageFor('INSUFFICIENT_ADMISSION'),
  RUN_CAPACITY_REACHED: noticeMessageFor('RUN_CAPACITY_REACHED'),
  DAILY_ALLOWANCE_EXHAUSTED: noticeMessageFor('DAILY_ALLOWANCE_EXHAUSTED'),
  GROUP_ALLOCATION_EXHAUSTED: noticeMessageFor('GROUP_ALLOCATION_EXHAUSTED'),
  ADMISSION_UNAVAILABLE: noticeMessageFor('ADMISSION_UNAVAILABLE'),
  ZDR_REFUSED: 'This model does not meet our zero-data-retention requirements and cannot be used.',
  UNSUPPORTED_MODALITY: 'This content type is not supported yet.',
  UNSUPPORTED_RESOLUTION:
    "One or more selected video models don't support the requested resolution. Pick a different resolution.",
  UNSUPPORTED_DURATION:
    "One or more selected video models don't support the requested duration. Pick a different duration.",
  CONTENT_POLICY:
    'The model declined to answer because it considered the request unsafe. Try rephrasing your message.',
  CONTEXT_LENGTH_EXCEEDED: noticeMessageFor('CONTEXT_LENGTH_EXCEEDED'),
  NETWORK_ERROR: "We couldn't reach the AI provider. Check your connection and try again.",
  NO_REASONING_ENDPOINTS:
    "No provider can run this model with reasoning within HushBox's privacy and price limits right now. Try a different effort level or model.",
  NO_ELIGIBLE_ENDPOINT:
    "No provider can answer this message within HushBox's privacy and price limits right now. Choose a different model.",
  CLASSIFIER_UNAVAILABLE:
    "Auto effort can't pick a level right now. Choose an effort level yourself and try again.",
  MODEL_OUTPUT_INVALID:
    "The model's reply didn't match the expected format. Try again, or choose a different model.",
  WORKFLOW_DEFINITION_INVALID:
    "This request couldn't be run. Please try again. If it keeps happening, contact support.",
  VERSION_MISMATCH: 'Your app is out of date. Please update to continue.',
  BUILD_NOT_FOUND: "That app version isn't available for download.",
  SERVICE_UNAVAILABLE: 'This service is temporarily unavailable. Please try again later.',
  CSRF_REJECTED: 'Request rejected for security reasons. Please refresh and try again.',
  PAYLOAD_TOO_LARGE: 'Your request is too large. Please shorten it and try again.',
  IDEMPOTENCY_KEY_REQUIRED: 'Something went wrong with your request. Please try again.',
  IDEMPOTENCY_BODY_MISMATCH: 'This request conflicts with an earlier one. Please try again.',
  REQUEST_IN_PROGRESS: 'This request is already being processed. Please wait a moment.',
  PAYMENT_IN_FLIGHT:
    'Your last credit purchase is still being confirmed. Wait for it to finish before starting another.',
  PAYMENT_TRANSACTION_ID_TAKEN:
    'That transaction id is already attached to another payment. Find the payment it belongs to before changing this one.',
  AUTH_FAILED: 'Incorrect username, email, or password. Please try again.',
  ACCOUNT_LOCKED: 'Your account is locked. Contact support for help.',
  EMAIL_NOT_VERIFIED:
    'Please verify your email address before signing in. Check your inbox for the link.',
  EMAIL_TAKEN: 'An account with this email already exists.',
  USERNAME_TAKEN: 'This username is taken. Please choose another.',
  NO_PENDING_LOGIN: 'Your login attempt expired. Please try again.',
  NO_PENDING_REGISTRATION: 'Your signup attempt expired. Please try again.',
  INVALID_TOTP_CODE: 'That code is incorrect or has expired. Please try again.',
  TOTP_CODE_REQUIRED: 'Enter your two-factor authentication code to continue.',
  TOTP_ALREADY_ENABLED: 'Two-factor authentication is already enabled.',
  TOTP_NOT_ENABLED: 'Two-factor authentication is not enabled.',
  TOTP_SECRET_STRANDED:
    "Your two-factor code can't be checked right now because of a server-side key change. Contact support to have two-factor authentication reset.",
  OPAQUE_KEK_ROTATED: 'A server key changed while you were doing this. Please start again.',
  CREDENTIAL_CONFLICT:
    'Your password was changed from another device while this was in progress. Sign in with your current password and try again.',
  NO_PENDING_2FA_SETUP: 'Your two-factor setup expired. Please start again.',
  NO_PENDING_STEP_UP: 'Your confirmation expired. Please try again.',
  NO_PENDING_RECOVERY: 'Your recovery attempt expired. Please try again.',
  INVALID_CONFIRMATION_PHRASE: "That confirmation phrase doesn't match. Please type it exactly.",
  DELETE_ACCOUNT_FORFEIT_UNACKNOWLEDGED:
    "You haven't confirmed forfeiting your account's credit. Review your balance, then try again.",
  INVALID_VERIFICATION_TOKEN: 'This verification link is invalid or has expired.',
  LOGIN_TOKEN_INVALID: 'This login link has expired or already been used.',
  TOO_MANY_ATTEMPTS: rateLimitedMessage(),
  STALE_EPOCH: 'The conversation keys changed. Refresh and try again.',
  WRAP_SET_MISMATCH: 'The key update does not match the current members. Refresh and try again.',
  MEMBER_LIMIT_REACHED: 'This conversation has reached its member limit.',
  ALREADY_MEMBER: 'This user is already a member of the conversation.',
  ROTATION_PENDING:
    "This conversation's keys are being updated after someone left. Try again in a moment.",
  EPOCH_KEYS_RESTORING:
    "This conversation's keys aren't verified on this device. Member changes, links and renames wait until they are.",
  CANNOT_REMOVE_OWNER: 'The owner of a conversation cannot be removed.',
  CANNOT_REMOVE_SELF: 'You cannot remove yourself. Use leave instead.',
  CANNOT_CHANGE_OWN_PRIVILEGE: 'You cannot change your own privilege.',
  PRIVILEGE_INSUFFICIENT: "You don't have sufficient privilege over this member.",
  FORK_LIMIT_REACHED: 'This conversation has reached its branch limit.',
  FORK_NAME_TAKEN: 'A branch with this name already exists. Please choose another.',
  FORK_TIP_CONFLICT: 'This branch has changed. Refresh and try again.',
  REGENERATION_BLOCKED_BY_OTHER_USER:
    "Another member replied after this message, so it can't be regenerated or edited. Send a new message instead.",
  FORK_ID_REQUIRED: 'This conversation has branches. Choose a branch, then try again.',
  AUTHENTICATED_ON_TRIAL: 'Signed-in users should use the main chat, not the trial.',
  TRIAL_LIMIT_REACHED: "You've reached today's free trial limit. Sign up to keep chatting.",
  TRIAL_CAPACITY_REACHED:
    "HushBox's free trial is at capacity for today. Sign up to keep chatting, or try again tomorrow.",
  FEATURE_REQUIRES_AUTH: 'This feature requires an account. Please sign up or log in.',
  TRIAL_MESSAGE_TOO_EXPENSIVE: noticeMessageFor('TRIAL_MESSAGE_TOO_EXPENSIVE'),
  PREMIUM_REQUIRES_ACCOUNT: noticeMessageFor('PREMIUM_REQUIRES_ACCOUNT'),
  MEDIA_TRIAL_BLOCKED:
    'The free trial supports text models only. Sign up to generate images and video.',
  MODEL_TIER_LOCKED: noticeMessageFor('MODEL_TIER_LOCKED'),
  GROUP_BUDGET_EXHAUSTED: noticeMessageFor('GROUP_BUDGET_EXHAUSTED'),
  BUDGET_BELOW_SPENT:
    "A budget can't be set below what has already been spent. Refresh to see the latest spend, then pick a higher amount.",
  MODEL_DISABLED: 'This model is temporarily unavailable. Please choose a different model.',
  FEEDBACK_SUBMIT_FAILED: "We couldn't send your feedback. Please try again.",
  FEEDBACK_DUPLICATE: "You've already sent this feedback.",
  NEWSLETTER_CONFIRM_INVALID:
    'That confirmation link is invalid or has expired. Sign up again to get a fresh one.',
  NEWSLETTER_UNSUBSCRIBE_INVALID:
    'That unsubscribe link is invalid or has already been used. If you keep receiving emails, use the unsubscribe link in the newest one.',
  LOGIN_FAILED: 'Login failed. Please check your credentials and try again.',
  REGISTRATION_FAILED: 'Registration failed. Please try again.',
  ENCRYPTION_NOT_SETUP: 'Your account encryption is not configured. Please contact support.',
  CREDENTIAL_UPDATE_FAILED: 'Password change failed. Please try again.',
  CREDENTIAL_UPDATED_KEY_NOT_SAVED:
    'Your password was changed. This device could not save the new key, so sign in again with your new password.',
  ACCOUNT_KEY_NOT_AVAILABLE: 'Your encryption key is unavailable. Please log out and log back in.',
  DISABLE_2FA_INIT_FAILED: 'Failed to start two-factor disable. Please try again.',
  TWO_FACTOR_VERIFICATION_FAILED: 'Two-factor verification failed. Please try again.',
  SIGN_IN_COMPLETION_FAILED:
    'Your code was accepted, but signing in could not be completed. Reload the page and try again.',
  TWO_FACTOR_SETUP_FAILED: 'Failed to initialize two-factor setup. Please try again.',
  EMAIL_VERIFICATION_FAILED: 'Email verification failed. Please try again or request a new link.',
  CUSTOM_INSTRUCTIONS_SAVE_FAILED: 'Failed to save custom instructions. Please try again.',
  CREDENTIAL_VERIFICATION_FAILED: 'Failed to verify password. Please try again.',
  RECOVERY_MATERIAL_SAVE_FAILED: 'Failed to save recovery material. Please try again.',
  RECOVERY_PHRASE_GENERATION_FAILED: 'Failed to generate recovery phrase. Please try again.',
  STORAGE_READ_FAILED: "We couldn't load this media. Please refresh the page.",
  INCORRECT_PASSWORD: 'Incorrect password.',
  DELETE_ACCOUNT_LOCKED: 'Too many deletion attempts. Try again later.',
  NO_PENDING_DELETE_ACCOUNT: 'Your deletion session expired. Start again.',
  STREAM_ERROR:
    'This model stopped before it finished answering. Try again, or choose a different model.',
  // Says nothing about billing: the same code carries the client deadline
  // firing, where the server may still have settled a billable partial.
  CHAT_STREAM_FAILED: "The answer didn't reach you. Check your connection and try again.",
  PAYMENT_TOKENIZATION_FAILED:
    'Your card could not be verified. Please check the details and try again.',
  PAYMENT_CARD_DETAILS_MISSING:
    'Your card was verified but its details did not come back complete. Please try again.',
  PAYMENT_DECLINED: 'Your payment was declined. Please try again or use a different card.',
  PAYMENT_EXPIRED: 'Your payment could not be confirmed and has expired. Please try again.',
  PAYMENT_FORM_LOAD_FAILED: 'The payment form could not be loaded. Reload the page to try again.',
  PAYMENT_FAILED: 'Something went wrong. Please try again or contact support.',
  INVITE_ACCEPT_FAILED: "Couldn't accept this invite. Please try again.",
} as const satisfies Record<ErrorCode, string>;

const FALLBACK_MESSAGE = 'Something went wrong. Please try again.';

/**
 * Narrows an arbitrary value to a registered code, or `undefined` when it names
 * none. This is the boundary {@link friendlyErrorMessage}'s closed parameter
 * type requires: a code parsed off the wire or read off a thrown error is an
 * arbitrary string at runtime, and it must still reach the fallback sentence
 * rather than the type checker.
 */
export function asErrorCode(value: unknown): ErrorCode | undefined {
  const parsed = errorCodeSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Maps a machine-readable code to a branded user-facing message. The parameter
 * is the closed code set, so an unregistered literal is a compile error rather
 * than a silent fall-through to the generic sentence; `undefined` is what a
 * value {@link asErrorCode} could not place arrives as, and renders that
 * sentence.
 */
export function friendlyErrorMessage(code: ErrorCode | undefined): UserFacingMessage {
  if (code === undefined) return FALLBACK_MESSAGE as UserFacingMessage;
  // The widened lookup keeps this fail-safe rather than merely type-safe: the
  // parameter type stops an unregistered code at compile time, and one that
  // reaches here anyway renders the fallback instead of the word "undefined".
  const message = (ERROR_MESSAGES as Record<string, string | undefined>)[code] ?? FALLBACK_MESSAGE;
  return message as UserFacingMessage;
}

/**
 * Route-level map from the lower-case `DomainError` taxonomy (the API
 * lib's `Result` error channel) to wire codes. The taxonomy union is
 * re-stated here as map keys because packages cannot import from apps; the
 * API lib consumes this map and its own `Record<DomainErrorCode, …>` check
 * keeps the two in sync at compile time.
 */
export const DOMAIN_ERROR_CODE_TO_WIRE_CODE = {
  validation: ERROR_CODES.VALIDATION,
  unauthorized: ERROR_CODES.UNAUTHORIZED,
  forbidden: ERROR_CODES.FORBIDDEN,
  not_found: ERROR_CODES.NOT_FOUND,
  conflict: ERROR_CODES.CONFLICT,
  rate_limited: ERROR_CODES.RATE_LIMITED,
  timeout: ERROR_CODES.TIMEOUT,
  unavailable: ERROR_CODES.UNAVAILABLE,
} as const satisfies Record<string, ErrorCode>;

/**
 * The API error response: `{ code, details? }`, strictly — a message
 * field on the wire is a contract violation (messages are client-mapped).
 */
export const errorResponseSchema = z.strictObject({
  code: errorCodeSchema,
  details: z.record(z.string(), z.unknown()).optional(),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;
