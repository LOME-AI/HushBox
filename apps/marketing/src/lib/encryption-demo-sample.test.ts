import { describe, it, expect, vi } from 'vitest';
import { decryptTextFromEpoch, generateKeyPair } from '@hushbox/crypto';
import * as cryptoContent from '@hushbox/crypto/content';
import { DEMO_SAMPLE_TEXT, encryptDemoSample, encryptDemoSampleTo } from './encryption-demo-sample';
import type { DemoSample } from './encryption-demo-sample';

// Wraps the real key generator so a test can see which key each sample drew;
// every key and every blob is still the real one.
vi.mock('@hushbox/crypto/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/crypto/content')>();
  return { ...actual, generateKeyPair: vi.fn(actual.generateKeyPair) };
});

const DEMO_LOCATION = { conversationId: 'demo', epochNumber: 1 };

function openSample(privateKey: Uint8Array, sample: DemoSample): string {
  const blob = Uint8Array.from(sample.hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
  return decryptTextFromEpoch(privateKey, blob, DEMO_LOCATION);
}

function drawnKeys(): ReturnType<typeof cryptoContent.generateKeyPair>[] {
  return vi
    .mocked(cryptoContent.generateKeyPair)
    .mock.results.flatMap((result) => (result.type === 'return' ? [result.value] : []));
}

describe('encryptDemoSample', () => {
  it('writes two hex digits per stored byte', () => {
    const sample = encryptDemoSample(DEMO_SAMPLE_TEXT);

    expect(sample.hex).toHaveLength(sample.byteLength * 2);
  });

  it('writes only lowercase hex digits', () => {
    expect(encryptDemoSample(DEMO_SAMPLE_TEXT).hex).toMatch(/^[0-9a-f]+$/);
  });

  it('stores the default text in 90 bytes', () => {
    expect(encryptDemoSample(DEMO_SAMPLE_TEXT).byteLength).toBe(90);
  });

  it('opens the demo on "This is private."', () => {
    expect(DEMO_SAMPLE_TEXT).toBe('This is private.');
  });

  it('draws one fresh key for every sample', () => {
    vi.mocked(cryptoContent.generateKeyPair).mockClear();

    encryptDemoSample(DEMO_SAMPLE_TEXT);
    encryptDemoSample(DEMO_SAMPLE_TEXT);

    expect(cryptoContent.generateKeyPair).toHaveBeenCalledTimes(2);
  });

  it('encrypts each sample to the key drawn for it', () => {
    vi.mocked(cryptoContent.generateKeyPair).mockClear();

    const first = encryptDemoSample(DEMO_SAMPLE_TEXT);
    const second = encryptDemoSample(DEMO_SAMPLE_TEXT);

    const [firstKey, secondKey] = drawnKeys();
    expect([
      firstKey && openSample(firstKey.privateKey, first),
      secondKey && openSample(secondKey.privateKey, second),
    ]).toStrictEqual([DEMO_SAMPLE_TEXT, DEMO_SAMPLE_TEXT]);
  });

  it('stores an empty message as the envelope alone', () => {
    const empty = encryptDemoSample('');

    expect(empty.byteLength).toBeGreaterThan(0);
    expect(empty.byteLength).toBeLessThan(90);
  });
});

describe('encryptDemoSampleTo', () => {
  it('encrypts to the key it is given, as a conversation title of the demo', () => {
    const { publicKey, privateKey } = generateKeyPair();

    const sample = encryptDemoSampleTo(publicKey, DEMO_SAMPLE_TEXT);

    expect(openSample(privateKey, sample)).toBe(DEMO_SAMPLE_TEXT);
  });
});
