/**
 * The `UserFacingMessage` brand plus helpers that produce one without going
 * through the code→copy map.
 *
 * The single source of truth for code→message copy is `error-codes.ts`
 * (`friendlyErrorMessage`). This module holds only the branded-string type and
 * the producers that mint a message from something other than a code alone: a
 * hand-written string (`customUserMessage`) and the rate-limit sentence with its
 * wait (`formatLockoutMessage`, `rateLimitedMessage`), plus the shared reader of
 * the wait a refusal carries (`retryAfterSecondsOf`).
 */

import { HOUR_SECONDS, MINUTE_SECONDS } from '../utils/durations.ts';

declare const __brand: unique symbol;

/**
 * A string that has been validated as a user-facing message.
 *
 * Produced by `friendlyErrorMessage()` (from an error code), or by
 * `customUserMessage()` / `formatLockoutMessage()` (from a hand-written or
 * formatted string).
 *
 * A chat error's sentence is this type (`turnErrorContent()`), keeping raw strings
 * from being passed without explicit mapping.
 */
export type UserFacingMessage = string & { readonly [__brand]: 'UserFacingMessage' };

/**
 * Wraps a hand-written string as a `UserFacingMessage`.
 *
 * Use when the message is not from the error code map — e.g., custom
 * markdown messages with signup links in the trial chat.
 */
export function customUserMessage(message: string): UserFacingMessage {
  return message as UserFacingMessage;
}

// Always rounds up so the displayed wait is never shorter than the real one.
export function formatLockoutMessage(retryAfterSeconds: number): UserFacingMessage {
  if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) {
    return 'Too many attempts. Try again in a moment.' as UserFacingMessage;
  }
  if (retryAfterSeconds < MINUTE_SECONDS) {
    const seconds = Math.ceil(retryAfterSeconds);
    return `Too many attempts. Try again in ${String(seconds)} ${seconds === 1 ? 'second' : 'seconds'}.` as UserFacingMessage;
  }
  if (retryAfterSeconds < HOUR_SECONDS) {
    const minutes = Math.ceil(retryAfterSeconds / MINUTE_SECONDS);
    return `Too many attempts. Try again in ${String(minutes)} ${minutes === 1 ? 'minute' : 'minutes'}.` as UserFacingMessage;
  }
  const hours = Math.ceil(retryAfterSeconds / HOUR_SECONDS);
  return `Too many attempts. Try again in ${String(hours)} ${hours === 1 ? 'hour' : 'hours'}.` as UserFacingMessage;
}

/**
 * The sentence every rate limit reads: the wait when the refusal carries one,
 * "in a moment" when it does not.
 */
export function rateLimitedMessage(retryAfterSeconds?: number): UserFacingMessage {
  return formatLockoutMessage(retryAfterSeconds ?? 0);
}

/**
 * The wait a rate-limit refusal carries, read off its `details`
 * (`{ retryAfterSeconds }`), or `undefined` when it carries no usable one.
 */
export function retryAfterSecondsOf(details: unknown): number | undefined {
  if (typeof details !== 'object' || details === null || !('retryAfterSeconds' in details)) {
    return undefined;
  }
  const { retryAfterSeconds } = details;
  return typeof retryAfterSeconds === 'number' &&
    Number.isFinite(retryAfterSeconds) &&
    retryAfterSeconds > 0
    ? retryAfterSeconds
    : undefined;
}
