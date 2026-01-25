import { describe, it, expect } from 'vitest';
import { parseContextLengthError } from './context-error.js';

describe('parseContextLengthError', () => {
  describe('text-only input', () => {
    it('parses standard context length error', () => {
      const message =
        'This endpoint\'s maximum context length is 204800 tokens. However, you requested about 4262473 tokens (65 of text input, 4262408 in the output). Please reduce the length of either one, or use the "middle-out" transform to compress your prompt automatically.';

      const result = parseContextLengthError(message);

      expect(result).toEqual({
        maxContext: 204_800,
        textInput: 65,
        requestedOutput: 4_262_408,
      });
    });

    it('parses error with different numbers', () => {
      const message =
        "This endpoint's maximum context length is 128000 tokens. However, you requested about 150000 tokens (10000 of text input, 140000 in the output).";

      const result = parseContextLengthError(message);

      expect(result).toEqual({
        maxContext: 128_000,
        textInput: 10_000,
        requestedOutput: 140_000,
      });
    });
  });

  describe('text + image input', () => {
    it('parses error with image tokens', () => {
      const message =
        'This endpoint\'s maximum context length is 200000 tokens. However, you requested about 239846 tokens (223654 of text input, 8000 of image input, 8192 in the output). Please reduce the length of either one, or use the "middle-out" transform to compress your prompt automatically.';

      const result = parseContextLengthError(message);

      // We extract text input and output, image input is ignored (included in total)
      expect(result).toEqual({
        maxContext: 200_000,
        textInput: 223_654,
        requestedOutput: 8192,
      });
    });
  });

  describe('text + tool input', () => {
    it('parses error with tool tokens', () => {
      const message =
        'This endpoint\'s maximum context length is 200000 tokens. However, you requested about 5028244 tokens (4945291 of text input, 2953 of tool input, 80000 in the output). Please reduce the length of either one, or use the "middle-out" transform to compress your prompt automatically.';

      const result = parseContextLengthError(message);

      expect(result).toEqual({
        maxContext: 200_000,
        textInput: 4_945_291,
        requestedOutput: 80_000,
      });
    });
  });

  describe('non-matching messages', () => {
    it('returns null for unrelated error message', () => {
      const message = 'Rate limit exceeded. Please try again later.';

      const result = parseContextLengthError(message);

      expect(result).toBeNull();
    });

    it('returns null for empty string', () => {
      const result = parseContextLengthError('');

      expect(result).toBeNull();
    });

    it('returns null for partial match (missing output)', () => {
      const message =
        "This endpoint's maximum context length is 204800 tokens. However, you requested about 4262473 tokens (65 of text input).";

      const result = parseContextLengthError(message);

      expect(result).toBeNull();
    });

    it('returns null for different error format', () => {
      const message = 'Context length exceeded: 204800 max, 300000 requested';

      const result = parseContextLengthError(message);

      expect(result).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('handles multiline error message', () => {
      const message = `This endpoint's maximum context length is 204800 tokens.
However, you requested about 4262473 tokens (65 of text input, 4262408 in the output).
Please reduce the length of either one.`;

      const result = parseContextLengthError(message);

      expect(result).toEqual({
        maxContext: 204_800,
        textInput: 65,
        requestedOutput: 4_262_408,
      });
    });

    it('handles message wrapped in OpenRouter error prefix', () => {
      const message =
        "OpenRouter error: This endpoint's maximum context length is 204800 tokens. However, you requested about 4262473 tokens (65 of text input, 4262408 in the output).";

      const result = parseContextLengthError(message);

      expect(result).toEqual({
        maxContext: 204_800,
        textInput: 65,
        requestedOutput: 4_262_408,
      });
    });
  });
});
