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
// Imports from `@hushbox/ui/accessibility/lib/*` are split into the
// chunker (cheap) and the TTS-engine helpers (heavy — pulls kokoro-js +
// transformers + espeak-ng on first reference). The TTS-side imports
// happen lazily inside the gated branch so callers that never enable
// chat-aloud avoid loading the audio runtime entirely (matters for both
// bundle splitting and for tests that don't mock kokoro-js).

import { createTtsStreamFeeder } from '@hushbox/ui/accessibility/lib/tts-stream-feeder';
import { useA11yStore } from '@hushbox/ui/accessibility/store';
import type { TtsStreamFeeder } from '@hushbox/ui/accessibility/lib/tts-stream-feeder';

/**
 * Build a per-stream TTS feeder if the user has opted into chat-aloud,
 * otherwise return null. Intended to be called once per chat stream, with
 * `feed(token)` invoked on every streamed token and `end()` after the
 * SSE done event (or on early termination).
 */
export async function startChatTtsStream(): Promise<TtsStreamFeeder | null> {
  const initial = useA11yStore.getState();
  if (!initial.ttsEnabled || !initial.streamChatAloud || initial.muteSounds) return null;

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
  });
}
