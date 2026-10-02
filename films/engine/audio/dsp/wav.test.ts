import { describe, expect, it } from 'vitest';

import { rand } from '../../rand/rand.js';

import { createStereo } from './buffer.js';
import { decodeWav24, encodeWav24, wavHeader } from './wav.js';

import type { StereoBuffer } from './buffer.js';

const FULL_SCALE = 8_388_607;
const HEADER_BYTES = 44;
/** The RIFF size field is 32-bit: 36 + 6 × this many samples is the last size it holds. */
const MAX_SAMPLES = 715_827_876;
/** The float32 just past full scale. */
const PAST_FULL_SCALE = 1 + 2 ** -23;

function ascii(bytes: Uint8Array, from: number, length: number): string {
  return String.fromCodePoint(...bytes.subarray(from, from + length));
}

/** The signed 24-bit little-endian sample at a byte offset. */
function code24(bytes: Uint8Array, offset: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const unsigned = view.getUint16(offset, true) + view.getUint8(offset + 2) * 65_536;
  return unsigned >= 8_388_608 ? unsigned - 16_777_216 : unsigned;
}

function stereo(left: number[], right: number[]): StereoBuffer {
  return { left: new Float32Array(left), right: new Float32Array(right) };
}

describe('encodeWav24', () => {
  const encoded = encodeWav24(createStereo(10), rand('wav'));
  const view = new DataView(encoded.buffer, encoded.byteOffset);

  it('is a 44-byte header followed by six bytes per stereo sample', () => {
    expect(encoded).toHaveLength(44 + 6 * 10);
  });

  it('writes the RIFF and WAVE chunk ids', () => {
    expect([ascii(encoded, 0, 4), ascii(encoded, 8, 4)]).toEqual(['RIFF', 'WAVE']);
  });

  it('writes the RIFF size as everything after the first eight bytes', () => {
    expect(view.getUint32(4, true)).toBe(36 + 6 * 10);
  });

  it('declares 16-byte PCM format: 2 channels, 48 kHz, 24 bits', () => {
    expect(ascii(encoded, 12, 4)).toBe('fmt ');
    expect([
      view.getUint32(16, true),
      view.getUint16(20, true),
      view.getUint16(22, true),
      view.getUint32(24, true),
      view.getUint32(28, true),
      view.getUint16(32, true),
      view.getUint16(34, true),
    ]).toEqual([16, 1, 2, 48_000, 288_000, 6, 24]);
  });

  it('writes the data chunk id and its length in bytes', () => {
    expect([ascii(encoded, 36, 4), view.getUint32(40, true)]).toEqual(['data', 6 * 10]);
  });

  it('interleaves left then right, each within one step of the scaled sample', () => {
    const bytes = encodeWav24(stereo([0.5, -1], [-0.25, 1]), rand('wav'));
    const written = [
      [44, 0.5],
      [47, -0.25],
      [50, -1],
      [53, 1],
    ] as const;
    for (const [offset, sample] of written) {
      expect(Math.abs(code24(bytes, offset) - sample * FULL_SCALE)).toBeLessThanOrEqual(1.5);
    }
  });

  it('never writes past the 24-bit range at full scale', () => {
    const loud = new Float32Array(4000).fill(1);
    const bytes = encodeWav24({ left: loud, right: loud.map((sample) => -sample) }, rand('loud'));
    const codes = Array.from({ length: 8000 }, (_, index) => code24(bytes, 44 + 3 * index));
    expect(Math.max(...codes)).toBe(FULL_SCALE);
    expect(Math.min(...codes)).toBeGreaterThanOrEqual(-FULL_SCALE - 1);
  });

  it('is byte-identical for two encodes with the same rand key', () => {
    const buffer = stereo([0.1, 0.2, 0.3], [-0.1, -0.2, -0.3]);
    expect(encodeWav24(buffer, rand('same'))).toEqual(encodeWav24(buffer, rand('same')));
  });

  it('differs for a different rand key, because the dither does', () => {
    const silence = createStereo(1000);
    expect(encodeWav24(silence, rand('key-1'))).not.toEqual(encodeWav24(silence, rand('key-2')));
  });

  it('dithers silence with triangular noise: codes −1, 0 and 1, the outer two an eighth each', () => {
    const bytes = encodeWav24(createStereo(24_000), rand('tpdf'));
    const codes = Array.from({ length: 48_000 }, (_, index) => code24(bytes, 44 + 3 * index));
    expect(new Set(codes)).toEqual(new Set([-1, 0, 1]));
    for (const outer of [-1, 1]) {
      const share = codes.filter((code) => code === outer).length / codes.length;
      expect(share).toBeGreaterThan(0.115);
      expect(share).toBeLessThan(0.135);
    }
  });

  it('accepts a sample at full scale', () => {
    expect(() => encodeWav24(stereo([1], [-1]), rand('wav'))).not.toThrow();
  });

  it('refuses the float32 just past positive full scale, naming the channel and sample', () => {
    expect(() => encodeWav24(stereo([0, 0], [0, PAST_FULL_SCALE]), rand('wav'))).toThrow(
      `right[1] must be in [-1, 1], got ${String(Math.fround(PAST_FULL_SCALE))}`
    );
  });

  it('refuses the float32 just past negative full scale', () => {
    expect(() => encodeWav24(stereo([-PAST_FULL_SCALE], [0]), rand('wav'))).toThrow(
      /left\[0\] must be in \[-1, 1\]/
    );
  });

  it('refuses NaN', () => {
    expect(() => encodeWav24(stereo([Number.NaN], [0]), rand('wav'))).toThrow(RangeError);
  });

  it('refuses channels of different lengths', () => {
    expect(() => encodeWav24(stereo([0, 0], [0]), rand('wav'))).toThrow(/equal channels/);
  });
});

describe('wavHeader', () => {
  it('accepts zero samples', () => {
    expect(wavHeader(0)).toHaveLength(44);
  });

  it('refuses minus one sample', () => {
    expect(() => wavHeader(-1)).toThrow(/samples must be a whole number/);
  });

  it('accepts the most samples a 32-bit RIFF size can describe', () => {
    const view = new DataView(wavHeader(MAX_SAMPLES).buffer);
    expect(view.getUint32(4, true)).toBe(36 + 6 * MAX_SAMPLES);
  });

  it('refuses one sample more', () => {
    expect(() => wavHeader(MAX_SAMPLES + 1)).toThrow(
      `a WAV file holds at most ${String(MAX_SAMPLES)} stereo 24-bit samples, got ${String(MAX_SAMPLES + 1)}`
    );
  });
});

/** A WAV of our header followed by the given 24-bit little-endian sample bytes. */
function wavWithFrames(frames: readonly (readonly [number, number, number])[]): Uint8Array {
  const header = wavHeader(0);
  const bytes = new Uint8Array(HEADER_BYTES + frames.length * 3);
  bytes.set(header);
  for (const [index, frame] of frames.entries()) {
    bytes.set(frame, HEADER_BYTES + index * 3);
  }
  return bytes;
}

/** WAVE_FORMAT_EXTENSIBLE's PCM subformat GUID, as ffmpeg writes it. */
const PCM_SUBFORMAT = [
  0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
];

function chunk(id: string, body: readonly number[]): number[] {
  const size = [0, 8, 16, 24].map((shift) => (body.length >>> shift) & 0xff);
  return [...new TextEncoder().encode(id), ...size, ...body];
}

function le(value: number, bytes: number): number[] {
  return Array.from({ length: bytes }, (_, index) => Math.floor(value / 256 ** index) % 256);
}

/** A 40-byte WAVE_FORMAT_EXTENSIBLE fmt chunk, laid out as the bundled ffmpeg writes one. */
function extensibleFmt({
  channels = 2,
  bits = 24,
  subformat = PCM_SUBFORMAT,
}: { channels?: number; bits?: number; subformat?: readonly number[] } = {}): number[] {
  return chunk('fmt ', [
    ...le(0xff_fe, 2),
    ...le(channels, 2),
    ...le(48_000, 4),
    ...le(48_000 * channels * 3, 4),
    ...le(channels * 3, 2),
    ...le(bits, 2),
    ...le(22, 2),
    ...le(bits, 2),
    ...le(3, 4),
    ...subformat,
  ]);
}

/** A RIFF WAVE file of the given chunks. */
function riff(...chunks: readonly number[][]): Uint8Array {
  const body = [...new TextEncoder().encode('WAVE'), ...chunks.flat()];
  return Uint8Array.from(chunk('RIFF', body));
}

/** One stereo frame: left full scale, right its negative. */
const FRAME = [0xff, 0xff, 0x7f, 0x01, 0x00, 0x80];

describe('decodeWav24: headers other than its own', () => {
  it('reads a WAVE_FORMAT_EXTENSIBLE header with a 40-byte fmt chunk', () => {
    const decoded = decodeWav24(riff(extensibleFmt(), chunk('data', FRAME)));

    expect([decoded.left[0], decoded.right[0]]).toEqual([1, -1]);
  });

  it('skips a chunk before the data', () => {
    const decoded = decodeWav24(
      riff(extensibleFmt(), chunk('LIST', [1, 2, 3, 4]), chunk('data', FRAME))
    );

    expect(decoded.left).toHaveLength(1);
  });

  it('refuses a format that is not stereo 24-bit PCM, naming what it holds', () => {
    expect(() => decodeWav24(riff(extensibleFmt({ bits: 16 }), chunk('data', FRAME)))).toThrow(
      /2 channels of 16-bit samples in format 65534/
    );
  });

  it('refuses an extensible header whose subformat is not PCM', () => {
    const float = [0x03, ...PCM_SUBFORMAT.slice(1)];

    expect(() =>
      decodeWav24(riff(extensibleFmt({ subformat: float }), chunk('data', FRAME)))
    ).toThrow(/subformat 3/);
  });

  it('refuses a RIFF file with no data chunk', () => {
    const noData = riff(extensibleFmt(), chunk('LIST', [...new Uint8Array(16)]));

    expect(() => decodeWav24(noData)).toThrow(/no data chunk/);
  });
});

describe('decodeWav24', () => {
  it('reads back what encodeWav24 wrote, to within the dither and rounding', () => {
    const buffer = createStereo(480);
    for (let index = 0; index < 480; index++) {
      buffer.left[index] = (index / 480) * 2 - 1;
      buffer.right[index] = 1 - (index / 480) * 2;
    }
    const decoded = decodeWav24(encodeWav24(buffer, rand('round-trip')));
    const tolerance = 1.5 / FULL_SCALE;
    for (let index = 0; index < 480; index++) {
      expect(
        Math.abs((decoded.left[index] ?? Number.NaN) - (buffer.left[index] ?? 0))
      ).toBeLessThanOrEqual(tolerance);
      expect(
        Math.abs((decoded.right[index] ?? Number.NaN) - (buffer.right[index] ?? 0))
      ).toBeLessThanOrEqual(tolerance);
    }
  });

  it('decodes the largest positive code as full scale', () => {
    const decoded = decodeWav24(
      wavWithFrames([
        [0xff, 0xff, 0x7f],
        [0x00, 0x00, 0x00],
      ])
    );
    expect(decoded.left[0]).toBe(1);
    expect(decoded.right[0]).toBe(0);
  });

  it('decodes negative codes by their two’s complement', () => {
    const decoded = decodeWav24(
      wavWithFrames([
        [0x01, 0x00, 0x80],
        [0x00, 0x00, 0x80],
      ])
    );
    expect(decoded.left[0]).toBe(-1);
    expect(decoded.right[0]).toBe(Math.fround(-8_388_608 / FULL_SCALE));
  });

  it('holds as many samples per channel as the data chunk holds frames', () => {
    expect(decodeWav24(encodeWav24(createStereo(7), rand('length'))).left).toHaveLength(7);
  });

  it('refuses data that is not a whole number of stereo 24-bit frames', () => {
    expect(() => decodeWav24(new Uint8Array(HEADER_BYTES + 5))).toThrow(
      /5 bytes of sample data is not a whole number of 6-byte stereo frames/
    );
  });

  it('refuses a file shorter than its header', () => {
    expect(() => decodeWav24(new Uint8Array(HEADER_BYTES - 1))).toThrow(
      /43 bytes is shorter than the 44-byte header/
    );
  });
});
