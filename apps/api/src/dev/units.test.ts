import { describe, expect, it } from 'vitest';
import { err, ok } from '../lib/result/index.js';
import {
  MOCK_VIDEO_BYTES,
  MOCK_VIDEO_DURATION_MS,
  MOCK_VIDEO_HEIGHT,
  MOCK_VIDEO_MIME_TYPE,
  MOCK_VIDEO_WIDTH,
} from '../slices/models/adapters/mock-video-clip.js';
import { DEV_MEDIA_FIXTURES } from './media-fixtures.js';
import {
  DevSeedError,
  DevSeedStorageUnavailableError,
  requireSeed,
  unwrapSeed,
  unwrapStoragePut,
} from './factories.js';
import { formatCredits } from './personas.js';
import { firstCount, nanoUsdToDecimalString } from './reads.js';

describe('unwrapSeed', () => {
  it('returns the ok value', () => {
    expect(unwrapSeed(ok(41), 'step')).toBe(41);
  });

  it('throws DevSeedError naming the failed step', () => {
    expect(() => unwrapSeed(err('boom'), 'epoch insert')).toThrow(DevSeedError);
    expect(() => unwrapSeed(err('boom'), 'epoch insert')).toThrow(/epoch insert/);
  });
});

describe('unwrapStoragePut', () => {
  it('returns the ok value', () => {
    expect(unwrapStoragePut(ok(7), 'media upload')).toBe(7);
  });

  it.each(['unavailable', 'timeout'] as const)(
    'throws DevSeedStorageUnavailableError on a %s put failure',
    (code) => {
      const run = (): unknown => unwrapStoragePut(err({ code, message: 'x' }), 'media upload');
      expect(run).toThrow(DevSeedStorageUnavailableError);
      expect(run).toThrow(/media upload/);
    }
  );

  it('throws an ordinary DevSeedError on a non-availability put failure', () => {
    const run = (): unknown =>
      unwrapStoragePut(err({ code: 'validation', message: 'x' }), 'media upload');
    expect(run).toThrow(DevSeedError);
    expect(run).not.toThrow(DevSeedStorageUnavailableError);
  });
});

describe('requireSeed', () => {
  it('returns a present value', () => {
    expect(requireSeed('x', 'step')).toBe('x');
  });

  it.each([null, undefined])('throws DevSeedError on %s', (value) => {
    expect(() => requireSeed(value, 'sequence number')).toThrow(DevSeedError);
  });
});

describe('formatCredits', () => {
  it('sums the wallets and rounds to cents', () => {
    expect(formatCredits(5_000_000_000n, 0n)).toBe('$5.00');
    expect(formatCredits(1_234_000_000n, 1_000_000_000n)).toBe('$2.23');
    expect(formatCredits(5_000_000n, 0n)).toBe('$0.01');
  });

  it('renders a negative balance with a leading sign', () => {
    expect(formatCredits(-1_500_000_000n, 0n)).toBe('-$1.50');
  });
});

describe('firstCount', () => {
  it('returns the first row count', () => {
    expect(firstCount([{ count: 3 }])).toBe(3);
  });

  it('returns 0 when the query yielded no rows', () => {
    expect(firstCount([])).toBe(0);
  });
});

describe('nanoUsdToDecimalString', () => {
  it('renders nano-USD as a plain decimal string', () => {
    expect(nanoUsdToDecimalString(0n)).toBe('0.000000000');
    expect(nanoUsdToDecimalString(5_000_000_000n)).toBe('5.000000000');
    expect(nanoUsdToDecimalString(3_000_000n)).toBe('0.003000000');
  });

  it('renders negative amounts', () => {
    expect(nanoUsdToDecimalString(-2_500_000_000n)).toBe('-2.500000000');
  });
});

describe('dev media fixtures', () => {
  it('ships a decodable PNG image fixture', () => {
    const image = DEV_MEDIA_FIXTURES.image;
    expect(image.mimeType).toBe('image/png');
    // PNG magic bytes prove the base64 decode is byte-accurate.
    expect(image.bytes.subarray(0, 4)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    expect(image.width).toBe(1);
    expect(image.durationMs).toBeUndefined();
  });

  it('ships the shared video clip, declared at the clip\u2019s own dimensions and duration', () => {
    const video = DEV_MEDIA_FIXTURES.video;
    expect(video.mimeType).toBe(MOCK_VIDEO_MIME_TYPE);
    expect(video.bytes).toEqual(MOCK_VIDEO_BYTES);
    expect(video.width).toBe(MOCK_VIDEO_WIDTH);
    expect(video.height).toBe(MOCK_VIDEO_HEIGHT);
    expect(video.durationMs).toBe(MOCK_VIDEO_DURATION_MS);
  });
});
