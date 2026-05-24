import { describe, expect, it } from 'vitest';
import { buildStorageInitScript } from './storage-state-init-script.js';

describe('buildStorageInitScript', () => {
  it('returns null when origins is missing entirely', () => {
    expect(buildStorageInitScript({ cookies: [] })).toBeNull();
  });

  it('returns null when origins is empty', () => {
    expect(buildStorageInitScript({ cookies: [], origins: [] })).toBeNull();
  });

  it('returns null when every origin has empty localStorage', () => {
    expect(
      buildStorageInitScript({
        cookies: [],
        origins: [{ origin: 'http://localhost:4301', localStorage: [] }],
      })
    ).toBeNull();
  });

  it('emits one setItem call guarded by origin check and getItem === null', () => {
    const script = buildStorageInitScript({
      cookies: [],
      origins: [
        {
          origin: 'http://localhost:4301',
          localStorage: [{ name: 'k', value: 'v' }],
        },
      ],
    });
    expect(script).toBe(
      `if (location.origin === "http://localhost:4301" && window.localStorage.getItem("k") === null) window.localStorage.setItem("k", "v");`
    );
  });

  it('guards every setItem with a getItem === null check so reloads do not clobber test mutations', () => {
    const script = buildStorageInitScript({
      cookies: [],
      origins: [
        {
          origin: 'http://localhost:4301',
          localStorage: [
            { name: 'a', value: '1' },
            { name: 'b', value: '2' },
          ],
        },
      ],
    });
    const guards = script?.match(/getItem\(/g) ?? [];
    const setters = script?.match(/setItem\(/g) ?? [];
    expect(guards).toHaveLength(setters.length);
  });

  it('emits one line per localStorage entry per origin', () => {
    const script = buildStorageInitScript({
      cookies: [],
      origins: [
        {
          origin: 'http://localhost:4301',
          localStorage: [
            { name: 'a', value: '1' },
            { name: 'b', value: '2' },
          ],
        },
        {
          origin: 'http://other:5000',
          localStorage: [{ name: 'c', value: '3' }],
        },
      ],
    });
    expect(script?.split('\n')).toHaveLength(3);
    expect(script).toContain('"http://localhost:4301"');
    expect(script).toContain('"http://other:5000"');
  });

  it('escapes values containing quotes so injected JS cannot break out of its string literal', () => {
    const evilValue = '"); alert(1); //';
    const script = buildStorageInitScript({
      cookies: [],
      origins: [
        {
          origin: 'http://localhost:4301',
          localStorage: [{ name: 'evil', value: evilValue }],
        },
      ],
    });
    // The emitted token must be the JSON-stringified form so the embedded
    // quote becomes `\"`. Without JSON.stringify, `value` would be
    // interpolated raw and the `");` prefix would terminate the setItem
    // call, letting the `alert(1)` payload execute.
    expect(script).toContain(JSON.stringify(evilValue));
  });

  it('escapes backslashes in values', () => {
    const script = buildStorageInitScript({
      cookies: [],
      origins: [
        {
          origin: 'http://localhost:4301',
          localStorage: [{ name: 'k', value: String.raw`a\b` }],
        },
      ],
    });
    expect(script).toContain(JSON.stringify(String.raw`a\b`));
  });

  it('escapes the origin string (defense-in-depth, even though origins are URLs)', () => {
    const script = buildStorageInitScript({
      cookies: [],
      origins: [
        {
          origin: 'http://"escaped":4301',
          localStorage: [{ name: 'k', value: 'v' }],
        },
      ],
    });
    expect(script).toContain(JSON.stringify('http://"escaped":4301'));
  });
});
