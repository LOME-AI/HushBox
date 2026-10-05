import * as React from 'react';
import { ChatRequestError } from '@/hooks/chat/use-chat-stream';
import { BALANCE_STALE_REFUSAL_CODES, handleTurnError } from '@/hooks/chat/turn-error';
import { billingKeys } from '@/hooks/billing/billing';
import { requestEpochMaintenanceOnRefusal } from '@/hooks/crypto/use-epoch-maintenance';
import { useChatErrorStore, type FailedTurn, type FailedTurnRetry } from '@/stores/chat/error';
import type { QueryClient } from '@tanstack/react-query';
import type { PromptInputRef } from '@/components/chat/message/types';

/** The executor each kind of failed turn first ran through, which its retry runs through again. */
export interface FailedTurnExecutors {
  send: (retry: Extract<FailedTurnRetry, { kind: 'send' }>, storedIds: readonly string[]) => void;
  regenerate: (
    retry: Extract<FailedTurnRetry, { kind: 'regenerate' }>,
    storedIds: readonly string[]
  ) => void;
}

/**
 * Removes a failed turn's notice once the stored history holds a row the turn's
 * own run would have stored: a run the client saw fail can still have settled on
 * the server, and then the stored turn is what the thread shows, with nothing to
 * retry.
 */
export function useFailedTurnReconcile(
  chatError: { failedTurn?: FailedTurn } | null,
  forkKey: string,
  stored: readonly { id: string }[]
): void {
  React.useEffect(() => {
    const failedTurn = chatError?.failedTurn;
    if (failedTurn === undefined) return;
    const storedIds = new Set(stored.map((m) => m.id));
    if (failedTurn.storedIds.some((id) => storedIds.has(id))) {
      useChatErrorStore.getState().clearError(forkKey);
    }
  }, [chatError, forkKey, stored]);
}

/**
 * Records a failed turn on its fork: its notice, and the retry handle beside it.
 * A refusal over money the client saw stale refreshes the balance first, and the
 * refusal also reaches the conversation's epoch maintenance.
 */
export async function recordFailedTurn(
  error: unknown,
  failedTurn: FailedTurn,
  context: {
    forkKey: string;
    queryClient: QueryClient;
    promptInputRef: React.RefObject<PromptInputRef | null>;
  }
): Promise<void> {
  if (error instanceof ChatRequestError && BALANCE_STALE_REFUSAL_CODES.has(error.code)) {
    await context.queryClient.invalidateQueries({ queryKey: billingKeys.balance() });
  }
  handleTurnError(error, failedTurn, context.forkKey, context.promptInputRef);
  requestEpochMaintenanceOnRefusal(failedTurn.retry.request.conversationId, error);
}

/**
 * Re-posts a failed turn's own request, under its own turn's key, through the
 * executor it first ran through: a failed regenerate or edit stays a regenerate
 * and never becomes a send of its question. The executor also gets the ids the
 * earlier attempts' rows would carry, which its own failure record keeps.
 */
export function dispatchFailedTurnRetry(
  failedTurn: FailedTurn | undefined,
  executors: FailedTurnExecutors
): void {
  if (failedTurn === undefined) return;
  const { retry, storedIds } = failedTurn;
  if (retry.kind === 'send') executors.send(retry, storedIds);
  if (retry.kind === 'regenerate') executors.regenerate(retry, storedIds);
}

/**
 * The ids a retried turn's record watches for: every attempt's, not the latest
 * alone. An earlier attempt the client saw fail can still be the one the server
 * stored, and a later attempt refused before its run started names nothing.
 */
export function mergeStoredIds(
  earlier: readonly string[],
  latest: readonly string[]
): readonly string[] {
  return [...new Set([...earlier, ...latest])];
}
