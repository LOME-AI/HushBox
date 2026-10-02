import {
  createAssistantStream,
  reduceAssistantStream,
  serializeAssistantStream,
  settleAssistantStream,
} from '@hushbox/shared';
import type { AssistantStreamState, WireInferenceEvent } from '@hushbox/shared';

/**
 * One streaming message's content, built from its inference events through the
 * shared reducer the server persists through, so the owner's tile, a watcher's
 * phantom and the stored message carry the same text.
 */
export interface StreamContentBuilder {
  feed(event: WireInferenceEvent): void;
  /** The stream ended: held-back text is decided and running searches are interrupted. */
  settle(): void;
  /** Back to an empty stream, for a clean re-execution whose content starts over. */
  reset(): void;
  /**
   * The content, when an event changed it since the last take; otherwise
   * `undefined`. Serializing re-encodes every search row, so callers take once
   * per rendered frame, never once per event.
   */
  take(): string | undefined;
}

export function createStreamContentBuilder(): StreamContentBuilder {
  let state: AssistantStreamState = createAssistantStream();
  let pending = false;
  let taken = '';
  const apply = (next: AssistantStreamState): void => {
    if (next === state) return;
    state = next;
    pending = true;
  };
  return {
    feed(event) {
      apply(reduceAssistantStream(state, event));
    },
    settle() {
      apply(settleAssistantStream(state));
    },
    reset() {
      state = createAssistantStream();
      pending = false;
      taken = '';
    },
    take() {
      if (!pending) return;
      pending = false;
      const { text } = serializeAssistantStream(state);
      if (text === taken) return;
      taken = text;
      return text;
    },
  };
}
