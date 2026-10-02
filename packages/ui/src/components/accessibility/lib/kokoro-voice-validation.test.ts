import { describe, it, expect, vi } from 'vitest';

import {
  VOICE_BASE_GLOBAL,
  voiceResponse,
  stubVoiceCache,
  startVoiceLoad,
} from './kokoro-voice-test-support';

// The vendored patch (`patches/kokoro-js@1.2.1.patch`) is the regression guard for a
// real incident: the unpatched loader cached a non-200 body (a 404 or a rate-limit
// response) as a "voice" with no status check, and nothing ever revalidated the entry
// afterward. These tests pin the fix: a non-200 response is refused (naming the
// status) and never persisted, and a cached entry that is not a full style table is
// evicted and refetched rather than served.

// A full kokoro style table is one 256-float vector per token-length bucket, 0..509
// inclusive, at 4 bytes per float32.
const FULL_STYLE_TABLE_BYTES = 4 * 256 * (509 + 1);

function poisonedCacheEntry(): Response {
  // A JSON error body ("{"code":"NOT_FOUND"}") is nowhere near a full style table.
  return {
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(20)),
  } as unknown as Response;
}

describe('kokoro voice loader validation', () => {
  it('refuses a non-200 response with an error naming the status', async () => {
    vi.stubGlobal(VOICE_BASE_GLOBAL, 'https://assets.test/kokoro/1/voices/');
    stubVoiceCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(voiceResponse(404)))
    );

    await expect(startVoiceLoad('af_heart')).rejects.toThrow('404');
  });

  it('does not persist a refused response', async () => {
    vi.stubGlobal(VOICE_BASE_GLOBAL, 'https://assets.test/kokoro/1/voices/');
    const { putMock } = stubVoiceCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(voiceResponse(429)))
    );

    await expect(startVoiceLoad('af_heart')).rejects.toThrow();

    expect(putMock).not.toHaveBeenCalled();
  });

  it('evicts and refetches a cached entry that is not a full style table', async () => {
    vi.stubGlobal(VOICE_BASE_GLOBAL, 'https://assets.test/kokoro/1/voices/');
    const { deleteMock } = stubVoiceCache(poisonedCacheEntry());
    const fetchMock = vi.fn(() => Promise.resolve(voiceResponse()));
    vi.stubGlobal('fetch', fetchMock);

    await startVoiceLoad('af_heart');

    expect(deleteMock).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith('https://assets.test/kokoro/1/voices/af_heart.bin');
  });

  it('serves a cached entry whose byte length is the full style table', async () => {
    vi.stubGlobal(VOICE_BASE_GLOBAL, 'https://assets.test/kokoro/1/voices/');
    const cachedEntry = {
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(FULL_STYLE_TABLE_BYTES)),
    } as unknown as Response;
    stubVoiceCache(cachedEntry);
    const fetchMock = vi.fn(() => Promise.resolve(voiceResponse()));
    vi.stubGlobal('fetch', fetchMock);

    await startVoiceLoad('af_heart');

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
