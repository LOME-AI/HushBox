import fs from 'node:fs/promises';

import { vi } from 'vitest';

import { KokoroTTS } from 'kokoro-js';

// Shared scaffolding for kokoro-js's vendored-patch regression tests
// (`kokoro-voice-base.test.ts`, `kokoro-voice-validation.test.ts`). Lives outside a
// `*.test.ts` file so importing it never re-registers another file's `describe`/`it`
// blocks.
export const VOICE_BASE_GLOBAL = '__HUSHBOX_TTS_VOICE_BASE__';
export const UNSET_ERROR_TOKEN = 'HUSHBOX_TTS_VOICE_BASE_UNSET';

// Voice bytes land in a `Float32Array`, so the body length must be a multiple of
// 4, and kokoro slices 256 floats out of it for the style vector.
const VOICE_BYTES = 1024;

// kokoro reads only `status`, `arrayBuffer()` and `headers` off the fetch
// result. A hand-rolled stand-in keeps the assertion on the requested URL and
// status rather than on the DOM emulator's `Response` body handling.
export function voiceResponse(status = 200): Response {
  return {
    status,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(VOICE_BYTES)),
    headers: new Headers(),
  } as unknown as Response;
}

interface VoiceCacheStub {
  readonly matchMock: () => Promise<Response | undefined>;
  readonly putMock: (url: unknown, response: unknown) => Promise<void>;
  readonly deleteMock: (url: unknown) => Promise<boolean>;
}

// kokoro consults a `caches` entry before fetching and warns on the console when
// the API is missing, as it is under the DOM emulator. With no `cached` argument
// this always misses, so a test that only cares about the fetch path observes a
// real request; passing one exercises the cache-hit branch, including eviction
// of an entry that fails validation.
export function stubVoiceCache(cached?: Response): VoiceCacheStub {
  const matchMock = vi.fn(() => Promise.resolve(cached));
  const putMock = vi.fn(() => Promise.resolve());
  const deleteMock = vi.fn(() => Promise.resolve(true));
  vi.stubGlobal('caches', {
    open: () => Promise.resolve({ match: matchMock, put: putMock, delete: deleteMock }),
  });
  return { matchMock, putMock, deleteMock };
}

// Drives exactly one voice load through the patched URL branch and returns the
// promise it produced, without awaiting it.
//
// kokoro-js picks its branch on `fs/promises` exposing `readFile` — true in
// Node, false in a browser, where the package's own `browser` field maps the
// module away. Removing the property is how a Node test reaches the browser
// branch, the only branch the patch touches. Nothing else can observe the
// removal: the patched branch either throws or builds the URL synchronously, so
// by the time this call returns, the branch has already been taken.
export function startVoiceLoad(voice: string): Promise<unknown> {
  const model = (): Promise<{ waveform: { data: Float32Array } }> =>
    Promise.resolve({ waveform: { data: new Float32Array(8) } });
  const tts = new KokoroTTS(
    model as unknown as ConstructorParameters<typeof KokoroTTS>[0],
    {} as unknown as ConstructorParameters<typeof KokoroTTS>[1]
  );
  // Two token ids: kokoro offsets into the voice data by 256 floats per token
  // past the first two, so this reads the style vector at offset zero and the
  // stub voice body above needs no more than those 256 floats.
  const inputIds = { dims: [1, 2] } as unknown as Parameters<KokoroTTS['generate_from_ids']>[0];

  const fsPromises = fs as unknown as Record<string, unknown>;
  const readFile = fsPromises['readFile'];
  delete fsPromises['readFile'];
  try {
    return tts.generate_from_ids(inputIds, { voice: voice as 'af_heart' });
  } finally {
    fsPromises['readFile'] = readFile;
  }
}
