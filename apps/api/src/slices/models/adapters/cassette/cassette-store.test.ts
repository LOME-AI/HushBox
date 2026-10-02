import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AI_RECORDING_VERSION, CASSETTE_FILE_SUFFIX } from '@hushbox/shared/cassettes';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { createCassetteStore, type Cassette } from './cassette-store.js';

let rootDir: string;

beforeEach(() => {
  rootDir = mkdtempSync(path.join(tmpdir(), 'cassette-store-'));
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

function sampleCassette(overrides: Partial<Cassette> = {}): Cassette {
  return {
    version: 1,
    exchanges: [
      {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'text/event-stream' },
        chunks: [Buffer.from('data: {}\n\n').toString('base64')],
      },
    ],
    recordedAt: isoAt(TEST_DAY_START),
    ...overrides,
  };
}

describe('createCassetteStore', () => {
  it('round-trips a cassette through write and read', () => {
    const store = createCassetteStore({ rootDir });
    const cassette = sampleCassette();

    store.write('abc123', cassette);

    expect(store.read('abc123')).toEqual(cassette);
  });

  it('round-trips the recorded request', () => {
    const store = createCassetteStore({ rootDir });
    const cassette = sampleCassette({
      request: {
        method: 'POST',
        pathAndQuery: '/v3/ai/language-model',
        headers: { 'ai-language-model-id': 'openai/gpt-4o' },
        body: '{"providerOptions":{"gateway":{"zeroDataRetention":true}}}',
      },
    });

    store.write('withreq', cassette);

    expect(store.read('withreq')?.request?.body).toContain('zeroDataRetention');
  });

  it('reads a legacy cassette that has no request field', () => {
    const store = createCassetteStore({ rootDir });
    const versionDir = path.join(rootDir, AI_RECORDING_VERSION);
    mkdirSync(versionDir, { recursive: true });
    const legacy = sampleCassette();
    writeFileSync(path.join(versionDir, 'legacy01.json'), JSON.stringify(legacy));

    expect(store.read('legacy01')).toEqual(legacy);
  });

  it('returns undefined for a missing cassette', () => {
    const store = createCassetteStore({ rootDir });

    expect(store.read('missing')).toBeUndefined();
  });

  it('returns undefined for a corrupt cassette file', () => {
    const store = createCassetteStore({ rootDir });
    const versionDir = path.join(rootDir, AI_RECORDING_VERSION);
    mkdirSync(versionDir, { recursive: true });
    writeFileSync(path.join(versionDir, 'corrupt1.json'), 'not json');

    expect(store.read('corrupt1')).toBeUndefined();
  });

  it('returns undefined for an unreadable cassette file', () => {
    const store = createCassetteStore({ rootDir });
    const versionDir = path.join(rootDir, AI_RECORDING_VERSION);
    // A directory at the cassette path makes readFileSync throw EISDIR.
    mkdirSync(path.join(versionDir, 'unreadable1.json'), { recursive: true });

    expect(store.read('unreadable1')).toBeUndefined();
  });

  it('returns undefined for a cassette that fails schema validation', () => {
    const store = createCassetteStore({ rootDir });
    const versionDir = path.join(rootDir, AI_RECORDING_VERSION);
    mkdirSync(versionDir, { recursive: true });
    writeFileSync(path.join(versionDir, 'badshape1.json'), JSON.stringify({ exchanges: 'nope' }));

    expect(store.read('badshape1')).toBeUndefined();
  });

  it('lists the hashes of every stored cassette', () => {
    const store = createCassetteStore({ rootDir });
    store.write('hash1', sampleCassette());
    store.write('hash2', sampleCassette());

    expect(store.list().toSorted((a, b) => a.localeCompare(b))).toEqual(['hash1', 'hash2']);
  });

  it('lists nothing when the version directory does not exist', () => {
    const store = createCassetteStore({ rootDir });

    expect(store.list()).toEqual([]);
  });

  it('stores cassettes under the directory the shared recording version names', () => {
    const store = createCassetteStore({ rootDir });
    store.write('dircheck', sampleCassette());

    // Asserted through the filesystem rather than through `read`, which would
    // agree with itself wherever the store put the file, and derived from the
    // shared constant rather than a literal, so a version bump stays the
    // one-line change the constant's definition promises.
    const stored = path.join(rootDir, AI_RECORDING_VERSION, `dircheck${CASSETTE_FILE_SUFFIX}`);
    expect(existsSync(stored)).toBe(true);
  });
});
