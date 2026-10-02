import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { initialPredictionState } from '@/lib/prediction/state';
import {
  claimSuggestionApply,
  claimSuggestionArrowUp,
} from '@/components/chat/input/composer-keys';
import type { usePromptPrediction } from '@/components/chat/input/use-prompt-prediction';

type Prediction = ReturnType<typeof usePromptPrediction>;

function createPrediction(overrides: Partial<Prediction> = {}): Prediction {
  return {
    state: initialPredictionState,
    composerHandlers: undefined,
    accept: vi.fn(() => null),
    dismiss: vi.fn(),
    activeSuggestion: null,
    handleArrowDown: vi.fn(() => false),
    handleArrowUp: vi.fn(() => false),
    applyActiveSuggestion: vi.fn(() => null),
    syncSuppression: vi.fn(() => null),
    ...overrides,
  };
}

/** Drives a claim through a real React key event, so nothing stands in for the synthetic event. */
function pressKey(
  claim: (event: React.KeyboardEvent<HTMLTextAreaElement>) => boolean,
  key: string
): boolean {
  let claimed = false;
  const { getByRole } = render(
    <textarea
      onKeyDown={(event) => {
        claimed = claim(event);
      }}
    />
  );
  fireEvent.keyDown(getByRole('textbox'), { key });
  return claimed;
}

describe('claimSuggestionArrowUp', () => {
  it('leaves ArrowUp unclaimed when the list declines to move', () => {
    const prediction = createPrediction({ handleArrowUp: vi.fn(() => false) });
    expect(pressKey((event) => claimSuggestionArrowUp(event, prediction), 'ArrowUp')).toBe(false);
  });

  it('claims ArrowUp when the list moves', () => {
    const prediction = createPrediction({ handleArrowUp: vi.fn(() => true) });
    expect(pressKey((event) => claimSuggestionArrowUp(event, prediction), 'ArrowUp')).toBe(true);
  });
});

describe('claimSuggestionApply', () => {
  it('leaves the key unclaimed when the active row yields no text to apply', () => {
    const onChange = vi.fn();
    const prediction = createPrediction({
      activeSuggestion: 0,
      applyActiveSuggestion: vi.fn(() => null),
    });
    expect(pressKey((event) => claimSuggestionApply(event, prediction, onChange), 'Tab')).toBe(
      false
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it('applies the active row and claims the key', () => {
    const onChange = vi.fn();
    const prediction = createPrediction({
      activeSuggestion: 0,
      applyActiveSuggestion: vi.fn(() => 'applied text'),
    });
    expect(pressKey((event) => claimSuggestionApply(event, prediction, onChange), 'Tab')).toBe(
      true
    );
    expect(onChange).toHaveBeenCalledWith('applied text');
  });
});
