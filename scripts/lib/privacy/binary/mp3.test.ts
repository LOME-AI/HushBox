import { describe, expect, it } from 'vitest';

import { matchesMp3, mp3ScanRanges, parseMp3 } from './mp3.js';

/** Assembled at runtime; see the specimen note in `leak-values.test.ts`. */
const isoSpecimen = (): string => {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `2026-01-02T${[3, 4, 5].map((part) => pad(part)).join(':')}Z`;
};

/** MPEG 1 Layer III, 128 kbit/s at 44.1 kHz: a 417-byte frame, header included. */
const MPEG_FRAME_BYTES = 417;
const frame = (): Buffer =>
  Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(MPEG_FRAME_BYTES - 4)]);

const tagged = (body: Buffer, tagBodyLength: number): Buffer =>
  Buffer.concat([
    Buffer.from('ID3', 'latin1'),
    Buffer.from([4, 0, 0]),
    Buffer.from([0, 0, 0, tagBodyLength]),
    Buffer.alloc(tagBodyLength),
    body,
  ]);

describe('matchesMp3', () => {
  it('matches a stream of two consecutive frames', () => {
    expect(matchesMp3(Buffer.concat([frame(), frame()]))).toBe(true);
  });

  it('does not match a lone frame, however well formed its header is', () => {
    expect(matchesMp3(frame())).toBe(false);
  });

  it('does not match a frame header declaring more bytes than the blob holds', () => {
    expect(matchesMp3(Buffer.from([0xff, 0xfb, 0x90, 0x00]))).toBe(false);
  });

  it('does not match the UTF-16LE byte-order mark that opens a text file', () => {
    const text = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('a note about the run', 'utf16le'),
    ]);
    expect(matchesMp3(text)).toBe(false);
  });

  it('matches a stream behind an ID3 prefix', () => {
    expect(matchesMp3(tagged(Buffer.concat([frame(), frame()]), 8))).toBe(true);
  });

  it('does not match a FLAC stream behind an ID3 prefix', () => {
    expect(matchesMp3(tagged(Buffer.from('fLaC', 'latin1'), 8))).toBe(false);
  });

  it('does not match a lone 0xff byte that is not followed by the sync bits', () => {
    expect(matchesMp3(Buffer.from([0xff, 0x00, 0x00, 0x00]))).toBe(false);
  });

  it('rejects a sync word with a reserved MPEG version', () => {
    expect(
      matchesMp3(Buffer.concat([Buffer.from([0xff, 0xe8, 0x90, 0x00]), Buffer.alloc(500)]))
    ).toBe(false);
  });

  it('rejects a frame header with an invalid bitrate index', () => {
    expect(
      matchesMp3(Buffer.concat([Buffer.from([0xff, 0xfb, 0xf0, 0x00]), Buffer.alloc(500)]))
    ).toBe(false);
  });

  it('rejects a frame header with a reserved sample-rate index', () => {
    expect(
      matchesMp3(Buffer.concat([Buffer.from([0xff, 0xfb, 0x9c, 0x00]), Buffer.alloc(500)]))
    ).toBe(false);
  });

  it('rejects a frame the following bytes do not corroborate', () => {
    expect(matchesMp3(Buffer.concat([frame(), Buffer.alloc(500, 0x41)]))).toBe(false);
  });

  it('rejects a byte-order mark whose blob matches the declared frame length', () => {
    const marked = Buffer.concat([
      Buffer.from([0xff, 0xfe, 0x1a, 0x00]),
      Buffer.from(isoSpecimen(), 'utf16le'),
      Buffer.alloc(8),
    ]);
    expect(matchesMp3(marked)).toBe(false);
  });

  it('rejects a sync word with a reserved layer', () => {
    expect(
      matchesMp3(Buffer.concat([Buffer.from([0xff, 0xf9, 0x90, 0x00]), Buffer.alloc(500)]))
    ).toBe(false);
  });

  it('rejects a lone 0xff byte that is not followed by the sync bits', () => {
    expect(matchesMp3(Buffer.from([0xff, 0x00, 0x00, 0x00]))).toBe(false);
  });

  it('rejects a blob too short to hold a frame header', () => {
    expect(matchesMp3(Buffer.from([0xff]))).toBe(false);
  });
});

describe('mp3ScanRanges', () => {
  it('covers the coded frames that follow a tag', () => {
    const bytes = tagged(Buffer.concat([frame(), frame()]), 16);
    expect(mp3ScanRanges(bytes)).toEqual([
      { location: 'frames', start: bytes.length - MPEG_FRAME_BYTES * 2, end: bytes.length },
    ]);
  });

  it('covers the whole blob when no tag precedes the audio', () => {
    const bytes = Buffer.concat([frame(), frame()]);
    expect(mp3ScanRanges(bytes)).toEqual([{ location: 'frames', start: 0, end: bytes.length }]);
  });

  it('declares no range where the tag runs to the end of the blob', () => {
    expect(mp3ScanRanges(tagged(Buffer.alloc(0), 16))).toEqual([]);
  });
});

describe('parseMp3', () => {
  it('reports the frames of the ID3 tag in front of the audio', () => {
    const tagBody = Buffer.concat([
      Buffer.from('TSSE'),
      Buffer.from([0, 0, 0, 9]),
      Buffer.alloc(2),
      Buffer.from('\0SomeTool'),
    ]);
    const bytes = Buffer.concat([
      Buffer.from('ID3', 'latin1'),
      Buffer.from([4, 0, 0]),
      Buffer.from([0, 0, 0, tagBody.length]),
      tagBody,
      frame(),
      frame(),
    ]);
    expect(parseMp3(bytes).map((region) => region.kind)).toEqual(['id3:TSSE']);
  });

  it('reports no region for untagged audio', () => {
    expect(parseMp3(Buffer.concat([frame(), frame()]))).toEqual([]);
  });

  it('matches Layer I frames, whose length is computed in four-byte slots', () => {
    // MPEG 1 Layer I, bitrate index 5 (=160 kbit/s) at 44.1 kHz:
    // (floor(12 * 160000 / 44100)) * 4 = 172 bytes.
    const layerOne = Buffer.concat([Buffer.from([0xff, 0xfe, 0x50, 0x00]), Buffer.alloc(168)]);
    expect(matchesMp3(Buffer.concat([layerOne, layerOne]))).toBe(true);
  });

  it('matches an MPEG 2 speech recording, not only MPEG 1', () => {
    // MPEG 2, Layer III, bitrate index 8 (=64 kbit/s) at 22.05 kHz: 208 bytes.
    const frame2 = Buffer.concat([Buffer.from([0xff, 0xf2, 0x80, 0x00]), Buffer.alloc(204)]);
    expect(matchesMp3(Buffer.concat([frame2, frame2]))).toBe(true);
  });

  it('matches an MPEG 2.5 recording', () => {
    // MPEG 2.5, Layer III, bitrate index 6 (=48 kbit/s) at 11.025 kHz: 313 bytes.
    const frame25 = Buffer.concat([Buffer.from([0xff, 0xe2, 0x60, 0x00]), Buffer.alloc(309)]);
    expect(matchesMp3(Buffer.concat([frame25, frame25]))).toBe(true);
  });

  it('matches frames carrying the padding bit', () => {
    // The padding bit adds one byte to the declared frame length: 418, not 417.
    const padded = Buffer.concat([Buffer.from([0xff, 0xfb, 0x92, 0x00]), Buffer.alloc(414)]);
    expect(matchesMp3(Buffer.concat([padded, padded]))).toBe(true);
  });

  it('matches MPEG 1 Layer II frames', () => {
    // MPEG 1, Layer II, bitrate index 5 (=80 kbit/s) at 44.1 kHz:
    // floor(1152/8 * 80000 / 44100) = 261 bytes.
    const frame2 = Buffer.concat([Buffer.from([0xff, 0xfc, 0x50, 0x00]), Buffer.alloc(257)]);
    expect(matchesMp3(Buffer.concat([frame2, frame2]))).toBe(true);
  });

  it('matches MPEG 2 Layer I frames', () => {
    // MPEG 2, Layer I, bitrate index 5 (=80 kbit/s) at 22.05 kHz:
    // (floor(384/32 * 80000 / 22050)) * 4 = 172 bytes.
    const frame21 = Buffer.concat([Buffer.from([0xff, 0xf6, 0x50, 0x00]), Buffer.alloc(168)]);
    expect(matchesMp3(Buffer.concat([frame21, frame21]))).toBe(true);
  });
});

/**
 * The budget is ruled per blob, and this format's tag output was the one path
 * outside it: the tag parse was returned straight to the caller where the two
 * sibling formats that read the same tag route it through a collector.
 */
describe('parseMp3 — the tag output is inside the per-blob budget', () => {
  /** Syncsafe size, as an ID3v2.4 tag and its frames both write one. */
  const syncsafe = (value: number): Buffer =>
    Buffer.from([(value >>> 21) & 0x7f, (value >>> 14) & 0x7f, (value >>> 7) & 0x7f, value & 0x7f]);

  const identityFrame = (): Buffer =>
    Buffer.concat([Buffer.from('TSSE', 'latin1'), syncsafe(1), Buffer.alloc(2), Buffer.alloc(1)]);

  it('stops collecting once one blob has spent its regions', () => {
    const frames = 60_000;
    const body = Buffer.concat(Array.from({ length: frames }, () => identityFrame()));
    const bytes = Buffer.concat([
      Buffer.from('ID3', 'latin1'),
      Buffer.from([4, 0, 0]),
      syncsafe(body.length),
      body,
      frame(),
      frame(),
    ]);

    const regions = parseMp3(bytes);

    // Against the fixture rather than against the ceiling: a bound read from the
    // module under test moves with it and can never fail for its own subject,
    // and an uncollected parse returns exactly one region per frame.
    expect(regions.length).toBeLessThan(frames);
    expect(regions.at(-1)?.kind).toBe('blob:budget');
  });
});
