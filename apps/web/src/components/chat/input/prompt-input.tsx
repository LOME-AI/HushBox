import * as React from 'react';
import { cn, Textarea, AnimatedHeight } from '@hushbox/ui';
import { Button } from '@hushbox/ui/button';
import { ArrowUp, Icon, Loader2, Pencil, X } from '@hushbox/ui/icons';
import { FEATURE_FLAGS, notices, TEST_IDS, TEST_SIGNALS } from '@hushbox/shared';
import { getLinkGuestAuth } from '@/lib/auth/link-guest-auth';
import { usePromptBudget, type PromptBudgetResult } from '@/hooks/billing/use-prompt-budget';
import { usePayerPremiumAccess } from '@/hooks/models/use-payer-premium-access';
import { useReasoningEffort } from '@/hooks/chat/use-reasoning-effort';
import { ReasoningEffortMenu } from '@/components/chat/input/reasoning-effort-menu';
import { useStability } from '@/providers/stability-provider';
import { StableContent } from '@/components/shared/stable-content';
import { MorphHeight } from '@/components/shared/morph-height';
import { AnimatedPlaceholder } from '@/components/chat/input/animated-placeholder';
import { PredictionOverlay } from '@/components/chat/input/prediction-overlay';
import { usePromptPrediction } from '@/components/chat/input/use-prompt-prediction';
import {
  canSubmitCurrentSend,
  isSendable,
  isUserOnlySend,
  resolveQueueState,
  resolveSend,
  spendableFundingSource,
} from '@/components/chat/input/composer-send-gate';
import {
  claimSuggestionApply,
  claimSuggestionArrowDown,
  claimSuggestionArrowUp,
  isSubmitKeyEvent,
  suggestionListAriaProps,
} from '@/components/chat/input/composer-keys';
import {
  ComposerNarrowRows,
  PromptToolbar,
  type ChatSearchProps,
} from '@/components/chat/input/prompt-toolbar';
import { BottomRows, drawsTextRow } from '@/components/chat/input/bottom-rows';
import { GenerationSettingsPopover } from '@/components/chat/media/generation-settings-popover';
import { RatioChip } from '@/components/chat/media/ratio-chip';
import { ContextGauge } from '@/components/chat/input/context-gauge';
import { ComposerBar, type ComposerBarProps } from '@/components/chat/input/composer-bar';
import { gestureFor } from '@/lib/prediction/gestures';
import { visiblePrediction } from '@/lib/prediction/state';
import { ComposerMessages } from '@/components/chat/budget/composer-messages';
import type { FundingSource, MemberPrivilege, ChatModality } from '@hushbox/shared';
import type { PredictionState } from '@/lib/prediction/state';
import type { PromptPredictor } from '@/lib/prediction/predictor';
import type { PromptInputRef } from '@/components/chat/message/types';

export type { PromptInputRef } from '@/components/chat/message/types';
export type { ChatSearchProps } from '@/components/chat/input/prompt-toolbar';

/**
 * Four names for four states. Mid-run the control queues rather than sends, and
 * the same `isProcessing` that picks the click handler picks the name, so the
 * two cannot drift. "Queue" is the term already on screen beside this button
 * (the queue-full hint), not a new coinage.
 */
const BUTTON_ARIA_LABELS = {
  send: { true: 'Send', false: 'Cannot send' },
  queue: { true: 'Queue', false: 'Cannot queue' },
} as const;
/**
 * The one disabled send with no notice behind it: a read the turn has to be
 * priced from — the payer's funding or the model catalog — has not come back, so
 * there is no verdict to declare and nothing for the user to do. The button says
 * so itself, and says it of the check rather than of either read, because the
 * user is owed the same sentence whichever one is late. A notice row would fire
 * on every conversation open, on the surface every real refusal uses.
 */
const SEND_CHECK_ARIA_LABEL = 'Checking what you can send';

interface SendControlAffordance {
  readonly busy: boolean;
  readonly label: string;
  readonly glyph: React.JSX.Element;
}

/**
 * How the send control presents itself. A read that has not come back is the
 * only state it declares on its own; every other block already carries a notice,
 * and a second declaration on the button would double it (§Notices 7).
 *
 * **`isBillingLoading` alone does not mean "still settling", and gating on it
 * alone is a defect.** It is true for an EXHAUSTED catalog read as well as an
 * in-flight one, and not by coincidence: the catalog publishes no rows either
 * way, so the pending term cannot tell the two apart and `send_check_unavailable`
 * can arrive alongside it. Gating on the loading term alone would spin forever
 * under a notice saying the check could not be made.
 *
 * `sendRefusal === undefined` is therefore the load-bearing term: any verdict at
 * all, including one whose read failed, belongs to the notice and not to the
 * button. It is deliberately not the DISABLED state — conditioning on that would
 * relabel every refusal as a wait. While a reply streams this control queues
 * instead, and the queue stays open through a settling read, so an enabled
 * control is never described as busy either. `sendSpends` holds that last
 * property for the AI-off post as well: it waits on no funding read, so it is
 * open through one and must not be labelled as waiting on it.
 */
function sendControlAffordance(args: {
  sendSpends: boolean;
  isBillingLoading: boolean;
  sendRefusal: PromptBudgetResult['sendRefusal'];
  isProcessing: boolean;
  enabled: boolean;
}): SendControlAffordance {
  if (
    args.sendSpends &&
    args.isBillingLoading &&
    args.sendRefusal === undefined &&
    !args.isProcessing
  ) {
    return {
      busy: true,
      label: SEND_CHECK_ARIA_LABEL,
      glyph: <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />,
    };
  }
  const names = args.isProcessing ? BUTTON_ARIA_LABELS.queue : BUTTON_ARIA_LABELS.send;
  return {
    busy: false,
    label: names[String(args.enabled) as 'true' | 'false'],
    glyph: <Icon icon={ArrowUp} size="md-lg" className="stroke-[2.25]" />,
  };
}

/**
 * What the composer draws around its text and in its bar, each by position. An
 * unfilled slot draws nothing and takes no room.
 */
interface ComposerSlots extends Omit<ComposerBarProps, 'send'> {
  /** Seated on the field's top border at the right, half above it. */
  readonly topEdge?: React.ReactNode;
  /** A line above the field, inside the composer. */
  readonly aboveField?: React.ReactNode;
}

/** The gauge a composer carries on its top edge: only a text turn fills a context window. */
function contextGaugeFor(
  modality: ChatModality | undefined,
  audioOffered: boolean,
  budget: PromptBudgetResult
): React.JSX.Element | null {
  if (!drawsTextRow(modality, audioOffered)) return null;
  return (
    <ContextGauge
      used={budget.capacityCurrentUsage}
      capacity={budget.capacityMaxCapacity}
      band={budget.capacityBand}
    />
  );
}

/** The image turn's ratio chip and its popover, hung below the field and graded by what the payer can afford. */
function imageSettingsControl(
  modality: ChatModality | undefined,
  budget: PromptBudgetResult,
  field: React.RefObject<HTMLElement | null>
): React.JSX.Element | null {
  if (modality !== 'image') return null;
  return (
    <GenerationSettingsPopover
      modality="image"
      trigger={<RatioChip />}
      anchor={field}
      dimensions={budget.mediaOptions?.affordable.turnDimensions}
      sendRefusal={budget.sendRefusal}
    />
  );
}

/**
 * Below a gauge on the top edge, the text's scroll area starts under the gauge's lower
 * edge, so a long draft never scrolls beneath it: a 0.5rem margin (`mt-2`) outside the
 * textarea, paid back from its minimum height so the composer grows no taller. The
 * textarea's own padding stays, as the prediction overlay mirrors it glyph for glyph.
 */
function composerTextClass(belowGauge: boolean): string {
  return belowGauge ? 'relative mt-2' : 'relative';
}

/** The textarea's minimum height, less the margin {@link composerTextClass} adds. */
function textMinHeight(minHeight: string, belowGauge: boolean): string {
  return belowGauge ? `calc(${minHeight} - 0.5rem)` : minHeight;
}

/** The mark a disabled composer's field carries, so it draws the neutral fill. */
function disabledMark(disabled: boolean): { 'data-disabled'?: '' } {
  return disabled ? { 'data-disabled': '' } : {};
}

/**
 * What a screen reader is told about a prediction. The overlay is `aria-hidden`,
 * so this sentence is the whole of the feature for anyone not looking at it —
 * which is why it carries the key that takes it as well as the words on offer.
 */
function predictionAnnouncement(completion: string): string {
  return `Suggested continuation: ${completion.trim()}. Press Tab to accept.`;
}

interface PredictionAnnouncementProps {
  readonly state: PredictionState;
  /** A composer given no predictor mounts no region at all. */
  readonly enabled: boolean;
}

/**
 * The prediction's only screen-reader channel.
 *
 * The announcement tracks whether a prediction is actually rendered, not merely
 * whether one was last computed: the overlay is `aria-hidden`, so a stale
 * announcement would tell a screen-reader user Tab accepts a suggestion that
 * is not on screen. When the prediction is withheld the region is emptied, and
 * a suggestion that returns — even unchanged — is announced again, because the
 * withdrawal itself must be audible.
 */
function PredictionAnnouncement({
  state,
  enabled,
}: Readonly<PredictionAnnouncementProps>): React.JSX.Element | null {
  const [announcement, setAnnouncement] = React.useState('');
  const completion = visiblePrediction(state)?.completion;

  React.useEffect(() => {
    setAnnouncement(completion === undefined ? '' : predictionAnnouncement(completion));
  }, [completion]);

  if (!enabled) return null;

  return (
    <div data-slot="prediction-announcement" role="status" aria-live="polite" className="sr-only">
      {announcement}
    </div>
  );
}

const TYPING_THROTTLE_MS = 3000;

function emitTypingChange(
  newValue: string,
  onTypingChange: ((isTyping: boolean) => void) | undefined,
  lastTypingSentRef: React.RefObject<number>
): void {
  if (!onTypingChange) return;
  if (newValue.length === 0) {
    onTypingChange(false);
    lastTypingSentRef.current = 0;
  } else {
    const now = Date.now();
    if (now - lastTypingSentRef.current >= TYPING_THROTTLE_MS) {
      onTypingChange(true);
      lastTypingSentRef.current = now;
    }
  }
}

interface PromptInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (fundingSource: FundingSource) => void;
  placeholder?: string;
  /** Current conversation history character count (for budget calculation) */
  historyCharacters?: number;
  className?: string;
  rows?: number;
  disabled?: boolean;
  /** When true, a run is streaming: the composer offers queueing instead of sending. */
  isProcessing?: boolean;
  /**
   * Retained for backward compatibility with parents that still pass it; the
   * button no longer uses it (stopping is no longer supported).
   */
  onStop?: (() => void) | undefined;
  /**
   * Enqueue the current text while a run is streaming. Supplying this activates
   * the queue capability: during `isProcessing`, Enter/click enqueue and clear
   * the input instead of sending. Omit to leave the button disabled mid-run.
   */
  onQueue?: (text: string) => void;
  /** Number of already-queued messages (drives the queue-full hint text). */
  queueCount?: number;
  /** When true, the queue is at capacity: the button is disabled and a hint shows. */
  queueFull?: boolean;
  /** Custom minimum height for textarea. Defaults to two text lines ("4rem"). */
  minHeight?: string;
  /** Custom maximum height for textarea. Defaults to seven text lines ("11.5rem"); content scrolls internally beyond it. */
  maxHeight?: string;
  /** Auto-focus the textarea on mount. Use for desktop only to avoid mobile keyboard popup. */
  autoFocus?: boolean;
  /** Conversation ID for group budget lookup. Omit for solo conversations. */
  conversationId?: string | null;
  /** Current user's privilege in the group conversation. Omit for solo conversations. */
  currentUserPrivilege?: MemberPrivilege;
  /** When true, shows the AI toggle button (group chats only). */
  isGroupChat?: boolean;
  /** Called when user submits with AI toggle off (user-only message, no AI invocation). */
  onSubmitUserOnly?: () => void;
  /** Called when typing state changes (for WebSocket typing indicators). Throttled internally. */
  onTypingChange?: ((isTyping: boolean) => void) | undefined;
  /**
   * Search feature props. Omit to disable the search toggle entirely
   * (e.g. image modality has no search).
   */
  searchProps?: ChatSearchProps | undefined;
  /** Whether the user is authenticated (trial users can't search or switch modality). */
  isAuthenticated?: boolean;
  /** Whether the prompt input is in edit mode (editing a previous message) */
  isEditing?: boolean;
  /** Called when the user cancels editing */
  onCancelEdit?: (() => void) | undefined;
  /** Current active modality */
  activeModality?: ChatModality;
  /** Called when the user picks a modality in the mode menu. */
  onSelectModality?: ((modality: ChatModality) => void) | undefined;
  /**
   * Whether this composer offers audio generation. It is the single gate on
   * every element the composer renders that is conditional on audio being
   * offered. Defaults to the shipped feature flag; a surface that must not
   * offer audio passes `false`. It arrives as a prop rather than being read
   * where it renders because the composer's caller decides which modalities
   * that surface offers, and the flag is only its default.
   */
  audioModalityEnabled?: boolean;
  /**
   * Supplying a predictor turns on the sentence-completion hint. Omit it and the
   * composer behaves exactly as it does with the feature absent — nothing extra
   * mounts, and the textarea gains no handlers.
   */
  predictor?: PromptPredictor | undefined;
  /**
   * Receives the rival continuations behind the current hint, and an empty list
   * whenever no hint is showing. The composer renders only the inline hint; a
   * consumer decides whether to offer the rest as a list.
   */
  onPredictionCandidatesChange?: ((candidates: readonly string[]) => void) | undefined;
  /** The control that picks the turn's model, seated in the bar's model slot. */
  modelControl?: React.ReactNode;
}

const PROMPT_INPUT_DEFAULTS: Pick<
  Required<PromptInputProps>,
  | 'placeholder'
  | 'historyCharacters'
  | 'rows'
  | 'disabled'
  | 'isProcessing'
  | 'minHeight'
  | 'maxHeight'
  | 'autoFocus'
  | 'isGroupChat'
  | 'queueCount'
  | 'queueFull'
  | 'audioModalityEnabled'
> = {
  placeholder: 'Ask me anything...',
  historyCharacters: 0,
  rows: 2,
  disabled: false,
  isProcessing: false,
  // Founder-ruled sizing: start at 2 lines, auto-grow (the Textarea
  // primitive's same-cell sizing replica, not field-sizing-content) to 7
  // lines, scroll internally beyond. text-base = 1.5rem line-height,
  // py-2 = 1rem vertical padding: 2×1.5+1 = 4rem, 7×1.5+1 = 11.5rem.
  minHeight: '4rem',
  maxHeight: '11.5rem',
  autoFocus: false,
  isGroupChat: false,
  queueCount: 0,
  queueFull: false,
  audioModalityEnabled: FEATURE_FLAGS.AUDIO_ENABLED,
};

/**
 * Whether this composer's sends come out of the free preview.
 *
 * `isAuthenticated === false` alone is the ANONYMOUS classification, and an
 * anonymous link guest is not on the free preview — their messages are the
 * conversation owner's spend. The link-guest store is the same fact
 * `getUserTier` consults to answer `guest` rather than `trial`, so the two
 * cannot disagree about who is which.
 */
function spendsFreePreview(isAuthenticated: boolean | undefined): boolean {
  return isAuthenticated === false && getLinkGuestAuth() === null;
}

/**
 * The typed value plus the completion currently shown, so the composer
 * grows to the size ghost text would occupy if accepted rather than to
 * the typed value alone. Falls back to the typed value when no prediction
 * is visible — including while one is suppressed, dismissed, or simply
 * absent — so the box shrinks back the moment nothing is shown over it.
 */
function composerSizingValueFor(value: string, predictionState: PredictionState): string {
  return value + (visiblePrediction(predictionState)?.completion ?? '');
}

/**
 * The conversation a payer-scoped hook is asked about. An omitted prop and an
 * explicit `null` are one case — no conversation, so the payer is the caller —
 * and the hooks take only the second spelling.
 */
function payerScope(conversationId: string | null | undefined): string | null {
  return conversationId ?? null;
}

export const PromptInput = React.forwardRef<PromptInputRef, PromptInputProps>(
  function PromptInput(rawProps, ref) {
    const {
      value,
      onChange,
      onSubmit,
      placeholder,
      historyCharacters,
      className,
      rows,
      disabled,
      isProcessing,
      onQueue,
      queueCount,
      queueFull,
      minHeight,
      maxHeight,
      autoFocus,
      conversationId,
      currentUserPrivilege,
      isGroupChat,
      onSubmitUserOnly,
      onTypingChange,
      searchProps,
      isAuthenticated,
      isEditing,
      onCancelEdit,
      activeModality,
      onSelectModality,
      audioModalityEnabled,
      predictor,
      onPredictionCandidatesChange,
      modelControl,
    } = { ...PROMPT_INPUT_DEFAULTS, ...rawProps };
    const textareaRef = React.useRef<HTMLTextAreaElement>(null);
    const fieldRef = React.useRef<HTMLDivElement>(null);
    const composerRef = React.useRef<HTMLDivElement>(null);
    const modeMenuTriggerRef = React.useRef<HTMLButtonElement>(null);
    // Held here because the mode menu's Effort row opens it too, on a composer too
    // narrow to show the effort chip.
    const [effortMenuOpen, setEffortMenuOpen] = React.useState(false);
    const [aiEnabled, setAiEnabled] = React.useState(true);
    const lastTypingSentRef = React.useRef(0);
    const onTypingChangeRef = React.useRef(onTypingChange);
    onTypingChangeRef.current = onTypingChange;

    const prediction = usePromptPrediction({
      predictor,
      value,
      disabled,
      textareaRef,
      onCandidatesChange: onPredictionCandidatesChange,
    });

    const composerSizingValue = composerSizingValueFor(value, prediction.state);

    React.useImperativeHandle(ref, () => ({ focus: () => textareaRef.current?.focus() }), []);

    React.useEffect(() => {
      if (!autoFocus) return;
      // eslint-disable-next-line no-restricted-globals -- one-shot rAF defers focus to next frame, not motion animation
      const id = requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
      return () => {
        cancelAnimationFrame(id);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- autoFocus intentionally omitted: this is a mount-only focus; re-running when the prop toggles would steal focus mid-session
    }, []);

    React.useEffect(() => {
      return () => {
        onTypingChangeRef.current?.(false);
      };
    }, []);

    const { isAppStable } = useStability();
    // The effective selection — model-clamped AND lowered to what the payer can
    // fund — prices the live estimate and rides the turn request; the effort menu
    // reads the same hook, so the checked option and the priced effort can never
    // disagree.
    const { effective: reasoningEffort } = useReasoningEffort();
    // The PAYER's reach, not the sender's: in an owner-funded conversation the
    // owner's tier decides which modalities may be entered at all.
    const premiumAccess = usePayerPremiumAccess(payerScope(conversationId));
    const budget = usePromptBudget({
      value,
      historyCharacters,
      ...(conversationId != null && { conversationId }),
      ...(currentUserPrivilege !== undefined && { currentUserPrivilege }),
      ...(reasoningEffort !== undefined && { reasoningEffort }),
    });

    // §Notices 7: a blocked send ALWAYS carries a notice, and exactly one
    // blocking demand renders. The refusal LEADS the list — an informational
    // funding notice must not sit above the reason the send is refused — and
    // any duplicate of the same condition is dropped so one cause yields one
    // notice.
    const composerNotices = React.useMemo(
      () =>
        budget.sendRefusal === undefined
          ? budget.notifications
          : [
              notices(budget.sendRefusal),
              ...budget.notifications.filter((notice) => notice.id !== budget.sendRefusal),
            ],
      [budget.sendRefusal, budget.notifications]
    );

    // The AI toggle decides which send the control performs, so it decides which
    // verdict answers for it and which handler runs; one predicate serves both,
    // because a control enabled by one verdict and acting on the other sends
    // what it was never cleared to send.
    const userOnlySend = isUserOnlySend(aiEnabled, onSubmitUserOnly);
    const spendable = spendableFundingSource(budget.fundingSource);
    const canSubmit = canSubmitCurrentSend({
      userOnlySend,
      hasContent: budget.hasContent,
      isOverCapacity: budget.isOverCapacity,
      hasBlockingError: budget.hasBlockingError,
      hasSpendableFunding: spendable !== undefined,
      isReadOnly: currentUserPrivilege === 'read',
      disabled,
      isProcessing,
    });

    // Queue capability is active only while a run streams AND a parent supplied
    // onQueue; a full queue blocks it, and so does anything that would still be
    // blocking the send once that run ends — the composer's notice already names
    // which. A block that ends with the run does not close the queue, or the
    // affordance would be gone in the only window it exists for.
    const { canQueue, showQueueFullHint } = resolveQueueState({
      isProcessing,
      hasQueueHandler: onQueue !== undefined,
      queueFull,
      queueable: isSendable({
        hasContent: budget.hasContent,
        isOverCapacity: budget.isOverCapacity,
        hasBlockingError: budget.hasPersistentBlockingError,
        disabled,
      }),
    });

    const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
      const newValue = e.target.value;
      onChange(newValue);
      emitTypingChange(newValue, onTypingChange, lastTypingSentRef);
    };

    const performSend = resolveSend({ userOnlySend, onSubmitUserOnly, onSubmit, spendable });

    const handleSubmit = (): void => {
      onTypingChange?.(false);
      lastTypingSentRef.current = 0;
      performSend?.();
    };

    const handleQueue = (): void => {
      const text = value.trim();
      if (text.length === 0) return;
      onQueue?.(text);
      onChange('');
    };

    /**
     * Whether the prediction claimed this key press.
     *
     * The decision is made against committed state with ONE field replaced:
     * suppression, re-read from the DOM here because it is the only part that
     * can already be wrong. `syncSuppression` dispatches, and a dispatch is
     * invisible to the handler that made it, so the state this component holds
     * still describes the composer as it was before the caret moved or the box
     * grew. Everything else in that state is by definition current — an answer
     * reaches the screen only by being committed, so committed state is exactly
     * what the user is looking at.
     */
    const handlePredictionKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (predictor === undefined) return false;
      const suppression = prediction.syncSuppression();
      const gesture = gestureFor(e, { ...prediction.state, suppression });
      if (gesture === 'accept') {
        const accepted = prediction.accept();
        if (accepted === null) return false;
        e.preventDefault();
        onChange(accepted);
        return true;
      }
      if (gesture === 'dismiss') {
        e.preventDefault();
        prediction.dismiss();
        return true;
      }
      return false;
    };

    /**
     * Whether the keyboard's virtual focus inside the suggestion list claimed
     * this key press.
     *
     * Runs before `handlePredictionKey`, so a row holding the virtual focus
     * claims Tab/ArrowRight/Enter for itself instead of letting the inline
     * hint accept or the submit handler fire. DOM focus never leaves the
     * textarea, so nothing here ever calls `.focus()`.
     */
    const handleSuggestionListKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (predictor === undefined) return false;
      return (
        claimSuggestionArrowDown(e, prediction) ||
        claimSuggestionArrowUp(e, prediction) ||
        claimSuggestionApply(e, prediction, onChange)
      );
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
      // An open candidate window owns every key it is shown: Enter confirms the
      // conversion rather than the message, and Tab and the arrows walk the
      // candidates. Claiming any of them sends half-converted text or corrupts
      // the conversion, so the composer intervenes in none of them.
      if (e.nativeEvent.isComposing) return;
      const claimedByPrediction = [handleSuggestionListKey, handlePredictionKey].some((claim) =>
        claim(e)
      );
      if (claimedByPrediction) return;
      if (!isSubmitKeyEvent(e)) return;
      if (isProcessing) {
        if (canQueue) {
          e.preventDefault();
          handleQueue();
        }
        return;
      }
      if (canSubmit) {
        e.preventDefault();
        handleSubmit();
      }
    };

    // The toolbar draws each control only when its props arrive, so one toolbar
    // given only the mode props fills the mode slot and one given only the
    // search props fills the Search slot.
    const toolbarProps = {
      isAuthenticated,
      premiumAccess,
      aiEnabled,
      onToggleAi: () => {
        setAiEnabled((previous) => !previous);
      },
      audioModalityEnabled,
    };
    const slots: ComposerSlots = {
      topEdge: contextGaugeFor(activeModality, audioModalityEnabled, budget),
      // The ratio chip rides the mode slot: the Search and Effort slots leave the bar below 20rem.
      modeControl: (
        <>
          <PromptToolbar
            {...toolbarProps}
            activeModality={activeModality}
            onSelectModality={onSelectModality}
            searchProps={undefined}
            isGroupChat={isGroupChat}
            modeMenuAnchor={fieldRef}
            modeMenuTriggerRef={modeMenuTriggerRef}
            modeMenuRows={
              <ComposerNarrowRows
                composer={composerRef}
                search={searchProps}
                onOpenEffort={() => {
                  setEffortMenuOpen(true);
                }}
              />
            }
          />
          {imageSettingsControl(activeModality, budget, fieldRef)}
        </>
      ),
      searchControl: (
        <PromptToolbar
          {...toolbarProps}
          activeModality={undefined}
          onSelectModality={undefined}
          searchProps={searchProps}
          isGroupChat={false}
        />
      ),
      effortControl: (
        <ReasoningEffortMenu
          effortDimension={budget.effortDimension}
          anchor={fieldRef}
          open={effortMenuOpen}
          onOpenChange={setEffortMenuOpen}
          fallbackFocus={modeMenuTriggerRef}
        />
      ),
      modelControl,
    };

    const buttonDisabled = isProcessing ? !canQueue : !canSubmit;
    const affordance = sendControlAffordance({
      sendSpends: !userOnlySend,
      isBillingLoading: budget.isBillingLoading,
      sendRefusal: budget.sendRefusal,
      isProcessing,
      enabled: !buttonDisabled,
    });
    const sendControl = (
      <>
        {showQueueFullHint && (
          <span data-testid={TEST_IDS.queueFullHint} className="text-muted-foreground text-xs">
            Queue full ({queueCount})
          </span>
        )}
        <Button
          id="send-button"
          type="button"
          onClick={isProcessing ? handleQueue : handleSubmit}
          disabled={buttonDisabled}
          aria-busy={affordance.busy}
          aria-label={affordance.label}
          data-testid={TEST_IDS.sendButton}
          className="size-9 p-0 has-[>svg]:p-0 pointer-coarse:size-11"
        >
          {affordance.glyph}
        </Button>
      </>
    );
    const { topEdge, aboveField, ...barSlots } = slots;

    return (
      <div
        className={cn('w-full', className)}
        {...{
          [TEST_SIGNALS.affordabilitySettled]: String(budget.isAffordabilitySettled),
        }}
      >
        <div ref={composerRef} data-slot="composer" className="@container/composer relative">
          <div data-slot="composer-above-field" className="empty:hidden">
            {aboveField}
          </div>
          {/* The estimate's place on a composer under 34rem, where the bar gives it up.
              Each copy is display: none wherever the other shows, so a reader meets one. */}
          <div
            data-slot="composer-estimate-above"
            className="@max-composer-compact/composer:not-empty:flex hidden justify-end px-1 pb-1"
          >
            {barSlots.estimate}
          </div>
          <div
            ref={fieldRef}
            data-slot="composer-field"
            {...disabledMark(disabled)}
            className={cn(
              'bg-background border-border-control flex w-full flex-col rounded-xl border transition-[border-color] duration-150',
              'not-focus-within:hover:border-foreground-muted',
              'focus-within:border-brand-red focus-within:outline-brand-red focus-within:outline-2 focus-within:outline-offset-2',
              'data-disabled:bg-[color-mix(in_srgb,var(--background-subtle)_45%,var(--background))]',
              // The textarea draws the field's own surface: no tint of its own in
              // dark and no shadow, so the field reads as one box.
              '[&_[data-slot=textarea]]:shadow-none dark:[&_[data-slot=textarea]]:bg-transparent'
            )}
          >
            <AnimatedHeight>
              {isEditing ? (
                <div className="border-border flex items-center justify-between border-b px-3 py-2">
                  <div className="flex items-center gap-1.5 text-sm">
                    <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Editing message</span>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={onCancelEdit}
                    aria-label="Cancel"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                    Cancel
                  </Button>
                </div>
              ) : null}
            </AnimatedHeight>
            <div data-slot="composer-text" className={composerTextClass(topEdge !== null)}>
              <Textarea
                ref={textareaRef}
                id="prompt-input"
                data-testid={TEST_IDS.promptInput}
                value={value}
                sizingValue={composerSizingValue}
                onChange={handleChange}
                onKeyDown={handleKeyDown}
                placeholder=""
                aria-label={placeholder}
                {...suggestionListAriaProps(prediction.activeSuggestion)}
                rows={rows}
                disabled={disabled}
                style={{ minHeight: textMinHeight(minHeight, topEdge !== null), maxHeight }}
                className="resize-none overflow-y-auto border-0 text-base focus-visible:ring-0"
                {...prediction.composerHandlers}
              />
              {value.length === 0 && <AnimatedPlaceholder text={placeholder} />}
              <PredictionOverlay
                state={prediction.state}
                onAccept={() => {
                  const accepted = prediction.accept();
                  if (accepted !== null) onChange(accepted);
                }}
              />
              <PredictionAnnouncement state={prediction.state} enabled={predictor !== undefined} />
            </div>

            <MorphHeight>
              {/* The per-modality row: the generation settings and their price.
                  Its controls live in the bar below. */}
              <BottomRows
                activeModality={activeModality}
                toolbar={null}
                sendButton={null}
                audioModalityEnabled={audioModalityEnabled}
                // `affordable`, never `admissible`: greying answers what the
                // payer's money can buy and must not move while a run holds
                // funds or while the user types (BILLING §Affordability 2).
                mediaDimensions={budget.mediaOptions?.affordable.turnDimensions}
                // The refusal itself, not a flag read off it: the verdict above
                // is absent for a funding read that FAILED and for one still in
                // flight alike, and only this value tells the two apart.
                sendRefusal={budget.sendRefusal}
              />
            </MorphHeight>
            <ComposerBar {...barSlots} send={sendControl} />
          </div>
          <div
            data-slot="composer-top-edge"
            className="absolute top-0 right-3 flex -translate-y-1/2 empty:hidden"
          >
            {topEdge}
          </div>
        </div>

        <StableContent isStable={isAppStable}>
          <ComposerMessages
            notices={composerNotices}
            isTrial={spendsFreePreview(isAuthenticated)}
            runInFlight={isProcessing}
            className="mt-2"
          />
        </StableContent>
      </div>
    );
  }
);
