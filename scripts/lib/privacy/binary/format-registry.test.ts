import { describe, expect, it } from 'vitest';

import { BINARY_FORMATS, detectBinaryFormat } from './format-registry.js';
import { PNG_SIGNATURE } from './png.js';

/** Assembled at runtime; see the specimen note in `leak-values.test.ts`. */
const isoSpecimen = (): string => {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `2026-01-02T${[3, 4, 5].map((part) => pad(part)).join(':')}Z`;
};

const id3Prefixed = (body: Buffer): Buffer =>
  Buffer.concat([
    Buffer.from('ID3', 'latin1'),
    Buffer.from([4, 0, 0]),
    Buffer.from([0, 0, 0, 8]),
    Buffer.alloc(8),
    body,
  ]);

describe('BINARY_FORMATS', () => {
  it('gives every format a unique identifier', () => {
    const ids = BINARY_FORMATS.map((format) => format.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every format at least one expected extension', () => {
    for (const format of BINARY_FORMATS) {
      expect(format.extensions.length).toBeGreaterThan(0);
    }
  });

  it('spells every expected extension with its leading dot in lower case', () => {
    for (const format of BINARY_FORMATS) {
      for (const extension of format.extensions) {
        expect(extension).toBe(extension.toLowerCase());
        expect(extension.startsWith('.')).toBe(true);
      }
    }
  });
});

/**
 * These fixtures carry structurally valid headers rather than bare magic bytes.
 * A matcher that claims on magic alone suppresses the text gate, which defers to
 * this registry — so each matcher now requires corroboration, and a fixture that
 * cannot supply it is not a file of that format.
 */
const isoBmff = (): Buffer => {
  const box = Buffer.alloc(16);
  box.writeUInt32BE(16, 0);
  box.write('ftypisom', 4, 'latin1');
  return box;
};

const flacStream = (): Buffer => {
  const header = Buffer.alloc(4);
  header.writeUIntBE(34, 1, 3);
  return Buffer.concat([Buffer.from('fLaC', 'latin1'), header, Buffer.alloc(34)]);
};

/** MPEG 1 Layer III, 128 kbit/s at 44.1 kHz: a 417-byte frame, header included. */
const MPEG_FRAME_BYTES = 417;
const mpegFrame = (): Buffer =>
  Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(MPEG_FRAME_BYTES - 4)]);

const woff2Font = (): Buffer => {
  const header = Buffer.alloc(48);
  header.write('wOF2', 0, 'latin1');
  header.writeUInt32BE(0x00_01_00_00, 4);
  return header;
};

const riffWave = (): Buffer => {
  const bytes = Buffer.alloc(12);
  bytes.write('RIFF', 0, 'latin1');
  bytes.writeUInt32LE(4, 4);
  bytes.write('WAVE', 8, 'latin1');
  return bytes;
};

const iconDirectory = (): Buffer => {
  const bytes = Buffer.alloc(22);
  bytes.writeUInt16LE(1, 2);
  bytes.writeUInt16LE(1, 4);
  return bytes;
};

describe('detectBinaryFormat', () => {
  it.each([
    ['png', Buffer.from(PNG_SIGNATURE)],
    ['isobmff', isoBmff()],
    ['matroska', Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0])],
    ['flac', flacStream()],
    ['mp3', Buffer.concat([mpegFrame(), mpegFrame()])],
    ['woff2', woff2Font()],
    ['zip', Buffer.from([0x50, 0x4b, 0x03, 0x04])],
    ['gif', Buffer.from('GIF89a\u0000\u0000\u0000\u0000\u0000\u0000\u0000', 'latin1')],
    ['riff', riffWave()],
    ['ico', iconDirectory()],
  ])('dispatches %s on its magic bytes', (expected, bytes) => {
    expect(detectBinaryFormat(bytes)?.id).toBe(expected);
  });

  it('resolves a tagged FLAC to FLAC rather than to MP3', () => {
    expect(detectBinaryFormat(id3Prefixed(flacStream()))?.id).toBe('flac');
  });

  it('resolves a tagged MPEG stream to MP3', () => {
    expect(detectBinaryFormat(id3Prefixed(Buffer.concat([mpegFrame(), mpegFrame()])))?.id).toBe(
      'mp3'
    );
  });

  it('returns nothing for a blob matching no registered format', () => {
    expect(detectBinaryFormat(Buffer.from('not a container', 'latin1'))).toBeUndefined();
  });

  it('returns nothing for an empty blob', () => {
    expect(detectBinaryFormat(Buffer.alloc(0))).toBeUndefined();
  });
});

/**
 * A claim of format is not a claim of examination. The text gate defers to this
 * registry, so every false claim here is a file neither gate looks at — which is
 * how a UTF-16 text file came to be claimed as audio and examined by nobody.
 */
describe('detectBinaryFormat — a claim must be evidence, not coincidence', () => {
  it('does not claim a UTF-16LE text file, whose byte-order mark is a valid frame sync', () => {
    const text = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('a note about the run', 'utf16le'),
    ]);
    expect(detectBinaryFormat(text)).toBeUndefined();
  });

  it('does not claim text that merely opens with the container-format characters', () => {
    for (const opener of ['fLaC is a codec', 'RIFF is a chunk format', 'wOF2 is a font wrapper']) {
      expect(detectBinaryFormat(Buffer.from(opener, 'latin1'))).toBeUndefined();
    }
  });

  it('does not claim text that happens to carry a brand marker at the box offset', () => {
    // `ftyp` sits where a box brand does, but the four bytes in front of it are
    // prose rather than a box size the blob could hold.
    expect(detectBinaryFormat(Buffer.from('abcdftyp is a box type', 'latin1'))).toBeUndefined();
  });

  it('does not claim a box declaring a size the blob cannot hold', () => {
    const box = Buffer.alloc(16);
    box.writeUInt32BE(9999, 0);
    box.write('ftypisom', 4, 'latin1');
    expect(detectBinaryFormat(box)).toBeUndefined();
  });

  it('does not claim a sync word whose frame header fields are invalid', () => {
    expect(detectBinaryFormat(Buffer.from([0xff, 0xfb, 0xf0, 0x00]))).toBeUndefined();
  });

  it('does not claim a frame header the next frame contradicts', () => {
    const isolated = Buffer.concat([mpegFrame(), Buffer.alloc(1024, 0x41)]);
    expect(detectBinaryFormat(isolated)).toBeUndefined();
  });

  it('does not claim a frame header declaring more bytes than the blob holds', () => {
    expect(detectBinaryFormat(Buffer.from([0xff, 0xfb, 0x90, 0x00]))).toBeUndefined();
  });

  it('does not claim a lone frame, however well formed its header is', () => {
    expect(detectBinaryFormat(mpegFrame())).toBeUndefined();
  });

  it('does not claim a byte-order mark whose blob happens to match the declared frame length', () => {
    // The third byte declares a 52-byte frame and the blob is exactly 52 bytes,
    // so a length check alone would have accepted this UTF-16 document as audio.
    const marked = Buffer.concat([
      Buffer.from([0xff, 0xfe, 0x1a, 0x00]),
      Buffer.from(isoSpecimen(), 'utf16le'),
      Buffer.alloc(8),
    ]);
    expect(detectBinaryFormat(marked)).toBeUndefined();
  });

  it('claims a frame header the next frame corroborates', () => {
    expect(detectBinaryFormat(Buffer.concat([mpegFrame(), mpegFrame()]))?.id).toBe('mp3');
  });
});
