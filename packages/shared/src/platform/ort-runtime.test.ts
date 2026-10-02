import { describe, expect, it } from 'vitest';

import { ORT_WASM_PATH } from './ort-runtime.ts';

describe('the self-hosted onnxruntime path', () => {
  it('serves the onnxruntime WASM from a same-origin absolute path', () => {
    expect(ORT_WASM_PATH).toBe('/ort/');
    expect(ORT_WASM_PATH.startsWith('/')).toBe(true);
    expect(ORT_WASM_PATH.endsWith('/')).toBe(true);
  });
});
