import { describe, it, expect } from 'vitest';
import { isDemoPath } from './is-demo-path';

describe('isDemoPath', () => {
  it('matches the exact demo path', () => {
    expect(isDemoPath('/demo')).toBe(true);
  });

  it('matches a demo subpath', () => {
    expect(isDemoPath('/demo/chat/abc')).toBe(true);
  });

  it('matches the demo path with a trailing slash', () => {
    expect(isDemoPath('/demo/')).toBe(true);
  });

  it('rejects a path that merely starts with the demo prefix', () => {
    expect(isDemoPath('/demoxyz')).toBe(false);
  });

  it('rejects an unrelated app route', () => {
    expect(isDemoPath('/chat')).toBe(false);
  });

  it('rejects the root path', () => {
    expect(isDemoPath('/')).toBe(false);
  });
});
