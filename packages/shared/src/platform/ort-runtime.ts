// Single source of truth for the same-origin path the onnxruntime-web runtime
// is self-hosted at. Two on-device engines load through it — the Kokoro TTS
// voice and the sentence-completion predictor — so the path is named here
// rather than by either of them.
//
// Neither model names a host either: weights, tokenizer, config and voice
// objects are served by the API's own model-weights route, addressed through
// the artifact contract in `@hushbox/shared/model-weights`. Nothing an
// on-device engine downloads is third-party, which is why the SPA CSP carries
// no model host beyond the API origin every other call already uses.

/**
 * Same-origin absolute path the onnxruntime-web `.wasm`/`.mjs` runtime assets
 * are self-hosted at. Shared so the path they are emitted to and the path each
 * runtime is pointed at cannot drift apart.
 */
export const ORT_WASM_PATH = '/ort/';
