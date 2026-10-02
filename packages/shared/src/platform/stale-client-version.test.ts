import { describe, it, expect } from 'vitest';
import { isStaleClientVersion } from './stale-client-version.ts';

describe('isStaleClientVersion', () => {
  it('is never stale when the served version is the development version', () => {
    expect(isStaleClientVersion('2026.09.01-abc', 'dev-local')).toBe(false);
  });

  it('is never stale when the served version is the test version', () => {
    expect(isStaleClientVersion('2026.09.01-abc', 'test')).toBe(false);
  });

  it('is stale when the client runs a different version than the one served', () => {
    expect(isStaleClientVersion('2026.09.01-abc', '2026.09.02-def')).toBe(true);
  });

  it('is not stale when the client runs the version served', () => {
    expect(isStaleClientVersion('2026.09.02-def', '2026.09.02-def')).toBe(false);
  });
});
