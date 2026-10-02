import { describe, it, expect } from 'vitest';
import { scriptSafeJson } from './script-safe-json.ts';

describe('scriptSafeJson', () => {
  it('serializes a value as JSON', () => {
    expect(JSON.parse(scriptSafeJson({ a: 1, b: ['two'] }))).toEqual({ a: 1, b: ['two'] });
  });

  it('emits no closing script tag when a string carries one', () => {
    expect(scriptSafeJson({ headline: 'a </script> tag' })).not.toContain('</script>');
  });

  it('escapes every `<`, not only the one starting a closing tag', () => {
    expect(scriptSafeJson('<a><b>')).not.toContain('<');
  });

  it('parses back to the literal text it was given', () => {
    const value = 'a </script><img src=x> tag';
    expect(JSON.parse(scriptSafeJson(value))).toBe(value);
  });
});
