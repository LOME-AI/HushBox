// Chat-aloud streaming TTS bridge.
//
// Reads `useA11yStore` to decide whether to instantiate a TTS feeder for
// this stream. The feeder is bound to live store reads so toggling
// streamChatAloud / muteSounds / ttsVoice mid-stream behaves as the user
// expects: silence the stream immediately, switch voices on the next
// sentence boundary, etc.
//
// Returns null when TTS or chat-aloud is off so callers can no-op cheaply.
//
// Per-stream lifecycle is wired through `useTtsPlaybackStore` so the chat
// UI can render a Stop button next to the currently-speaking message and
// suppress further sentences for any stream the user explicitly stopped.
//
// Imports from `@hushbox/ui/accessibility/lib/*` are split into the
// chunker (cheap) and the TTS-engine helpers (heavy — pulls kokoro-js +
// transformers + espeak-ng on first reference). The TTS-side imports
// happen lazily inside the gated branch so callers that never enable
// chat-aloud avoid loading the audio runtime entirely (matters for both
// bundle splitting and for tests that don't mock kokoro-js).

import { createTtsStreamFeeder } from '@hushbox/ui/accessibility/lib/tts-stream-feeder';
import { useA11yStore, useTtsPlaybackStore } from '@hushbox/ui/accessibility/store';
import type { TtsStreamFeeder } from '@hushbox/ui/accessibility/lib/tts-stream-feeder';

export interface StartChatTtsStreamOptions {
  /**
   * Returns the assistant message id for the current stream, or null if
   * it is not yet known. Resolved on each callback invocation, so the
   * caller can populate it lazily once the SSE `start` event arrives
   * (which carries the id) without racing the dynamic import.
   */
  readonly messageId: () => string | null;
}

/**
 * Build a per-stream TTS feeder if the user has opted into chat-aloud,
 * otherwise return null. Intended to be called once per chat stream, with
 * `feed(token)` invoked on every streamed token and `end()` after the
 * SSE done event (or on early termination).
 */
export async function startChatTtsStream(
  options: StartChatTtsStreamOptions
): Promise<TtsStreamFeeder | null> {
  const initial = useA11yStore.getState();
  if (!initial.ttsEnabled || !initial.streamChatAloud || initial.muteSounds) return null;

  const getMessageId = options.messageId;
  // The id arrives later (via the SSE start event) and is read through
  // the getter; this wrapper resolves it lazily and no-ops while it's null.
  const withId =
    (action: (id: string) => void): (() => void) =>
    () => {
      const id = getMessageId();
      if (id !== null) action(id);
    };

  // Lazy import so the kokoro-js bundle is only fetched when the user
  // actually opts in (97MB cost referenced in TECH-STACK.md).
  const { getTtsService } = await import('@hushbox/ui/accessibility/lib/tts-engine');

  return createTtsStreamFeeder({
    tts: getTtsService(),
    voice: () => useA11yStore.getState().ttsVoice,
    isEnabled: () => {
      const state = useA11yStore.getState();
      return state.ttsEnabled && state.streamChatAloud && !state.muteSounds;
    },
    isStreamMuted: () => {
      const id = getMessageId();
      return id !== null && useTtsPlaybackStore.getState().stoppedStreamIds.has(id);
    },
    onStreamStart: withId((id) => useTtsPlaybackStore.getState().setSpeakingStream(id)),
    onStreamEnd: withId((id) => useTtsPlaybackStore.getState().clearSpeakingStreamIfMatches(id)),
  });
}

/**
 * Stop the currently-playing TTS audio for a single message. The global
 * auto-read setting is unaffected; subsequent assistant messages still
 * read aloud. The muted state persists in `useTtsPlaybackStore` so any
 * sentences still arriving from the model are silently dropped by the
 * feeder via its `isStreamMuted` gate.
 */
export function stopTtsForMessage(messageId: string): void {
  // Mark synchronously so the Stop button hides and the inline notice
  // appears in the same React commit as the user's click.
  useTtsPlaybackStore.getState().markStreamStopped(messageId);
  // Engine stop is fire-and-forget. Worst case one pre-queued sentence
  // finishes playing before the queue is cleared; any sentences still
  // arriving from the model after this point are suppressed by the
  // feeder's isStreamMuted gate.
  void (async (): Promise<void> => {
    const { getTtsService } = await import('@hushbox/ui/accessibility/lib/tts-engine');
    getTtsService().stop();
  })();
}
