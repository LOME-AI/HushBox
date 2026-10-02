import { describe, expect, it } from 'vitest';
import {
  MOCK_VIDEO_BYTES,
  MOCK_VIDEO_DURATION_MS,
  MOCK_VIDEO_HEIGHT,
  MOCK_VIDEO_MIME_TYPE,
  MOCK_VIDEO_WIDTH,
} from './mock-video-clip.js';

/**
 * A minimal EBML reader — enough to read the clip's own container metadata, so
 * the declared mime, dimensions and duration are proven against the committed
 * bytes rather than trusted. Element ids are written as hex, the spelling the
 * Matroska specification uses.
 */
const EBML_HEADER = '1a45dfa3';
const SEGMENT = '18538067';
const INFO = '1549a966';
const TRACKS = '1654ae6b';
const TRACK_ENTRY = 'ae';
const VIDEO_SETTINGS = 'e0';
const DOC_TYPE = '4282';
const TIMESTAMP_SCALE = '2ad7b1';
const DURATION = '4489';
const CODEC_ID = '86';
const PIXEL_WIDTH = 'b0';
const PIXEL_HEIGHT = 'ba';

/** The elements holding other elements; everything else is read as a leaf. */
const MASTER_IDS: ReadonlySet<string> = new Set([
  EBML_HEADER,
  SEGMENT,
  INFO,
  TRACKS,
  TRACK_ENTRY,
  VIDEO_SETTINGS,
]);

interface Vint {
  readonly value: number;
  readonly width: number;
}

/** One byte's worth of shift, for the big-endian accumulations below. */
const BYTE_RADIX = 256;

function byteAt(bytes: Uint8Array, offset: number): number {
  const byte = bytes[offset];
  if (byte === undefined) throw new Error('EBML: truncated variable-width integer');
  return byte;
}

/**
 * EBML variable-width integers: leading zero bits count the extra bytes, and
 * the first set bit is a length marker that ids keep and sizes drop.
 */
function readVint(bytes: Uint8Array, offset: number, stripMarker: boolean): Vint {
  const first = byteAt(bytes, offset);
  let marker = 0x80;
  let width = 1;
  while (marker > 0 && (first & marker) === 0) {
    marker >>= 1;
    width += 1;
  }
  if (marker === 0) throw new Error('EBML: invalid variable-width integer');
  let value = stripMarker ? first & (marker - 1) : first;
  for (let index = 1; index < width; index += 1) {
    value = value * BYTE_RADIX + byteAt(bytes, offset + index);
  }
  return { value, width };
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Every leaf element under the master elements above, first occurrence wins. */
function readLeaves(
  bytes: Uint8Array,
  start: number,
  end: number,
  into: Map<string, Uint8Array>
): void {
  let offset = start;
  while (offset < end) {
    const id = readVint(bytes, offset, false);
    const idHex = toHex(bytes.subarray(offset, offset + id.width));
    const size = readVint(bytes, offset + id.width, true);
    const dataStart = offset + id.width + size.width;
    const dataEnd = Math.min(dataStart + size.value, end);
    if (MASTER_IDS.has(idHex)) {
      readLeaves(bytes, dataStart, dataEnd, into);
    } else if (!into.has(idHex)) {
      into.set(idHex, bytes.subarray(dataStart, dataEnd));
    }
    offset = dataEnd;
  }
}

function parseContainer(bytes: Uint8Array): Map<string, Uint8Array> {
  const leaves = new Map<string, Uint8Array>();
  readLeaves(bytes, 0, bytes.length, leaves);
  return leaves;
}

function requireLeaf(leaves: ReadonlyMap<string, Uint8Array>, id: string): Uint8Array {
  const data = leaves.get(id);
  if (data === undefined) throw new Error(`EBML: element ${id} is absent`);
  return data;
}

function readAscii(leaves: ReadonlyMap<string, Uint8Array>, id: string): string {
  return String.fromCodePoint(...requireLeaf(leaves, id)).replace(/\0+$/, '');
}

function readUnsigned(leaves: ReadonlyMap<string, Uint8Array>, id: string): number {
  return requireLeaf(leaves, id).reduce((total, byte) => total * BYTE_RADIX + byte, 0);
}

function readFloat(leaves: ReadonlyMap<string, Uint8Array>, id: string): number {
  const data = requireLeaf(leaves, id);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return data.byteLength === 4 ? view.getFloat32(0) : view.getFloat64(0);
}

/** The container's own duration in milliseconds: ticks × the nanosecond scale. */
function containerDurationMs(leaves: ReadonlyMap<string, Uint8Array>): number {
  const nanosecondsPerTick = readUnsigned(leaves, TIMESTAMP_SCALE);
  return (readFloat(leaves, DURATION) * nanosecondsPerTick) / 1_000_000;
}

describe('the mock video clip', () => {
  const leaves = parseContainer(MOCK_VIDEO_BYTES);

  it('is a WebM container', () => {
    expect(MOCK_VIDEO_BYTES.subarray(0, 4)).toEqual(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]));
    expect(readAscii(leaves, DOC_TYPE)).toBe('webm');
    expect(MOCK_VIDEO_MIME_TYPE).toBe('video/webm');
  });

  it('carries a VP9 video track', () => {
    expect(readAscii(leaves, CODEC_ID)).toBe('V_VP9');
  });

  it('declares the duration the container reports', () => {
    expect(containerDurationMs(leaves)).toBeGreaterThan(0);
    expect(MOCK_VIDEO_DURATION_MS).toBe(containerDurationMs(leaves));
  });

  it('declares the dimensions the container reports', () => {
    expect(MOCK_VIDEO_WIDTH).toBe(readUnsigned(leaves, PIXEL_WIDTH));
    expect(MOCK_VIDEO_HEIGHT).toBe(readUnsigned(leaves, PIXEL_HEIGHT));
  });
});
