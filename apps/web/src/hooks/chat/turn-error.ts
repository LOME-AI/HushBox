import { ChatRequestError, ChatRunFailedError } from '@/hooks/chat/use-chat-stream';
import { turnNoticeForCode, turnNoticeText, type TurnNotice } from '@/lib/chat/turn-notice';
import { useChatErrorStore, createChatError } from '@/stores/chat/error';
import type * as React from 'react';
import type { UserFacingMessage } from '@hushbox/shared';
import type { PromptInputRef } from '@/components/chat/message/types';

/**
 * Refusals whose answer means the served money numbers are behind the server's.
 * These were one code until admission split by whose action remedies it, and
 * nothing type-checks membership here: a code that leaves this set stops
 * refreshing the figures the composer prices against.
 */
export const BALANCE_STALE_REFUSAL_CODES = new Set([
  'INSUFFICIENT_ADMISSION',
  'DAILY_ALLOWANCE_EXHAUSTED',
  'GROUP_ALLOCATION_EXHAUSTED',
]);

/**
 * A run failure reads its own wire code rather than one fixed sentence: the
 * codes it carries differ in what they mean for money (the client's own
 * deadline fires when the server may have billed a partial), and the
 * re-execution path routes a rejected re-POST through it, so it carries wire
 * refusals as well as kills.
 */
export function turnNoticeOf(error: unknown): TurnNotice {
  if (error instanceof ChatRequestError) return turnNoticeForCode(error.code, error.details);
  if (error instanceof ChatRunFailedError) return turnNoticeForCode(error.code);
  return turnNoticeForCode('INTERNAL');
}

export function turnErrorContent(error: unknown): { content: UserFacingMessage } {
  return { content: turnNoticeText(turnNoticeOf(error)) };
}

export function handleTurnError(
  error: unknown,
  failedContent: string,
  forkKey: string,
  promptInputRef: React.RefObject<PromptInputRef | null>
): void {
  if (!(error instanceof ChatRequestError) && !(error instanceof ChatRunFailedError)) {
    console.error('Turn failed:', error);
    promptInputRef.current?.focus();
  }
  useChatErrorStore
    .getState()
    .setError(forkKey, createChatError({ notice: turnNoticeOf(error), failedContent }));
}
