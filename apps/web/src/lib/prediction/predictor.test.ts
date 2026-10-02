import { describe, it, expect } from 'vitest';
import {
  initialPredictionState,
  predictionReducer,
  visiblePrediction,
  type PredictionState,
} from './state';
import type { Prediction, PromptPredictor } from './predictor';
import type { PredictionAction } from './state';

const TYPED = 'the cat sat';

function applyActions(
  state: PredictionState,
  actions: readonly PredictionAction[]
): PredictionState {
  let next = state;
  for (const action of actions) next = predictionReducer(next, action);
  return next;
}

/**
 * A predictor that answers from a script — no model, no worker, no clock. It is
 * the proof that the seam asks nothing an implementation cannot supply
 * synchronously, and the shape every test of this feature leans on.
 */
class ScriptedPredictor implements PromptPredictor {
  constructor(private readonly answers: ReadonlyMap<string, Prediction>) {}

  predict(
    text: string,
    signal: AbortSignal,
    onCompletion: (completion: string) => void
  ): Promise<Prediction> {
    if (signal.aborted) return Promise.reject(new Error('prediction aborted'));
    const answer = this.answers.get(text);
    if (answer === undefined) return Promise.reject(new Error('no scripted answer'));
    onCompletion(answer.completion);
    return Promise.resolve(answer);
  }
}

async function runOnePrediction(
  predictor: PromptPredictor,
  signal: AbortSignal
): Promise<PredictionState> {
  let state = applyActions(initialPredictionState, [
    { type: 'typed', text: TYPED },
    { type: 'debounce-settled', text: TYPED },
  ]);
  const prediction = await predictor.predict(TYPED, signal, (completion) => {
    state = predictionReducer(state, {
      type: 'completion-arrived',
      requestText: TYPED,
      completion,
    });
  });
  return predictionReducer(state, {
    type: 'alternatives-arrived',
    requestText: TYPED,
    alternatives: prediction.alternatives,
  });
}

describe('PromptPredictor', () => {
  it('drives the state machine from a synchronous implementation', async () => {
    const predictor = new ScriptedPredictor(
      new Map([[TYPED, { completion: ' on the mat ', alternatives: [] }]])
    );
    const state = await runOnePrediction(predictor, new AbortController().signal);
    expect(visiblePrediction(state)?.completion).toBe(' on the mat');
  });

  it('rejects rather than answering once its signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const predictor = new ScriptedPredictor(
      new Map([[TYPED, { completion: ' on the mat ', alternatives: [] }]])
    );
    await expect(runOnePrediction(predictor, controller.signal)).rejects.toThrow(
      'prediction aborted'
    );
  });
});
