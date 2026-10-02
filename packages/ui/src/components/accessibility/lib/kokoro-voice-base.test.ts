import { describe, it, expect, vi } from 'vitest';

import {
  VOICE_BASE_GLOBAL,
  UNSET_ERROR_TOKEN,
  voiceResponse,
  stubVoiceCache,
  startVoiceLoad,
} from './kokoro-voice-test-support';

// kokoro-js hardcodes the Hugging Face URL of every voice `.bin` in its compiled
// dist and honours no host setting, so the vendored patch
// (`patches/kokoro-js@1.2.1.patch`) rewrites that URL to resolve its base from a
// global the host sets before any voice load. A patched third-party build
// artifact can export nothing, so the global's name and the error it throws when
// unset are restated here; this file is what pins them, and what fails if the
// patch ever stops being applied.

describe('kokoro voice base URL', () => {
  it('throws the documented error when the base global is unset', async () => {
    Reflect.deleteProperty(globalThis, VOICE_BASE_GLOBAL);
    stubVoiceCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('no voice request may be made')))
    );

    await expect(startVoiceLoad('af_heart')).rejects.toThrow(UNSET_ERROR_TOKEN);
  });

  it('requests the voice from the base URL the global names', async () => {
    vi.stubGlobal(VOICE_BASE_GLOBAL, 'https://assets.test/kokoro/1/voices/');
    stubVoiceCache();
    const fetchMock = vi.fn(() => Promise.resolve(voiceResponse()));
    vi.stubGlobal('fetch', fetchMock);

    await startVoiceLoad('af_bella');

    expect(fetchMock).toHaveBeenCalledWith('https://assets.test/kokoro/1/voices/af_bella.bin');
  });

  it('joins a base URL that carries no trailing slash', async () => {
    vi.stubGlobal(VOICE_BASE_GLOBAL, 'https://assets.test/kokoro/1/voices');
    stubVoiceCache();
    const fetchMock = vi.fn(() => Promise.resolve(voiceResponse()));
    vi.stubGlobal('fetch', fetchMock);

    await startVoiceLoad('af_nicole');

    expect(fetchMock).toHaveBeenCalledWith('https://assets.test/kokoro/1/voices/af_nicole.bin');
  });
});
