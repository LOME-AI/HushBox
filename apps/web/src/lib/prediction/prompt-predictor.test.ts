import { describe, it, expect, vi, beforeEach } from 'vitest';

const { predictionSessionOffered, predictWithSharedSession, subscribePredictionSessionReady } =
  vi.hoisted(() => ({
    predictionSessionOffered: vi.fn(() => true),
    predictWithSharedSession: vi.fn(() =>
      Promise.resolve({ completion: ' x y', alternatives: [] })
    ),
    subscribePredictionSessionReady: vi.fn(() => () => undefined),
  }));

vi.mock('./prediction-session', () => ({
  predictionSessionOffered,
  predictWithSharedSession,
  subscribePredictionSessionReady,
}));

import { promptPredictor } from './prompt-predictor';

const TYPED_TEXT = 'the quick brown fox';

beforeEach(() => {
  predictionSessionOffered.mockReturnValue(true);
  predictWithSharedSession.mockClear();
});

describe('promptPredictor', () => {
  it('offers a predictor while a session is still possible', () => {
    expect(promptPredictor(3)).toBeDefined();
  });

  it('offers none once no model is going to arrive, leaving the composer as it was', () => {
    predictionSessionOffered.mockReturnValue(false);
    expect(promptPredictor(3)).toBeUndefined();
  });

  it('tells the shared session how many alternatives the asking surface can show', async () => {
    await promptPredictor(3)?.predict(TYPED_TEXT, new AbortController().signal, vi.fn());
    expect(predictWithSharedSession).toHaveBeenCalledWith(
      TYPED_TEXT,
      3,
      expect.any(AbortSignal) as AbortSignal,
      expect.any(Function) as (completion: string) => void
    );
  });

  it('asks for no alternatives on a surface that cannot display them', async () => {
    await promptPredictor(0)?.predict(TYPED_TEXT, new AbortController().signal, vi.fn());
    expect(predictWithSharedSession).toHaveBeenCalledWith(
      TYPED_TEXT,
      0,
      expect.any(AbortSignal) as AbortSignal,
      expect.any(Function) as (completion: string) => void
    );
  });

  it('passes a session rejection straight through as no prediction', async () => {
    predictWithSharedSession.mockReturnValue(Promise.reject(new Error('not ready')));
    await expect(
      promptPredictor(3)?.predict(TYPED_TEXT, new AbortController().signal, vi.fn())
    ).rejects.toThrow();
  });

  it('delegates its ready notification to the shared session', () => {
    const listener = vi.fn();
    promptPredictor(3)?.onReady?.(listener);
    expect(subscribePredictionSessionReady).toHaveBeenCalledWith(listener);
  });
});
