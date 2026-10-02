import * as React from 'react';
import { notifyManager, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { decryptTextFromEpoch } from '@hushbox/crypto';
import { ERROR_CODES, fromBase64 } from '@hushbox/shared';
import { useConversation } from '@/hooks/chat/chat';
import { keyKeys } from '@/hooks/crypto/keys';
import { useRotateEpoch } from '@/hooks/realtime/use-conversation-members';
import { getErrorBody } from '@/lib/api/api';
import { useLinkGuestActive } from '@/lib/auth/link-guest-auth';
import { ChatRequestError } from '@/lib/chat/request-error';
import {
  getEpochKey,
  getEpochVerdict,
  getSnapshot,
  subscribe,
  type EpochVerdict,
  type KeyChainResponse,
} from '@/lib/crypto/epoch-key-cache';
import { executeRecoveryRotation, executeWithRotation } from '@/lib/crypto/rotation';
import type { MemberKeyResponse, RotationMember } from '@/lib/crypto/rotation';

type MaintenanceStep =
  | { readonly kind: 'rotate'; readonly currentEpoch: number; readonly key: Uint8Array }
  | {
      readonly kind: 'recover';
      readonly currentEpoch: number;
      readonly predecessor: { readonly epochNumber: number; readonly privateKey: Uint8Array };
    };

/**
 * What this client should do about its conversation's keys. A bad rotation is
 * recovered from the last epoch whose keys verified, which also rotates out
 * any departed seat; otherwise a pending departure is rotated from the current
 * epoch. Either needs a verified key this client holds, so a client that holds
 * none waits for a member who does.
 */
function nextStep(conversationId: string, verdict: EpochVerdict): MaintenanceStep | undefined {
  if (verdict.rotation === 'bad') {
    const predecessor = recoveryPredecessor(conversationId, verdict);
    if (predecessor === undefined) return undefined;
    return { kind: 'recover', currentEpoch: verdict.currentEpoch, predecessor };
  }
  if (!verdict.rotationPending) return undefined;
  const key = getEpochKey(conversationId, verdict.currentEpoch);
  if (key === undefined) return undefined;
  return { kind: 'rotate', currentEpoch: verdict.currentEpoch, key };
}

/**
 * The verified epoch a bad rotation is recovered from, with its key, when this
 * client holds it; undefined when this client cannot recover the conversation.
 */
export function recoveryPredecessor(
  conversationId: string,
  verdict: EpochVerdict
): { readonly epochNumber: number; readonly privateKey: Uint8Array } | undefined {
  if (verdict.rotation !== 'bad' || verdict.lastGoodEpoch === null) return undefined;
  const privateKey = getEpochKey(conversationId, verdict.lastGoodEpoch);
  if (privateKey === undefined) return undefined;
  return { epochNumber: verdict.lastGoodEpoch, privateKey };
}

/**
 * The title the new epoch re-encrypts. The server stores it only from the
 * owner, whose floor is the first epoch, so a title the owner cannot read sits
 * under a key that did not verify or is itself corrupt — unreadable to every
 * honest member — and is replaced by an empty one rather than blocking repair.
 */
function readableTitle(
  conversationId: string,
  conversation: { readonly title: string; readonly titleEpochNumber: number }
): string {
  const key = getEpochKey(conversationId, conversation.titleEpochNumber);
  if (key === undefined) return '';
  try {
    return decryptTextFromEpoch(key, fromBase64(conversation.title), {
      conversationId,
      epochNumber: conversation.titleEpochNumber,
    });
  } catch {
    return '';
  }
}

/** Every live seat: `member-keys` serves only those, and the new epoch wraps to all of them. */
function everySeat(keys: MemberKeyResponse[]): RotationMember[] {
  return keys.map((k) => ({ publicKey: fromBase64(k.publicKey) }));
}

type RotateEpoch = ReturnType<typeof useRotateEpoch>['mutateAsync'];

/** Attempts at one (conversation, kind, current epoch) per mount of the hook. */
const MAX_ATTEMPTS = 3;

interface Attempts {
  count: number;
  /** Keychain fetches completed when the latest attempt began. */
  fetchesAtStart: number;
  state: 'running' | 'failed' | 'done';
}

/**
 * Runs one step as a single submission and says whether it succeeded; a
 * `{rotated:false}` answer is a success, since another member already rotated.
 * A failure is reported and retried by the hook, never here, so the hook's cap
 * counts submitted rotations: see {@link mayRetry}. The app's mutation retry may
 * resend a submission under its one `Idempotency-Key`, and that resend is not a
 * new attempt.
 */
async function runStep(
  conversationId: string,
  step: MaintenanceStep,
  plaintextTitle: string,
  rotate: RotateEpoch
): Promise<boolean> {
  try {
    await (step.kind === 'rotate'
      ? executeWithRotation({
          conversationId,
          currentEpochPrivateKey: step.key,
          currentEpochNumber: step.currentEpoch,
          plaintextTitle,
          filterMembers: everySeat,
          execute: (rotation) => rotate({ conversationId, rotation }),
          maxAttempts: 1,
        })
      : executeRecoveryRotation({
          conversationId,
          currentEpochNumber: step.currentEpoch,
          predecessor: step.predecessor,
          plaintextTitle,
          filterMembers: everySeat,
          execute: (rotation) =>
            rotate({ conversationId, rotation, predecessorEpoch: step.predecessor.epochNumber }),
        }));
    return true;
  } catch (error: unknown) {
    console.error('Epoch maintenance failed:', error);
    return false;
  }
}

/**
 * A failed attempt is retried once a keychain fetch has completed since it
 * began — `useRotateEpoch` refetches the keychain before a failure reaches
 * {@link runStep}, and `member:removed` or a refused send refetch it too — and
 * that fetch still shows the situation the verdict describes, up to
 * {@link MAX_ATTEMPTS}. A fetch the cache has not judged yet can disagree with
 * the verdict on epoch or pending flag; the verdict it then lands re-runs this
 * check.
 */
function mayRetry(
  attempts: Attempts,
  keychainFetches: number,
  served: KeyChainResponse | undefined,
  verdict: EpochVerdict
): boolean {
  return (
    attempts.state === 'failed' &&
    attempts.count < MAX_ATTEMPTS &&
    keychainFetches > attempts.fetchesAtStart &&
    served?.currentEpoch === verdict.currentEpoch &&
    served.rotationPending === verdict.rotationPending
  );
}

/**
 * How many times the conversation's keychain query has landed data, identical data included.
 * The cache notifies synchronously, including when another component's render creates an
 * entry, so the callback is deferred as TanStack's own hooks do.
 */
function useKeychainFetches(queryClient: QueryClient, conversationId: string): number {
  const subscribeToQueries = React.useCallback(
    (onChange: () => void) =>
      queryClient.getQueryCache().subscribe(notifyManager.batchCalls(onChange)),
    [queryClient]
  );
  return React.useSyncExternalStore(
    subscribeToQueries,
    () => queryClient.getQueryState(keyKeys.chain(conversationId))?.dataUpdateCount ?? 0
  );
}

const refusalListeners = new Set<(conversationId: string) => void>();

/**
 * Hands a refusal of this client's own send to its conversation's maintenance.
 * A `ROTATION_PENDING` refusal means the server saw a departure this client's
 * keychain has not, or a repair that has not landed, so maintenance refetches
 * the keychain, whose arrival is what a first attempt or a retry acts on.
 */
export function requestEpochMaintenanceOnRefusal(conversationId: string, error: unknown): void {
  const code = error instanceof ChatRequestError ? error.code : getErrorBody(error)?.code;
  if (code !== ERROR_CODES.ROTATION_PENDING) return;
  for (const listener of refusalListeners) listener(conversationId);
}

/**
 * Keeps an open conversation's epoch keys current for a session member: it
 * rotates out a departed seat once the keychain says a departure is pending,
 * and recovers from a rotation whose keys did not verify. A situation that
 * succeeds is never attempted again, and one that fails is retried under
 * {@link mayRetry}; a `{rotated:false}` answer means another member already
 * rotated, and the refetched keychain is what says whether anything remains.
 * A link guest never rotates.
 */
export function useEpochMaintenance(conversationId: string | null): void {
  const queryClient = useQueryClient();
  const isLinkGuest = useLinkGuestActive();
  const cacheVersion = React.useSyncExternalStore(subscribe, getSnapshot);
  const { data: conversation } = useConversation(conversationId ?? '');
  const rotateEpoch = useRotateEpoch();
  const rotateRef = React.useRef(rotateEpoch.mutateAsync);
  rotateRef.current = rotateEpoch.mutateAsync;
  const keychainFetches = useKeychainFetches(queryClient, conversationId ?? '');
  const attemptsRef = React.useRef(new Map<string, Attempts>());
  const [settledAttempts, setSettledAttempts] = React.useState(0);

  React.useEffect(() => {
    if (!conversationId) return;
    const listener = (refusedId: string): void => {
      if (refusedId !== conversationId) return;
      void queryClient.invalidateQueries({ queryKey: keyKeys.chain(conversationId) });
    };
    refusalListeners.add(listener);
    return (): void => {
      refusalListeners.delete(listener);
    };
  }, [conversationId, queryClient]);

  React.useEffect(() => {
    if (!conversationId || isLinkGuest || !conversation) return;
    const verdict = getEpochVerdict(conversationId);
    if (verdict === undefined) return;
    const step = nextStep(conversationId, verdict);
    if (step === undefined) return;
    const situation = `${conversationId}:${step.kind}:${String(step.currentEpoch)}`;
    const previous = attemptsRef.current.get(situation);
    const served = queryClient.getQueryData<KeyChainResponse>(keyKeys.chain(conversationId));
    if (previous !== undefined && !mayRetry(previous, keychainFetches, served, verdict)) return;
    const attempts: Attempts = {
      count: (previous?.count ?? 0) + 1,
      fetchesAtStart: keychainFetches,
      state: 'running',
    };
    attemptsRef.current.set(situation, attempts);

    void (async (): Promise<void> => {
      const succeeded = await runStep(
        conversationId,
        step,
        readableTitle(conversationId, conversation),
        (variables) => rotateRef.current(variables)
      );
      attempts.state = succeeded ? 'done' : 'failed';
      setSettledAttempts((count) => count + 1);
    })();
  }, [
    conversationId,
    isLinkGuest,
    conversation,
    cacheVersion,
    keychainFetches,
    settledAttempts,
    queryClient,
  ]);
}
