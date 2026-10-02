import { describe, it, expect } from 'vitest';

import { RELEASE_TAG, claimRef, claimedTag } from './release-references.js';

describe('RELEASE_TAG', () => {
  it('reads a v-prefixed three-part version as a release', () => {
    expect(RELEASE_TAG.test('v1.2.3')).toBe(true);
  });

  it('passes over a version written without its prefix', () => {
    expect(RELEASE_TAG.test('1.2.3')).toBe(false);
  });

  it('passes over a pre-release', () => {
    expect(RELEASE_TAG.test('v1.2.3-beta.1')).toBe(false);
  });

  it('passes over a name that only contains a release', () => {
    expect(RELEASE_TAG.test('claims/v1.2.3')).toBe(false);
  });
});

describe('claimRef', () => {
  it('names the claim for a version outside the tag namespace', () => {
    expect(claimRef('1.2.3')).toBe('refs/version-claims/v1.2.3');
  });

  it('refuses a version that is not three whole numbers', () => {
    expect(() => claimRef('1.2')).toThrow('1.2');
  });
});

describe('claimedTag', () => {
  it('reads the release a claim ref reserves', () => {
    expect(claimedTag('refs/version-claims/v1.2.3')).toBe('v1.2.3');
  });

  it('reads a release tag as no claim', () => {
    expect(claimedTag('refs/tags/v1.2.3')).toBeNull();
  });

  it('reads a malformed name in the claim namespace as no claim', () => {
    expect(claimedTag('refs/version-claims/v1.2')).toBeNull();
  });

  it('reads back the ref claimRef writes', () => {
    expect(claimedTag(claimRef('4.0.10'))).toBe('v4.0.10');
  });
});
