import { shapeAlternatives, shapeCompletion, type ShapedPrediction } from './shaping';
import type { SuppressionReason } from './suppression';

/**
 * The composer's prediction state machine.
 *
 * Pure and framework-free: it owns the policy — when a request may be issued,
 * which answers may be shown, what a gesture leaves behind — while the timer,
 * the predictor call and the rendering all live with the caller. The caller
 * reports what happened; the selectors at the bottom tell it what to do next.
 */

/** Where the prediction for the current composer value has got to. */
export type PredictionStatus =
  /** Nothing wanted and nothing pending. */
  | { readonly kind: 'idle' }
  /** Typing has paused-in-waiting for this text; the caller's debounce is running. */
  | { readonly kind: 'settling'; readonly requestText: string }
  /** A predictor call is outstanding for this text. */
  | { readonly kind: 'awaiting'; readonly requestText: string }
  /** An answer for this text is held, shown only while the text still matches. */
  | {
      readonly kind: 'ready';
      readonly requestText: string;
      readonly prediction: ShapedPrediction;
    }
  /** The user dismissed the prediction for this text; predicting resumes when it changes. */
  | { readonly kind: 'dismissed'; readonly dismissedText: string };

export interface PredictionState {
  /** The composer value as last reported. */
  readonly typedText: string;
  readonly status: PredictionStatus;
  /** Whether an input method is mid-composition. */
  readonly composing: boolean;
  /** Why predictions are being withheld, or `null` when they are not. */
  readonly suppression: SuppressionReason | null;
}

export type PredictionAction =
  | { readonly type: 'typed'; readonly text: string }
  | { readonly type: 'debounce-settled'; readonly text: string }
  | {
      readonly type: 'completion-arrived';
      readonly requestText: string;
      readonly completion: string;
    }
  | {
      readonly type: 'alternatives-arrived';
      readonly requestText: string;
      readonly alternatives: readonly string[];
    }
  | { readonly type: 'prediction-failed'; readonly requestText: string }
  | { readonly type: 'accepted' }
  | { readonly type: 'dismissed' }
  | { readonly type: 'composition-started' }
  | { readonly type: 'composition-ended'; readonly text: string }
  | { readonly type: 'suppression-changed'; readonly reason: SuppressionReason | null };

export const initialPredictionState: PredictionState = {
  typedText: '',
  status: { kind: 'idle' },
  composing: false,
  suppression: null,
};

function statusForTypedText(status: PredictionStatus, text: string): PredictionStatus {
  const settling: PredictionStatus = { kind: 'settling', requestText: text };
  switch (status.kind) {
    case 'idle': {
      return settling;
    }
    case 'dismissed': {
      return status.dismissedText === text ? status : settling;
    }
    case 'ready':
    case 'settling':
    case 'awaiting': {
      // Exact match keeps what is already held or in flight; anything else
      // re-targets — consistent across every non-idle status, held answer or
      // not. A held `ready` answer whose text the composer has left (by
      // diverging from it or by backspacing into a prefix of it) is never
      // shown for what is currently typed, so keeping it parked here would
      // leave the composer with neither a visible answer nor a request in
      // flight to produce one.
      return status.requestText === text ? status : settling;
    }
  }
}

/** Whether a predictor call for `requestText` is the one the state is waiting on. */
function isOutstandingRequest(state: PredictionState, requestText: string): boolean {
  return state.status.kind === 'awaiting' && state.status.requestText === requestText;
}

function withTypedText(state: PredictionState, text: string): PredictionState {
  return { ...state, typedText: text, status: statusForTypedText(state.status, text) };
}

function withDebounceSettled(state: PredictionState, text: string): PredictionState {
  const armedForThisText = state.status.kind === 'settling' && state.status.requestText === text;
  return armedForThisText ? { ...state, status: { kind: 'awaiting', requestText: text } } : state;
}

function withCompletionArrived(
  state: PredictionState,
  requestText: string,
  rawCompletion: string
): PredictionState {
  if (!isOutstandingRequest(state, requestText)) return state;
  const completion = shapeCompletion(requestText, rawCompletion);
  if (completion === null) return { ...state, status: { kind: 'idle' } };
  const prediction: ShapedPrediction = { completion, candidates: [] };
  return { ...state, status: { kind: 'ready', requestText, prediction } };
}

/**
 * Attaches an alternatives-phase answer to the `ready` state its completion
 * produced.
 *
 * The completion phase must already have landed as the exact `ready` state
 * this answer continues: a newer request's completion moves `requestText`
 * before this one's alternatives can arrive, and that later `ready` is not
 * this answer's to attach to.
 */
function withAlternativesArrived(
  state: PredictionState,
  requestText: string,
  rawAlternatives: readonly string[]
): PredictionState {
  if (state.status.kind !== 'ready' || state.status.requestText !== requestText) return state;
  const candidates = shapeAlternatives(
    requestText,
    state.status.prediction.completion,
    rawAlternatives
  );
  return {
    ...state,
    status: { ...state.status, prediction: { ...state.status.prediction, candidates } },
  };
}

function withRequestFailed(state: PredictionState, requestText: string): PredictionState {
  if (!isOutstandingRequest(state, requestText)) return state;
  return { ...state, status: { kind: 'idle' } };
}

type ComposerReportAction = Extract<
  PredictionAction,
  { readonly type: 'typed' | 'composition-started' | 'composition-ended' | 'debounce-settled' }
>;
type PredictionLifecycleAction = Exclude<PredictionAction, ComposerReportAction>;

/** Handles what the composer itself reported: text, IME state, the debounce timer. */
function withComposerReport(state: PredictionState, action: ComposerReportAction): PredictionState {
  switch (action.type) {
    case 'typed': {
      return withTypedText(state, action.text);
    }

    case 'composition-started': {
      return { ...state, composing: true };
    }

    case 'composition-ended': {
      return { ...withTypedText(state, action.text), composing: false };
    }

    case 'debounce-settled': {
      return withDebounceSettled(state, action.text);
    }
  }
}

/** Handles a prediction call's outcome and the gestures that act on it. */
function withLifecycleAction(
  state: PredictionState,
  action: PredictionLifecycleAction
): PredictionState {
  switch (action.type) {
    case 'completion-arrived': {
      return withCompletionArrived(state, action.requestText, action.completion);
    }

    case 'alternatives-arrived': {
      return withAlternativesArrived(state, action.requestText, action.alternatives);
    }

    case 'prediction-failed': {
      return withRequestFailed(state, action.requestText);
    }

    case 'accepted': {
      return { ...state, status: { kind: 'idle' } };
    }

    case 'dismissed': {
      return { ...state, status: { kind: 'dismissed', dismissedText: state.typedText } };
    }

    case 'suppression-changed': {
      return { ...state, suppression: action.reason };
    }
  }
}

export function predictionReducer(
  state: PredictionState,
  action: PredictionAction
): PredictionState {
  switch (action.type) {
    case 'typed':
    case 'composition-started':
    case 'composition-ended':
    case 'debounce-settled': {
      return withComposerReport(state, action);
    }

    default: {
      return withLifecycleAction(state, action);
    }
  }
}

/**
 * The prediction to render, or `null` for nothing.
 *
 * The equality check is what keeps a stale answer off the screen: a held
 * prediction reappears only when the composer holds exactly the text it was
 * computed from.
 */
export function visiblePrediction(state: PredictionState): ShapedPrediction | null {
  if (state.composing || state.suppression !== null) return null;
  if (state.status.kind !== 'ready' || state.status.requestText !== state.typedText) return null;
  return state.status.prediction;
}

/** The text a debounce should currently be running for, or `null` for no timer. */
export function debounceTargetText(state: PredictionState): string | null {
  if (state.composing || state.suppression !== null) return null;
  return state.status.kind === 'settling' ? state.status.requestText : null;
}

/** The text a predictor call should currently be outstanding for, or `null` for none. */
export function pendingRequestText(state: PredictionState): string | null {
  return state.status.kind === 'awaiting' ? state.status.requestText : null;
}

/**
 * The text a predictor call is currently running for, or `null` once none is.
 *
 * Unlike {@link pendingRequestText}, this stays truthy through `ready`: a call
 * settles its completion phase before its alternatives phase, and `ready` is
 * where the first phase lands while the second may still be in flight. A
 * caller that tears its call down when this goes `null` — rather than when
 * `pendingRequestText` does — cancels only once both phases have landed or
 * the request text itself has moved on, never between them.
 */
export function runningRequestText(state: PredictionState): string | null {
  if (state.status.kind === 'ready') return state.status.requestText;
  return pendingRequestText(state);
}

/**
 * The composer value that accepting the visible prediction produces, or `null`
 * when there is nothing to accept. The completion is appended verbatim — it may
 * finish the word the user is halfway through, so no separator is inserted.
 */
export function acceptedValue(state: PredictionState): string | null {
  const prediction = visiblePrediction(state);
  return prediction === null ? null : state.typedText + prediction.completion;
}
