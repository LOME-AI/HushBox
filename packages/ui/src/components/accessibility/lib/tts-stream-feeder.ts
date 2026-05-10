// Streaming TTS feeder. Adapts the SentenceChunker to a streamed
// AI chat response: caller pumps tokens via feed(); the feeder emits
// completed sentences to the TTS service. When the stream ends,
// end() flushes the chunker and speaks any trailing buffered text.
//
// Decoupled from React/Zustand so it can be unit-tested in isolation.
// Wire-up uses callbacks (`isEnabled`, `voice`) so the caller can pull
// reactive state from any source (Zustand store, React state, etc.).

import { SentenceChunker } from './sentence-chunker';
import type { TtsService, TtsVoice } from './tts-engine';

export interface TtsStreamFeeder {
  /** Feed a streamed token chunk. Speaks any newly-completed sentences. */
  feed(chunk: string): void;
  /** End-of-stream. Flushes the chunker and speaks any trailing remainder. */
  end(): void;
}

export interface CreateTtsStreamFeederOptions {
  readonly tts: TtsService;
  /** Voice id, or a callback that returns the current voice (for live updates). */
  readonly voice: TtsVoice | (() => TtsVoice);
  /**
   * Callback returning whether the feeder should be active. Called on every
   * sentence boundary so the user can flip the toggle mid-stream.
   */
  readonly isEnabled: () => boolean;
}

function speakSentence(
  tts: TtsService,
  sentence: string,
  voice: TtsVoice | (() => TtsVoice)
): void {
  const resolvedVoice = typeof voice === 'function' ? voice() : voice;
  // Speak failures must not break the chat stream — surface to console only.
  void (async (): Promise<void> => {
    try {
      await tts.speak(sentence, resolvedVoice);
    } catch (error: unknown) {
      console.error('TTS speak failed:', error);
    }
  })();
}

/**
 * Create a feeder that bridges streamed AI tokens to the TTS service.
 * Caller is responsible for invoking feed() and end() at the right moments.
 */
export function createTtsStreamFeeder(options: CreateTtsStreamFeederOptions): TtsStreamFeeder {
  const { tts, voice, isEnabled } = options;
  const chunker = new SentenceChunker();

  return {
    feed(chunk: string): void {
      // Always feed so the chunker stays in sync, but only speak when active.
      const sentences = chunker.feed(chunk);
      if (!isEnabled() || !tts.isLoaded()) return;
      for (const sentence of sentences) {
        speakSentence(tts, sentence, voice);
      }
    },
    end(): void {
      const remainder = chunker.flush();
      if (remainder === null) return;
      if (!isEnabled() || !tts.isLoaded()) return;
      speakSentence(tts, remainder, voice);
    },
  };
}
