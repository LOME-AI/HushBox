import { describe, it, expect, afterEach, vi } from 'vitest';
import { PROMPT_PREDICTION_STUB_STORAGE_KEY } from '@hushbox/shared';
import { shapePrediction } from './shaping';
import { promptPredictor } from './prompt-predictor.e2e';

const TYPED_TEXT = 'the quick brown fox jumps';

/** Any count: the variant answers the same fixed text whatever a surface can display. */
const ALTERNATIVES_WANTED = 3;

/** Puts the arming key in storage, the way a spec's init script does. */
function arm(): void {
  vi.spyOn(globalThis.localStorage, 'getItem').mockImplementation((key) =>
    key === PROMPT_PREDICTION_STUB_STORAGE_KEY ? '' : null
  );
}

describe('promptPredictor (end-to-end variant)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('offers nothing until a page arms it, so an unarmed spec drives the shipped composer', () => {
    expect(promptPredictor(ALTERNATIVES_WANTED)).toBeUndefined();
  });

  it('offers a predictor once the arming key is present', () => {
    arm();
    expect(promptPredictor(ALTERNATIVES_WANTED)).toBeDefined();
  });

  it('answers the same continuation whatever it is asked to continue', async () => {
    arm();
    const predictor = promptPredictor(ALTERNATIVES_WANTED);
    const first = await predictor?.predict(TYPED_TEXT, new AbortController().signal, vi.fn());
    const second = await predictor?.predict(
      'a different sentence',
      new AbortController().signal,
      vi.fn()
    );
    expect(first).toEqual(second);
  });

  it('calls onCompletion with the same completion the resolved prediction carries', async () => {
    arm();
    const onCompletion = vi.fn();
    const prediction = await promptPredictor(ALTERNATIVES_WANTED)?.predict(
      TYPED_TEXT,
      new AbortController().signal,
      onCompletion
    );
    expect(onCompletion).toHaveBeenCalledExactlyOnceWith(prediction?.completion);
  });

  it('answers text that survives output shaping into a hint plus three distinct rival candidates', async () => {
    arm();
    const raw = await promptPredictor(ALTERNATIVES_WANTED)?.predict(
      TYPED_TEXT,
      new AbortController().signal,
      vi.fn()
    );
    const shaped = raw === undefined ? null : shapePrediction(TYPED_TEXT, raw);
    expect(shaped?.completion.length).toBeGreaterThan(0);
    // The fixed stub answer's three alternatives are each distinct from the
    // completion and from one another, so all three survive shaping.
    expect(shaped?.candidates.length).toBe(3);
  });

  it('rejects an already-aborted request rather than resolving stale text', async () => {
    arm();
    const controller = new AbortController();
    controller.abort();
    await expect(
      promptPredictor(ALTERNATIVES_WANTED)?.predict(TYPED_TEXT, controller.signal, vi.fn())
    ).rejects.toThrow();
  });
});
