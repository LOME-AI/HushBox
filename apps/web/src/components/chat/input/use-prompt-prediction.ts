import * as React from 'react';
import {
  acceptedValue,
  debounceTargetText,
  initialPredictionState,
  predictionReducer,
  runningRequestText,
  visiblePrediction,
  type PredictionState,
} from '@/lib/prediction/state';
import {
  suppressionReason,
  type ComposerReading,
  type SuppressionReason,
} from '@/lib/prediction/suppression';
import { measureMirroredHeight } from '@/lib/prediction/completion-height';
import type { PromptPredictor } from '@/lib/prediction/predictor';

/**
 * How long the composer stays quiet before asking for a prediction.
 *
 * Short enough that a hint follows a pause rather than a wait, long enough that
 * it is not armed between the keystrokes of a word. Added to the measured
 * time-to-first-token on the two engines that run this model at usable speed,
 * the whole gesture still lands inside the quarter-second at which a response
 * stops reading as immediate.
 */
export const PREDICTION_DEBOUNCE_MS = 180;

/** The array handed to a candidate consumer when there is nothing to offer. */
const NO_CANDIDATES: readonly string[] = [];

/** DOM id of the suggestion listbox rendered by `PredictionSuggestionList`. */
export const PREDICTION_SUGGESTION_LISTBOX_ID = 'prediction-suggestion-listbox';

/** DOM id of one suggestion row, keyed by its position in the candidate list. */
export function suggestionRowId(index: number): string {
  return `prediction-suggestion-option-${String(index)}`;
}

/**
 * The document's font set, which the DOM lib declares as always present while
 * jsdom (the test environment) implements none. The declared return is what
 * makes that absence a type the checker can see.
 */
function fontSetOf(target: Document): FontFaceSet | undefined {
  return target.fonts;
}

/**
 * Which candidate row currently holds the keyboard's virtual focus.
 *
 * The composer owns DOM focus and the keydown handling; the suggestion list is
 * rendered as its sibling, not its descendant, by a component neither of them
 * owns — so there is no shared parent to hold this in state or context without
 * an edit outside this task's file ownership. A module-scoped store, on the
 * `link-guest-auth.ts` external-store pattern, reaches both without one.
 * Every mount resets it: the alternative, leaving a stale index for whichever
 * composer or list mounts next, is worse than a store no wider than one screen
 * needs to be at a time.
 */
let activeSuggestionIndex: number | null = null;
const activeSuggestionListeners = new Set<() => void>();

function notifyActiveSuggestionChange(): void {
  for (const listener of activeSuggestionListeners) listener();
}

/**
 * Moves the virtual focus directly to `index` (or clears it with `null`).
 *
 * Exported alongside the read side on the same `link-guest-auth.ts` precedent:
 * production code only ever reaches this through the bounds-checked
 * `handleArrowDown` / `handleArrowUp` / `applyActiveSuggestion` callbacks
 * `usePromptPrediction` returns, but `prediction-suggestion-list.tsx` renders
 * as a sibling of the composer with no shared parent to inject a driver
 * through, so its tests reach the same store directly, exactly as the
 * composer's own tests do via those callbacks.
 */
export function setActiveSuggestionIndex(index: number | null): void {
  if (index === activeSuggestionIndex) return;
  activeSuggestionIndex = index;
  notifyActiveSuggestionChange();
}

function getActiveSuggestionIndex(): number | null {
  return activeSuggestionIndex;
}

function subscribeActiveSuggestion(listener: () => void): () => void {
  activeSuggestionListeners.add(listener);
  return () => {
    activeSuggestionListeners.delete(listener);
  };
}

/** The candidate row currently holding the keyboard's virtual focus, or `null`. */
export function useActiveSuggestionIndex(): number | null {
  return React.useSyncExternalStore(subscribeActiveSuggestion, getActiveSuggestionIndex);
}

/** Handlers the composer must carry for the prediction state to stay truthful. */
interface PromptPredictionComposerHandlers {
  readonly onCompositionStart: () => void;
  readonly onCompositionEnd: (event: React.CompositionEvent<HTMLTextAreaElement>) => void;
  readonly onSelect: () => void;
  readonly onScroll: () => void;
}

interface PromptPredictionInput {
  /** Omit to leave the composer exactly as it behaves with no prediction feature. */
  readonly predictor: PromptPredictor | undefined;
  /** The composer's current value, as its owner holds it. */
  readonly value: string;
  /**
   * Whether the composer is refusing input. A frozen composer offers no
   * prediction at all — including one that was on screen when it froze.
   */
  readonly disabled: boolean;
  readonly textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  /** Receives the candidate continuations, and an empty list when there are none. */
  readonly onCandidatesChange: ((candidates: readonly string[]) => void) | undefined;
}

interface PromptPrediction {
  /**
   * The state every consumer decides from — render, gesture, acceptance and the
   * candidate list alike. Empty whenever the composer is offering nothing, so a
   * consumer cannot reach a prediction the composer is withholding.
   */
  readonly state: PredictionState;
  /** `undefined` while the composer offers no predictions, so it gains no handlers at all. */
  readonly composerHandlers: PromptPredictionComposerHandlers | undefined;
  /**
   * Takes the visible prediction and returns the composer's whole new value, or
   * `null` when there is nothing to accept. The caller assigns the returned
   * string; it is never an insertion at the caret.
   */
  readonly accept: () => string | null;
  /** Withdraws the visible prediction until the typed text changes. */
  readonly dismiss: () => void;
  /**
   * The candidate row holding the keyboard's virtual focus, or `null` while
   * none does — including whenever the candidate list itself is empty, so a
   * caller never reads an index past the end of what it can render.
   */
  readonly activeSuggestion: number | null;
  /**
   * Moves the virtual focus one row down, entering the list at its first row
   * from no active row. Returns whether it claimed the key: `false` when no
   * candidate consumer is wired up or the list is empty, in which case the
   * caller must let the composer's ordinary ArrowDown behavior run.
   */
  readonly handleArrowDown: () => boolean;
  /**
   * Moves the virtual focus one row up, or off the list entirely from its
   * first row. Returns `false` only when no row is active, so the caller can
   * fall back to the composer's ordinary ArrowUp behavior.
   */
  readonly handleArrowUp: () => boolean;
  /**
   * Takes the active row's candidate and returns the composer's whole new
   * value, exactly as `accept` does for the inline completion — or `null`
   * when no row is active.
   */
  readonly applyActiveSuggestion: () => string | null;
  /**
   * Re-reads the composer, updates the suppression decision, and returns the
   * reading it just took — `null` when nothing withholds a prediction.
   *
   * **Decide on the returned value.** A caller inside an event handler cannot
   * see the dispatch it just made: neither `state` nor the ref behind it moves
   * until the next commit, so both still hold the pre-call snapshot for the rest
   * of that handler. A key press is the case that matters — it must know whether
   * a prediction is on screen before the composer has re-rendered.
   *
   * With no composer mounted there is nothing to read, so the decision already
   * in force comes back unchanged.
   */
  readonly syncSuppression: () => SuppressionReason | null;
}

/** The completion held for the composer's current text, or `null` when there is none. */
function currentReadyCompletion(state: PredictionState): string | null {
  if (state.status.kind !== 'ready') return null;
  if (state.status.requestText !== state.typedText) return null;
  return state.status.prediction.completion;
}

function readComposer(element: HTMLTextAreaElement, completion: string | null): ComposerReading {
  return {
    value: element.value,
    selectionStart: element.selectionStart,
    selectionEnd: element.selectionEnd,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    writingDirection: getComputedStyle(element).direction,
    predictedContentHeight:
      completion === null ? null : measureMirroredHeight(element, element.value + completion),
  };
}

/**
 * Drives the composer's sentence-completion hint: the debounce timer, the
 * predictor call and its cancellation, and the readings the suppression rules
 * are decided from. Policy lives in the prediction core; this is the effects
 * half of it.
 *
 * Two orderings here are load-bearing. Suppression is re-read and dispatched
 * ahead of the typed text on every commit, in a layout effect — so no paint can
 * ever show a prediction against a reading the DOM has already left behind, and
 * anything acting on visibility later in the same turn sees the current one. And
 * the predictor is held in a ref rather than an effect dependency, so a caller
 * that builds it inline cannot restart an in-flight prediction on every render.
 */
export function usePromptPrediction({
  predictor,
  value,
  disabled,
  textareaRef,
  onCandidatesChange,
}: PromptPredictionInput): PromptPrediction {
  const [state, dispatch] = React.useReducer(predictionReducer, initialPredictionState);
  /**
   * Whether the composer is offering predictions at all.
   *
   * `disabled` belongs here rather than among the suppression reasons, which
   * name the ways a mirror overlay stops lining up with the glyphs beneath it —
   * this is not a misalignment but an absence of a composer to complete. What it
   * shares with suppression is the shape: it withholds the answer without
   * discarding it, so the hint the user had is the hint they get back.
   */
  const offering = predictor !== undefined && !disabled;
  /**
   * A hint the user cannot see must also be one they cannot take. Every
   * consumer — the overlay, the gesture decision, `accept`, the candidate list —
   * reads its answer from here, so the two can never disagree.
   */
  const offeredState = offering ? state : initialPredictionState;

  const stateRef = React.useRef(state);
  stateRef.current = state;
  const offeredStateRef = React.useRef(offeredState);
  offeredStateRef.current = offeredState;
  const predictorRef = React.useRef(predictor);
  predictorRef.current = predictor;
  const onCandidatesChangeRef = React.useRef(onCandidatesChange);
  onCandidatesChangeRef.current = onCandidatesChange;

  const syncSuppression = React.useCallback((): SuppressionReason | null => {
    const element = textareaRef.current;
    if (element === null) return stateRef.current.suppression;
    const completion = currentReadyCompletion(stateRef.current);
    const reason = suppressionReason(readComposer(element, completion));
    if (reason !== stateRef.current.suppression) dispatch({ type: 'suppression-changed', reason });
    return reason;
  }, [textareaRef]);

  React.useLayoutEffect(() => {
    if (!offering) return;
    syncSuppression();
    if (state.typedText !== value) dispatch({ type: 'typed', text: value });
  });

  React.useEffect(() => {
    const element = textareaRef.current;
    if (!offering || element === null) return;
    // The composer's own events cover everything the user does to it, and the
    // layout effect covers everything that re-renders it. Geometry alone is
    // neither: a rotation, a viewport resize or the accessibility widget's font
    // scale can push the composer past its maximum height and leave a hint
    // rendered against a reading the box has already left behind.
    const observer = new ResizeObserver(() => {
      syncSuppression();
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [offering, syncSuppression, textareaRef]);

  React.useEffect(() => {
    // `font-display: swap` (packages/ui/src/styles/fonts.css) can render a
    // completion against fallback-font metrics that fit, then reflow wider once
    // the real face loads — with no React commit and no textarea resize to
    // re-run suppression through either path above. `document.fonts.ready`
    // resolves exactly once per document, so this re-reads the one time a swap
    // could have invalidated the standing decision, never on a keystroke.
    const fonts = fontSetOf(document);
    if (!offering || fonts === undefined) return;
    const controller = new AbortController();
    void (async (): Promise<void> => {
      await fonts.ready;
      if (!controller.signal.aborted) syncSuppression();
    })();
    return () => {
      controller.abort();
    };
  }, [offering, syncSuppression]);

  React.useEffect(() => {
    if (!offering) return;
    return predictorRef.current?.onReady?.(() => {
      // A composer that typed while the session was still loading has an
      // in-flight request that already rejected, leaving status idle with the
      // text still sitting unanswered. Re-dispatching it re-enters the same
      // debounce every keystroke does, so this cannot bypass the pause or
      // race a request that is already in flight or already answered.
      const current = stateRef.current;
      if (current.typedText === '' || current.status.kind !== 'idle') return;
      dispatch({ type: 'typed', text: current.typedText });
    });
  }, [offering]);

  const debounceText = debounceTargetText(state);
  React.useEffect(() => {
    if (debounceText === null) return;
    const timer = setTimeout(() => {
      dispatch({ type: 'debounce-settled', text: debounceText });
    }, PREDICTION_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [debounceText]);

  // Keyed on runningRequestText, not the narrower pendingRequestText: that one
  // goes null the instant the completion phase lands (status moves out of
  // `awaiting` into `ready`), which would tear this effect down — aborting
  // the controller — while the alternatives phase is still in flight.
  const requestText = runningRequestText(state);
  React.useEffect(() => {
    const activePredictor = predictorRef.current;
    if (requestText === null || activePredictor === undefined) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const prediction = await activePredictor.predict(
          requestText,
          controller.signal,
          (completion) => {
            if (controller.signal.aborted) return;
            // Re-read first, so the very commit that turns the inline hint
            // visible already carries the composer's current suppression
            // rather than the reading taken when the request went out.
            syncSuppression();
            dispatch({ type: 'completion-arrived', requestText, completion });
          }
        );
        if (controller.signal.aborted) return;
        // Re-read again for the same reason: the candidate list must not
        // render against a suppression reading the alternatives outlived.
        syncSuppression();
        dispatch({
          type: 'alternatives-arrived',
          requestText,
          alternatives: prediction.alternatives,
        });
      } catch {
        // A prediction is a best-effort hint: every rejection, the cancellation
        // above included, means the user sees nothing and hears about nothing.
        if (!controller.signal.aborted) dispatch({ type: 'prediction-failed', requestText });
      }
    })();
    return () => {
      controller.abort();
    };
  }, [requestText, syncSuppression]);

  const visible = visiblePrediction(offeredState);
  const candidates = visible === null ? NO_CANDIDATES : visible.candidates;
  const candidatesRef = React.useRef(candidates);
  candidatesRef.current = candidates;
  React.useEffect(() => {
    onCandidatesChangeRef.current?.(candidates);
  }, [candidates]);

  // A fresh candidate set — the text moved on, the list closed, a new mount —
  // starts the virtual focus over at "nothing active" rather than carrying an
  // index the founder's spec never asked to survive a re-open.
  React.useEffect(() => {
    setActiveSuggestionIndex(null);
  }, [candidates]);

  const rawActiveSuggestion = React.useSyncExternalStore(
    subscribeActiveSuggestion,
    getActiveSuggestionIndex
  );
  // Clamped against this render's own candidates: the reset effect above only
  // runs after commit, so the one render between a shrinking candidate set and
  // that reset must not expose an index past the end of the list it is drawn
  // against.
  const activeSuggestion =
    rawActiveSuggestion !== null && rawActiveSuggestion < candidatesRef.current.length
      ? rawActiveSuggestion
      : null;

  const accept = React.useCallback((): string | null => {
    const accepted = acceptedValue(offeredStateRef.current);
    if (accepted === null) return null;
    dispatch({ type: 'accepted' });
    return accepted;
  }, []);

  const dismiss = React.useCallback((): void => {
    dispatch({ type: 'dismissed' });
  }, []);

  const handleArrowDown = React.useCallback((): boolean => {
    if (onCandidatesChangeRef.current === undefined) return false;
    const list = candidatesRef.current;
    if (list.length === 0) return false;
    const current = getActiveSuggestionIndex();
    if (current === null) {
      setActiveSuggestionIndex(0);
    } else if (current < list.length - 1) {
      setActiveSuggestionIndex(current + 1);
    }
    // Parked at the last row, ArrowDown still claims the key: the founder's
    // spec gives the open list every ArrowDown while it is open, never a wrap.
    return true;
  }, []);

  const handleArrowUp = React.useCallback((): boolean => {
    const current = getActiveSuggestionIndex();
    if (current === null) return false;
    // The caret was never moved to begin with — DOM focus stayed on the
    // composer the whole time — so leaving the list is already "return to the
    // caret at the end of the prompt"; nothing else needs to move it there.
    setActiveSuggestionIndex(current === 0 ? null : current - 1);
    return true;
  }, []);

  const applyActiveSuggestion = React.useCallback((): string | null => {
    const index = getActiveSuggestionIndex();
    if (index === null) return null;
    const candidate = candidatesRef.current[index];
    if (candidate === undefined) return null;
    const applied = offeredStateRef.current.typedText + candidate;
    dispatch({ type: 'accepted' });
    setActiveSuggestionIndex(null);
    return applied;
  }, []);

  const composerHandlers = React.useMemo(
    (): PromptPredictionComposerHandlers => ({
      onCompositionStart: () => {
        dispatch({ type: 'composition-started' });
      },
      onCompositionEnd: (event) => {
        dispatch({ type: 'composition-ended', text: event.currentTarget.value });
      },
      onSelect: syncSuppression,
      onScroll: syncSuppression,
    }),
    [syncSuppression]
  );

  return {
    state: offeredState,
    composerHandlers: offering ? composerHandlers : undefined,
    accept,
    dismiss,
    activeSuggestion,
    handleArrowDown,
    handleArrowUp,
    applyActiveSuggestion,
    syncSuppression,
  };
}
