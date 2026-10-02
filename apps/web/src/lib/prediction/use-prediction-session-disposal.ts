import { useAppLifecycle } from '@/capacitor/hooks/use-app-lifecycle';
import { disposePredictionSession } from './prediction-session';

/**
 * Drops the shared prediction session when the app is backgrounded, so a
 * suspended app holds no model weights.
 *
 * A no-op on the web, where the underlying lifecycle listener never fires.
 * Returning to the foreground rebuilds nothing on its own: the next composer
 * engagement starts a session under the same rules as the first, which is what
 * keeps a resume off the loading path.
 */
export function usePredictionSessionDisposal(): void {
  useAppLifecycle({ onPause: disposePredictionSession });
}
