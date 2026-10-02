import { describe, expect, it } from 'vitest';

import { HOUR_MS, MINUTE_MS, SECOND_MS, TEST_DAY_START } from '@hushbox/shared/test-time';

import { contentSpans } from './binary-content.js';
import { BINARY_FORMATS } from './binary/format-registry.js';
import { scanBinaryBlob } from './binary/scan.js';
import {
  MATROSKA_VOID_ID,
  STRIP_POLICY,
  assertContentPreserved,
  stripBinaryBlob,
  verifiedStrip,
} from './binary-strip.js';
import {
  bitstreamSpans,
  literalRunSpan,
  rangeContaining,
  seiPayload,
} from './binary/bitstream-spans.js';
import { applyByteEdits, newWorkMeter } from './binary/strip-plan.js';
import {
  ISO_EPOCH_OFFSET_SECONDS,
  ISO_FTYP,
  PNG_SIGNATURE,
  ascii,
  concat,
  filled,
  isoBox,
  isoHeaderBox,
  isoLargeBox,
  isoMetaBox,
  isoSampleDescription,
  isoTrackHandler,
  isoVisualSampleEntry,
  isoWideHeaderBox,
  isoZeroSizedBox,
  MATROSKA_ID_CLUSTER,
  MATROSKA_ID_DATE_UTC,
  MATROSKA_ID_EBML,
  MATROSKA_ID_INFO,
  MATROSKA_ID_MUXING_APP,
  MATROSKA_ID_SEGMENT,
  MATROSKA_ID_TAGS,
  MATROSKA_ID_WRITING_APP,
  matroskaTracks,
  FLAC_SIGNATURE,
  FLAC_TYPE_APPLICATION,
  FLAC_TYPE_CUESHEET,
  FLAC_TYPE_PADDING,
  FLAC_TYPE_PICTURE,
  FLAC_TYPE_SEEKTABLE,
  FLAC_TYPE_STREAMINFO,
  FLAC_TYPE_VORBIS_COMMENT,
  MP3_FRAME_BYTES,
  ebmlElement,
  flacAudio,
  flacStreamInfo,
  gif,
  gifComment,
  flacBlock,
  id3Frame,
  id3Tag,
  id3TagWithFooter,
  latin1,
  matroskaDateNanos,
  mp3Audio,
  png,
  pngChunk,
  pngTextChunk,
  pngTimeChunk,
  seiUnit,
  u32be,
  u32le,
  u64be,
  vorbisComment,
} from '../__test-fixtures-binary-strip__/media.js';
import type { Policy, StripResult } from './binary-strip.js';

/**
 * Every disclosing instant in this file is assembled from the run's shared
 * test-time module plus named durations. A literal timestamp here would be a
 * specimen of exactly what the gate detects, in a file no allowlist entry could
 * ever admit without disabling detection where detection is defined.
 */
const DISCLOSING_MS = TEST_DAY_START + 13 * HOUR_MS + 45 * MINUTE_MS + SECOND_MS;
const DISCLOSING_SECONDS = DISCLOSING_MS / SECOND_MS;
const BOUNDARY_SECONDS = TEST_DAY_START / SECOND_MS;

const isoAt = (instantMs: number): string => new Date(instantMs).toISOString().slice(0, 19) + 'Z';
const clockAt = (instantMs: number): string => new Date(instantMs).toISOString().slice(11, 19);
const compactAt = (instantMs: number): string =>
  isoAt(instantMs).replaceAll('-', '').replace('T', '').replaceAll(':', '');

const IMAGE_DATA = filled(96, 0x5a);

/** The IDAT payload as the file carries it, so a re-encode shows up as a diff. */
function imageDataOf(bytes: Uint8Array): Buffer {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts: Buffer[] = [];
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= bytes.length) {
    const length = view.readUInt32BE(offset);
    const type = view.toString('latin1', offset + 4, offset + 8);
    if (type === 'IDAT') parts.push(view.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  return Buffer.concat(parts);
}

function strippedBytes(file: string, bytes: Uint8Array): Uint8Array {
  const result = stripBinaryBlob(file, bytes);
  expect(result.status).toBe('stripped');
  return result.bytes;
}

describe('applyByteEdits', () => {
  it('replaces a span with the edit’s own bytes', () => {
    const out = applyByteEdits(ascii('abcdef'), [
      { start: 2, end: 4, data: ascii('XY'), reason: 'test' },
    ]);
    expect(Buffer.from(out).toString('latin1')).toBe('abXYef');
  });

  it('drops a span when the edit carries no bytes', () => {
    const out = applyByteEdits(ascii('abcdef'), [
      { start: 1, end: 4, data: new Uint8Array(0), reason: 'test' },
    ]);
    expect(Buffer.from(out).toString('latin1')).toBe('aef');
  });

  it('applies edits in position order regardless of the order given', () => {
    const out = applyByteEdits(ascii('abcdef'), [
      { start: 4, end: 5, data: ascii('F'), reason: 'test' },
      { start: 0, end: 1, data: ascii('A'), reason: 'test' },
    ]);
    expect(Buffer.from(out).toString('latin1')).toBe('AbcdFf');
  });

  it('refuses two edits that overlap rather than letting one silently win', () => {
    expect(() =>
      applyByteEdits(ascii('abcdef'), [
        { start: 1, end: 4, data: new Uint8Array(0), reason: 'first' },
        { start: 3, end: 5, data: new Uint8Array(0), reason: 'second' },
      ])
    ).toThrow(/overlap/i);
  });
});

describe('stripping a PNG', () => {
  it('leaves a file the detector reports nothing about untouched', () => {
    const clean = png({ imageData: IMAGE_DATA });
    const result = stripBinaryBlob('clean.png', clean);
    expect(result.status).toBe('clean');
    expect(result.edits).toEqual([]);
  });

  it('removes a text chunk the detector reports', () => {
    const dirty = png({
      ancillary: [pngTextChunk('Software', 'Matplotlib 3.9.0')],
      imageData: IMAGE_DATA,
    });
    expect(scanBinaryBlob('dirty.png', dirty).length).toBeGreaterThan(0);
    expect(scanBinaryBlob('dirty.png', strippedBytes('dirty.png', dirty))).toEqual([]);
  });

  it('leaves the image data byte-identical when it drops a text chunk', () => {
    const dirty = png({
      ancillary: [pngTextChunk('Software', 'Matplotlib 3.9.0')],
      imageData: IMAGE_DATA,
    });
    const out = strippedBytes('dirty.png', dirty);
    expect(imageDataOf(out).equals(imageDataOf(dirty))).toBe(true);
    expect(imageDataOf(out).equals(Buffer.from(IMAGE_DATA))).toBe(true);
  });

  it('removes an opaque provenance chunk', () => {
    const dirty = png({
      ancillary: [pngChunk('caBX', concat(ascii('urn:uuid:'), ascii(compactAt(DISCLOSING_MS))))],
      imageData: IMAGE_DATA,
    });
    expect(scanBinaryBlob('dirty.png', dirty).length).toBeGreaterThan(0);
    expect(scanBinaryBlob('dirty.png', strippedBytes('dirty.png', dirty))).toEqual([]);
  });

  it('removes a modification-time chunk that is not on a day boundary', () => {
    const dirty = png({ ancillary: [pngTimeChunk(DISCLOSING_MS)], imageData: IMAGE_DATA });
    expect(scanBinaryBlob('dirty.png', dirty).length).toBeGreaterThan(0);
    expect(scanBinaryBlob('dirty.png', strippedBytes('dirty.png', dirty))).toEqual([]);
  });

  it('keeps every chunk the detector says nothing about', () => {
    const dirty = png({
      ancillary: [pngChunk('gAMA', u32be(45_455)), pngTextChunk('Software', 'ImageMagick 7')],
      imageData: IMAGE_DATA,
    });
    const out = strippedBytes('dirty.png', dirty);
    expect(Buffer.from(out).includes(Buffer.from('gAMA'))).toBe(true);
    expect(Buffer.from(out).includes(Buffer.from('Software'))).toBe(false);
  });

  it('drops an unrecognised ancillary chunk, which the format says a decoder may skip', () => {
    // The lower-case first letter is the format's own statement that a decoder
    // may skip a chunk it does not recognise, which is what makes dropping this
    // one free; an unrecognised critical chunk is refused instead.
    const dirty = png({
      ancillary: [pngChunk('prVt', ascii('Lavf58.76.100'))],
      imageData: IMAGE_DATA,
    });
    expect(
      scanBinaryBlob('dirty.png', dirty).some((finding) => finding.kind === 'png:unnamed')
    ).toBe(true);
    const out = strippedBytes('dirty.png', dirty);
    expect(scanBinaryBlob('dirty.png', out)).toEqual([]);
    expect(imageDataOf(out).equals(Buffer.from(IMAGE_DATA))).toBe(true);
  });

  it('refuses an unrecognised critical chunk, rather than dropping it', () => {
    // The case that drops an unrecognised ancillary chunk turns on that chunk
    // being ancillary. This is the same chunk with its type cased the other way,
    // which is the format's own way of saying a decoder meeting it may not skip
    // it — so what the remedy could say nothing about there, it may not remove
    // here.
    const dirty = png({
      ancillary: [pngChunk('PrVt', ascii('Lavf58.76.100'))],
      imageData: IMAGE_DATA,
    });
    expect(
      scanBinaryBlob('dirty.png', dirty).some((finding) => finding.kind === 'png:unnamed-critical')
    ).toBe(true);
    const result = stripBinaryBlob('dirty.png', dirty);
    expect(result.status).toBe('refused');
    expect(result.reasons.join(' ')).toContain('what removing it costs');
    expect(Buffer.from(result.bytes).equals(Buffer.from(dirty))).toBe(true);
  });
});

describe('a blob the detector could not read', () => {
  it('refuses a container whose framing is damaged rather than reporting it stripped', () => {
    const dirty = png({
      ancillary: [pngTextChunk('Software', 'Matplotlib 3.9.0')],
      imageData: IMAGE_DATA,
    });
    const damaged = dirty.subarray(0, -5);
    const result = stripBinaryBlob('damaged.png', damaged);
    expect(result.status).toBe('refused');
    expect(result.reasons.length).toBeGreaterThan(0);
    // The chunk the detector would have reported on an intact file is still
    // there: a refusal writes nothing, so nothing may read as cleaned.
    expect(Buffer.from(result.bytes).includes(Buffer.from('Software'))).toBe(true);
  });

  it('refuses a blob carrying content its own framing never declared', () => {
    const dirty = png({ imageData: IMAGE_DATA, trailing: filled(16, 0x99) });
    expect(stripBinaryBlob('trailing.png', dirty).status).toBe('refused');
  });

  it('refuses bytes matching no registered container', () => {
    const result = stripBinaryBlob('mystery.bin', filled(64, 0x01));
    expect(result.status).toBe('refused');
  });

  it('returns the input unchanged when it refuses', () => {
    const damaged = png({ imageData: IMAGE_DATA, trailing: filled(16, 0x99) });
    expect(Buffer.from(stripBinaryBlob('t.png', damaged).bytes).equals(Buffer.from(damaged))).toBe(
      true
    );
  });
});

/**
 * Sized like a real one. A container's coded payload dwarfs its metadata, and a
 * specimen where it does not lets a remedy carve an implausible share out of its
 * own content proof without any test noticing.
 */
const CODED_SAMPLES = filled(4096, 0x37);

/** The `mdat` payload, which no metadata remedy is allowed to move. */
function codedSamplesOf(bytes: Uint8Array): Buffer {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = view.indexOf('mdat', 0, 'latin1');
  return view.subarray(at + 4);
}

function itemList(entry: Uint8Array): Uint8Array {
  return isoBox('moov', isoBox('udta', isoMetaBox(isoBox('ilst', entry))));
}

/** A muxer's own banner, short enough for the field the format gives it. */
const COMPRESSOR_BANNER = 'Lavc58.134.100 h264';

/** The codec configuration a decoder reads before it can start the stream. */
const AVC_CONFIG = concat(
  Uint8Array.from([0x01, 0x4d, 0x60, 0x32, 0xff, 0xe1, 0x00, 0x04]),
  Uint8Array.from([0x27, 0x4d, 0x60, 0x32, 0x01, 0x00, 0x04, 0x28])
);

const BOX_HEADER_BYTES = 8;

/** A blob whose one sample entry has had a byte of its fixed block moved. */
function patchedSampleEntryBlob(patch: (body: Buffer) => void): Uint8Array {
  const entry = isoVisualSampleEntry(COMPRESSOR_BANNER, AVC_CONFIG);
  patch(
    Buffer.from(entry.buffer, entry.byteOffset + BOX_HEADER_BYTES, entry.length - BOX_HEADER_BYTES)
  );
  return concat(ISO_FTYP, isoSampleDescription(entry), isoBox('mdat', CODED_SAMPLES));
}

/** What the strip did with a blob the detector reports as dirty. */
function sampleEntryStrip(dirty: Uint8Array): StripResult {
  expect(scanBinaryBlob('a.mp4', dirty).length).toBeGreaterThan(0);
  return stripBinaryBlob('a.mp4', dirty);
}

/** A blob with one sample entry, and where that entry sits in it. */
function sampleEntryBlob(): { dirty: Uint8Array; region: { start: number; end: number } } {
  const entry = isoVisualSampleEntry(COMPRESSOR_BANNER, AVC_CONFIG);
  const dirty = concat(ISO_FTYP, isoSampleDescription(entry), isoBox('mdat', CODED_SAMPLES));
  const found = scanBinaryBlob('a.mp4', dirty).find(
    (finding) => finding.kind === 'isobmff:sample-entry'
  );
  if (found === undefined) throw new Error('the fixture must report a sample entry');
  return { dirty, region: { start: found.offset, end: found.offset + found.length } };
}

/** A muxer's banner, in the free-text field of a box no parser here names. */
const HANDLER_BANNER = 'Lavf58.76.100';

/** A blob whose one unrecognised box discloses, and where that box sits in it. */
function handlerBoxBlob(): { dirty: Uint8Array; region: { start: number; end: number } } {
  const dirty = concat(ISO_FTYP, isoTrackHandler(HANDLER_BANNER), isoBox('mdat', CODED_SAMPLES));
  const found = scanBinaryBlob('a.mp4', dirty).find(
    (finding) => finding.kind === 'isobmff:unnamed'
  );
  if (found === undefined) throw new Error('the fixture must report an unrecognised box');
  return { dirty, region: { start: found.offset, end: found.offset + found.length } };
}

/** A box header that declares its extent in the 64-bit form sitting behind the type. */
const ISO_WIDE_HEADER_BYTES = 16;

/** A blob whose one unrecognised box declares its extent in that wide form. */
function wideHandlerBoxBlob(): { dirty: Uint8Array; region: { start: number; end: number } } {
  const handler = isoLargeBox(
    'hdlr',
    concat(filled(8, 0x00), ascii('vide'), filled(12, 0x00), ascii(HANDLER_BANNER), filled(1, 0x00))
  );
  const dirty = concat(
    ISO_FTYP,
    isoBox('moov', isoBox('trak', isoBox('mdia', handler))),
    isoBox('mdat', CODED_SAMPLES)
  );
  const found = scanBinaryBlob('a.mp4', dirty).find(
    (finding) => finding.kind === 'isobmff:unnamed'
  );
  if (found === undefined) throw new Error('the fixture must report an unrecognised box');
  return { dirty, region: { start: found.offset, end: found.offset + found.length } };
}

/** The `avcC` child of the one sample entry in `bytes`. */
function codecConfigOf(bytes: Uint8Array): Buffer {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = view.indexOf('avcC', 0, 'latin1');
  return view.subarray(at + 4, at + 4 + AVC_CONFIG.length);
}

describe('stripping an ISO base-media file', () => {
  it('clears a sample entry compressor name and leaves the codec configuration', () => {
    const entry = isoVisualSampleEntry(COMPRESSOR_BANNER, AVC_CONFIG);
    const dirty = concat(ISO_FTYP, isoSampleDescription(entry), isoBox('mdat', CODED_SAMPLES));
    expect(scanBinaryBlob('a.mp4', dirty).length).toBeGreaterThan(0);
    const out = strippedBytes('a.mp4', dirty);
    expect(scanBinaryBlob('a.mp4', out)).toEqual([]);
    expect(out.length).toBe(dirty.length);
    expect(codecConfigOf(out).equals(codecConfigOf(dirty))).toBe(true);
    expect(Buffer.from(out).includes(Buffer.from('avc1'))).toBe(true);
  });

  it('refuses a sample entry too short to hold the fixed block the format specifies', () => {
    // The bytes behind a short entry belong to the box after it, and they can
    // read as the fixed block's own closing word — so the entry's length is
    // established before anything inside it is read.
    const short = isoBox(
      'avc1',
      concat(
        ascii(COMPRESSOR_BANNER),
        filled(42 - COMPRESSOR_BANNER.length, 0x00),
        Uint8Array.from([0x01]),
        filled(17, 0x00)
      )
    );
    const result = sampleEntryStrip(
      concat(
        ISO_FTYP,
        isoSampleDescription(concat(short, isoBox('skip', filled(64, 0xff)))),
        isoBox('mdat', CODED_SAMPLES)
      )
    );
    expect(result.status).toBe('refused');
    expect(result.reasons.join(' ')).toContain('compressor-name');
  });

  it('refuses a sample entry whose compressor name declares more characters than the field holds', () => {
    const result = sampleEntryStrip(
      patchedSampleEntryBlob((body) => {
        body.writeUInt8(32, 42);
      })
    );
    expect(result.status).toBe('refused');
    expect(result.reasons.join(' ')).toContain('compressor-name');
  });

  it('refuses a sample entry whose fixed block does not close where the format closes it', () => {
    const result = sampleEntryStrip(
      patchedSampleEntryBlob((body) => {
        body.writeUInt16BE(0, 76);
      })
    );
    expect(result.status).toBe('refused');
    expect(result.reasons.join(' ')).toContain('compressor-name');
  });

  it('refuses a sample entry whose children declare a size no box can have', () => {
    const result = sampleEntryStrip(
      patchedSampleEntryBlob((body) => {
        body.writeUInt32BE(4, 78);
      })
    );
    expect(result.status).toBe('refused');
    expect(result.reasons.join(' ')).toContain('compressor-name');
  });

  it('refuses a sample entry whose children leave bytes its walk cannot account for', () => {
    const result = sampleEntryStrip(
      patchedSampleEntryBlob((body) => {
        body.writeUInt32BE(body.length - 78 - 4, 78);
      })
    );
    expect(result.status).toBe('refused');
    expect(result.reasons.join(' ')).toContain('compressor-name');
  });

  it('names the regions a strip had to leave standing, read off the findings', () => {
    const { dirty, region } = sampleEntryBlob();
    expect(stripBinaryBlob('a.mp4', dirty).describedRegions).toEqual([region]);
  });

  it('reports a remedy that overwrites a region the container needs to describe its content', () => {
    const { dirty, region } = sampleEntryBlob();
    expect(() =>
      verifiedStrip({
        file: 'a.mp4',
        format: 'isobmff',
        bytes: dirty,
        edits: [
          {
            start: region.start + BOX_HEADER_BYTES,
            end: region.end,
            data: filled(region.end - region.start - BOX_HEADER_BYTES, 0x00),
            reason: 'zeroed the isobmff:sample-entry box body',
          },
        ],
        described: [region],
      })
    ).toThrow(/overwrite more/);
  });

  it('reports a remedy that rewrites the framing of a region the container describes with', () => {
    const { dirty, region } = sampleEntryBlob();
    expect(() =>
      verifiedStrip({
        file: 'a.mp4',
        format: 'isobmff',
        bytes: dirty,
        edits: [
          {
            start: region.start,
            end: region.start + BOX_HEADER_BYTES,
            data: filled(BOX_HEADER_BYTES, 0x00),
            reason: 'rewrote the box header',
          },
        ],
        described: [region],
      })
    ).toThrow(/framing/);
  });

  it('refuses a box whose role no parser here can name, rather than blanking it', () => {
    const { dirty } = handlerBoxBlob();
    const result = stripBinaryBlob('a.mp4', dirty);
    expect(result.status).toBe('refused');
    expect(result.reasons.join(' ')).toContain('what removing it costs');
    expect(Buffer.from(result.bytes).equals(Buffer.from(dirty))).toBe(true);
  });

  it('names an unrecognised box among the regions a strip had to leave standing', () => {
    const { dirty, region } = handlerBoxBlob();
    expect(stripBinaryBlob('a.mp4', dirty).describedRegions).toEqual([region]);
  });

  it('reports a remedy that blanks an unrecognised box wholesale', () => {
    const { dirty, region } = handlerBoxBlob();
    const described = stripBinaryBlob('a.mp4', dirty).describedRegions;
    expect(() =>
      verifiedStrip({
        file: 'a.mp4',
        format: 'isobmff',
        bytes: dirty,
        edits: [
          {
            start: region.start,
            end: region.end,
            data: filled(region.end - region.start, 0x00),
            reason: 'retyped the box to free and zeroed its body',
          },
        ],
        described,
      })
    ).toThrow(/framing/);
  });

  it('reports a remedy that rewrites the tail of a box header written in the wide form', () => {
    const { dirty, region } = wideHandlerBoxBlob();
    const described = stripBinaryBlob('a.mp4', dirty).describedRegions;
    expect(() =>
      verifiedStrip({
        file: 'a.mp4',
        format: 'isobmff',
        bytes: dirty,
        edits: [
          {
            start: region.start + ISO_WIDE_HEADER_BYTES - 1,
            end: region.start + ISO_WIDE_HEADER_BYTES,
            data: filled(1, 0x00),
            reason: 'rewrote the last byte of the box extent',
          },
        ],
        described,
      })
    ).toThrow(/framing/);
  });

  it('empties an item-list entry naming the authoring toolchain', () => {
    const entry = isoBox(
      '©too',
      isoBox('data', concat(u32be(1), u32be(0), ascii('Lavf58.76.100')))
    );
    const dirty = concat(ISO_FTYP, itemList(entry), isoBox('mdat', CODED_SAMPLES));
    expect(scanBinaryBlob('a.mp4', dirty).length).toBeGreaterThan(0);
    const out = strippedBytes('a.mp4', dirty);
    expect(scanBinaryBlob('a.mp4', out)).toEqual([]);
    expect(out.length).toBe(dirty.length);
    expect(codedSamplesOf(out).equals(codedSamplesOf(dirty))).toBe(true);
  });

  it('retypes a provenance uuid box to a skippable free box of the same size', () => {
    const uuid = isoBox(
      'uuid',
      concat(filled(16, 0x2b), ascii(`c2pa ${compactAt(DISCLOSING_MS)}`))
    );
    const dirty = concat(ISO_FTYP, uuid, isoBox('mdat', CODED_SAMPLES));
    expect(scanBinaryBlob('a.mp4', dirty).length).toBeGreaterThan(0);
    const out = strippedBytes('a.mp4', dirty);
    expect(scanBinaryBlob('a.mp4', out)).toEqual([]);
    expect(out.length).toBe(dirty.length);
    expect(Buffer.from(out).includes(Buffer.from('free'))).toBe(true);
    expect(Buffer.from(out).includes(Buffer.from('c2pa'))).toBe(false);
  });

  it('retypes a uuid box that declares the 64-bit size form', () => {
    const uuid = isoLargeBox(
      'uuid',
      concat(filled(16, 0x2b), ascii(`c2pa ${compactAt(DISCLOSING_MS)}`))
    );
    const dirty = concat(ISO_FTYP, uuid, isoBox('mdat', CODED_SAMPLES));
    const out = strippedBytes('a.mp4', dirty);
    expect(scanBinaryBlob('a.mp4', out)).toEqual([]);
    expect(out.length).toBe(dirty.length);
  });

  it('zeroes the creation and modification times a header box carries', () => {
    const header = isoHeaderBox(
      'mvhd',
      ISO_EPOCH_OFFSET_SECONDS + DISCLOSING_SECONDS,
      ISO_EPOCH_OFFSET_SECONDS + DISCLOSING_SECONDS + 20
    );
    const dirty = concat(ISO_FTYP, isoBox('moov', header), isoBox('mdat', CODED_SAMPLES));
    expect(scanBinaryBlob('a.mp4', dirty).length).toBeGreaterThan(0);
    const out = strippedBytes('a.mp4', dirty);
    expect(scanBinaryBlob('a.mp4', out)).toEqual([]);
    expect(out.length).toBe(dirty.length);
  });

  it('leaves a header box whose times already sit on a day boundary alone', () => {
    const header = isoHeaderBox('mvhd', ISO_EPOCH_OFFSET_SECONDS + BOUNDARY_SECONDS, 0);
    const clean = concat(ISO_FTYP, isoBox('moov', header), isoBox('mdat', CODED_SAMPLES));
    expect(stripBinaryBlob('a.mp4', clean).status).toBe('clean');
  });

  it('overwrites an encoder build banner carried inside the coded payload', () => {
    const banner = 'x264 - core 163 r3060 - H.264/MPEG-4 AVC codec - options: cabac=1 ref=3';
    const mdat = isoBox('mdat', seiUnit({ banner, coded: CODED_SAMPLES }));
    const dirty = concat(ISO_FTYP, mdat);
    expect(scanBinaryBlob('a.mp4', dirty).length).toBeGreaterThan(0);
    const out = strippedBytes('a.mp4', dirty);
    expect(scanBinaryBlob('a.mp4', out)).toEqual([]);
    expect(out.length).toBe(dirty.length);
    expect(Buffer.from(out).includes(Buffer.from('x264'))).toBe(false);
  });

  it('leaves every coded byte outside the overwritten banner identical', () => {
    const banner = 'x264 - core 163 r3060 - H.264/MPEG-4 AVC codec';
    const mdat = isoBox('mdat', seiUnit({ banner, coded: CODED_SAMPLES }));
    const dirty = concat(ISO_FTYP, mdat);
    const out = strippedBytes('a.mp4', dirty);
    expect(
      codedSamplesOf(out).subarray(-CODED_SAMPLES.length).equals(Buffer.from(CODED_SAMPLES))
    ).toBe(true);
  });

  it('overwrites a toolchain string the coded payload carries outside any SEI unit', () => {
    const inline = concat(
      filled(24, 0x37),
      Uint8Array.from([0x00]),
      ascii('Lavc58.134.100'),
      Uint8Array.from([0x00]),
      CODED_SAMPLES
    );
    const dirty = concat(ISO_FTYP, isoBox('mdat', inline));
    expect(scanBinaryBlob('a.mp4', dirty).length).toBeGreaterThan(0);
    const out = strippedBytes('a.mp4', dirty);
    expect(scanBinaryBlob('a.mp4', out)).toEqual([]);
    expect(out.length).toBe(dirty.length);
  });

  it('overwrites every occurrence, not only the one the detector points at', () => {
    const one = concat(Uint8Array.from([0x00]), ascii('Lavc58.134.100'), Uint8Array.from([0x00]));
    const dirty = concat(
      ISO_FTYP,
      isoBox('mdat', concat(one, CODED_SAMPLES, one, CODED_SAMPLES, one, CODED_SAMPLES))
    );
    const out = strippedBytes('a.mp4', dirty);
    expect(Buffer.from(out).includes(Buffer.from('Lavc'))).toBe(false);
  });

  it('empties a leaf directly under user data', () => {
    const leaf = isoBox('moov', isoBox('udta', isoBox('©wrt', latin1('HandBrake 1.7.3'))));
    const dirty = concat(ISO_FTYP, leaf, isoBox('mdat', CODED_SAMPLES));
    expect(scanBinaryBlob('a.mp4', dirty).length).toBeGreaterThan(0);
    const out = strippedBytes('a.mp4', dirty);
    expect(scanBinaryBlob('a.mp4', out)).toEqual([]);
  });
});

const CLUSTER_BODY = filled(2048, 0x61);

function matroska(
  infoChildren: readonly Uint8Array[],
  extra: readonly Uint8Array[] = []
): Uint8Array {
  return concat(
    ebmlElement(MATROSKA_ID_EBML, filled(4, 0)),
    ebmlElement(
      MATROSKA_ID_SEGMENT,
      concat(
        ebmlElement(MATROSKA_ID_INFO, concat(...infoChildren)),
        ...extra,
        ebmlElement(MATROSKA_ID_CLUSTER, CLUSTER_BODY)
      )
    )
  );
}

/** The coded frames, which an element rewrite must leave exactly where they are. */
function clusterOf(bytes: Uint8Array): Buffer {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = view.indexOf(Buffer.from(MATROSKA_ID_CLUSTER));
  return view.subarray(at);
}

/**
 * A Vorbis track's codec configuration: the private headers a decoder reads
 * before it can decode a frame, whose comment header carries the vendor string
 * the encoder wrote there.
 */
const CODEC_PRIVATE = concat(
  ascii('\u0001vorbis'),
  filled(23, 0x00),
  ascii('\u0003vorbis'),
  u32le(13),
  ascii('Lavf58.76.100')
);

/** A blob whose track list discloses, and where that element sits in it. */
function trackListBlob(): { dirty: Uint8Array; region: { start: number; end: number } } {
  const dirty = matroska([], [matroskaTracks('A_VORBIS', CODEC_PRIVATE)]);
  const found = scanBinaryBlob('a.webm', dirty).find(
    (finding) => finding.kind === 'matroska:unnamed'
  );
  if (found === undefined) throw new Error('the fixture must report an unrecognised element');
  return { dirty, region: { start: found.offset, end: found.offset + found.length } };
}

/** An id vint plus a size vint, each as wide as the walk's own vint reader accepts. */
const MATROSKA_WIDEST_HEADER_BYTES = 16;

/**
 * A blob whose one unrecognised element opens with that widest framing: an
 * eight-byte id and an over-long eight-byte size, both of which the walk reads.
 */
function wideFramedElementBlob(): { dirty: Uint8Array; region: { start: number; end: number } } {
  const body = ascii(`ffmpeg version n7.1 built ${clockAt(DISCLOSING_MS)}`);
  const element = concat(
    Uint8Array.from([0x01, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]),
    Uint8Array.from([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, body.length]),
    body
  );
  const dirty = matroska([], [element]);
  const found = scanBinaryBlob('a.webm', dirty).find(
    (finding) => finding.kind === 'matroska:unnamed'
  );
  if (found === undefined) throw new Error('the fixture must report an unrecognised element');
  return { dirty, region: { start: found.offset, end: found.offset + found.length } };
}

describe('stripping a Matroska container', () => {
  it('replaces a muxer string with a void element of the same size', () => {
    const dirty = matroska([
      ebmlElement(MATROSKA_ID_MUXING_APP, ascii('Lavf58.76.100')),
      ebmlElement(MATROSKA_ID_WRITING_APP, ascii('Lavf58.76.100')),
    ]);
    expect(scanBinaryBlob('a.webm', dirty).length).toBeGreaterThan(0);
    const out = strippedBytes('a.webm', dirty);
    expect(scanBinaryBlob('a.webm', out)).toEqual([]);
    expect(out.length).toBe(dirty.length);
    expect(clusterOf(out).equals(clusterOf(dirty))).toBe(true);
    expect(Buffer.from(out).includes(Buffer.from('Lavf'))).toBe(false);
  });

  it('replaces a segment date that is not on a day boundary', () => {
    const dirty = matroska([
      ebmlElement(MATROSKA_ID_DATE_UTC, u64be(matroskaDateNanos(DISCLOSING_SECONDS))),
    ]);
    expect(scanBinaryBlob('a.webm', dirty).length).toBeGreaterThan(0);
    const out = strippedBytes('a.webm', dirty);
    expect(scanBinaryBlob('a.webm', out)).toEqual([]);
    expect(out.length).toBe(dirty.length);
  });

  it('leaves a segment date that already sits on a day boundary alone', () => {
    const clean = matroska([
      ebmlElement(MATROSKA_ID_DATE_UTC, u64be(matroskaDateNanos(BOUNDARY_SECONDS))),
    ]);
    expect(stripBinaryBlob('a.webm', clean).status).toBe('clean');
  });

  it('replaces a tags element whose size needs a multi-byte length', () => {
    const tags = ebmlElement(
      MATROSKA_ID_TAGS,
      concat(ascii(`ffmpeg version n7.1 built ${clockAt(DISCLOSING_MS)}`), filled(220, 0x30))
    );
    const dirty = matroska([ebmlElement(MATROSKA_ID_MUXING_APP, ascii('x'))], [tags]);
    expect(scanBinaryBlob('a.webm', dirty).length).toBeGreaterThan(0);
    const out = strippedBytes('a.webm', dirty);
    expect(scanBinaryBlob('a.webm', out)).toEqual([]);
    expect(out.length).toBe(dirty.length);
    expect(clusterOf(out).equals(clusterOf(dirty))).toBe(true);
  });

  it('refuses an element whose role no parser here can name, rather than voiding it', () => {
    const { dirty } = trackListBlob();
    const result = stripBinaryBlob('a.webm', dirty);
    expect(result.status).toBe('refused');
    expect(result.reasons.join(' ')).toContain('what removing it costs');
    expect(Buffer.from(result.bytes).equals(Buffer.from(dirty))).toBe(true);
  });

  it('names an unrecognised element among the regions a strip had to leave standing', () => {
    const { dirty, region } = trackListBlob();
    expect(stripBinaryBlob('a.webm', dirty).describedRegions).toEqual([region]);
  });

  it('reports a remedy that voids an unrecognised element wholesale', () => {
    const { dirty, region } = trackListBlob();
    const described = stripBinaryBlob('a.webm', dirty).describedRegions;
    const width = region.end - region.start;
    expect(() =>
      verifiedStrip({
        file: 'a.webm',
        format: 'matroska',
        bytes: dirty,
        edits: [
          {
            start: region.start,
            end: region.end,
            data: concat(
              Uint8Array.from([MATROSKA_VOID_ID, 0x80 | (width - 2)]),
              filled(width - 2, 0x00)
            ),
            reason: 'replaced the element with a void element of the same size',
          },
        ],
        described,
      })
    ).toThrow(/framing/);
  });

  it('reports a remedy that rewrites the tail of an element header at its widest', () => {
    const { dirty, region } = wideFramedElementBlob();
    const described = stripBinaryBlob('a.webm', dirty).describedRegions;
    expect(() =>
      verifiedStrip({
        file: 'a.webm',
        format: 'matroska',
        bytes: dirty,
        edits: [
          {
            start: region.start + MATROSKA_WIDEST_HEADER_BYTES - 1,
            end: region.start + MATROSKA_WIDEST_HEADER_BYTES,
            data: filled(1, 0x00),
            reason: 'rewrote the last byte of the element size',
          },
        ],
        described,
      })
    ).toThrow(/framing/);
  });
});

const FLAC_AUDIO = flacAudio();

function flacStream(blocks: readonly Uint8Array[]): Uint8Array {
  return concat(
    FLAC_SIGNATURE,
    flacBlock(FLAC_TYPE_STREAMINFO, filled(34, 0)),
    ...blocks,
    FLAC_AUDIO
  );
}

/** The coded audio, found by its frame sync so a shifted file still lines up. */
function audioFramesOf(bytes: Uint8Array): Buffer {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.subarray(view.indexOf(Buffer.from([0xff, 0xf8])));
}

const VORBIS = flacBlock(
  FLAC_TYPE_VORBIS_COMMENT,
  vorbisComment('reference libFLAC 1.4.3', ['ENCODER=Lavf58.76.100'])
);

/**
 * A banner where the digest of the unencoded audio belongs: that field is the
 * only part of a stream-description block whose bytes the format leaves free,
 * so it is the only place inside the block a disclosure can sit.
 */
const STREAMINFO_SIGNATURE = concat(ascii('Lavf58.76.100'), filled(3, 0x00));

/** The type-and-length word every metadata block of this format opens with. */
const FLAC_BLOCK_HEADER_BYTES = 4;

/** A blob whose stream description discloses, and where that block sits in it. */
function streamInfoBlob(): { dirty: Uint8Array; region: { start: number; end: number } } {
  const dirty = concat(
    FLAC_SIGNATURE,
    flacBlock(FLAC_TYPE_STREAMINFO, flacStreamInfo(STREAMINFO_SIGNATURE)),
    flacBlock(FLAC_TYPE_PADDING, filled(16, 0), true),
    FLAC_AUDIO
  );
  const found = scanBinaryBlob('a.flac', dirty).find((finding) => finding.kind === 'flac:unnamed');
  if (found === undefined) throw new Error('the fixture must report an unrecognised block');
  return { dirty, region: { start: found.offset, end: found.offset + found.length } };
}

describe('stripping a FLAC stream', () => {
  it('turns a vorbis comment block into padding of the same size', () => {
    const dirty = flacStream([VORBIS, flacBlock(FLAC_TYPE_PADDING, filled(16, 0), true)]);
    expect(scanBinaryBlob('a.flac', dirty).length).toBeGreaterThan(0);
    const out = strippedBytes('a.flac', dirty);
    expect(scanBinaryBlob('a.flac', out)).toEqual([]);
    expect(out.length).toBe(dirty.length);
    expect(audioFramesOf(out).equals(Buffer.from(FLAC_AUDIO))).toBe(true);
    expect(Buffer.from(out).includes(Buffer.from('libFLAC'))).toBe(false);
  });

  it('keeps the last-block flag when the comment block is the final one', () => {
    const last = flacBlock(
      FLAC_TYPE_VORBIS_COMMENT,
      vorbisComment('reference libFLAC 1.4.3', []),
      true
    );
    const dirty = flacStream([last]);
    const out = strippedBytes('a.flac', dirty);
    expect(scanBinaryBlob('a.flac', out)).toEqual([]);
    expect(audioFramesOf(out).equals(Buffer.from(FLAC_AUDIO))).toBe(true);
  });

  it('turns an application block into padding', () => {
    const application = flacBlock(
      FLAC_TYPE_APPLICATION,
      concat(ascii('riff'), ascii('HandBrake 1.7.3'))
    );
    const dirty = flacStream([application, flacBlock(FLAC_TYPE_PADDING, filled(8, 0), true)]);
    expect(scanBinaryBlob('a.flac', dirty).length).toBeGreaterThan(0);
    expect(scanBinaryBlob('a.flac', strippedBytes('a.flac', dirty))).toEqual([]);
  });

  it.each([
    { name: 'padding', type: FLAC_TYPE_PADDING },
    { name: 'a seek table', type: FLAC_TYPE_SEEKTABLE },
    { name: 'a cuesheet', type: FLAC_TYPE_CUESHEET },
    { name: 'a picture', type: FLAC_TYPE_PICTURE },
  ])('turns $name block into padding, the format defining it as inert', ({ type }) => {
    const dirty = flacStream([
      flacBlock(type, ascii('Lavf58.76.100')),
      flacBlock(FLAC_TYPE_PADDING, filled(16, 0), true),
    ]);
    expect(scanBinaryBlob('a.flac', dirty).length).toBeGreaterThan(0);
    const out = strippedBytes('a.flac', dirty);
    expect(scanBinaryBlob('a.flac', out)).toEqual([]);
    expect(out.length).toBe(dirty.length);
    expect(audioFramesOf(out).equals(Buffer.from(FLAC_AUDIO))).toBe(true);
  });

  it('drops an ID3 prefix a FLAC stream should never have carried', () => {
    const tag = id3Tag([id3Frame('GEOB', ascii(`c2pa manifest ${compactAt(DISCLOSING_MS)}`))]);
    const dirty = concat(tag, flacStream([flacBlock(FLAC_TYPE_PADDING, filled(8, 0), true)]));
    expect(scanBinaryBlob('a.flac', dirty).length).toBeGreaterThan(0);
    const out = strippedBytes('a.flac', dirty);
    expect(scanBinaryBlob('a.flac', out)).toEqual([]);
    expect(out.length).toBe(dirty.length - tag.length);
    expect(audioFramesOf(out).equals(Buffer.from(FLAC_AUDIO))).toBe(true);
    expect(Buffer.from(out.subarray(0, 4)).toString('latin1')).toBe('fLaC');
  });

  it('drops the prefix once when it carries several reportable frames', () => {
    const tag = id3Tag([
      id3Frame('GEOB', ascii(`c2pa manifest ${compactAt(DISCLOSING_MS)}`)),
      id3Frame('TSSE', ascii('Lavf58.76.100')),
    ]);
    const dirty = concat(tag, flacStream([flacBlock(FLAC_TYPE_PADDING, filled(8, 0), true)]));
    const out = strippedBytes('a.flac', dirty);
    expect(scanBinaryBlob('a.flac', out)).toEqual([]);
    expect(out.length).toBe(dirty.length - tag.length);
  });

  it('refuses a block whose role no parser here can name, rather than padding it out', () => {
    const { dirty } = streamInfoBlob();
    const result = stripBinaryBlob('a.flac', dirty);
    expect(result.status).toBe('refused');
    expect(result.reasons.join(' ')).toContain('what removing it costs');
    expect(Buffer.from(result.bytes).equals(Buffer.from(dirty))).toBe(true);
  });

  it('names an unrecognised block among the regions a strip had to leave standing', () => {
    const { dirty, region } = streamInfoBlob();
    expect(stripBinaryBlob('a.flac', dirty).describedRegions).toEqual([region]);
  });

  it('reports a remedy that pads out an unrecognised block wholesale', () => {
    const { dirty, region } = streamInfoBlob();
    const described = stripBinaryBlob('a.flac', dirty).describedRegions;
    expect(() =>
      verifiedStrip({
        file: 'a.flac',
        format: 'flac',
        bytes: dirty,
        edits: [
          {
            start: region.start,
            end: region.end,
            data: flacBlock(FLAC_TYPE_PADDING, filled(region.end - region.start - 4, 0x00)),
            reason: 'turned the block into padding',
          },
        ],
        described,
      })
    ).toThrow(/framing/);
  });

  // This format frames its units in four bytes where an ISO box takes eight, so
  // the window is wider here than the framing it protects. The pin is on the
  // other side of it: a window narrower than four would leave a block's own
  // declared length rewritable, which is the failure the check exists for.
  it('reports a remedy that rewrites the tail of a block header', () => {
    const { dirty, region } = streamInfoBlob();
    const described = stripBinaryBlob('a.flac', dirty).describedRegions;
    expect(() =>
      verifiedStrip({
        file: 'a.flac',
        format: 'flac',
        bytes: dirty,
        edits: [
          {
            start: region.start + FLAC_BLOCK_HEADER_BYTES - 1,
            end: region.start + FLAC_BLOCK_HEADER_BYTES,
            data: filled(1, 0x00),
            reason: 'rewrote the last byte of the block length',
          },
        ],
        described,
      })
    ).toThrow(/framing/);
  });
});

describe('stripping an MPEG audio file', () => {
  it('drops a reportable frame and keeps the tag exactly as long', () => {
    const tag = id3Tag([
      id3Frame('GEOB', ascii(`c2pa manifest ${compactAt(DISCLOSING_MS)}`)),
      id3Frame('TIT2', ascii('a title')),
    ]);
    const dirty = concat(tag, mp3Audio());
    expect(scanBinaryBlob('a.mp3', dirty).length).toBeGreaterThan(0);
    const out = strippedBytes('a.mp3', dirty);
    expect(scanBinaryBlob('a.mp3', out)).toEqual([]);
    expect(out.length).toBe(dirty.length);
    expect(Buffer.from(out).includes(Buffer.from('c2pa'))).toBe(false);
    expect(Buffer.from(out).includes(Buffer.from('a title'))).toBe(true);
  });

  it('drops an unrecognised frame, which the tag format defines as metadata', () => {
    // The refusal over unrecognised regions stops at this parser. Everything a
    // tag holds is a frame, and a frame is metadata by the format's own
    // definition, so a frame this gate could not name still holds nothing a
    // decoder reads and dropping it costs nothing.
    const tag = id3Tag([id3Frame('TDRL', ascii(isoAt(DISCLOSING_MS)))]);
    const dirty = concat(tag, mp3Audio());
    expect(scanBinaryBlob('a.mp3', dirty).some((finding) => finding.kind === 'id3:unnamed')).toBe(
      true
    );
    const out = strippedBytes('a.mp3', dirty);
    expect(scanBinaryBlob('a.mp3', out)).toEqual([]);
    expect(out.length).toBe(dirty.length);
  });

  it('leaves the coded frames byte-identical', () => {
    const tag = id3Tag([id3Frame('TSSE', ascii('Lavf58.76.100'))]);
    const dirty = concat(tag, mp3Audio());
    const out = strippedBytes('a.mp3', dirty);
    expect(
      Buffer.from(out.subarray(out.length - MP3_FRAME_BYTES * 2)).equals(Buffer.from(mp3Audio()))
    ).toBe(true);
  });

  it('drops several reportable frames at once', () => {
    const tag = id3Tag([
      id3Frame('TXXX', ascii(`run ${isoAt(DISCLOSING_MS)}`)),
      id3Frame('TIT2', ascii('a title')),
      id3Frame('TSSE', ascii('Lavf58.76.100')),
    ]);
    const dirty = concat(tag, mp3Audio());
    const out = strippedBytes('a.mp3', dirty);
    expect(scanBinaryBlob('a.mp3', out)).toEqual([]);
    expect(out.length).toBe(dirty.length);
    expect(Buffer.from(out).includes(Buffer.from('a title'))).toBe(true);
  });
});

describe('the strip policy table', () => {
  it('states a reason long enough to act on wherever no remedy ships', () => {
    const thin = BINARY_FORMATS.filter((format) => {
      const policy = STRIP_POLICY[format.id];
      return !('remedy' in policy) && policy.unsupported.length < 40;
    }).map((format) => format.id);
    expect(thin).toEqual([]);
  });

  it('locates a content stream for every format it will strip', () => {
    const specimens: readonly (readonly [string, Uint8Array])[] = [
      ['png', png({ imageData: IMAGE_DATA })],
      ['isobmff', concat(ISO_FTYP, isoBox('mdat', CODED_SAMPLES))],
      ['matroska', matroska([])],
      ['flac', flacStream([flacBlock(FLAC_TYPE_PADDING, filled(8, 0), true)])],
      ['mp3', concat(id3Tag([]), mp3Audio())],
    ];
    const remedied = BINARY_FORMATS.filter((format) => 'remedy' in STRIP_POLICY[format.id]).map(
      (format) => format.id
    );
    expect(specimens.map(([id]) => id)).toEqual(remedied);
    for (const [, bytes] of specimens) expect(contentSpans(bytes)).toBeDefined();
  });
});

describe('a format with no lossless remedy', () => {
  it('reports the reason and writes nothing', () => {
    const dirty = gif([gifComment('Made with ImageMagick 7')]);
    expect(scanBinaryBlob('a.gif', dirty).length).toBeGreaterThan(0);
    const result = stripBinaryBlob('a.gif', dirty);
    expect(result.status).toBe('unsupported');
    expect(result.reasons.join(' ')).toContain('content-stream locator');
    expect(Buffer.from(result.bytes).equals(Buffer.from(dirty))).toBe(true);
  });

  it('still reports a file of that format the detector says nothing about as clean', () => {
    expect(stripBinaryBlob('a.gif', gif([])).status).toBe('clean');
  });
});

describe('a file wearing the wrong extension', () => {
  it('names the true format and strips the metadata anyway', () => {
    const dirty = png({
      ancillary: [pngTextChunk('Software', 'Matplotlib 3.9.0')],
      imageData: IMAGE_DATA,
    });
    const result = stripBinaryBlob('cover.jpg', dirty);
    expect(result.status).toBe('stripped');
    expect(result.reasons.join(' ')).toContain('PNG image');
    expect(scanBinaryBlob('cover.png', result.bytes)).toEqual([]);
  });

  it('does not let the rename it cannot perform read as a clean pass', () => {
    const result = stripBinaryBlob('cover.jpg', png({ imageData: IMAGE_DATA }));
    expect(result.status).toBe('incomplete');
    expect(result.reasons.length).toBeGreaterThan(0);
  });
});

describe('assertContentPreserved', () => {
  it('accepts a strip that left the image data alone', () => {
    const before = png({
      ancillary: [pngTextChunk('Software', 'x')],
      imageData: IMAGE_DATA,
    });
    expect(() => {
      assertContentPreserved({ file: 'a.png', before, after: png({ imageData: IMAGE_DATA }) });
    }).not.toThrow();
  });

  it('rejects a strip that re-encoded the image data', () => {
    expect(() => {
      assertContentPreserved({
        file: 'a.png',
        before: png({ imageData: IMAGE_DATA }),
        after: png({ imageData: filled(96, 0x11) }),
      });
    }).toThrow(/re-encode/);
  });

  it('rejects a comparison it cannot locate content for', () => {
    expect(() => {
      assertContentPreserved({ file: 'a.bin', before: filled(32, 0x01), after: filled(32, 0x01) });
    }).toThrow(/content bytes/);
  });

  it('rejects a proof whose exclusions leave no content behind', () => {
    const bytes = png({ imageData: IMAGE_DATA });
    expect(() => {
      assertContentPreserved({
        file: 'a.png',
        before: bytes,
        after: bytes,
        excluded: contentSpans(bytes) ?? [],
      });
    }).toThrow(/share of the content/);
  });

  // Both endpoints of the band, because a bound held only from the inside is a
  // bound nothing pins: the located content here is IMAGE_DATA.
  it('accepts exclusions covering exactly the largest admitted share', () => {
    const bytes = png({ imageData: IMAGE_DATA });
    const [span] = contentSpans(bytes) ?? [];
    const start = span?.start ?? 0;
    // Ninety-six located bytes, a quarter of which is twenty-four.
    expect(() => {
      assertContentPreserved({
        file: 'a.png',
        before: bytes,
        after: bytes,
        excluded: [{ start, end: start + 24 }],
      });
    }).not.toThrow();
  });

  it('rejects exclusions one byte beyond the largest admitted share', () => {
    const bytes = png({ imageData: IMAGE_DATA });
    const [span] = contentSpans(bytes) ?? [];
    const start = span?.start ?? 0;
    expect(() => {
      assertContentPreserved({
        file: 'a.png',
        before: bytes,
        after: bytes,
        excluded: [{ start, end: start + 25 }],
      });
    }).toThrow(/share of the content/);
  });
});

describe('field widths a container may choose', () => {
  it('zeroes the 64-bit form of a header box’s time fields', () => {
    const header = isoWideHeaderBox(
      'mvhd',
      BigInt(ISO_EPOCH_OFFSET_SECONDS + DISCLOSING_SECONDS),
      BigInt(ISO_EPOCH_OFFSET_SECONDS + DISCLOSING_SECONDS + 20)
    );
    const dirty = concat(ISO_FTYP, isoBox('moov', header), isoBox('mdat', CODED_SAMPLES));
    expect(scanBinaryBlob('a.mp4', dirty).length).toBeGreaterThan(0);
    const out = strippedBytes('a.mp4', dirty);
    expect(scanBinaryBlob('a.mp4', out)).toEqual([]);
    expect(out.length).toBe(dirty.length);
  });

  it('keeps a tag’s footer where the tag declares one', () => {
    const tag = id3TagWithFooter([
      id3Frame('GEOB', ascii(`c2pa manifest ${compactAt(DISCLOSING_MS)}`)),
      id3Frame('TIT2', ascii('a title')),
    ]);
    const dirty = concat(tag, mp3Audio());
    expect(scanBinaryBlob('a.mp3', dirty).length).toBeGreaterThan(0);
    const out = strippedBytes('a.mp3', dirty);
    expect(scanBinaryBlob('a.mp3', out)).toEqual([]);
    expect(out.length).toBe(dirty.length);
    // The footer is the tag's last ten bytes by definition, so the padding that
    // replaces a dropped frame goes in front of it, not behind it — and reaches
    // it, with no byte of the frames left displaced between the two.
    const audioStart = out.length - MP3_FRAME_BYTES * 2;
    expect(Buffer.from(out.subarray(audioStart - 10, audioStart - 7)).toString('latin1')).toBe(
      '3DI'
    );
    const padStart = Buffer.from(out).indexOf(Buffer.from('a title')) + 'a title'.length;
    expect(padStart).toBeGreaterThan(0);
    expect(
      Buffer.from(out.subarray(padStart, audioStart - 10)).equals(
        Buffer.alloc(audioStart - 10 - padStart)
      )
    ).toBe(true);
  });
});

/**
 * An mdat whose leading bytes a test lays out itself, to craft framing the walk
 * must reject, padded out to a realistic payload behind it.
 */
function craftedMdat(body: Uint8Array): Uint8Array {
  return concat(ISO_FTYP, isoBox('mdat', concat(body, CODED_SAMPLES)));
}

const BANNER = 'x264 - core 163 r3060 - H.264/MPEG-4 AVC codec';

describe('framing the SEI search must not trust', () => {
  it('reads the payload extent of a well-formed unit', () => {
    const nal = concat(Uint8Array.from([0x06, 0x05, 20]), filled(16, 0x2b), ascii('abcd'));
    const view = Buffer.from(nal);
    expect(seiPayload(view, 2, nal.length)).toEqual({ dataStart: 19, end: 23 });
  });

  it('rejects a unit with no room for a payload header at all', () => {
    const nal = Uint8Array.from([0x06, 0x05]);
    expect(seiPayload(Buffer.from(nal), 2, 2)).toBeUndefined();
  });

  it('rejects a size chain that runs to the end of the unit', () => {
    const nal = Uint8Array.from([0x06, 0x05, 0xff, 0xff]);
    expect(seiPayload(Buffer.from(nal), 2, nal.length)).toBeUndefined();
  });

  it('rejects a payload declaring more bytes than the unit holds', () => {
    const nal = concat(Uint8Array.from([0x06, 0x05, 200]), filled(16, 0x2b), ascii('abcd'));
    expect(seiPayload(Buffer.from(nal), 2, nal.length)).toBeUndefined();
  });

  it('rejects a payload too short to hold even its own uuid', () => {
    const nal = concat(Uint8Array.from([0x06, 0x05, 16]), filled(16, 0x2b));
    expect(seiPayload(Buffer.from(nal), 2, nal.length)).toBeUndefined();
  });

  it('falls back to the printable run when the unit length overruns the payload', () => {
    const dirty = craftedMdat(
      concat(
        u32be(0xff_ff_ff),
        Uint8Array.from([0x06, 0x05, 60]),
        filled(16, 0x2b),
        ascii(BANNER),
        Uint8Array.from([0x00])
      )
    );
    expect(scanBinaryBlob('a.mp4', dirty).length).toBeGreaterThan(0);
    const out = strippedBytes('a.mp4', dirty);
    expect(scanBinaryBlob('a.mp4', out)).toEqual([]);
    expect(out.length).toBe(dirty.length);
  });

  it('rejects a candidate whose unit runs past the coded range it sits in', () => {
    // The declared length is internally consistent and points far outside the
    // range. Without the enclosure guard the payload extent is believed, and the
    // overwrite reaches past the printable run into bytes nothing reported.
    const marker = 'MARKERTEXT';
    const payload = concat(
      filled(16, 0x01),
      ascii(BANNER.slice(0, 16)),
      Uint8Array.from([0x01]),
      ascii(marker)
    );
    const dirty = mdatOf(
      concat(u32be(0x00_ff_ff_ff), Uint8Array.from([0x06, 0x05, payload.length]), payload),
      8192
    );
    const at = Buffer.from(dirty).indexOf(Buffer.from(marker));
    const out = strippedBytes('a.mp4', dirty);
    expect(scanBinaryBlob('a.mp4', out)).toEqual([]);
    expect(Buffer.from(out.subarray(at, at + marker.length)).toString('latin1')).toBe(marker);
  });

  it('rejects a candidate whose declared payload has no room and falls back', () => {
    const dirty = craftedMdat(
      concat(
        u32be(53),
        Uint8Array.from([0x06, 0x05, 60]),
        ascii(BANNER.slice(0, 50)),
        Uint8Array.from([0x00])
      )
    );
    expect(scanBinaryBlob('a.mp4', dirty).length).toBeGreaterThan(0);
    const out = strippedBytes('a.mp4', dirty);
    expect(scanBinaryBlob('a.mp4', out)).toEqual([]);
    expect(out.length).toBe(dirty.length);
  });

  it('falls back to the printable run when the literal sits inside the payload uuid', () => {
    const dirty = craftedMdat(
      concat(
        u32be(43),
        Uint8Array.from([0x06, 0x05, 40]),
        ascii(BANNER.slice(0, 40)),
        Uint8Array.from([0x00])
      )
    );
    expect(scanBinaryBlob('a.mp4', dirty).length).toBeGreaterThan(0);
    const out = strippedBytes('a.mp4', dirty);
    expect(scanBinaryBlob('a.mp4', out)).toEqual([]);
    expect(out.length).toBe(dirty.length);
  });

  it('carries the printable text around a literal away with it', () => {
    const dirty = craftedMdat(
      concat(
        filled(8, 0x37),
        Uint8Array.from([0x00]),
        ascii('encoded by Lavc58.134.100 on a workstation'),
        Uint8Array.from([0x00])
      )
    );
    expect(scanBinaryBlob('a.mp4', dirty).length).toBeGreaterThan(0);
    const out = strippedBytes('a.mp4', dirty);
    expect(scanBinaryBlob('a.mp4', out)).toEqual([]);
    // Both sides of the literal go: clearing only the four bytes the detector
    // matches would leave the version string beside them and read as fixed.
    expect(Buffer.from(out).includes(Buffer.from('encoded by'))).toBe(false);
    expect(Buffer.from(out).includes(Buffer.from('on a workstation'))).toBe(false);
  });
});

describe('a box that declares no size of its own', () => {
  it('writes the real extent in when it retypes one to free', () => {
    const dirty = concat(
      ISO_FTYP,
      isoBox('mdat', CODED_SAMPLES),
      isoZeroSizedBox('uuid', concat(filled(16, 0x2b), ascii(`c2pa ${compactAt(DISCLOSING_MS)}`)))
    );
    expect(scanBinaryBlob('a.mp4', dirty).length).toBeGreaterThan(0);
    const out = strippedBytes('a.mp4', dirty);
    expect(scanBinaryBlob('a.mp4', out)).toEqual([]);
    expect(out.length).toBe(dirty.length);
    expect(
      codedSamplesOf(out).subarray(0, CODED_SAMPLES.length).equals(Buffer.from(CODED_SAMPLES))
    ).toBe(true);
  });

  it('refuses when the box swallows the coded payload, rather than zeroing it', () => {
    const dirty = concat(
      ISO_FTYP,
      isoZeroSizedBox(
        'uuid',
        concat(filled(16, 0x2b), ascii('c2pa'), isoBox('mdat', CODED_SAMPLES))
      )
    );
    expect(() => stripBinaryBlob('a.mp4', dirty)).toThrow(/content bytes/);
  });
});

describe('a container whose only finding no edit can fix', () => {
  it('reports a tag with nothing reportable in it as unfinished, not stripped', () => {
    const dirty = concat(id3Tag([id3Frame('TIT2', ascii('a title'))]), mp3Audio());
    const result = stripBinaryBlob('sound.wav', dirty);
    expect(result.status).toBe('incomplete');
    expect(result.edits).toEqual([]);
    expect(result.reasons.join(' ')).toContain('MPEG audio');
  });
});

describe('the net under a remedy that does not finish', () => {
  it('reports a strip that left a finding standing as unfinished', () => {
    const dirty = png({
      ancillary: [pngChunk('gAMA', u32be(45_455)), pngTextChunk('Software', 'ImageMagick 7')],
      imageData: IMAGE_DATA,
    });
    // An edit that drops the wrong chunk: content survives, the disclosure does not.
    const gama = Buffer.from(dirty).indexOf(Buffer.from('gAMA')) - 4;
    const result = verifiedStrip({
      file: 'a.png',
      format: 'png',
      bytes: dirty,
      edits: [{ start: gama, end: gama + 16, data: new Uint8Array(0), reason: 'test' }],
    });
    expect(result.status).toBe('incomplete');
    expect(result.contentDigest).toBe('');
    expect(Buffer.from(result.bytes).equals(Buffer.from(dirty))).toBe(true);
    expect(result.reasons.join(' ')).toContain('still present');
  });

  it('accepts a strip that did finish', () => {
    const dirty = png({
      ancillary: [pngTextChunk('Software', 'ImageMagick 7')],
      imageData: IMAGE_DATA,
    });
    const at = Buffer.from(dirty).indexOf(Buffer.from('tEXt')) - 4;
    const length = Buffer.from(dirty).readUInt32BE(at) + 12;
    const result = verifiedStrip({
      file: 'a.png',
      format: 'png',
      bytes: dirty,
      edits: [{ start: at, end: at + length, data: new Uint8Array(0), reason: 'test' }],
    });
    expect(result.status).toBe('stripped');
    expect(result.contentDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});

/** A printable run of exactly `length` bytes carrying `literal`, delimited by non-printable bytes. */
function printableRun(literal: string, length: number): Uint8Array {
  const filler = 'A'.repeat(length - literal.length);
  return concat(Uint8Array.from([0x00]), ascii(literal + filler), Uint8Array.from([0x00]));
}

/** An mdat of exactly `payload` bytes, the rest non-printable so no run escapes. */
function mdatOf(head: Uint8Array, payload: number): Uint8Array {
  return concat(ISO_FTYP, isoBox('mdat', concat(head, filled(payload - head.length, 0x01))));
}

describe('an overwrite extent the file itself declares', () => {
  it('refuses a unit whose declared payload spans most of the coded range', () => {
    // The measured attack: a length prefix and size chain that are internally
    // consistent and cover the whole payload. Consistency is not a bound.
    const dirty = concat(
      ISO_FTYP,
      isoBox('mdat', seiUnit({ banner: `${BANNER}${'A'.repeat(4000)}`, coded: new Uint8Array(0) }))
    );
    const result = stripBinaryBlob('a.mp4', dirty);
    expect(result.status).toBe('refused');
    expect(Buffer.from(result.bytes).equals(Buffer.from(dirty))).toBe(true);
    expect(scanBinaryBlob('a.mp4', result.bytes).length).toBeGreaterThan(0);
  });

  // The edges below are written as numbers rather than computed from the
  // constants they pin. A fixture derived from the bound it is testing moves
  // with the bound, so every mutation of it stays green — which is how nine of
  // these read as covered while pinning nothing.
  it('accepts a run of exactly the largest admitted length', () => {
    const dirty = mdatOf(printableRun('Lavc', 4096), 65_536);
    expect(stripBinaryBlob('a.mp4', dirty).status).toBe('stripped');
  });

  it('refuses a run one byte longer than the largest admitted length', () => {
    const result = stripBinaryBlob('a.mp4', mdatOf(printableRun('Lavc', 4097), 65_536));
    expect(result.status).toBe('refused');
    expect(result.reasons.join(' ')).toContain('coded payload');
  });

  it('accepts a run of exactly the largest admitted share of its range', () => {
    expect(stripBinaryBlob('a.mp4', mdatOf(printableRun('Lavc', 128), 1024)).status).toBe(
      'stripped'
    );
  });

  it('refuses a run one byte beyond the largest admitted share of its range', () => {
    expect(stripBinaryBlob('a.mp4', mdatOf(printableRun('Lavc', 129), 1024)).status).toBe(
      'refused'
    );
  });

  it('refuses a run whose share exceeds its range by a single byte', () => {
    // 128 x 8 is one more than 1023, which separates "greater than the range"
    // from "greater than the range plus one".
    expect(stripBinaryBlob('a.mp4', mdatOf(printableRun('Lavc', 128), 1023)).status).toBe(
      'refused'
    );
  });
});

/**
 * `count` occurrences of `literal`, each past the candidate window from the last,
 * inside a payload padded with non-printable bytes.
 *
 * Every occurrence charges one candidate window plus its own four-byte run —
 * 4100 bytes — so the count is what sets the cost.
 */
function occurrences(literal: string, count: number): Uint8Array {
  const unit = concat(Uint8Array.from([0]), ascii(literal), Uint8Array.from([0]));
  return concat(
    ...Array.from({ length: count }, () => concat(unit, filled(4200 - unit.length, 0x01)))
  );
}

describe('work over untrusted bytes', () => {
  it('refuses a blob that would spend the whole work budget rather than walking it', () => {
    const head = concat(filled(4200, 0x01), occurrences('Lavc', 400));
    const result = stripBinaryBlob('a.mp4', concat(ISO_FTYP, isoBox('mdat', head)));
    expect(result.status).toBe('refused');
    expect(result.reasons.join(' ')).toContain('work');
  });

  it('walks a blob carrying two reported literals once, not once per literal', () => {
    // Two hundred occurrences cost about 820 kilobytes of stepping against a
    // budget of one megabyte; walking them a second time for the second reported
    // literal would not fit.
    const head = concat(filled(4200, 0x01), occurrences('Lavc', 100), occurrences('LAME', 100));
    const dirty = concat(ISO_FTYP, isoBox('mdat', head));
    expect(scanBinaryBlob('a.mp4', dirty).length).toBe(2);
    const result = stripBinaryBlob('a.mp4', dirty);
    expect(result.status).toBe('stripped');
    expect(result.walkedBytes).toBeLessThan(1_048_576);
  });
});

describe('a header box the remedy must keep', () => {
  it.each(['mvhd', 'tkhd', 'mdhd'])('zeroes only %s’s time pair', (type) => {
    const trailing = filled(12, 0x11);
    const header = isoHeaderBox(
      type,
      ISO_EPOCH_OFFSET_SECONDS + DISCLOSING_SECONDS,
      ISO_EPOCH_OFFSET_SECONDS + DISCLOSING_SECONDS + 20
    );
    const dirty = concat(ISO_FTYP, isoBox('moov', header), isoBox('mdat', CODED_SAMPLES));
    expect(scanBinaryBlob('a.mp4', dirty).length).toBeGreaterThan(0);
    const out = strippedBytes('a.mp4', dirty);
    expect(scanBinaryBlob('a.mp4', out)).toEqual([]);

    const at = Buffer.from(out).indexOf(Buffer.from(type));
    // The box survives as itself: retyping it to a skippable box would also
    // clear the finding, and would take the movie's timescale with it.
    expect(at).toBeGreaterThan(0);
    const body = at + 4;
    expect(Buffer.from(out.subarray(body + 4, body + 12)).equals(Buffer.alloc(8))).toBe(true);
    // Everything past the time pair is the timescale and duration, which a
    // wrongly-wide field width would clobber.
    expect(Buffer.from(out.subarray(body + 12, body + 24)).equals(Buffer.from(trailing))).toBe(
      true
    );
  });
});

describe('the SEI recognizer against its own fallback', () => {
  // A payload the fallback cannot reach: the run stops at the non-printable
  // byte, so anything the SEI path covers past it is the difference between the
  // two, and every guard in the recognizer is what selects it.
  const BEYOND_THE_RUN = 'BUILDHOST';
  const seiPayloadBytes = concat(ascii(BANNER), Uint8Array.from([0x01]), ascii(BEYOND_THE_RUN));

  it('overwrites the whole unit payload, not merely the printable run', () => {
    const dirty = concat(
      ISO_FTYP,
      isoBox('mdat', seiUnit({ banner: seiPayloadBytes, coded: CODED_SAMPLES }))
    );
    const out = strippedBytes('a.mp4', dirty);
    expect(scanBinaryBlob('a.mp4', out)).toEqual([]);
    expect(Buffer.from(out).includes(Buffer.from(BEYOND_THE_RUN))).toBe(false);
  });

  it('stops at the end of the unit payload and leaves its trailing byte alone', () => {
    const dirty = concat(
      ISO_FTYP,
      isoBox('mdat', seiUnit({ banner: seiPayloadBytes, coded: CODED_SAMPLES }))
    );
    const out = strippedBytes('a.mp4', dirty);
    const trailer = Buffer.from(dirty).indexOf(Buffer.from(BEYOND_THE_RUN)) + BEYOND_THE_RUN.length;
    // Both edges of the extent. The unit's rbsp trailing byte sits immediately
    // past the payload and its sixteen-byte uuid immediately before the user
    // data; an extent one byte wide of the truth at either end eats one of them,
    // and the content proof cannot see it because the excluded set is exactly
    // what the remedy rewrote.
    expect(out[trailer]).toBe(0x80);
    expect(Buffer.from(out.subarray(trailer + 1)).equals(Buffer.from(CODED_SAMPLES))).toBe(true);
    const banner = Buffer.from(dirty).indexOf(Buffer.from(BANNER));
    expect(Buffer.from(out.subarray(banner - 16, banner)).equals(Buffer.alloc(16, 0x2b))).toBe(
      true
    );
  });
});

describe('the identity of a replacement element', () => {
  it('leaves a void element where a Matroska element was', () => {
    const dirty = matroska([ebmlElement(MATROSKA_ID_MUXING_APP, ascii('Lavf58.76.100'))]);
    const at = Buffer.from(dirty).indexOf(Buffer.from(MATROSKA_ID_MUXING_APP));
    const out = strippedBytes('a.webm', dirty);
    expect(out[at]).toBe(0xec);
  });

  it('leaves a free box where an ISO-BMFF metadata box was', () => {
    const uuid = isoBox(
      'uuid',
      concat(filled(16, 0x2b), ascii(`c2pa ${compactAt(DISCLOSING_MS)}`))
    );
    const dirty = concat(ISO_FTYP, uuid, isoBox('mdat', CODED_SAMPLES));
    const at = Buffer.from(dirty).indexOf(Buffer.from('uuid')) - 4;
    const out = strippedBytes('a.mp4', dirty);
    expect(Buffer.from(out.subarray(at + 4, at + 8)).toString('latin1')).toBe('free');
  });

  it('leaves a padding block where a FLAC metadata block was', () => {
    const dirty = flacStream([VORBIS, flacBlock(FLAC_TYPE_PADDING, filled(16, 0), true)]);
    // The signature and STREAMINFO are fixed width, so the next block is here.
    const at = 4 + 4 + 34;
    expect(dirty[at]).toBeDefined();
    const out = strippedBytes('a.flac', dirty);
    expect((out[at] ?? 0) & 0x7f).toBe(FLAC_TYPE_PADDING);
  });

  // Both sides of the one-byte size form's capacity. A one-byte size holds 126
  // at most: 127 is the reserved all-ones value meaning "unknown size", which
  // would run the void element to the end of the segment and swallow whatever
  // follows it.
  it.each([
    [125, 1, 126],
    [126, 2, 126],
  ])('replaces a %i-byte body with a %i-byte size holding %i', (body, width, value) => {
    const element = ebmlElement(
      MATROSKA_ID_MUXING_APP,
      concat(ascii('Lavf'), filled(body - 4, 0x41))
    );
    const dirty = matroska([element]);
    const at = Buffer.from(dirty).indexOf(Buffer.from(MATROSKA_ID_MUXING_APP));
    const out = strippedBytes('a.webm', dirty);
    expect(out[at]).toBe(0xec);
    expect(readVintAt(out, at + 1)).toEqual({ value, width });
    expect(clusterOf(out).equals(clusterOf(dirty))).toBe(true);
  });
});

/** The size vint at `at`, decoded the way a Matroska reader decodes it. */
function readVintAt(bytes: Uint8Array, at: number): { value: number; width: number } {
  const first = bytes[at] ?? 0;
  let width = 1;
  while (width <= 8 && (first & (0x1_00 >> width)) === 0) width += 1;
  let value = first & ((0x1_00 >> width) - 1);
  for (let index = 1; index < width; index++) value = value * 256 + (bytes[at + index] ?? 0);
  return { value, width };
}

describe('the bounds of the one remedy that writes inside content', () => {
  const runAt = (byte: number): Uint8Array =>
    concat(
      Uint8Array.from([0x00]),
      Uint8Array.from([byte]),
      ascii('Lavc58.134.100'),
      Uint8Array.from([byte]),
      Uint8Array.from([0x00])
    );

  /** True when some planned edit covers `offset` — asked of the plan, not of the output. */
  function overwrites(result: StripResult, offset: number): boolean {
    return result.edits.some((edit) => edit.start <= offset && edit.end > offset);
  }

  // Asked of the planned span rather than of the byte that landed there. The
  // fill is a space, so at the bottom of the band the written byte equals the
  // fixture byte and an output comparison cannot fail for its own subject.
  it('carries away a byte at the bottom of the printable band', () => {
    const dirty = mdatOf(runAt(0x20), 4096);
    const result = stripBinaryBlob('a.mp4', dirty);
    const at = Buffer.from(dirty).indexOf(Buffer.from('Lavc'));
    expect(result.status).toBe('stripped');
    expect(overwrites(result, at - 1)).toBe(true);
  });

  it('carries away a byte at the top of the printable band', () => {
    const dirty = mdatOf(runAt(0x7e), 4096);
    const result = stripBinaryBlob('a.mp4', dirty);
    const at = Buffer.from(dirty).indexOf(Buffer.from('Lavc'));
    expect(result.status).toBe('stripped');
    expect(overwrites(result, at - 1)).toBe(true);
  });

  it('leaves a byte one below the printable band where it is', () => {
    const dirty = mdatOf(runAt(0x1f), 4096);
    const result = stripBinaryBlob('a.mp4', dirty);
    const at = Buffer.from(dirty).indexOf(Buffer.from('Lavc'));
    expect(result.bytes[at - 1]).toBe(0x1f);
    expect(overwrites(result, at - 1)).toBe(false);
  });

  it('leaves a byte one above the printable band where it is', () => {
    const dirty = mdatOf(runAt(0x7f), 4096);
    const result = stripBinaryBlob('a.mp4', dirty);
    const at = Buffer.from(dirty).indexOf(Buffer.from('Lavc'));
    expect(result.bytes[at - 1]).toBe(0x7f);
    expect(overwrites(result, at - 1)).toBe(false);
  });

  it('fills with a byte that cannot synthesise a start-code emulation', () => {
    const dirty = mdatOf(runAt(0x41), 4096);
    const out = strippedBytes('a.mp4', dirty);
    const at = Buffer.from(dirty).indexOf(Buffer.from('Lavc'));
    const written = Buffer.from(out.subarray(at, at + 'Lavc58.134.100'.length));
    // A space, stated as one: reading the constant back out of the module would
    // make this assertion agree with whatever the constant happened to say.
    expect([...written].every((byte) => byte === 0x20)).toBe(true);
    // A zero fill would put three zero bytes in a row into a bitstream that
    // reserves that sequence, which desynchronises a decoder rather than
    // disclosing anything — a failure no gate in this repository can see.
    expect(written.includes(Buffer.from([0, 0, 0]))).toBe(false);
  });

  it('never walks past the end of the range it was given', () => {
    // Unreachable through a well-formed container, because the byte past a coded
    // payload opens a size word — so the property is asserted where it lives.
    const bytes = concat(ascii('Lavc'), ascii('AAAA'));
    const span = literalRunSpan({
      bytes,
      view: Buffer.from(bytes),
      range: { location: 'mdat', start: 0, end: 2 },
      at: 0,
      length: 4,
      meter: newWorkMeter(),
    });
    expect(span.end).toBe(2);
  });
});

describe('which offsets belong to the coded payload', () => {
  const LITERAL = 'Lavc58.134.100';

  // Half-open at both ends, asserted at both ends. A container cannot put a
  // literal exactly on the far edge — the byte past a coded payload opens a size
  // word — so the boundary is asserted where it is decided.
  it.each([
    [9, false],
    [10, true],
    [19, true],
    [20, false],
  ])('places offset %i inside the range: %s', (at, inside) => {
    const found = rangeContaining([{ location: 'mdat', start: 10, end: 20 }], at);
    expect(found !== undefined).toBe(inside);
  });

  it('finds the right range among several', () => {
    const ranges = [
      { location: 'mdat', start: 0, end: 10 },
      { location: 'mdat', start: 20, end: 30 },
      { location: 'mdat', start: 40, end: 50 },
    ];
    expect(rangeContaining(ranges, 25)?.start).toBe(20);
    expect(rangeContaining(ranges, 45)?.start).toBe(40);
    expect(rangeContaining(ranges, 35)).toBeUndefined();
  });

  it('places a literal by offset when the container declares its ranges out of order', () => {
    // The search over the ranges is a binary one, so a container that declares
    // them in any order but ascending would hide occurrences from it.
    const bytes = new Uint8Array(10_000);
    bytes.set(ascii(LITERAL), 8500);
    const descending = [
      { location: 'mdat', start: 8000, end: 10_000 },
      { location: 'mdat', start: 4000, end: 6000 },
      { location: 'mdat', start: 0, end: 2000 },
    ];
    const plan = bitstreamSpans(bytes, Buffer.from(bytes), descending, newWorkMeter());
    expect(plan.spans).toEqual([{ start: 8500, end: 8500 + LITERAL.length }]);
  });

  it('overwrites a literal that opens the coded payload', () => {
    const dirty = mdatOf(concat(ascii(LITERAL), Uint8Array.from([0x00])), 4096);
    const at = Buffer.from(dirty).indexOf(Buffer.from(LITERAL));
    const out = strippedBytes('a.mp4', dirty);
    expect(out[at]).toBe(0x20);
  });

  it('remedies a literal in a box after the coded payload as the box it sits in', () => {
    const dirty = concat(
      ISO_FTYP,
      isoBox('mdat', filled(4096, 0x01)),
      isoBox('uuid', concat(filled(16, 0x2b), ascii(LITERAL)))
    );
    const at = Buffer.from(dirty).indexOf(Buffer.from(LITERAL));
    const result = stripBinaryBlob('a.mp4', dirty);
    expect(result.status).toBe('stripped');
    expect(result.bytes.length).toBe(dirty.length);
    expect(result.bytes[at]).toBe(0x00);
  });

  it('refuses a literal in the box that declares what the container is', () => {
    const dirty = concat(
      isoBox('ftyp', concat(ascii('isom'), u32be(512), ascii(LITERAL))),
      isoBox('mdat', filled(4096, 0x01))
    );
    const result = stripBinaryBlob('a.mp4', dirty);
    expect(result.status).toBe('refused');
    expect(Buffer.from(result.bytes).equals(Buffer.from(dirty))).toBe(true);
    expect(result.reasons.join(' ')).toContain('what removing it costs');
  });
});

describe('the leftover-finding net at its endpoint', () => {
  it('reports a strip that left exactly one finding as unfinished', () => {
    const dirty = png({
      // The second chunk is worth exactly one finding, so dropping the first
      // leaves the net facing the single-finding case rather than a comfortable
      // handful: a threshold pinned from its interior is not pinned.
      ancillary: [pngTextChunk('Software', 'ImageMagick 7'), pngTextChunk('Comment', 'a note')],
      imageData: IMAGE_DATA,
    });
    const at = Buffer.from(dirty).indexOf(Buffer.from('tEXt')) - 4;
    const length = Buffer.from(dirty).readUInt32BE(at) + 12;
    const edits = [{ start: at, end: at + length, data: new Uint8Array(0), reason: 'test' }];
    // The endpoint is genuinely one finding, not a comfortable handful.
    expect(scanBinaryBlob('a.png', applyByteEdits(dirty, edits)).length).toBe(1);

    const result = verifiedStrip({ file: 'a.png', format: 'png', bytes: dirty, edits });
    expect(result.status).toBe('incomplete');
    expect(result.reasons.filter((reason) => reason.includes('still present'))).toHaveLength(1);
    expect(Buffer.from(result.bytes).equals(Buffer.from(dirty))).toBe(true);
  });
});

describe('bounds moved rather than removed', () => {
  const LAVC = 'Lavc58.134.100';

  /** One occurrence every `stride` bytes, the first at `first`, inside a padded payload. */
  function walkingBlob(first: number, count: number, stride: number): Uint8Array {
    const unit = concat(Uint8Array.from([0]), ascii('Lavc'), Uint8Array.from([0]));
    const parts: Uint8Array[] = [filled(first - 1, 0x01)];
    for (let index = 0; index < count; index++) {
      parts.push(unit, filled(stride - unit.length, 0x01));
    }
    return concat(ISO_FTYP, isoBox('mdat', concat(...parts)));
  }

  // 255 occurrences past the candidate window charge 4100 apiece, the first
  // charges its own offset, and the proof charges one located span plus 256
  // excluded ones: 255 x 4100 + 2818 + 257 is exactly 1048576. The numbers are
  // written out because deriving them from the budget would move the fixture
  // with the bound and pin nothing.
  it('accepts a blob whose stepping costs exactly the work budget', () => {
    const result = stripBinaryBlob('a.mp4', walkingBlob(2819, 256, 4200));
    expect(result.status).toBe('stripped');
    expect(result.walkedBytes).toBe(1_048_576);
  });

  it('refuses a blob whose stepping costs one byte more', () => {
    expect(() => stripBinaryBlob('a.mp4', walkingBlob(2820, 256, 4200))).toThrow(/work/);
  });

  it('never charges a negative amount for an occurrence at the payload start', () => {
    // The candidate window's floor sits four bytes past the range start, so an
    // occurrence at the very first byte would otherwise charge minus four and
    // hand budget back to the blob that spent it. Four for the run, two for the
    // proof's one located span and one exclusion.
    const body = concat(ascii('Lavc'), Uint8Array.from([0x00]), filled(4096, 0x01));
    const result = stripBinaryBlob('a.mp4', concat(ISO_FTYP, isoBox('mdat', body)));
    expect(result.status).toBe('stripped');
    expect(result.walkedBytes).toBe(6);
  });

  /** A unit whose declared length puts its end exactly `past` bytes beyond the range. */
  function enclosedUnit(past: number): Uint8Array {
    const marker = 'MARKERTEXT';
    const payload = concat(
      filled(16, 0x01),
      ascii(BANNER.slice(0, 16)),
      Uint8Array.from([0x01]),
      ascii(marker)
    );
    const nal = concat(Uint8Array.from([0x06, 0x05, payload.length]), payload);
    // Non-printable padding first, so the unit ends exactly at the payload's end.
    const body = concat(filled(8192, 0x01), u32be(nal.length + past), nal);
    return concat(ISO_FTYP, isoBox('mdat', body));
  }

  it('reads a unit whose declared end lands exactly on the range end', () => {
    const dirty = enclosedUnit(0);
    const at = Buffer.from(dirty).indexOf(Buffer.from('MARKERTEXT'));
    const out = strippedBytes('a.mp4', dirty);
    expect(out[at]).toBe(0x20);
  });

  it('refuses a unit whose declared end lands one byte past the range end', () => {
    const dirty = enclosedUnit(1);
    const at = Buffer.from(dirty).indexOf(Buffer.from('MARKERTEXT'));
    const out = strippedBytes('a.mp4', dirty);
    expect(Buffer.from(out.subarray(at, at + 10)).toString('latin1')).toBe('MARKERTEXT');
  });

  it('overwrites the first and last byte of a unit payload', () => {
    const marker = 'MARKERTEXT';
    const payload = concat(ascii(BANNER), Uint8Array.from([0x01]), ascii(marker));
    const dirty = concat(
      ISO_FTYP,
      isoBox('mdat', seiUnit({ banner: payload, coded: CODED_SAMPLES }))
    );
    const first = Buffer.from(dirty).indexOf(Buffer.from(BANNER));
    const last = Buffer.from(dirty).indexOf(Buffer.from(marker)) + marker.length - 1;
    const out = strippedBytes('a.mp4', dirty);
    // Narrowing the extent at either end leaves a byte of the banner behind.
    expect(out[first]).toBe(0x20);
    expect(out[last]).toBe(0x20);
  });

  it('reaches back to the first byte of the coded payload', () => {
    // The run starts at the range's own first byte, with the literal past it.
    const dirty = mdatOf(concat(ascii(`AA${LAVC}`), Uint8Array.from([0x00])), 4096);
    const start = Buffer.from(dirty).indexOf(Buffer.from(`AA${LAVC}`));
    const out = strippedBytes('a.mp4', dirty);
    expect(out[start]).toBe(0x20);
  });

  it('reaches forward to the last byte of the coded payload', () => {
    const tail = ascii(`${LAVC}AA`);
    const body = concat(filled(4096 - tail.length - 1, 0x01), Uint8Array.from([0x00]), tail);
    const dirty = concat(ISO_FTYP, isoBox('mdat', body));
    const out = strippedBytes('a.mp4', dirty);
    expect(out.at(-1)).toBe(0x20);
  });

  it('keeps a rewritten FLAC block’s declared length exactly as it was', () => {
    const dirty = flacStream([VORBIS, flacBlock(FLAC_TYPE_PADDING, filled(16, 0), true)]);
    const at = 4 + 4 + 34;
    const declared = Buffer.from(dirty).readUIntBE(at + 1, 3);
    const out = strippedBytes('a.flac', dirty);
    expect(Buffer.from(out).readUIntBE(at + 1, 3)).toBe(declared);
    expect(out.length).toBe(dirty.length);
    // Padding is zero by specification, and the header is exactly four bytes:
    // copying a fifth would carry a byte of the old comment into the body.
    expect(
      Buffer.from(out.subarray(at + 4, at + 4 + declared)).equals(Buffer.alloc(declared))
    ).toBe(true);
  });

  it('zeroes a 64-bit box’s body from exactly past its extended header', () => {
    const uuid = isoLargeBox('uuid', concat(filled(16, 0x2b), ascii('c2pa')));
    const dirty = concat(ISO_FTYP, uuid, isoBox('mdat', CODED_SAMPLES));
    const at = Buffer.from(dirty).indexOf(Buffer.from('uuid')) - 4;
    const out = strippedBytes('a.mp4', dirty);
    // The eight-byte extended size survives; the body past it is all zero.
    expect(
      Buffer.from(out.subarray(at + 8, at + 16)).equals(
        Buffer.from(dirty.subarray(at + 8, at + 16))
      )
    ).toBe(true);
    expect(
      Buffer.from(out.subarray(at + 16, at + uuid.length)).equals(Buffer.alloc(uuid.length - 16))
    ).toBe(true);
  });

  it('pads a re-packed tag with zeroes and nothing else', () => {
    const tag = id3Tag([
      id3Frame('GEOB', ascii(`c2pa manifest ${compactAt(DISCLOSING_MS)}`)),
      id3Frame('TIT2', ascii('a title')),
    ]);
    const dirty = concat(tag, mp3Audio());
    const out = strippedBytes('a.mp3', dirty);
    // A non-zero pad byte reads as the start of another frame.
    const padStart = Buffer.from(out).indexOf(Buffer.from('a title')) + 'a title'.length;
    expect(
      Buffer.from(out.subarray(padStart, tag.length)).equals(Buffer.alloc(tag.length - padStart))
    ).toBe(true);
  });

  /** A printable run of exactly `length` bytes carrying a literal, delimited both sides. */
  function runOf(length: number): Uint8Array {
    return concat(
      Uint8Array.from([0x00]),
      ascii(`Lavc${'A'.repeat(length - 4)}`),
      Uint8Array.from([0x00])
    );
  }

  it('accepts a blob whose overwrites total exactly the aggregate ceiling', () => {
    // Fifteen runs of 4096, one of 4092 and one of 4: 65_536 exactly.
    const head = concat(...Array.from({ length: 15 }, () => runOf(4096)), runOf(4092), runOf(4));
    expect(stripBinaryBlob('a.mp4', mdatOf(head, 1_048_576)).status).toBe('stripped');
  });

  it('refuses a blob whose overwrites total one byte more', () => {
    const head = concat(...Array.from({ length: 15 }, () => runOf(4096)), runOf(4093), runOf(4));
    const result = stripBinaryBlob('a.mp4', mdatOf(head, 1_048_576));
    expect(result.status).toBe('refused');
    expect(result.reasons.join(' ')).toContain('in total');
  });

  it('reads a unit payload that fits its unit exactly', () => {
    // The smallest payload that can carry a reported literal is the uuid plus
    // four bytes, which is where the floor has to sit to matter at all.
    const payload = concat(filled(16, 0x01), ascii('Lavc'));
    const nal = concat(Uint8Array.from([0x06, 0x05, payload.length]), payload);
    const dirty = mdatOf(concat(filled(4096, 0x01), u32be(nal.length), nal), 65_536);
    const at = Buffer.from(dirty).indexOf(Buffer.from('Lavc'));
    const out = strippedBytes('a.mp4', dirty);
    expect(out[at]).toBe(0x20);
    expect(out[at - 1]).toBe(0x01);
  });

  it('refuses a unit payload declaring one byte more than its unit holds', () => {
    const payload = concat(filled(16, 0x01), ascii('Lavc'), Uint8Array.from([0x01]), ascii('TAIL'));
    const nal = concat(Uint8Array.from([0x06, 0x05, payload.length + 1]), payload);
    const dirty = mdatOf(concat(filled(4096, 0x01), u32be(nal.length), nal), 65_536);
    const tail = Buffer.from(dirty).indexOf(Buffer.from('TAIL'));
    const out = strippedBytes('a.mp4', dirty);
    // The declared payload does not fit, so the unit is not believed and the
    // printable run is what gets overwritten — leaving the tail past the break.
    expect(Buffer.from(out.subarray(tail, tail + 4)).toString('latin1')).toBe('TAIL');
  });

  it('refuses a blob carrying more toolchain text in total than one blob may overwrite', () => {
    // Sixteen runs of 4096 bytes is 65_536 exactly; seventeen is past the total.
    const run = (): Uint8Array =>
      concat(Uint8Array.from([0x00]), ascii(`Lavc${'A'.repeat(4092)}`), Uint8Array.from([0x00]));
    const admitted = concat(...Array.from({ length: 16 }, () => run()));
    const refused = concat(...Array.from({ length: 17 }, () => run()));
    expect(stripBinaryBlob('a.mp4', mdatOf(admitted, 1_048_576)).status).toBe('stripped');
    const result = stripBinaryBlob('a.mp4', mdatOf(refused, 1_048_576));
    expect(result.status).toBe('refused');
    expect(result.reasons.join(' ')).toContain('in total');
  });
});

describe('bounds the mechanical enumeration reached', () => {
  const LAVC = 'Lavc58.134.100';

  it('zeroes only the time pair of a 64-bit header box', () => {
    const trailing = filled(12, 0x11);
    const header = isoWideHeaderBox(
      'mvhd',
      BigInt(ISO_EPOCH_OFFSET_SECONDS + DISCLOSING_SECONDS),
      BigInt(ISO_EPOCH_OFFSET_SECONDS + DISCLOSING_SECONDS + 20)
    );
    const dirty = concat(ISO_FTYP, isoBox('moov', header), isoBox('mdat', CODED_SAMPLES));
    const at = Buffer.from(dirty).indexOf(Buffer.from('mvhd'));
    const out = strippedBytes('a.mp4', dirty);
    const body = at + 4;
    // Sixteen zeroed bytes, then the timescale and duration untouched: a width
    // one step wide eats two bytes of a field inside a box no content proof
    // covers.
    expect(Buffer.from(out.subarray(body + 4, body + 20)).equals(Buffer.alloc(16))).toBe(true);
    expect(Buffer.from(out.subarray(body + 20, body + 32)).equals(Buffer.from(trailing))).toBe(
      true
    );
  });

  it('leaves a coded byte sitting between two literals alone', () => {
    // The two runs are one byte apart. An adjacency that reaches one step
    // further merges them and overwrites the byte between, which nothing
    // reported and the content proof cannot see.
    const body = concat(
      Uint8Array.from([0x00]),
      ascii('Lavc'),
      Uint8Array.from([0x01]),
      ascii('LAME'),
      Uint8Array.from([0x00])
    );
    const dirty = mdatOf(body, 4096);
    const gap = Buffer.from(dirty).indexOf(Buffer.from('Lavc')) + 4;
    const result = stripBinaryBlob('a.mp4', dirty);
    expect(result.status).toBe('stripped');
    expect(result.bytes[gap]).toBe(0x01);
    expect(result.edits.length).toBe(2);
  });

  it('reads a literal that opens a unit payload and one that closes it', () => {
    const payload = concat(filled(16, 0x01), ascii('Lavc'), filled(8, 0x41), ascii('LAME'));
    const nal = concat(Uint8Array.from([0x06, 0x05, payload.length]), payload);
    const dirty = mdatOf(concat(filled(4096, 0x01), u32be(nal.length), nal), 65_536);
    const first = Buffer.from(dirty).indexOf(Buffer.from('Lavc'));
    const last = Buffer.from(dirty).indexOf(Buffer.from('LAME')) + 3;
    const out = strippedBytes('a.mp4', dirty);
    // Both the payload's first data byte and its last are inside the unit.
    expect(out[first]).toBe(0x20);
    expect(out[last]).toBe(0x20);
  });

  it('carries a run of odd length back to its first byte', () => {
    // An odd prefix separates a walk that steps one byte at a time from one
    // that steps two and lands past the run's start.
    const dirty = mdatOf(concat(ascii(`AAA${LAVC}`), Uint8Array.from([0x00])), 4096);
    const start = Buffer.from(dirty).indexOf(Buffer.from('AAA'));
    const result = stripBinaryBlob('a.mp4', dirty);
    expect(result.status).toBe('stripped');
    expect(result.edits[0]?.start).toBe(start);
  });

  it('rejects exclusions one byte past the share of an odd-sized content', () => {
    // Ninety-five located bytes: a quarter of that is not a whole number, which
    // is where a comparison one step wide stops agreeing with this one.
    const bytes = png({ imageData: filled(95, 0x5a) });
    const [span] = contentSpans(bytes) ?? [];
    const start = span?.start ?? 0;
    expect(() => {
      assertContentPreserved({
        file: 'a.png',
        before: bytes,
        after: bytes,
        excluded: [{ start, end: start + 24 }],
      });
    }).toThrow(/share of the content/);
  });

  it('finds every range among many by search', () => {
    const ranges = Array.from({ length: 33 }, (_, index) => ({
      location: 'mdat',
      start: index * 10,
      end: index * 10 + 5,
    }));
    for (const [index, range] of ranges.entries()) {
      expect(rangeContaining(ranges, range.start)?.start).toBe(index * 10);
      expect(rangeContaining(ranges, range.end - 1)?.start).toBe(index * 10);
      expect(rangeContaining(ranges, range.end)).toBeUndefined();
    }
  });

  // Two values whose high byte moves if the encoder's radix moves: 512 divides
  // differently by 256 and 257, and 255 differently by 256 and 255.
  it.each([
    [511, 512],
    [254, 255],
  ])('encodes a %i-byte body as a two-byte size holding %i', (body, value) => {
    const dirty = matroska([
      ebmlElement(MATROSKA_ID_MUXING_APP, concat(ascii('Lavf'), filled(body - 4, 0x41))),
    ]);
    const at = Buffer.from(dirty).indexOf(Buffer.from(MATROSKA_ID_MUXING_APP));
    const out = strippedBytes('a.webm', dirty);
    expect(out[at]).toBe(0xec);
    expect(readVintAt(out, at + 1)).toEqual({ value, width: 2 });
  });

  it('reads a unit whose payload size needs a chained length', () => {
    const banner = concat(ascii('Lavc'), filled(300, 0x41));
    const dirty = concat(
      ISO_FTYP,
      isoBox('mdat', concat(filled(8192, 0x01), seiUnit({ banner, coded: filled(64, 0x37) })))
    );
    const at = Buffer.from(dirty).indexOf(Buffer.from('Lavc'));
    const out = strippedBytes('a.mp4', dirty);
    // The chain decodes to 320: sixteen uuid bytes then 304 of payload data.
    expect(Buffer.from(out.subarray(at, at + 304)).equals(Buffer.alloc(304, 0x20))).toBe(true);
    expect(out[at + 304]).toBe(0x80);
  });

  it('reports no walked bytes for a blob it never planned against', () => {
    expect(stripBinaryBlob('a.png', png({ imageData: IMAGE_DATA })).walkedBytes).toBe(0);
  });
});

describe('a toolchain string inside coded audio', () => {
  const LITERAL = 'Lavc58.134.100';

  /** A FLAC stream whose audio frames carry `text` between non-printable bytes. */
  function flacWithCodedText(text: string, padding = 256): Uint8Array {
    return concat(
      FLAC_SIGNATURE,
      flacBlock(FLAC_TYPE_STREAMINFO, filled(34, 0)),
      flacBlock(FLAC_TYPE_PADDING, filled(8, 0), true),
      flacAudio(),
      Uint8Array.from([0x00]),
      ascii(text),
      Uint8Array.from([0x00]),
      filled(padding, 0x4d)
    );
  }

  /** An MPEG stream with `text` spliced into the body of its first frame. */
  function mp3WithCodedText(text: string): Uint8Array {
    const audio = mp3Audio();
    audio.set(concat(Uint8Array.from([0x00]), ascii(text), Uint8Array.from([0x00])), 100);
    return concat(id3Tag([id3Frame('TIT2', ascii('a title'))]), audio);
  }

  it('overwrites one an encoder drained into FLAC frames', () => {
    const dirty = flacWithCodedText(LITERAL);
    expect(scanBinaryBlob('a.flac', dirty).length).toBeGreaterThan(0);
    const out = strippedBytes('a.flac', dirty);
    expect(scanBinaryBlob('a.flac', out)).toEqual([]);
    expect(out.length).toBe(dirty.length);
    expect(Buffer.from(out).includes(Buffer.from('Lavc'))).toBe(false);
  });

  it('overwrites one an encoder drained into MPEG frames', () => {
    const dirty = mp3WithCodedText(LITERAL);
    expect(scanBinaryBlob('a.mp3', dirty).length).toBeGreaterThan(0);
    const out = strippedBytes('a.mp3', dirty);
    expect(scanBinaryBlob('a.mp3', out)).toEqual([]);
    expect(out.length).toBe(dirty.length);
    expect(Buffer.from(out).includes(Buffer.from('Lavc'))).toBe(false);
  });

  it('still drops the tag frames of a stream whose audio also discloses', () => {
    const audio = mp3Audio();
    audio.set(concat(Uint8Array.from([0x00]), ascii(LITERAL), Uint8Array.from([0x00])), 100);
    const dirty = concat(id3Tag([id3Frame('TSSE', ascii('Lavf58.76.100'))]), audio);
    const out = strippedBytes('a.mp3', dirty);
    expect(scanBinaryBlob('a.mp3', out)).toEqual([]);
    expect(Buffer.from(out).includes(Buffer.from('Lavf'))).toBe(false);
    expect(out.length).toBe(dirty.length);
  });

  it('refuses a FLAC whose coded run is longer than one overwrite may cover', () => {
    const result = stripBinaryBlob('a.flac', flacWithCodedText(`Lavc${'A'.repeat(4093)}`, 65_536));
    expect(result.status).toBe('refused');
    expect(result.reasons.join(' ')).toContain('coded payload');
  });

  it('refuses an MPEG stream whose coded run is longer than one overwrite may cover', () => {
    // Spliced past the two frame headers the matcher validates, so the blob is
    // still recognised as MPEG audio and the refusal is the extent bound's.
    const audio = mp3Audio(24);
    audio.set(
      concat(Uint8Array.from([0x00]), ascii(`Lavc${'A'.repeat(4093)}`), Uint8Array.from([0x00])),
      MP3_FRAME_BYTES * 2
    );
    const result = stripBinaryBlob('a.mp3', concat(id3Tag([]), audio));
    expect(result.status).toBe('refused');
    expect(result.reasons.join(' ')).toContain('coded payload');
  });
});

describe('a literal straddling a unit payload’s own boundaries', () => {
  it('is carried away whole when it starts inside the payload uuid', () => {
    // The banner begins on the uuid's last byte, so it is not "inside the user
    // data" and the unit must be declined: the unit's span starts past that
    // byte and would leave it standing. The run that replaces it does not.
    const payload = concat(filled(15, 0x01), ascii('Lavc58.134.100'));
    const nal = concat(
      Uint8Array.from([0x06, 0x05, payload.length]),
      payload,
      Uint8Array.from([0x00])
    );
    const dirty = mdatOf(concat(filled(4096, 0x01), u32be(nal.length), nal), 65_536);
    const at = Buffer.from(dirty).indexOf(Buffer.from('Lavc'));
    const out = strippedBytes('a.mp4', dirty);
    expect(scanBinaryBlob('a.mp4', out)).toEqual([]);
    expect(out[at]).toBe(0x20);
  });
});

describe('a literal starting exactly where a unit payload ends', () => {
  it('is not treated as part of the unit', () => {
    // One byte past the payload and still inside the unit. The recognizer has to
    // decline it: the unit's own span stops at the payload end, so believing the
    // unit here would leave the literal standing while reporting a clean strip —
    // and the content proof cannot see it, the excluded set being exactly what
    // the remedy rewrote.
    const payload = concat(filled(16, 0x01), filled(8, 0x01));
    const nal = concat(
      Uint8Array.from([0x06, 0x05, payload.length]),
      payload,
      ascii('Lavc58.134.100'),
      Uint8Array.from([0x00])
    );
    const dirty = mdatOf(concat(filled(4096, 0x01), u32be(nal.length), nal), 65_536);
    const at = Buffer.from(dirty).indexOf(Buffer.from('Lavc'));
    const out = strippedBytes('a.mp4', dirty);
    expect(scanBinaryBlob('a.mp4', out)).toEqual([]);
    expect(out[at]).toBe(0x20);
  });
});

describe('claims that cross the module boundary, checked where they are used', () => {
  const BANNER = 'Lavc58.134.100';
  const isobmff = BINARY_FORMATS.find((format) => format.id === 'isobmff');
  const policy = STRIP_POLICY.isobmff;

  function isoPlan(
    bytes: Uint8Array,
    target: { kind: string; offset: number; length: number }
  ): ReturnType<Extract<Policy, { remedy: unknown }>['remedy']> {
    if (isobmff === undefined || !('remedy' in policy)) {
      throw new Error('the registry must carry an isobmff format with a remedy');
    }
    return policy.remedy({
      bytes,
      view: Buffer.from(bytes),
      format: isobmff,
      ranges: [],
      targets: [target],
      meter: newWorkMeter(),
    });
  }

  // A `free` box whose body is neither zeroes nor a plausible size word, so a
  // body-shaped extent cannot be mistaken for a box that runs to end of file.
  const framed = concat(
    ISO_FTYP,
    isoBox('mdat', filled(64, 0x01)),
    isoBox('free', filled(24, 0x11))
  );
  const boxStart = framed.length - 32;

  // Every target below but one names a kind the free-box remedy still serves, so
  // the unit shape is what decides it. An unrecognised kind is refused on its own
  // reason, which is what the one exception pins.
  it('refuses an isobmff target whose offset opens no box of the reported length', () => {
    const plan = isoPlan(framed, { kind: 'isobmff:uuid', offset: boxStart + 8, length: 24 });
    expect(plan.edits).toEqual([]);
    expect(plan.refusal).toContain('does not open a container unit');
  });

  it('refuses an isobmff target whose box no parser here could name', () => {
    const plan = isoPlan(framed, { kind: 'isobmff:unnamed', offset: boxStart, length: 32 });
    expect(plan.edits).toEqual([]);
    expect(plan.refusal).toContain('what removing it costs');
  });

  it('refuses an isobmff target reaching past the end of the blob', () => {
    const plan = isoPlan(framed, { kind: 'isobmff:uuid', offset: framed.length - 4, length: 4 });
    expect(plan.edits).toEqual([]);
    expect(plan.refusal).toContain('does not open a container unit');
  });

  it('accepts an isobmff target whose box declares its size in the wide form', () => {
    const wide = concat(
      ISO_FTYP,
      isoBox('mdat', filled(64, 0x01)),
      isoLargeBox('free', filled(24, 0x11))
    );
    const start = ISO_FTYP.length + 72;
    const plan = isoPlan(wide, {
      kind: 'isobmff:uuid',
      offset: start,
      length: wide.length - start,
    });
    expect(plan.refusal).toBeUndefined();
    expect(plan.edits).toHaveLength(1);
    expect(plan.edits[0]?.start).toBe(start);
    expect(plan.edits[0]?.end).toBe(wide.length);
  });

  it('refuses an isobmff target whose wide size word runs off the end of the blob', () => {
    const truncated = concat(ISO_FTYP, isoBox('mdat', filled(64, 0x01)), u32be(1), ascii('free'));
    const plan = isoPlan(truncated, {
      kind: 'isobmff:uuid',
      offset: truncated.length - 8,
      length: 8,
    });
    expect(plan.edits).toEqual([]);
    expect(plan.refusal).toContain('does not open a container unit');
  });

  it('accepts an isobmff target whose box declares that it runs to the end of the file', () => {
    const open = concat(
      ISO_FTYP,
      isoBox('mdat', filled(64, 0x01)),
      isoZeroSizedBox('free', filled(24, 0x11))
    );
    const start = ISO_FTYP.length + 72;
    const plan = isoPlan(open, {
      kind: 'isobmff:uuid',
      offset: start,
      length: open.length - start,
    });
    expect(plan.refusal).toBeUndefined();
    expect(plan.edits).toHaveLength(1);
  });

  it('accepts an isobmff target that is a bare header ending the blob', () => {
    const bare = concat(
      ISO_FTYP,
      isoBox('mdat', filled(64, 0x01)),
      isoBox('free', filled(0, 0x00))
    );
    const plan = isoPlan(bare, {
      kind: 'isobmff:uuid',
      offset: bare.length - 8,
      length: 8,
    });
    expect(plan.refusal).toBeUndefined();
    expect(plan.edits).toHaveLength(1);
  });

  it('accepts an isobmff target that is a bare wide header ending the blob', () => {
    const bare = concat(
      ISO_FTYP,
      isoBox('mdat', filled(64, 0x01)),
      isoLargeBox('free', filled(0, 0x00))
    );
    const plan = isoPlan(bare, {
      kind: 'isobmff:uuid',
      offset: bare.length - 16,
      length: 16,
    });
    expect(plan.refusal).toBeUndefined();
    expect(plan.edits).toHaveLength(1);
  });

  it('counts an edit ending exactly where an exclusion starts as moving it', () => {
    const blob = concat(
      MATROSKA_ID_EBML,
      Uint8Array.from([0x84]),
      filled(4, 0x00),
      MATROSKA_ID_SEGMENT,
      Uint8Array.from([0x90]),
      filled(16, 0x11)
    );
    const cut = 12;
    const result = verifiedStrip({
      file: 'a.webm',
      format: 'matroska',
      bytes: blob,
      edits: [{ start: cut - 4, end: cut, data: new Uint8Array(0), reason: 'dropped four bytes' }],
      excluded: [{ start: cut, end: cut + 4 }],
    });
    expect(result.status).toBe('refused');
    expect(result.reasons.join(' ')).toContain('same coordinates');
  });

  it('refuses when an earlier edit moves the bytes an exclusion was measured against', () => {
    const dirty = concat(
      id3Tag([id3Frame('TSSE', ascii('Lavf58.76.100'))]),
      FLAC_SIGNATURE,
      flacBlock(FLAC_TYPE_STREAMINFO, filled(34, 0x00), true),
      Uint8Array.from([0xff, 0xf8]),
      ascii(BANNER),
      filled(300, 0x01)
    );
    const result = stripBinaryBlob('a.flac', dirty);
    expect(result.status).toBe('refused');
    expect(Buffer.from(result.bytes).equals(Buffer.from(dirty))).toBe(true);
    expect(result.reasons.join(' ')).toContain('same coordinates');
  });

  // The one box whose loss costs an ISO file its identity is the one declaring
  // the brand, and the dispatch above now refuses that box for its own reason.
  // So the identity net is reached here rather than through a remedy, which is
  // what a backstop looks like once nothing routes into it.
  it('refuses a strip whose edits leave bytes no longer read as the format they arrived as', () => {
    const blob = concat(ISO_FTYP, isoBox('mdat', filled(64, 0x01)));
    const result = verifiedStrip({
      file: 'a.mp4',
      format: 'isobmff',
      bytes: blob,
      edits: [
        {
          start: 0,
          end: ISO_FTYP.length,
          data: filled(ISO_FTYP.length, 0x00),
          reason: 'zeroed the box declaring the brand',
        },
      ],
    });
    expect(result.status).toBe('refused');
    expect(result.reasons.join(' ')).toContain('no longer read as');
  });
});
