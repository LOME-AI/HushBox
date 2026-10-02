import { SAMPLE_RATE } from '../../time/grid.js';

import { requireSampleCount } from './bounds.js';
import { controlInRange, createStereo, requireEqualChannels, sampleAt } from './buffer.js';

import type { Interval } from './bounds.js';
import type { StereoBuffer } from './buffer.js';

const CHANNELS = 2;
const BYTES_PER_SAMPLE = 3;
const BYTES_PER_FRAME = CHANNELS * BYTES_PER_SAMPLE;
const HEADER_BYTES = 44;
/** What the RIFF size field counts beyond the data: "WAVE", the fmt chunk and the data chunk's header. */
const RIFF_OVERHEAD = HEADER_BYTES - 8;
/** The most frames whose RIFF size still fits the field's 32 bits. */
const MAX_SAMPLES = Math.floor((0xff_ff_ff_ff - RIFF_OVERHEAD) / BYTES_PER_FRAME);
/** 2^23 − 1: ±1 maps to ±FULL_SCALE, symmetric about zero, so a decoded code of it reads exactly 1. */
const FULL_SCALE = 8_388_607;
const SIGN_BIT = 0x80_00_00;
const CODE_RANGE = 0x1_00_00_00;
const FULL_RANGE: Interval = { min: -1, max: 1 };

const encoder = new TextEncoder();

/** The 44-byte header of a 48 kHz stereo 24-bit PCM WAV holding `samples` frames. */
export function wavHeader(samples: number): Uint8Array {
  requireSampleCount('samples', samples);
  if (samples > MAX_SAMPLES) {
    throw new RangeError(
      `a WAV file holds at most ${String(MAX_SAMPLES)} stereo 24-bit samples, got ${String(samples)}`
    );
  }
  const header = new Uint8Array(HEADER_BYTES);
  const view = new DataView(header.buffer);
  const dataBytes = samples * BYTES_PER_FRAME;
  header.set(encoder.encode('RIFF'), 0);
  view.setUint32(4, RIFF_OVERHEAD + dataBytes, true);
  header.set(encoder.encode('WAVE'), 8);
  header.set(encoder.encode('fmt '), 12);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * BYTES_PER_FRAME, true);
  view.setUint16(32, BYTES_PER_FRAME, true);
  view.setUint16(34, BYTES_PER_SAMPLE * 8, true);
  header.set(encoder.encode('data'), 36);
  view.setUint32(40, dataBytes, true);
  return header;
}

/**
 * A sample in [−1, 1] as a 24-bit code, with TPDF dither: the difference of two
 * generator values, triangular over (−1, 1) step. Dither can carry full scale
 * one step past the range, so the code is clamped to it.
 */
function quantize(sample: number, next: () => number): number {
  const first = next();
  const second = next();
  const code = Math.round(sample * FULL_SCALE + (first - second));
  return Math.min(Math.max(code, -FULL_SCALE - 1), FULL_SCALE);
}

/**
 * A 48 kHz stereo 24-bit PCM WAV of the buffer, frames interleaved left then
 * right. The dither is drawn from `next` in that order, so the same buffer and
 * generator key give the same bytes. A sample outside [−1, 1] is refused rather
 * than clipped.
 */
export function encodeWav24(buffer: StereoBuffer, next: () => number): Uint8Array {
  requireEqualChannels(buffer);
  const samples = buffer.left.length;
  const bytes = new Uint8Array(HEADER_BYTES + samples * BYTES_PER_FRAME);
  bytes.set(wavHeader(samples));
  const channels = [
    ['left', buffer.left],
    ['right', buffer.right],
  ] as const;
  let offset = HEADER_BYTES;
  for (let index = 0; index < samples; index++) {
    for (const [name, channel] of channels) {
      const code = quantize(controlInRange(name, channel, index, FULL_RANGE), next);
      bytes[offset] = code & 0xff;
      bytes[offset + 1] = (code >> 8) & 0xff;
      bytes[offset + 2] = (code >> 16) & 0xff;
      offset += BYTES_PER_SAMPLE;
    }
  }
  return bytes;
}

/** One little-endian 24-bit two's-complement code, as a sample. */
function sampleFrom(bytes: Uint8Array, offset: number): number {
  const code =
    sampleAt(bytes, offset) |
    (sampleAt(bytes, offset + 1) << 8) |
    (sampleAt(bytes, offset + 2) << 16);
  return (code & SIGN_BIT ? code - CODE_RANGE : code) / FULL_SCALE;
}

const PCM_FORMAT = 1;
/** WAVE_FORMAT_EXTENSIBLE: the format the bundled ffmpeg writes for 24-bit PCM, its subformat naming the coding. */
const EXTENSIBLE_FORMAT = 0xff_fe;
/** Where an extensible fmt chunk's subformat code sits in its body. */
const SUBFORMAT_OFFSET = 24;

function chunkId(bytes: Uint8Array, offset: number): string {
  return String.fromCodePoint(...bytes.subarray(offset, offset + 4));
}

/** Refuses a fmt chunk body that is not stereo 24-bit PCM, plain or extensible. */
function requireStereo24(view: DataView, body: number): void {
  const format = view.getUint16(body, true);
  const channels = view.getUint16(body + 2, true);
  const bits = view.getUint16(body + 14, true);
  if (
    !(
      (format === PCM_FORMAT || format === EXTENSIBLE_FORMAT) &&
      channels === CHANNELS &&
      bits === BYTES_PER_SAMPLE * 8
    )
  ) {
    throw new RangeError(
      `the WAV holds ${String(channels)} channels of ${String(bits)}-bit samples in format ${String(format)}, not ${String(CHANNELS)} channels of 24-bit PCM`
    );
  }
  if (format === EXTENSIBLE_FORMAT) {
    const subformat = view.getUint16(body + SUBFORMAT_OFFSET, true);
    if (subformat !== PCM_FORMAT) {
      throw new RangeError(
        `the WAV's extensible format carries subformat ${String(subformat)}, not PCM`
      );
    }
  }
}

/**
 * Where the sample data starts. A RIFF WAVE file is walked chunk by chunk, its
 * fmt chunk checked and any chunk before the data skipped; other bytes are read
 * as `encodeWav24` lays them out, the data after its fixed header.
 */
function dataOffset(bytes: Uint8Array): number {
  if (chunkId(bytes, 0) !== 'RIFF' || chunkId(bytes, 8) !== 'WAVE') {
    return HEADER_BYTES;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = chunkId(bytes, offset);
    if (id === 'data') {
      return offset + 8;
    }
    if (id === 'fmt ') {
      requireStereo24(view, offset + 8);
    }
    const size = view.getUint32(offset + 4, true);
    offset += 8 + size + (size % 2);
  }
  throw new RangeError('the WAV has no data chunk');
}

/**
 * The samples of a 24-bit stereo PCM WAV: what `encodeWav24` wrote, or what the
 * bundled ffmpeg writes when it decodes a delivery. The data runs to the end of
 * the file, and is exactly what the file delivers, dither included, so a
 * measurement of it measures the audio as delivered.
 */
export function decodeWav24(bytes: Uint8Array): StereoBuffer {
  if (bytes.length < HEADER_BYTES) {
    throw new RangeError(
      `${String(bytes.length)} bytes is shorter than the ${String(HEADER_BYTES)}-byte header of a WAV file`
    );
  }
  const start = dataOffset(bytes);
  const dataBytes = bytes.length - start;
  if (dataBytes % BYTES_PER_FRAME !== 0) {
    throw new RangeError(
      `${String(dataBytes)} bytes of sample data is not a whole number of ${String(BYTES_PER_FRAME)}-byte stereo frames`
    );
  }
  const buffer = createStereo(dataBytes / BYTES_PER_FRAME);
  for (let index = 0; index < buffer.left.length; index++) {
    const offset = start + index * BYTES_PER_FRAME;
    buffer.left[index] = sampleFrom(bytes, offset);
    buffer.right[index] = sampleFrom(bytes, offset + BYTES_PER_SAMPLE);
  }
  return buffer;
}
