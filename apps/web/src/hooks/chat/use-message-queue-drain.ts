import * as React from 'react';
import { isTransientBlock } from '@hushbox/shared';
import { usePromptBudget } from '@/hooks/billing/use-prompt-budget';
import { useMessageQueueStore, type QueuedMessage } from '@/stores/chat/message-queue';
import type {
  FundingSource,
  MemberPrivilege,
  NoticeReason,
  PayerSwitchReason,
} from '@hushbox/shared';
import type { useChatPageState } from '@/hooks/chat/use-chat-page';

/** Stable empty reference so an unqueued conversation never re-renders consumers. */
const EMPTY_QUEUE: QueuedMessage[] = [];

/** What the drain may do with the queued message at the head of the queue. */
type DrainDecision =
  | { readonly kind: 'send'; readonly fundingSource: FundingSource }
  | { readonly kind: 'refuse' }
  | { readonly kind: 'disclose' }
  | { readonly kind: 'wait' };

/**
 * The drained message's disposition, read off the composer's own send gate —
 * resolved for THAT message rather than assumed, because a queued message is
 * charged like any other and a default source can charge a wallet the send gate
 * would not have used.
 *
 * The order is the rule. A gate that blocks without naming a cause is the gate's
 * own not-yet-known state (the funding read still in flight), so the named
 * refusals are read first and the bare block means WAIT. Refusing there would
 * dump an affordable message back into the composer every time a queue outran a
 * balance fetch.
 *
 * A refusal that ends without the user joins that WAIT arm. A held-funds
 * refusal is the case the drain makes vivid: the run whose hold is named is the
 * one that just settled to let this drain proceed, and the funding read carrying
 * the release lands a commit later. Refusing there states a condition that is
 * already false, and it costs the user the queue — so the drain re-asks on the
 * commit that carries the released figure instead. Held funds always release,
 * which is what makes waiting terminate; a reason that needs the user to act
 * (an empty balance, a long prompt, a locked model) never does and must refuse.
 * An unreadable funding read waits on the same argument: it clears on the next
 * refetch, so nothing the user does is what ends it, and the refuse arm latches
 * the drain until the conversation changes or a manual send succeeds — one
 * transient read failure would strand every queued message behind it.
 *
 * WHICH refusals those are is not decided here. It is declared once beside the
 * reason itself and read by both surfaces, so the composer cannot accept into
 * the queue a message this drain would hand straight back.
 *
 * An absent funding VERDICT waits on the same argument and is the wider case:
 * it covers the read still in flight as well as the exhausted one, so it holds
 * even when no other signal happens to name the state. It does not outrank a
 * refusal only the user can clear, though — an over-long prompt stays theirs to
 * shorten however the read resolves, and waiting on it would never end. What
 * the absence must never be is a send: an absence is not a wallet.
 *
 * The payer is the last thing decided, because a message that will not be sent
 * at all is owed its refusal rather than a sentence about a charge.
 */
export function resolveDrainDecision(
  gate: {
    readonly fundingSource: FundingSource | 'denied' | 'no_verdict';
    readonly hasBlockingError: boolean;
    readonly isOverCapacity: boolean;
    readonly sendRefusal: NoticeReason | undefined;
    readonly payerSwitch: PayerSwitchReason | undefined;
  },
  queued?: { readonly payerSwitch: PayerSwitchReason | undefined }
): DrainDecision {
  if (gate.fundingSource === 'denied') return { kind: 'refuse' };
  if (gate.isOverCapacity) return { kind: 'refuse' };
  if (gate.fundingSource === 'no_verdict') return { kind: 'wait' };
  if (gate.sendRefusal !== undefined && isTransientBlock(gate.sendRefusal)) return { kind: 'wait' };
  if (gate.sendRefusal !== undefined) return { kind: 'refuse' };
  if (gate.hasBlockingError) return { kind: 'wait' };
  if (payerMovedSinceQueued(gate.payerSwitch, queued)) return { kind: 'disclose' };
  return { kind: 'send', fundingSource: gate.fundingSource };
}

/**
 * Whether this send would charge the sender under a sentence that said someone
 * else would pay. The queued message carries the payer sentence that was on
 * screen when the user accepted it; the gate carries the one resolved now, and
 * the drain re-resolves funding at the moment it sends — the run that just
 * settled can have exhausted the headroom that was paying. Nothing is
 * mischarged when they differ, because the server reaches the same payer the
 * gate did; what is missing is that the charge would land before anything said
 * it had moved, and a change of payer is owed an affirmative disclosure BEFORE
 * the send.
 *
 * A message with no recorded sentence is treated as one that was told nothing,
 * which is why an absent argument errs toward disclosing.
 */
function payerMovedSinceQueued(
  resolved: PayerSwitchReason | undefined,
  queued: { readonly payerSwitch: PayerSwitchReason | undefined } | undefined
): boolean {
  return resolved !== undefined && resolved !== queued?.payerSwitch;
}

type PromptGateInput = Parameters<typeof usePromptBudget>[0];

/**
 * What the gate needs to price one queued message: that message's text plus the
 * counts and ids naming the payer. An absent head prices the empty composer,
 * which is the neutral question — the drain never spends on the answer.
 */
function drainGateInput(args: {
  head: QueuedMessage | undefined;
  historyCharacters: number;
  conversationId: string | null;
  privilege: MemberPrivilege | undefined;
  reasoningEffort: PromptGateInput['reasoningEffort'];
}): PromptGateInput {
  const { head, conversationId, privilege, reasoningEffort } = args;
  return {
    value: head?.text ?? '',
    historyCharacters: args.historyCharacters,
    ...(conversationId != null && { conversationId }),
    ...(privilege !== undefined && { currentUserPrivilege: privilege }),
    ...(reasoningEffort !== undefined && { reasoningEffort }),
  };
}

interface MessageQueueDrainInput {
  readonly realConversationId: string | null;
  readonly historyCharacters: number;
  readonly callerPrivilege: MemberPrivilege | undefined;
  readonly reasoningEffort: PromptGateInput['reasoningEffort'];
  readonly isStreaming: boolean;
  readonly state: ReturnType<typeof useChatPageState>;
  readonly executeSend: (
    content: string,
    convId: string,
    fundingSource: FundingSource
  ) => Promise<{ ok: boolean }>;
}

export interface MessageQueueDrain {
  /** Queued messages for the active conversation, oldest first (drives the pills). */
  readonly queuedMessages: QueuedMessage[];
  /** Enqueue a message on the active conversation (composer's `onQueue`). */
  readonly onQueueMessage: (text: string) => void;
  /** Remove a queued message by id (pill cancel). */
  readonly onCancelQueued: (id: string) => void;
  readonly queueCount: number;
  readonly queueFull: boolean;
  /**
   * A user send that fully settled — evidence a halting condition has lifted, so
   * the halt clears and the next queued message drains.
   */
  readonly onUserSendSettled: () => void;
}

/**
 * The queue-while-streaming drain: it holds the queue for the active
 * conversation, prices each head against the composer's own send gate, and sends
 * the head one at a time at each terminal settle.
 */
export function useMessageQueueDrain({
  realConversationId,
  historyCharacters,
  callerPrivilege,
  reasoningEffort,
  isStreaming,
  state,
  executeSend,
}: MessageQueueDrainInput): MessageQueueDrain {
  // True while a drained send is in flight — the double-send guard. A settle
  // event that fires while the drain loop is already running is ignored.
  const drainingRef = React.useRef(false);
  // Mirrors `isStreaming` for synchronous reads inside the imperative drain,
  // which must never start a send while a run is active.
  const isStreamingRef = React.useRef(isStreaming);
  React.useEffect(() => {
    isStreamingRef.current = isStreaming;
  }, [isStreaming]);
  /**
   * Set when a drained message is refused or fails. The queue then stops instead
   * of walking on: that message's text now sits in the composer, and draining
   * the next one would overwrite it — losing the message the user is being asked
   * to act on. Only a user send that fully settles (evidence the condition has
   * lifted) or a change of conversation clears it.
   */
  const drainHaltedRef = React.useRef(false);
  /** Latest drain step, so callers reach it without depending on its identity. */
  const drainStepRef = React.useRef<(() => void) | undefined>(undefined);

  // Subscribe to the whole per-conversation queue map (a stable reference until a
  // queue actually changes), then derive this conversation's slice — reactive
  // without the fresh-`[]` identity churn of selecting `queued(convId)` directly.
  const enqueue = useMessageQueueStore((s) => s.enqueue);
  const cancelQueued = useMessageQueueStore((s) => s.cancel);
  const queuesByConversation = useMessageQueueStore((s) => s.queuesByConversation);
  const queuedMessages = React.useMemo(
    () =>
      realConversationId ? (queuesByConversation[realConversationId] ?? EMPTY_QUEUE) : EMPTY_QUEUE,
    [queuesByConversation, realConversationId]
  );
  const queueCount = queuedMessages.length;
  const queueFull = React.useMemo(
    () => (realConversationId ? useMessageQueueStore.getState().isFull(realConversationId) : false),
    [realConversationId, queuedMessages]
  );
  const onCancelQueued = React.useCallback(
    (id: string): void => {
      if (realConversationId) cancelQueued(realConversationId, id);
    },
    [cancelQueued, realConversationId]
  );

  const queuedHead = queuedMessages[0];
  // The queued head's OWN gate: the same hook the composer's send button reads,
  // resolved against the queued text instead of the draft in the box. One
  // producer, one verdict — a drained send cannot be admitted on terms the send
  // button would have refused.
  const drainGate = usePromptBudget(
    drainGateInput({
      head: queuedHead,
      historyCharacters,
      conversationId: realConversationId,
      privilege: callerPrivilege,
      reasoningEffort,
    })
  );
  // Accepting a message into the queue records the payer sentence the composer
  // was showing at that moment, off the same gate the drain will re-resolve
  // against. Nothing re-derives it: a payer read twice from one producer is what
  // lets the drain tell a payer that changed behind the user from one they were
  // told about.
  const onQueueMessage = React.useCallback(
    (text: string): void => {
      if (realConversationId) enqueue(realConversationId, text, drainGate.payerSwitch);
    },
    [enqueue, realConversationId, drainGate.payerSwitch]
  );
  // Bound to the message it was resolved FOR. The imperative loop below spans
  // several settles, so it must be able to tell a verdict for the message in hand
  // from a verdict for the one before it.
  const drainDecision = resolveDrainDecision(drainGate, queuedHead);
  const drainGateRef = React.useRef<{ headId: string | undefined; decision: DrainDecision }>({
    headId: undefined,
    decision: { kind: 'wait' },
  });
  /**
   * Set when the drain stopped with messages still queued and no verdict to spend
   * on them — the funding read was in flight, the settling run's hold was still
   * counted, or the render carrying this head's verdict had not committed yet.
   * All clear on a later render, which is why the re-entry hangs off the commit
   * that produces the verdict rather than off a timer or a retry count.
   */
  const drainResumeRef = React.useRef(false);

  React.useEffect(() => {
    drainHaltedRef.current = false;
  }, [realConversationId]);

  const drainStep = React.useCallback((): void => {
    // Invariant: never start a drained send while a run is active, and never let
    // a second settle event kick off a parallel drain (double-send).
    if (drainingRef.current || isStreamingRef.current || drainHaltedRef.current) return;
    const convId = realConversationId;
    if (!convId) return;
    if (useMessageQueueStore.getState().count(convId) === 0) {
      drainResumeRef.current = false;
      return;
    }
    drainingRef.current = true;
    void (async () => {
      try {
        // Drain FIFO, one message at a time, each awaited to its FULL settle
        // (executeSend resolves after the post-stream query invalidations and
        // onAllStreamsSettled). Draining at the terminal settle — never at the
        // earlier onAllModelsComplete — is load-bearing: it guarantees the next
        // drained message's optimistic parent is the just-persisted assistant
        // turn, not a mid-flight tile whose id resolves the wrong
        // parentMessageId. A refused or failed send pauses the drain and
        // restores that message's text to the composer; the remaining queued
        // messages are left untouched (never dropped, never auto-sent).
        while (!drainHaltedRef.current) {
          const [head] = useMessageQueueStore.getState().queued(convId);
          if (!head) {
            drainResumeRef.current = false;
            break;
          }
          const { headId, decision } = drainGateRef.current;
          // The gate is a rendered value, so it may only be spent on the message
          // it was resolved for. A mismatch means the render for this head has not
          // committed yet; the commit that resolves it re-enters the drain.
          if (headId !== head.id || decision.kind === 'wait') {
            drainResumeRef.current = true;
            break;
          }
          drainResumeRef.current = false;
          useMessageQueueStore.getState().dequeueHead(convId);
          if (decision.kind === 'refuse' || decision.kind === 'disclose') {
            // One disposition for two causes, because the remedy is the same
            // sentence in the same place: the composer re-derives it from the
            // restored text, so neither the refusal nor the payer change needs a
            // second source. What differs is only which of them the user is
            // reading — a reason they must clear, or a charge that has moved to
            // them and is now stated before they send rather than after.
            state.setInputValue(head.text);
            drainHaltedRef.current = true;
            break;
          }
          const result = await executeSend(head.text, convId, decision.fundingSource);
          if (!result.ok) {
            state.setInputValue(head.text);
            drainHaltedRef.current = true;
            break;
          }
        }
      } finally {
        drainingRef.current = false;
      }
    })();
  }, [realConversationId, executeSend, state]);

  // Publish this render's verdict and drain step, then resume a drain that
  // stopped for want of a verdict. Runs on every commit because the verdict this
  // render carries IS the event being waited on — and enqueuing must not be, which
  // is why resumption is gated on the flag rather than on the queue changing.
  React.useEffect(() => {
    drainGateRef.current = { headId: queuedHead?.id, decision: drainDecision };
    drainStepRef.current = drainStep;
    if (drainResumeRef.current) drainStep();
  });

  // Mount-resume + terminal-settle trigger. `isStreaming` flips false only in the
  // stream hook's `finally` (post onAllStreamsSettled), so reacting to
  // `!isStreaming` starts the drain at the terminal settle. On mount, an idle
  // conversation with a non-empty queue begins draining immediately.
  React.useEffect(() => {
    if (!isStreaming) drainStepRef.current?.();
  }, [isStreaming, realConversationId]);
  const onUserSendSettled = React.useCallback((): void => {
    drainHaltedRef.current = false;
    drainStepRef.current?.();
  }, []);

  return {
    queuedMessages,
    onQueueMessage,
    onCancelQueued,
    queueCount,
    queueFull,
    onUserSendSettled,
  };
}
