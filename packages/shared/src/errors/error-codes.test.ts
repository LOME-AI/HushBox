import { describe, expect, it } from 'vitest';
import {
  DOMAIN_ERROR_CODE_TO_WIRE_CODE,
  asErrorCode,
  friendlyErrorMessage,
  ERROR_CODES,
  ERROR_MESSAGES,
  errorCodeSchema,
  errorResponseSchema,
  noticeReasonForCode,
} from './error-codes.ts';
import { rateLimitedMessage } from './error-messages.ts';
import { NOTICE_REASONS, noticeText } from '../affordability/notices.ts';
import type { ErrorCode } from './error-codes.ts';

describe('ERROR_CODES', () => {
  it('covers the eight DomainError taxonomy codes', () => {
    const taxonomy = [
      'VALIDATION',
      'UNAUTHORIZED',
      'FORBIDDEN',
      'NOT_FOUND',
      'CONFLICT',
      'RATE_LIMITED',
      'TIMEOUT',
      'UNAVAILABLE',
    ];
    for (const code of taxonomy) {
      expect(Object.values(ERROR_CODES)).toContain(code);
    }
  });

  it('names the backend domain-specific codes', () => {
    const planCodes = [
      'CONCURRENT_RUN',
      'INSUFFICIENT_ADMISSION',
      'ADMISSION_UNAVAILABLE',
      'ZDR_REFUSED',
      'UNSUPPORTED_MODALITY',
      'VERSION_MISMATCH',
      'IDEMPOTENCY_KEY_REQUIRED',
      'IDEMPOTENCY_BODY_MISMATCH',
      'REQUEST_IN_PROGRESS',
      'INTERNAL',
    ];
    for (const code of planCodes) {
      expect(Object.values(ERROR_CODES)).toContain(code);
    }
  });

  it('names the identity auth-flow codes', () => {
    const identityCodes = [
      'AUTH_FAILED',
      'ACCOUNT_LOCKED',
      'EMAIL_TAKEN',
      'USERNAME_TAKEN',
      'NO_PENDING_LOGIN',
      'NO_PENDING_REGISTRATION',
      'LOGIN_TOKEN_INVALID',
    ];
    for (const code of identityCodes) {
      expect(Object.values(ERROR_CODES)).toContain(code);
    }
  });

  it('names the account-deletion confirmation and TOTP-gate codes', () => {
    for (const code of ['INVALID_CONFIRMATION_PHRASE', 'TOTP_CODE_REQUIRED']) {
      expect(Object.values(ERROR_CODES)).toContain(code);
    }
    expect(ERROR_MESSAGES.INVALID_CONFIRMATION_PHRASE).not.toBe(ERROR_MESSAGES.TOTP_CODE_REQUIRED);
  });

  it('names the regenerate guard code', () => {
    expect(Object.values(ERROR_CODES)).toContain('REGENERATION_BLOCKED_BY_OTHER_USER');
  });

  // A settlement refusal can be billed after the answer already streamed, and
  // whoever moved the branch may be the sender, so this copy names an action
  // and blames no one.
  it('gives a moved or deleted branch copy that names an action and blames no one', () => {
    expect(ERROR_MESSAGES.FORK_TIP_CONFLICT).toBe(
      'This branch has changed. Refresh and try again.'
    );
  });

  it('gives a regenerate blocked by a later reply copy that names an action', () => {
    expect(ERROR_MESSAGES.REGENERATION_BLOCKED_BY_OTHER_USER).toBe(
      "Another member replied after this message, so it can't be regenerated or edited. Send a new message instead."
    );
  });

  it('names the rotation-pending refusal code with its own copy', () => {
    expect(ERROR_CODES.ROTATION_PENDING).toBe('ROTATION_PENDING');
    expect(friendlyErrorMessage('ROTATION_PENDING')).toBe(ERROR_MESSAGES.ROTATION_PENDING);
    expect(friendlyErrorMessage('ROTATION_PENDING')).not.toBe(
      'Something went wrong. Please try again.'
    );
  });

  it('tells the user the keys are updating after someone left and to retry shortly', () => {
    expect(ERROR_MESSAGES.ROTATION_PENDING).toBe(
      "This conversation's keys are being updated after someone left. Try again in a moment."
    );
  });

  it('names the keys-restoring refusal code with its own copy', () => {
    expect(ERROR_CODES.EPOCH_KEYS_RESTORING).toBe('EPOCH_KEYS_RESTORING');
    expect(friendlyErrorMessage('EPOCH_KEYS_RESTORING')).toBe(ERROR_MESSAGES.EPOCH_KEYS_RESTORING);
  });

  it('tells the user member changes, links and renames wait on verified keys', () => {
    expect(ERROR_MESSAGES.EPOCH_KEYS_RESTORING).toBe(
      "This conversation's keys aren't verified on this device. Member changes, links and renames wait until they are."
    );
  });

  it('carries no leave-time rotation-required code', () => {
    expect(Object.keys(ERROR_CODES)).not.toContain('ROTATION_REQUIRED');
    expect(Object.keys(ERROR_MESSAGES)).not.toContain('ROTATION_REQUIRED');
  });

  it('names the payment-in-flight refusal code with its own copy', () => {
    expect(ERROR_CODES.PAYMENT_IN_FLIGHT).toBe('PAYMENT_IN_FLIGHT');
    expect(friendlyErrorMessage('PAYMENT_IN_FLIGHT')).toBe(ERROR_MESSAGES.PAYMENT_IN_FLIGHT);
    // It refuses a second deposit while an earlier one is unresolved, which is
    // neither a decline nor the same-key replay refusal: telling the user to
    // retry the card, or that this very request is running, would both be false.
    expect(ERROR_MESSAGES.PAYMENT_IN_FLIGHT).not.toBe(ERROR_MESSAGES.PAYMENT_DECLINED);
    expect(ERROR_MESSAGES.PAYMENT_IN_FLIGHT).not.toBe(ERROR_MESSAGES.REQUEST_IN_PROGRESS);
    expect(friendlyErrorMessage('PAYMENT_IN_FLIGHT')).not.toBe(
      'Something went wrong. Please try again.'
    );
  });

  it('names the feedback-submit failure code with its own copy', () => {
    expect(ERROR_CODES.FEEDBACK_SUBMIT_FAILED).toBe('FEEDBACK_SUBMIT_FAILED');
    expect(friendlyErrorMessage('FEEDBACK_SUBMIT_FAILED')).toBe(
      ERROR_MESSAGES.FEEDBACK_SUBMIT_FAILED
    );
    expect(friendlyErrorMessage('FEEDBACK_SUBMIT_FAILED')).not.toBe(
      'Something went wrong. Please try again.'
    );
  });

  it('names the feedback-duplicate code with its own calm copy', () => {
    expect(ERROR_CODES.FEEDBACK_DUPLICATE).toBe('FEEDBACK_DUPLICATE');
    expect(friendlyErrorMessage('FEEDBACK_DUPLICATE')).toBe(ERROR_MESSAGES.FEEDBACK_DUPLICATE);
    // The duplicate refusal is not the generic submit failure: it tells the
    // user the note already landed, so it carries its own distinct copy.
    expect(ERROR_MESSAGES.FEEDBACK_DUPLICATE).not.toBe(ERROR_MESSAGES.FEEDBACK_SUBMIT_FAILED);
    expect(friendlyErrorMessage('FEEDBACK_DUPLICATE')).not.toBe(
      'Something went wrong. Please try again.'
    );
  });

  it('names the link-guest group-budget refusal code with its own copy', () => {
    expect(ERROR_CODES.GROUP_BUDGET_EXHAUSTED).toBe('GROUP_BUDGET_EXHAUSTED');
    expect(friendlyErrorMessage('GROUP_BUDGET_EXHAUSTED')).toBe(
      ERROR_MESSAGES.GROUP_BUDGET_EXHAUSTED
    );
    // A guest denial names its remedy (owner-allocated budget) — never the
    // generic permission copy that stood here before the typed code.
    expect(ERROR_MESSAGES.GROUP_BUDGET_EXHAUSTED).not.toBe(ERROR_MESSAGES.FORBIDDEN);
    expect(friendlyErrorMessage('GROUP_BUDGET_EXHAUSTED')).not.toBe(
      'Something went wrong. Please try again.'
    );
  });

  it('names the budget-edit-below-spend rejection code with its own copy', () => {
    expect(ERROR_CODES.BUDGET_BELOW_SPENT).toBe('BUDGET_BELOW_SPENT');
    expect(friendlyErrorMessage('BUDGET_BELOW_SPENT')).toBe(ERROR_MESSAGES.BUDGET_BELOW_SPENT);
    expect(ERROR_MESSAGES.BUDGET_BELOW_SPENT).not.toBe(ERROR_MESSAGES.VALIDATION);
  });

  it('names the admin model kill-switch code', () => {
    expect(ERROR_CODES.MODEL_DISABLED).toBe('MODEL_DISABLED');
    expect(friendlyErrorMessage('MODEL_DISABLED')).toBe(ERROR_MESSAGES.MODEL_DISABLED);
  });

  it('names the limiter-unavailable refusal code with copy that says nothing was submitted', () => {
    expect(ERROR_CODES.RATE_LIMIT_UNAVAILABLE).toBe('RATE_LIMIT_UNAVAILABLE');
    expect(friendlyErrorMessage('RATE_LIMIT_UNAVAILABLE')).toBe(
      ERROR_MESSAGES.RATE_LIMIT_UNAVAILABLE
    );
    // The whole point of the split: the generic sentence cannot promise the
    // request was never attempted, because a handler raises it after work it
    // may already have done.
    expect(ERROR_MESSAGES.RATE_LIMIT_UNAVAILABLE).not.toBe(ERROR_MESSAGES.UNAVAILABLE);
  });

  it('keeps the limiter-unavailable code off the taxonomy projection', () => {
    // No `DomainError` kind maps onto it, so the only way it reaches a caller
    // is a site that names the constant. That is what a money guard on the web
    // client rests on.
    expect(Object.values(DOMAIN_ERROR_CODE_TO_WIRE_CODE)).not.toContain(
      ERROR_CODES.RATE_LIMIT_UNAVAILABLE
    );
  });

  it('names the reasoning no-endpoints refusal code with its own copy', () => {
    expect(ERROR_CODES.NO_REASONING_ENDPOINTS).toBe('NO_REASONING_ENDPOINTS');
    expect(friendlyErrorMessage('NO_REASONING_ENDPOINTS')).toBe(
      ERROR_MESSAGES.NO_REASONING_ENDPOINTS
    );
    expect(ERROR_MESSAGES.NO_REASONING_ENDPOINTS).not.toBe(ERROR_MESSAGES.UNAVAILABLE);
  });

  it("names HushBox's privacy and price limits in the reasoning no-endpoints refusal", () => {
    expect(ERROR_MESSAGES.NO_REASONING_ENDPOINTS).toContain("HushBox's privacy and price limits");
  });

  it('names the no-eligible-endpoint refusal code with its own copy', () => {
    expect(ERROR_CODES.NO_ELIGIBLE_ENDPOINT).toBe('NO_ELIGIBLE_ENDPOINT');
    expect(friendlyErrorMessage('NO_ELIGIBLE_ENDPOINT')).toBe(ERROR_MESSAGES.NO_ELIGIBLE_ENDPOINT);
    expect(ERROR_MESSAGES.NO_ELIGIBLE_ENDPOINT).not.toBe(ERROR_MESSAGES.UNAVAILABLE);
  });

  it("names HushBox's privacy and price limits in the no-eligible-endpoint refusal", () => {
    // A price refusal and a zero-retention miss arrive identically from the
    // gateway, so the one sentence must name both limits rather than guess.
    expect(ERROR_MESSAGES.NO_ELIGIBLE_ENDPOINT).toContain("HushBox's privacy and price limits");
  });

  it('words the no-eligible-endpoint refusal without a long dash', () => {
    expect(ERROR_MESSAGES.NO_ELIGIBLE_ENDPOINT).not.toMatch(/[\u2013\u2014]/u);
  });

  it('words the no-eligible-endpoint refusal without naming the gateway vendor', () => {
    expect(ERROR_MESSAGES.NO_ELIGIBLE_ENDPOINT).not.toMatch(/openrouter/iu);
  });

  it('names the malformed-model-return code with copy that does not blame the provider', () => {
    expect(ERROR_CODES.MODEL_OUTPUT_INVALID).toBe('MODEL_OUTPUT_INVALID');
    expect(friendlyErrorMessage('MODEL_OUTPUT_INVALID')).toBe(ERROR_MESSAGES.MODEL_OUTPUT_INVALID);
    // A model whose reply fails its declared schema is not an outage: the
    // provider answered. Sharing UNAVAILABLE told the user to retry against a
    // provider that was fine and hid the real fault.
    expect(ERROR_MESSAGES.MODEL_OUTPUT_INVALID).not.toBe(ERROR_MESSAGES.UNAVAILABLE);
  });

  it('names the workflow-definition fault code with copy that does not blame the provider', () => {
    expect(ERROR_CODES.WORKFLOW_DEFINITION_INVALID).toBe('WORKFLOW_DEFINITION_INVALID');
    expect(friendlyErrorMessage('WORKFLOW_DEFINITION_INVALID')).toBe(
      ERROR_MESSAGES.WORKFLOW_DEFINITION_INVALID
    );
    expect(ERROR_MESSAGES.WORKFLOW_DEFINITION_INVALID).not.toBe(ERROR_MESSAGES.UNAVAILABLE);
  });

  it('separates the malformed model return from the definition fault', () => {
    // One is an external fault the user can retry through; the other is our own
    // definition exceeding its compiled cap, which retrying cannot clear.
    expect(ERROR_MESSAGES.MODEL_OUTPUT_INVALID).not.toBe(
      ERROR_MESSAGES.WORKFLOW_DEFINITION_INVALID
    );
  });

  it('names the CSRF Origin-rejection code (edge middleware)', () => {
    expect(ERROR_CODES.CSRF_REJECTED).toBe('CSRF_REJECTED');
    expect(ERROR_MESSAGES.CSRF_REJECTED).toBeTruthy();
  });

  it('names the platform-surface codes (OTA download, roadmap proxy)', () => {
    expect(ERROR_CODES.BUILD_NOT_FOUND).toBe('BUILD_NOT_FOUND');
    expect(ERROR_MESSAGES.BUILD_NOT_FOUND).toBeTruthy();
    expect(ERROR_CODES.SERVICE_UNAVAILABLE).toBe('SERVICE_UNAVAILABLE');
    expect(ERROR_MESSAGES.SERVICE_UNAVAILABLE).toBeTruthy();
  });

  it('names the trial-surface codes', () => {
    const trialCodes = [
      'AUTHENTICATED_ON_TRIAL',
      'TRIAL_LIMIT_REACHED',
      'TRIAL_CAPACITY_REACHED',
      'FEATURE_REQUIRES_AUTH',
    ];
    for (const code of trialCodes) {
      expect(Object.values(ERROR_CODES)).toContain(code);
    }
  });

  it('names the trial pre-run refusal codes', () => {
    const refusalCodes = [
      'TRIAL_MESSAGE_TOO_EXPENSIVE',
      'PREMIUM_REQUIRES_ACCOUNT',
      'MEDIA_TRIAL_BLOCKED',
    ];
    for (const code of refusalCodes) {
      expect(Object.values(ERROR_CODES)).toContain(code);
    }
  });

  it('names the paid premium-tier gate code', () => {
    expect(Object.values(ERROR_CODES)).toContain('MODEL_TIER_LOCKED');
    expect(ERROR_MESSAGES.MODEL_TIER_LOCKED).toBeTruthy();
  });

  it('separates the paid tier lock from the trial premium refusal', () => {
    // MODEL_TIER_LOCKED gates an authenticated caller with no balance from a
    // premium model on a paid turn; PREMIUM_REQUIRES_ACCOUNT is the trial's
    // sign-up prompt. Distinct codes carry distinct copy.
    expect(ERROR_CODES.MODEL_TIER_LOCKED).not.toBe(ERROR_CODES.PREMIUM_REQUIRES_ACCOUNT);
    expect(ERROR_MESSAGES.MODEL_TIER_LOCKED).not.toBe(ERROR_MESSAGES.PREMIUM_REQUIRES_ACCOUNT);
  });

  it('gives each trial pre-run refusal its own distinct copy', () => {
    const messages = [
      ERROR_MESSAGES.TRIAL_MESSAGE_TOO_EXPENSIVE,
      ERROR_MESSAGES.PREMIUM_REQUIRES_ACCOUNT,
      ERROR_MESSAGES.MEDIA_TRIAL_BLOCKED,
      ERROR_MESSAGES.TRIAL_LIMIT_REACHED,
      ERROR_MESSAGES.AUTHENTICATED_ON_TRIAL,
    ];
    expect(new Set(messages).size).toBe(messages.length);
  });

  it('separates the daily-capacity refusal from the personal 5/day quota', () => {
    // TRIAL_CAPACITY_REACHED is the shared daily-spend ceiling (an
    // admission refusal, like INSUFFICIENT_ADMISSION); TRIAL_LIMIT_REACHED is
    // the caller's own 5/day quota. Distinct codes carry distinct copy.
    expect(ERROR_CODES.TRIAL_CAPACITY_REACHED).not.toBe(ERROR_CODES.TRIAL_LIMIT_REACHED);
    expect(ERROR_MESSAGES.TRIAL_CAPACITY_REACHED).not.toBe(ERROR_MESSAGES.TRIAL_LIMIT_REACHED);
  });

  it('names the client-minted auth-flow and modal codes with distinct copy', () => {
    const clientCodes = [
      'LOGIN_FAILED',
      'REGISTRATION_FAILED',
      'ENCRYPTION_NOT_SETUP',
      'CREDENTIAL_UPDATE_FAILED',
      'ACCOUNT_KEY_NOT_AVAILABLE',
      'DISABLE_2FA_INIT_FAILED',
      'TWO_FACTOR_VERIFICATION_FAILED',
      'TWO_FACTOR_SETUP_FAILED',
      'EMAIL_VERIFICATION_FAILED',
      'CUSTOM_INSTRUCTIONS_SAVE_FAILED',
      'CREDENTIAL_VERIFICATION_FAILED',
      'RECOVERY_MATERIAL_SAVE_FAILED',
      'RECOVERY_PHRASE_GENERATION_FAILED',
    ] as const;
    for (const code of clientCodes) {
      expect(Object.values(ERROR_CODES)).toContain(code);
      // Each maps to exactly one non-empty message home, no fallback.
      expect(friendlyErrorMessage(code)).toBe(ERROR_MESSAGES[code]);
      expect(friendlyErrorMessage(code)).not.toBe('Something went wrong. Please try again.');
    }
    const messages = clientCodes.map((code) => ERROR_MESSAGES[code]);
    expect(new Set(messages).size).toBe(messages.length);
  });

  it('uses each key as its own value (machine-readable constants)', () => {
    for (const [key, value] of Object.entries(ERROR_CODES)) {
      expect(key).toBe(value);
    }
  });
});

describe('client-emitted UI-state codes', () => {
  // These four carry preserved account/media copy byte-identical to the
  // retired legacy map. Three surface only from the web client's own
  // guard/catch branches (media load failure, account-deletion password +
  // expired session); DELETE_ACCOUNT_LOCKED is also emitted on the wire (the
  // delete-account step-up lock answers it as a 403).
  const clientUiCopy = {
    STORAGE_READ_FAILED: "We couldn't load this media. Please refresh the page.",
    INCORRECT_PASSWORD: 'Incorrect password.',
    DELETE_ACCOUNT_LOCKED: 'Too many deletion attempts. Try again later.',
    NO_PENDING_DELETE_ACCOUNT: 'Your deletion session expired. Start again.',
  } as const;

  it('registers each code in the closed set', () => {
    for (const code of Object.keys(clientUiCopy)) {
      expect(Object.values(ERROR_CODES)).toContain(code);
    }
  });

  it('maps each to its exact preserved copy, never the generic fallback', () => {
    const fallback = friendlyErrorMessage(asErrorCode('DEFINITELY_UNKNOWN_CODE'));
    for (const [code, copy] of Object.entries(clientUiCopy)) {
      expect(friendlyErrorMessage(asErrorCode(code))).toBe(copy);
      expect(friendlyErrorMessage(asErrorCode(code))).not.toBe(fallback);
    }
  });
});

describe('unacknowledged-forfeit deletion refusal', () => {
  it('maps to its own copy, never the generic fallback', () => {
    const code = ERROR_CODES.DELETE_ACCOUNT_FORFEIT_UNACKNOWLEDGED;
    const fallback = friendlyErrorMessage(asErrorCode('DEFINITELY_UNKNOWN_CODE'));
    expect(code).toBe('DELETE_ACCOUNT_FORFEIT_UNACKNOWLEDGED');
    expect(friendlyErrorMessage(code)).toBe(ERROR_MESSAGES[code]);
    expect(friendlyErrorMessage(code)).not.toBe(fallback);
  });
});

describe('media-modality and streaming-failure codes', () => {
  const mediaCodes = [
    'UNSUPPORTED_MODALITY',
    'UNSUPPORTED_RESOLUTION',
    'UNSUPPORTED_DURATION',
  ] as const;
  const streamingCodes = ['CONTENT_POLICY', 'CONTEXT_LENGTH_EXCEEDED', 'NETWORK_ERROR'] as const;

  it('registers every media-modality and streaming code in the closed set', () => {
    for (const code of [...mediaCodes, ...streamingCodes]) {
      expect(Object.values(ERROR_CODES)).toContain(code);
    }
  });

  it('gives each new code its own non-fallback copy', () => {
    const fallback = friendlyErrorMessage(asErrorCode('DEFINITELY_UNKNOWN_CODE'));
    for (const code of [...mediaCodes, ...streamingCodes]) {
      expect(friendlyErrorMessage(code)).toBe(ERROR_MESSAGES[code]);
      expect(friendlyErrorMessage(code)).not.toBe(fallback);
    }
  });

  it('distinguishes the resolution and duration refusals', () => {
    expect(ERROR_MESSAGES.UNSUPPORTED_RESOLUTION).not.toBe(ERROR_MESSAGES.UNSUPPORTED_DURATION);
  });
});

describe('chat stream and transport failure codes', () => {
  const chatFailureCodes = ['STREAM_ERROR', 'CHAT_STREAM_FAILED'] as const;

  it('registers each chat failure code in the closed set', () => {
    for (const code of chatFailureCodes) {
      expect(Object.values(ERROR_CODES)).toContain(code);
    }
  });

  it('gives each chat failure code copy of its own rather than the generic fallback', () => {
    const fallback = friendlyErrorMessage(asErrorCode('DEFINITELY_UNKNOWN_CODE'));
    for (const code of chatFailureCodes) {
      expect(friendlyErrorMessage(code)).toBe(ERROR_MESSAGES[code]);
      expect(friendlyErrorMessage(code)).not.toBe(fallback);
    }
  });

  it('separates the per-stream failure from the transport failure', () => {
    expect(ERROR_MESSAGES.STREAM_ERROR).not.toBe(ERROR_MESSAGES.CHAT_STREAM_FAILED);
  });
});

describe('client-minted payment and invitation failure codes', () => {
  const clientSurfaceCodes = [
    'PAYMENT_TOKENIZATION_FAILED',
    'PAYMENT_CARD_DETAILS_MISSING',
    'PAYMENT_DECLINED',
    'PAYMENT_EXPIRED',
    'PAYMENT_FORM_LOAD_FAILED',
    'PAYMENT_FAILED',
    'INVITE_ACCEPT_FAILED',
  ] as const;

  it('registers each client-minted surface code in the closed set', () => {
    for (const code of clientSurfaceCodes) {
      expect(Object.values(ERROR_CODES)).toContain(code);
    }
  });

  it('gives each one copy of its own rather than the generic fallback', () => {
    const fallback = friendlyErrorMessage(asErrorCode('DEFINITELY_UNKNOWN_CODE'));
    for (const code of clientSurfaceCodes) {
      expect(friendlyErrorMessage(code)).toBe(ERROR_MESSAGES[code]);
      expect(friendlyErrorMessage(code)).not.toBe(fallback);
    }
  });

  it('keeps every one of them distinct from the others', () => {
    const messages = clientSurfaceCodes.map((code) => ERROR_MESSAGES[code]);
    expect(new Set(messages).size).toBe(messages.length);
  });

  it('separates the declined charge from the unconfirmed charge that expired', () => {
    expect(ERROR_MESSAGES.PAYMENT_DECLINED).not.toBe(ERROR_MESSAGES.PAYMENT_EXPIRED);
  });

  it('uses no long dash in any of their copy', () => {
    for (const code of clientSurfaceCodes) {
      expect(ERROR_MESSAGES[code]).not.toMatch(/[\u2013\u2014]/);
    }
  });
});

describe('ERROR_MESSAGES', () => {
  it('has a user-facing message for every code (runtime mirror of the compile-time guarantee)', () => {
    for (const code of Object.values(ERROR_CODES)) {
      expect(ERROR_MESSAGES[code]).toBeTruthy();
    }
  });

  it('carries no long dash in any message', () => {
    // docs/DESIGN.md bans the em dash and the separator en dash from anything
    // users read. The map is the whole user-facing error vocabulary, so the ban
    // is asserted over every entry rather than over the one that broke it.
    const offenders = Object.entries(ERROR_MESSAGES)
      .filter(([, message]) => /[\u2013\u2014]/u.test(message))
      .map(([code]) => code);
    expect(offenders).toEqual([]);
  });

  it('is compile-time exhaustive: a missing code fails the type checker', () => {
    // The map's declared type is Record<ErrorCode, string>; assigning an
    // object missing a key is a compile error. This proves the mechanism.
    const incomplete = { VALIDATION: 'x' };
    // @ts-expect-error -- missing every other ErrorCode key
    const map: Record<ErrorCode, string> = incomplete;
    expect(map.VALIDATION).toBe('x');
  });
});

describe('asErrorCode', () => {
  it('returns the code when the value names a registered one', () => {
    expect(asErrorCode('CONCURRENT_RUN')).toBe(ERROR_CODES.CONCURRENT_RUN);
  });

  it('returns undefined for a string outside the closed set', () => {
    expect(asErrorCode('NOT_A_CODE')).toBeUndefined();
  });

  it('returns undefined for a value that is not a string', () => {
    expect(asErrorCode(42)).toBeUndefined();
  });
});

describe('friendlyErrorMessage', () => {
  it('maps a known code to its message', () => {
    expect(friendlyErrorMessage('CONCURRENT_RUN')).toBe(ERROR_MESSAGES.CONCURRENT_RUN);
  });

  it('renders the fallback for a wire code outside the closed set', () => {
    expect(friendlyErrorMessage(asErrorCode('NOT_A_CODE'))).toBe(
      'Something went wrong. Please try again.'
    );
  });

  it('does not throw on a wire code outside the closed set', () => {
    expect(() => friendlyErrorMessage(asErrorCode('NOT_A_CODE'))).not.toThrow();
  });

  it('renders the fallback when the wire carried no code at all', () => {
    expect(friendlyErrorMessage(asErrorCode(null))).toBe('Something went wrong. Please try again.');
  });

  it('rejects an unregistered literal at compile time', () => {
    // The parameter type is the closed code set, so a literal that names no
    // registered code cannot be passed. This proves the mechanism that keeps a
    // future code from silently rendering the generic sentence.
    // @ts-expect-error -- 'STREAM_ERROR_TYPO' names no registered code
    const message = friendlyErrorMessage('STREAM_ERROR_TYPO');
    expect(message).toBe('Something went wrong. Please try again.');
  });
});

describe('DOMAIN_ERROR_CODE_TO_WIRE_CODE', () => {
  it('maps each lower-case taxonomy code to a defined wire code with a message', () => {
    for (const wireCode of Object.values(DOMAIN_ERROR_CODE_TO_WIRE_CODE)) {
      expect(ERROR_MESSAGES[wireCode]).toBeTruthy();
    }
  });

  it('maps the taxonomy one-to-one onto the eight base codes', () => {
    expect(DOMAIN_ERROR_CODE_TO_WIRE_CODE).toEqual({
      validation: 'VALIDATION',
      unauthorized: 'UNAUTHORIZED',
      forbidden: 'FORBIDDEN',
      not_found: 'NOT_FOUND',
      conflict: 'CONFLICT',
      rate_limited: 'RATE_LIMITED',
      timeout: 'TIMEOUT',
      unavailable: 'UNAVAILABLE',
    });
  });
});

describe('errorCodeSchema', () => {
  it('accepts a known code', () => {
    expect(errorCodeSchema.parse('ZDR_REFUSED')).toBe('ZDR_REFUSED');
  });

  it('rejects an unknown code', () => {
    expect(errorCodeSchema.safeParse('NOPE').success).toBe(false);
  });
});

describe('errorResponseSchema', () => {
  it('accepts code-only responses', () => {
    expect(errorResponseSchema.parse({ code: 'VALIDATION' })).toEqual({ code: 'VALIDATION' });
  });

  it('accepts optional details', () => {
    const parsed = errorResponseSchema.parse({
      code: 'VERSION_MISMATCH',
      details: { otaUrl: 'https://example.test' },
    });
    expect(parsed.details).toEqual({ otaUrl: 'https://example.test' });
  });

  it('rejects a message field (codes only on the wire — messages map client-side)', () => {
    expect(errorResponseSchema.safeParse({ code: 'VALIDATION', message: 'nope' }).success).toBe(
      false
    );
  });

  it('rejects an unknown code', () => {
    expect(errorResponseSchema.safeParse({ code: 'WHAT' }).success).toBe(false);
  });
});

describe('classifier-unavailable error code', () => {
  it('names the auto-effort classifier-unbuildable refusal with its own copy', () => {
    expect(ERROR_CODES.CLASSIFIER_UNAVAILABLE).toBe('CLASSIFIER_UNAVAILABLE');
    expect(friendlyErrorMessage('CLASSIFIER_UNAVAILABLE')).toBe(
      ERROR_MESSAGES.CLASSIFIER_UNAVAILABLE
    );
    // The refusal must tell the user explicit levels still work — never the
    // generic fallback or the plain unavailable copy.
    expect(ERROR_MESSAGES.CLASSIFIER_UNAVAILABLE).not.toBe(ERROR_MESSAGES.UNAVAILABLE);
    expect(friendlyErrorMessage('CLASSIFIER_UNAVAILABLE')).not.toBe(
      'Something went wrong. Please try again.'
    );
  });
});

describe('newsletter error codes', () => {
  const newsletterCodes = ['NEWSLETTER_CONFIRM_INVALID', 'NEWSLETTER_UNSUBSCRIBE_INVALID'] as const;

  it('are registered in the closed code set', () => {
    for (const code of newsletterCodes) {
      expect(Object.values(ERROR_CODES)).toContain(code);
    }
  });

  it('each map to a non-fallback friendly message', () => {
    const fallback = friendlyErrorMessage(asErrorCode('DEFINITELY_UNKNOWN_CODE'));
    for (const code of newsletterCodes) {
      const message = friendlyErrorMessage(code);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toBe(fallback);
    }
  });
});

describe('wire refusals read the same as their pre-send notices', () => {
  // §Notices 2: a pre-send notice and a wire refusal describing the same
  // condition read the same. The mapping is asserted here so a divergence is a
  // failing test rather than a copy review.
  const SHARED_CONDITIONS = [
    ['MODEL_TIER_LOCKED', 'premium_requires_credit'],
    ['PREMIUM_REQUIRES_ACCOUNT', 'premium_requires_account'],
    ['GROUP_BUDGET_EXHAUSTED', 'guest_no_group_budget'],
    ['TRIAL_MESSAGE_TOO_EXPENSIVE', 'trial_message_cap_exceeded'],
    ['CONCURRENT_RUN', 'run_already_in_progress'],
    ['CONTEXT_LENGTH_EXCEEDED', 'prompt_too_long'],
    ['DAILY_ALLOWANCE_EXHAUSTED', 'free_allowance_exhausted'],
    ['GROUP_ALLOCATION_EXHAUSTED', 'group_owner_funds_unavailable'],
    // The condition is "the funding could not be checked", and which side could
    // not check it is an internal difference (§Notices 6): the client's own
    // funding read exhausts its retries and the server's admission gate fails
    // closed for the same kind of reason, leaving the same user with the same
    // single remedy.
    ['ADMISSION_UNAVAILABLE', 'send_check_unavailable'],
  ] as const;

  it('words each shared condition once', () => {
    for (const [code, reason] of SHARED_CONDITIONS) {
      expect(friendlyErrorMessage(code)).toBe(noticeText(reason));
    }
  });

  // INSUFFICIENT_ADMISSION answers for two producers whose conditions it cannot
  // tell apart: the admission balance gate, which compares spendable funds MINUS
  // funds reserved by runs in flight, and the Smart Model build, which finds no
  // candidate within the payer's effective funding. Naming either one's condition
  // would put that one's action on the other's callers, so the wording stays
  // condition-neutral and out of the per-condition set above.
  it('keeps the condition-neutral refusal out of the per-condition wordings', () => {
    expect(friendlyErrorMessage('INSUFFICIENT_ADMISSION')).toBe(noticeText('send_cannot_start'));
    expect(friendlyErrorMessage('INSUFFICIENT_ADMISSION')).not.toBe(
      noticeText('insufficient_funds')
    );
  });

  // The three admission conditions differ in the ACTION they leave the user,
  // which is what §Notices 2 makes them separate wordings for: paying fixes an
  // empty balance, only waiting fixes runs already in flight, and only the
  // conversation owner fixes an exhausted budget.
  it('gives the run-cap refusal its own wording, not the balance one', () => {
    expect(friendlyErrorMessage('RUN_CAPACITY_REACHED')).toBe(noticeText('funds_held_by_run'));
    expect(friendlyErrorMessage('RUN_CAPACITY_REACHED')).not.toBe(
      friendlyErrorMessage('INSUFFICIENT_ADMISSION')
    );
  });

  it('offers no payment action on a run-cap refusal, because paying cannot help', () => {
    expect(friendlyErrorMessage('RUN_CAPACITY_REACHED').toLowerCase()).not.toContain('add credit');
    expect(friendlyErrorMessage('RUN_CAPACITY_REACHED').toLowerCase()).not.toContain('balance');
  });

  // The chat client reads a failed run's sentence from its wire code, so any code
  // whose copy claims a billing outcome makes that claim on every path that code
  // can ride. No run outcome is unbilled by construction: a stopped or cut run
  // settles what it produced, and a run whose outcome never reached the client is
  // unknowable. So no code may claim one.
  it('lets no error code claim a billing outcome', () => {
    const claimants = Object.entries(ERROR_MESSAGES)
      .filter(([, message]) => /bill/i.test(message))
      .map(([code]) => code);
    expect(claimants).toEqual([]);
  });

  it('routes each budget level to the wording whose action names the right person', () => {
    expect(friendlyErrorMessage('DAILY_ALLOWANCE_EXHAUSTED')).not.toBe(
      friendlyErrorMessage('GROUP_ALLOCATION_EXHAUSTED')
    );
    expect(friendlyErrorMessage('GROUP_ALLOCATION_EXHAUSTED').toLowerCase()).toContain('owner');
  });

  // GROUP_BUDGET_EXHAUSTED has its own live producer — the link-guest denial —
  // and guest-specific copy that is false for a member whose allocation ran out.
  it('does not reuse the unallocated-guest refusal for an exhausted allocation', () => {
    expect(friendlyErrorMessage('GROUP_ALLOCATION_EXHAUSTED')).not.toBe(
      friendlyErrorMessage('GROUP_BUDGET_EXHAUSTED')
    );
  });
});

describe('noticeReasonForCode', () => {
  const ALL_CODES = Object.values(ERROR_CODES);

  it('names the notice condition a wire code describes', () => {
    expect(noticeReasonForCode('CONCURRENT_RUN')).toBe('run_already_in_progress');
  });

  it('names no condition for a code the notice vocabulary does not describe', () => {
    expect(noticeReasonForCode('RATE_LIMITED')).toBeUndefined();
  });

  it("words every code that has a condition with that condition's notice", () => {
    const codesWithReason = ALL_CODES.filter((code) => noticeReasonForCode(code) !== undefined);
    expect(codesWithReason.length).toBeGreaterThan(0);
    for (const code of codesWithReason) {
      const reason = noticeReasonForCode(code);
      if (reason === undefined) throw new Error(`Expected a notice reason for ${code}`);
      expect(ERROR_MESSAGES[code]).toBe(noticeText(reason));
    }
  });

  it('names the condition for every code worded as a notice', () => {
    for (const code of ALL_CODES) {
      for (const reason of NOTICE_REASONS) {
        if (ERROR_MESSAGES[code] === noticeText(reason)) {
          expect(noticeReasonForCode(code)).toBe(reason);
        }
      }
    }
  });
});

describe('rate-limit refusals', () => {
  it('words a rate limit without a wait as the rate-limit sentence', () => {
    expect(friendlyErrorMessage('RATE_LIMITED')).toBe(rateLimitedMessage());
  });

  it('words an attempt lockout without a wait as the rate-limit sentence', () => {
    expect(friendlyErrorMessage('TOO_MANY_ATTEMPTS')).toBe(rateLimitedMessage());
  });
});
