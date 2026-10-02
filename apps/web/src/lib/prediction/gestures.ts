import { visiblePrediction, type PredictionState } from './state';

/**
 * Which key presses the prediction claims, and — just as load-bearing — which
 * it refuses.
 *
 * A prediction is a hint, never a mode: every key keeps its ordinary meaning
 * whenever nothing is on screen. Tab in particular must still move focus, or
 * the composer becomes a keyboard trap; Enter is never claimed at all, so what
 * the user sends is always exactly what they typed.
 */

/** What the composer should do with a key press. `'none'` means "do not intervene". */
type PredictionGesture = 'accept' | 'dismiss' | 'none';

/** The parts of a key press the decision reads. */
export interface PredictionKeyPress {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

function isModified(keyPress: PredictionKeyPress): boolean {
  return keyPress.altKey || keyPress.ctrlKey || keyPress.metaKey || keyPress.shiftKey;
}

export function gestureFor(
  keyPress: PredictionKeyPress,
  state: PredictionState
): PredictionGesture {
  // Visibility already carries the composition and suppression gates, so a
  // caret mid-value or an input method mid-conversion claims nothing.
  if (visiblePrediction(state) === null) return 'none';
  if (isModified(keyPress)) return 'none';
  if (keyPress.key === 'Tab' || keyPress.key === 'ArrowRight') return 'accept';
  if (keyPress.key === 'Escape') return 'dismiss';
  return 'none';
}
