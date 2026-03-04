import { describe, it, expect } from 'vitest';
import { extractVersion, semverToCode } from './extract-version.js';

describe('semverToCode', () => {
  it('converts 1.0.0 to 10000', () => {
    expect(semverToCode('1.0.0')).toBe(10_000);
  });

  it('converts 1.2.3 to 10203', () => {
    expect(semverToCode('1.2.3')).toBe(10_203);
  });

  it('converts 2.15.1 to 21501', () => {
    expect(semverToCode('2.15.1')).toBe(21_501);
  });

  it('converts 0.1.0 to 100', () => {
    expect(semverToCode('0.1.0')).toBe(100);
  });

  it('converts 10.0.0 to 100000', () => {
    expect(semverToCode('10.0.0')).toBe(100_000);
  });

  it('throws on invalid semver', () => {
    expect(() => semverToCode('not-a-version')).toThrow();
  });

  it('throws on incomplete semver (missing patch)', () => {
    expect(() => semverToCode('1.2')).toThrow();
  });

  it('throws on empty string', () => {
    expect(() => semverToCode('')).toThrow();
  });

  it('accepts pre-release suffix and ignores it for code', () => {
    expect(semverToCode('1.0.0-beta.1')).toBe(10_000);
  });

  it('accepts alpha pre-release suffix', () => {
    expect(semverToCode('2.3.1-alpha.5')).toBe(20_301);
  });

  it('accepts rc pre-release suffix', () => {
    expect(semverToCode('1.2.3-rc.1')).toBe(10_203);
  });
});

describe('extractVersion', () => {
  it('strips v prefix from INPUT_VERSION if present', () => {
    const result = extractVersion({ INPUT_VERSION: 'v1.5.0' });

    expect(result.versionName).toBe('1.5.0');
    expect(result.versionCode).toBe(10_500);
  });

  it('parses INPUT_VERSION without v prefix', () => {
    const result = extractVersion({ INPUT_VERSION: '1.5.0' });

    expect(result.versionName).toBe('1.5.0');
    expect(result.versionCode).toBe(10_500);
  });

  it('returns version as alias for versionName', () => {
    const result = extractVersion({ INPUT_VERSION: '2.1.0' });

    expect(result.version).toBe(result.versionName);
  });

  it('throws on invalid semver input', () => {
    expect(() => extractVersion({ INPUT_VERSION: 'bad' })).toThrow();
  });

  it('throws when INPUT_VERSION is missing', () => {
    expect(() => extractVersion({})).toThrow('INPUT_VERSION is required');
  });

  it('handles pre-release INPUT_VERSION', () => {
    const result = extractVersion({ INPUT_VERSION: '1.0.0-beta.1' });

    expect(result.versionName).toBe('1.0.0-beta.1');
    expect(result.versionCode).toBe(10_000);
    expect(result.version).toBe('1.0.0-beta.1');
  });

  it('strips v prefix from pre-release INPUT_VERSION', () => {
    const result = extractVersion({ INPUT_VERSION: 'v1.0.0-beta.1' });

    expect(result.versionName).toBe('1.0.0-beta.1');
    expect(result.versionCode).toBe(10_000);
  });
});
