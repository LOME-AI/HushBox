import { describe, it, expect } from 'vitest';
import {
  acceptedValue,
  debounceTargetText,
  initialPredictionState,
  pendingRequestText,
  predictionReducer,
  runningRequestText,
  visiblePrediction,
  type PredictionAction,
  type PredictionState,
} from './state';

const TYPED = 'the cat sat';
const RAW_COMPLETION = ' on the mat ';
const RAW_ALTERNATIVES = [' by the fire '] as const;
const SHAPED = { completion: ' on the mat', candidates: [' by the fire'] };

function reduceAll(actions: readonly PredictionAction[]): PredictionState {
  let state = initialPredictionState;
  for (const action of actions) state = predictionReducer(state, action);
  return state;
}

const READY: readonly PredictionAction[] = [
  { type: 'typed', text: TYPED },
  { type: 'debounce-settled', text: TYPED },
  { type: 'completion-arrived', requestText: TYPED, completion: RAW_COMPLETION },
  { type: 'alternatives-arrived', requestText: TYPED, alternatives: RAW_ALTERNATIVES },
];

describe('predictionReducer', () => {
  it('starts idle with nothing typed', () => {
    expect(initialPredictionState).toEqual({
      typedText: '',
      status: { kind: 'idle' },
      composing: false,
      suppression: null,
    });
  });

  it('arms a debounce when text is first typed', () => {
    const state = reduceAll([{ type: 'typed', text: TYPED }]);
    expect(state.typedText).toBe(TYPED);
    expect(state.status).toEqual({ kind: 'settling', requestText: TYPED });
  });

  it('leaves the armed debounce alone when the same text is reported again', () => {
    const armed = reduceAll([{ type: 'typed', text: TYPED }]);
    expect(predictionReducer(armed, { type: 'typed', text: TYPED }).status).toBe(armed.status);
  });

  it('re-arms the debounce for the new text when typing continues', () => {
    const state = reduceAll([
      { type: 'typed', text: TYPED },
      { type: 'typed', text: `${TYPED} down` },
    ]);
    expect(state.status).toEqual({ kind: 'settling', requestText: `${TYPED} down` });
  });

  it('issues a request when the debounce settles on the text it was armed for', () => {
    const state = reduceAll([
      { type: 'typed', text: TYPED },
      { type: 'debounce-settled', text: TYPED },
    ]);
    expect(state.status).toEqual({ kind: 'awaiting', requestText: TYPED });
  });

  it('ignores a debounce that settled on text the composer has moved past', () => {
    const armed = reduceAll([{ type: 'typed', text: TYPED }]);
    const state = predictionReducer(armed, { type: 'debounce-settled', text: 'the cat s' });
    expect(state).toBe(armed);
  });

  it('ignores a settled debounce when no debounce is armed', () => {
    const state = predictionReducer(initialPredictionState, {
      type: 'debounce-settled',
      text: TYPED,
    });
    expect(state).toBe(initialPredictionState);
  });

  it('holds the shaped prediction when the answer to the live request arrives', () => {
    const state = reduceAll(READY);
    expect(state.status).toEqual({ kind: 'ready', requestText: TYPED, prediction: SHAPED });
  });

  it('shows nothing when the arriving completion does not survive shaping', () => {
    const state = reduceAll([
      { type: 'typed', text: TYPED },
      { type: 'debounce-settled', text: TYPED },
      { type: 'completion-arrived', requestText: TYPED, completion: ' onwards ' },
    ]);
    expect(state.status).toEqual({ kind: 'idle' });
  });

  it('discards a completion for a request the composer has already moved past', () => {
    const awaiting = reduceAll([
      { type: 'typed', text: TYPED },
      { type: 'debounce-settled', text: TYPED },
      { type: 'typed', text: `${TYPED} down` },
    ]);
    const state = predictionReducer(awaiting, {
      type: 'completion-arrived',
      requestText: TYPED,
      completion: RAW_COMPLETION,
    });
    expect(state).toBe(awaiting);
    expect(visiblePrediction(state)).toBeNull();
  });

  it('discards a completion that arrives when no request is outstanding', () => {
    const state = predictionReducer(initialPredictionState, {
      type: 'completion-arrived',
      requestText: TYPED,
      completion: RAW_COMPLETION,
    });
    expect(state).toBe(initialPredictionState);
  });

  it('discards alternatives that arrive before their own completion phase', () => {
    const awaiting = reduceAll([
      { type: 'typed', text: TYPED },
      { type: 'debounce-settled', text: TYPED },
    ]);
    const state = predictionReducer(awaiting, {
      type: 'alternatives-arrived',
      requestText: TYPED,
      alternatives: RAW_ALTERNATIVES,
    });
    expect(state).toBe(awaiting);
  });

  it('discards alternatives for a request a newer completion has already replaced', () => {
    const requestA = TYPED;
    const requestB = `${TYPED} down by the barn`;
    const readyForB = reduceAll([
      { type: 'typed', text: requestA },
      { type: 'debounce-settled', text: requestA },
      { type: 'completion-arrived', requestText: requestA, completion: RAW_COMPLETION },
      { type: 'typed', text: requestB },
      { type: 'debounce-settled', text: requestB },
      { type: 'completion-arrived', requestText: requestB, completion: ' near the barn ' },
    ]);
    const state = predictionReducer(readyForB, {
      type: 'alternatives-arrived',
      requestText: requestA,
      alternatives: RAW_ALTERNATIVES,
    });
    expect(state).toBe(readyForB);
  });

  it('keeps the completion visible when the request fails after the completion phase landed', () => {
    const ready = reduceAll([
      { type: 'typed', text: TYPED },
      { type: 'debounce-settled', text: TYPED },
      { type: 'completion-arrived', requestText: TYPED, completion: RAW_COMPLETION },
    ]);
    const state = predictionReducer(ready, { type: 'prediction-failed', requestText: TYPED });
    expect(state).toBe(ready);
  });

  it('shows nothing when the live request fails', () => {
    const state = reduceAll([
      { type: 'typed', text: TYPED },
      { type: 'debounce-settled', text: TYPED },
      { type: 'prediction-failed', requestText: TYPED },
    ]);
    expect(state.status).toEqual({ kind: 'idle' });
  });

  it('ignores a failure reported for a request the composer has moved past', () => {
    const awaiting = reduceAll([
      { type: 'typed', text: TYPED },
      { type: 'debounce-settled', text: TYPED },
      { type: 'typed', text: `${TYPED} down` },
    ]);
    expect(predictionReducer(awaiting, { type: 'prediction-failed', requestText: TYPED })).toBe(
      awaiting
    );
  });

  it('re-requests, rather than parking, when the typed text shrinks back into the text it was made for', () => {
    const state = reduceAll([...READY, { type: 'typed', text: 'the cat s' }]);
    expect(state.status).toEqual({ kind: 'settling', requestText: 'the cat s' });
    expect(visiblePrediction(state)).toBeNull();
    expect(debounceTargetText(state)).toBe('the cat s');
  });

  it('re-arms a fresh debounce, rather than reusing the discarded prediction, once the typed text is retyped in full', () => {
    const state = reduceAll([
      ...READY,
      { type: 'typed', text: 'the cat s' },
      { type: 'typed', text: TYPED },
    ]);
    expect(state.status).toEqual({ kind: 'settling', requestText: TYPED });
    expect(visiblePrediction(state)).toBeNull();
  });

  it('re-requests instead of parking when a trailing space is typed and then backspaced away', () => {
    const spaced = `${TYPED} `;
    const spacedReady = reduceAll([
      ...READY,
      { type: 'typed', text: spaced },
      { type: 'debounce-settled', text: spaced },
      { type: 'completion-arrived', requestText: spaced, completion: RAW_COMPLETION },
      { type: 'alternatives-arrived', requestText: spaced, alternatives: RAW_ALTERNATIVES },
    ]);
    expect(spacedReady.status).toEqual({ kind: 'ready', requestText: spaced, prediction: SHAPED });

    const backspaced = predictionReducer(spacedReady, { type: 'typed', text: TYPED });
    expect(backspaced.status).toEqual({ kind: 'settling', requestText: TYPED });
    expect(visiblePrediction(backspaced)).toBeNull();
    expect(debounceTargetText(backspaced)).toBe(TYPED);
  });

  it('drops a prediction the moment the typed text stops being a prefix of its request', () => {
    const state = reduceAll([...READY, { type: 'typed', text: 'the cat sap' }]);
    expect(state.status).toEqual({ kind: 'settling', requestText: 'the cat sap' });
  });

  it('re-arms the debounce when the typed text shrinks while a request is outstanding', () => {
    const state = reduceAll([
      { type: 'typed', text: TYPED },
      { type: 'debounce-settled', text: TYPED },
      { type: 'typed', text: 'the cat s' },
    ]);
    expect(state.status).toEqual({ kind: 'settling', requestText: 'the cat s' });
  });

  it('shows nothing after the prediction is accepted', () => {
    const state = reduceAll([...READY, { type: 'accepted' }]);
    expect(state.status).toEqual({ kind: 'idle' });
  });

  it('remembers the text a dismissal was made against', () => {
    const state = reduceAll([...READY, { type: 'dismissed' }]);
    expect(state.status).toEqual({ kind: 'dismissed', dismissedText: TYPED });
    expect(visiblePrediction(state)).toBeNull();
  });

  it('stays dismissed while the typed text is unchanged', () => {
    const dismissed = reduceAll([...READY, { type: 'dismissed' }]);
    expect(predictionReducer(dismissed, { type: 'typed', text: TYPED }).status).toBe(
      dismissed.status
    );
  });

  it('predicts again once typing resumes after a dismissal', () => {
    const state = reduceAll([
      ...READY,
      { type: 'dismissed' },
      { type: 'typed', text: `${TYPED} down` },
    ]);
    expect(state.status).toEqual({ kind: 'settling', requestText: `${TYPED} down` });
  });

  it('records that an input method is composing', () => {
    const state = reduceAll([{ type: 'composition-started' }]);
    expect(state.composing).toBe(true);
  });

  it('takes the composed text and resumes predicting when composition ends', () => {
    const state = reduceAll([
      { type: 'composition-started' },
      { type: 'typed', text: TYPED },
      { type: 'composition-ended', text: TYPED },
    ]);
    expect(state.composing).toBe(false);
    expect(state.status).toEqual({ kind: 'settling', requestText: TYPED });
  });

  it('records the reason a prediction is being withheld', () => {
    const state = reduceAll([{ type: 'suppression-changed', reason: 'composer-scrolls' }]);
    expect(state.suppression).toBe('composer-scrolls');
  });

  it('records that nothing is withholding a prediction any more', () => {
    const state = reduceAll([
      { type: 'suppression-changed', reason: 'composer-scrolls' },
      { type: 'suppression-changed', reason: null },
    ]);
    expect(state.suppression).toBeNull();
  });
});

describe('visiblePrediction', () => {
  it('is the shaped prediction when the request matches what is typed', () => {
    expect(visiblePrediction(reduceAll(READY))).toEqual(SHAPED);
  });

  it('is null while an input method is composing', () => {
    expect(visiblePrediction(reduceAll([...READY, { type: 'composition-started' }]))).toBeNull();
  });

  it('is null while a suppression reason holds', () => {
    expect(
      visiblePrediction(
        reduceAll([...READY, { type: 'suppression-changed', reason: 'right-to-left' }])
      )
    ).toBeNull();
  });

  it('is null before any prediction has arrived', () => {
    expect(visiblePrediction(reduceAll([{ type: 'typed', text: TYPED }]))).toBeNull();
  });
});

describe('debounceTargetText', () => {
  it('is the text a debounce is armed for', () => {
    expect(debounceTargetText(reduceAll([{ type: 'typed', text: TYPED }]))).toBe(TYPED);
  });

  it('is null while an input method is composing', () => {
    expect(
      debounceTargetText(
        reduceAll([{ type: 'composition-started' }, { type: 'typed', text: TYPED }])
      )
    ).toBeNull();
  });

  it('is null while a suppression reason holds', () => {
    expect(
      debounceTargetText(
        reduceAll([
          { type: 'suppression-changed', reason: 'caret-not-at-end' },
          { type: 'typed', text: TYPED },
        ])
      )
    ).toBeNull();
  });

  it('is null when no debounce is armed', () => {
    expect(debounceTargetText(reduceAll(READY))).toBeNull();
  });
});

describe('pendingRequestText', () => {
  it('is the text a predictor call should be running for', () => {
    expect(
      pendingRequestText(
        reduceAll([
          { type: 'typed', text: TYPED },
          { type: 'debounce-settled', text: TYPED },
        ])
      )
    ).toBe(TYPED);
  });

  it('is null when no request is outstanding', () => {
    expect(pendingRequestText(reduceAll(READY))).toBeNull();
  });
});

describe('runningRequestText', () => {
  it('is the text a predictor call is running for, same as pendingRequestText, while awaiting', () => {
    const awaiting = reduceAll([
      { type: 'typed', text: TYPED },
      { type: 'debounce-settled', text: TYPED },
    ]);
    expect(runningRequestText(awaiting)).toBe(TYPED);
  });

  it('stays the request text once the completion phase lands, unlike pendingRequestText', () => {
    const readyForCompletionOnly = reduceAll([
      { type: 'typed', text: TYPED },
      { type: 'debounce-settled', text: TYPED },
      { type: 'completion-arrived', requestText: TYPED, completion: RAW_COMPLETION },
    ]);
    expect(pendingRequestText(readyForCompletionOnly)).toBeNull();
    expect(runningRequestText(readyForCompletionOnly)).toBe(TYPED);
  });

  it('stays the request text once both phases have landed', () => {
    expect(runningRequestText(reduceAll(READY))).toBe(TYPED);
  });

  it('is null once no request is outstanding and none has answered', () => {
    expect(runningRequestText(initialPredictionState)).toBeNull();
  });
});

describe('acceptedValue', () => {
  it('is the typed text with the visible completion appended verbatim', () => {
    expect(acceptedValue(reduceAll(READY))).toBe(`${TYPED} on the mat`);
  });

  it('is null when no prediction is visible to accept', () => {
    expect(acceptedValue(initialPredictionState)).toBeNull();
  });
});
