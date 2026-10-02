import { describe, expect, it } from 'vitest';

import {
  AI_RECORDING_VERSION,
  CASSETTE_DIRECTORY,
  CASSETTE_FILE_SUFFIX,
  CASSETTE_OBJECT_PREFIX,
} from './cassettes.ts';

describe('cassette layout constants', () => {
  it('carries its own separator on the object prefix', () => {
    expect(CASSETTE_OBJECT_PREFIX.endsWith('/')).toBe(true);
  });

  it('names the recording version as one path segment', () => {
    expect(AI_RECORDING_VERSION).toMatch(/^[^/\\]+$/);
  });

  it('names the local directory without a path separator', () => {
    expect(CASSETTE_DIRECTORY).toMatch(/^[^/\\]+$/);
  });

  it('carries its own dot on the file suffix', () => {
    expect(CASSETTE_FILE_SUFFIX).toMatch(/^\.[^./\\]+$/);
  });
});
