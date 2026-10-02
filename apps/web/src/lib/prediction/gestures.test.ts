import { describe, it, expect } from 'vitest';
import { gestureFor, type PredictionKeyPress } from './gestures';
import {
  initialPredictionState,
  predictionReducer,
  type PredictionAction,
  type PredictionState,
} from './state';

const TYPED = 'the cat sat';

function reduceAll(actions: readonly PredictionAction[]): PredictionState {
  let state = initialPredictionState;
  for (const action of actions) state = predictionReducer(state, action);
  return state;
}

const SHOWING = reduceAll([
  { type: 'typed', text: TYPED },
  { type: 'debounce-settled', text: TYPED },
  { type: 'completion-arrived', requestText: TYPED, completion: ' on the mat ' },
]);

function press(key: string, held: Partial<PredictionKeyPress> = {}): PredictionKeyPress {
  return { key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...held };
}

describe('gestureFor', () => {
  it('accepts on Tab while a prediction shows', () => {
    expect(gestureFor(press('Tab'), SHOWING)).toBe('accept');
  });

  it('accepts on ArrowRight while a prediction shows', () => {
    expect(gestureFor(press('ArrowRight'), SHOWING)).toBe('accept');
  });

  it('dismisses on Escape while a prediction shows', () => {
    expect(gestureFor(press('Escape'), SHOWING)).toBe('dismiss');
  });

  it('never claims Enter, so a prediction cannot change what is sent', () => {
    expect(gestureFor(press('Enter'), SHOWING)).toBe('none');
  });

  it('leaves Tab alone when no prediction shows, so focus still advances', () => {
    expect(gestureFor(press('Tab'), initialPredictionState)).toBe('none');
  });

  it('leaves ArrowRight alone when no prediction shows', () => {
    expect(gestureFor(press('ArrowRight'), initialPredictionState)).toBe('none');
  });

  it('leaves Escape alone when no prediction shows', () => {
    expect(gestureFor(press('Escape'), initialPredictionState)).toBe('none');
  });

  it('leaves Shift+Tab alone, which navigates focus backwards', () => {
    expect(gestureFor(press('Tab', { shiftKey: true }), SHOWING)).toBe('none');
  });

  it('leaves a modified ArrowRight alone, which jumps by word', () => {
    expect(gestureFor(press('ArrowRight', { ctrlKey: true }), SHOWING)).toBe('none');
    expect(gestureFor(press('ArrowRight', { altKey: true }), SHOWING)).toBe('none');
    expect(gestureFor(press('ArrowRight', { metaKey: true }), SHOWING)).toBe('none');
  });

  it('leaves every other key alone', () => {
    expect(gestureFor(press('ArrowLeft'), SHOWING)).toBe('none');
  });

  it('leaves Tab alone while an input method is composing', () => {
    const composing = predictionReducer(SHOWING, { type: 'composition-started' });
    expect(gestureFor(press('Tab'), composing)).toBe('none');
  });
});
