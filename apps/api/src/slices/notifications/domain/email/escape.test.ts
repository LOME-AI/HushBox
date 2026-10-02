import { describe, it, expect } from 'vitest';
import { escapeHtml } from './escape.js';

describe('escapeHtml', () => {
  it('turns an ampersand into its entity', () => {
    expect(escapeHtml('Tom & Jerry')).toBe('Tom &amp; Jerry');
  });

  it('turns a less-than sign into its entity', () => {
    expect(escapeHtml('a < b')).toBe('a &lt; b');
  });

  it('turns a greater-than sign into its entity', () => {
    expect(escapeHtml('a > b')).toBe('a &gt; b');
  });

  it('turns a double quote into its entity', () => {
    expect(escapeHtml('say "hi"')).toBe('say &quot;hi&quot;');
  });

  it('turns a single quote into its entity', () => {
    expect(escapeHtml("it's")).toBe('it&#39;s');
  });

  it('escapes an existing entity rather than passing it through', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('leaves text without those characters unchanged', () => {
    expect(escapeHtml('Hello World')).toBe('Hello World');
  });
});
