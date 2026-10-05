import { describe, expect, it } from 'vitest';
import { encodedForms } from './forms.js';

/** Whether any form of `value` occurs in `haystack`. */
function found(value: string, haystack: string): string | undefined {
  return encodedForms(value).find(({ text }) => haystack.includes(text))?.form;
}

const VALUE = 'fixture-credential-value-0123456789';

describe('encodedForms', () => {
  it('finds the value written literally', () => {
    expect(found(VALUE, `const a="${VALUE}";`)).toBe('literal');
  });

  it.each([0, 1, 2])(
    'finds the value base64-encoded behind %i bytes of other content',
    (offset) => {
      const blob = Buffer.concat([
        Buffer.from('ab'.slice(0, offset)),
        Buffer.from(VALUE),
        Buffer.from('trailing bytes'),
      ]).toString('base64');

      expect(found(VALUE, `data:application/octet-stream;base64,${blob}`)).toBe('base64');
    }
  );

  it('finds the value in URL-safe base64', () => {
    const value = '>>>?>>>?>>>?>>>?>>>?';
    const blob = Buffer.from(value).toString('base64url');

    expect(blob).toMatch(/[-_]/u);
    expect(found(value, blob)).toBe('base64url');
  });

  it('finds a value carrying a newline in its JSON-escaped spelling', () => {
    const value = 'line-one-of-a-key\nline-two-of-a-key';
    const source = `{"key":${JSON.stringify(value)}}`;

    expect(found(value, source)).toBe('json-escaped');
  });

  it('gives no JSON-escaped form when escaping changes nothing', () => {
    expect(encodedForms(VALUE).map(({ form }) => form)).not.toContain('json-escaped');
  });

  it('finds nothing in content that does not carry the value', () => {
    expect(found(VALUE, 'an unrelated chunk of minified code')).toBeUndefined();
  });
});
