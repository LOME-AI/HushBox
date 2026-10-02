import { describe, expect, it } from 'vitest';
import { artifactContentType, artifactObjectKey, artifactParamsSchema } from './artifact.js';

/** A well-formed request; each case below replaces one field of it. */
const VALID = {
  model: 'smollm2-135m-instruct',
  version: '2026-08-31',
  file: 'model_quantized.onnx',
};

describe('artifactObjectKey', () => {
  it('addresses one object per model, version and file', () => {
    expect(artifactObjectKey('kokoro-82m', '1', 'config.json')).toBe(
      'models/kokoro-82m/1/config.json'
    );
  });
});

describe('artifactContentType', () => {
  it('serves a .json artifact as json', () => {
    expect(artifactContentType('tokenizer.json')).toBe('application/json');
  });

  it('serves every other artifact as opaque bytes', () => {
    expect(artifactContentType('model_quantized.onnx')).toBe('application/octet-stream');
  });
});

describe('artifactParamsSchema', () => {
  it('accepts a well-formed model, version and file', () => {
    expect(artifactParamsSchema.safeParse(VALID).success).toBe(true);
  });

  it('accepts a file name carrying no extension', () => {
    expect(artifactParamsSchema.safeParse({ ...VALID, file: 'LICENSE' }).success).toBe(true);
  });

  /**
   * Hono decodes a percent-escaped path parameter before a validator sees it,
   * so `..%2F` and `%2e%2e%2f` both arrive here as the traversal they encode;
   * a still-encoded value arrives carrying `%`. Both shapes are refused, which
   * is why the table below holds decoded and encoded spellings side by side.
   */
  it.each([
    ['a bare parent-directory segment', '..'],
    ['a decoded relative escape', '../secret'],
    ['a decoded absolute path', '/etc/passwd'],
    ['a decoded nested path', 'onnx/model.onnx'],
    ['a backslash escape', String.raw`..\secret`],
    ['a parent-directory hop inside a name', 'model..onnx'],
    ['a still-encoded escape', '..%2Fsecret'],
    ['a leading dot', '.hidden'],
    ['a leading dash', '-model.onnx'],
    ['a space', 'model onnx'],
    ['a null byte', 'model\u0000.onnx'],
    ['an empty segment', ''],
  ])('rejects %s as the file', (_case, file) => {
    expect(artifactParamsSchema.safeParse({ ...VALID, file }).success).toBe(false);
  });

  it('rejects a traversal in the model segment', () => {
    expect(artifactParamsSchema.safeParse({ ...VALID, model: '../secret' }).success).toBe(false);
  });

  it('rejects a traversal in the version segment', () => {
    expect(artifactParamsSchema.safeParse({ ...VALID, version: '../secret' }).success).toBe(false);
  });

  it('rejects a segment longer than the cap', () => {
    expect(artifactParamsSchema.safeParse({ ...VALID, file: 'a'.repeat(129) }).success).toBe(false);
  });
});
