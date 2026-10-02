// Pre-spawn the TTS worker + warm up the model on app boot for users who have
// already opted in. Hides ~5–30 s of cold-cache cost from the user's first
// speak() — by the time they send a chat, the worker is alive, ORT/transformers
// are initialised, and the first sentence inference starts immediately.
//
// Gated on `ttsEnabled` so first-time-visitor bandwidth isn't burned on a
// feature they may never use; the AudioSection toggle handles that on opt-in.
// Errors are swallowed: a model-fetch failure must not crash app boot.

import { useA11yStore } from '@hushbox/ui/accessibility/store';

export async function prewarmTtsIfEnabled(): Promise<void> {
  const state = useA11yStore.getState();
  if (!state.ttsEnabled) return;
  const voice = state.ttsVoice;
  try {
    const { getTtsService } = await import('@hushbox/ui/accessibility/lib/tts-engine');
    await getTtsService().load(voice);
  } catch (error: unknown) {
    console.error('TTS prewarm failed (app boot continues):', error);
  }
}
